import assert from 'node:assert/strict'
import { mkdir,writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
const url=process.env.VECTOR_PREVIEW_URL||'http://127.0.0.1:5175'
const body=process.env.CUBE_BODY||'moon'
assert.ok(['moon','mars'].includes(body))
const output=resolve(`.terrain-cache/${body}-cube/browser`);await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
const report={errors:[],cases:[],completed:false}
try{
 const page=await browser.newPage({viewport:{width:900,height:700}})
 page.on('pageerror',e=>report.errors.push(e.message))
 page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGLProgram/.test(m.text()))report.errors.push(m.text())})
 await page.route('**/src/ExplorerScene.ts*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('pilotMetrics() {','pilotMetrics() { window.__cubeScene=this;')})})
 await page.goto(`${url}/?terrainPilot=1`,{waitUntil:'domcontentloaded'})
 await page.waitForFunction(()=>window.terrainPilot)
 await page.evaluate(()=>{terrainPilot.metrics();terrainPilot.date('2026-10-26T12:00:00Z');__cubeScene.setSurfaceDetail(false);__cubeScene.setTerrainShadows(false)})
 const settle=async()=>{
  // Software WebGL can dominate streaming time. This optional mode still
  // runs normal LOD/camera updates and renders each settled view below.
  if(process.argv.includes('--fast-stream'))await page.evaluate(()=>{const s=__cubeScene;s.__cubeRender??=s.renderer.render;s.renderer.render=()=>{}})
  try{
  let stable=0,last='',metrics
  for(let i=0;i<240;i++){
   metrics=await page.evaluate(body=>terrainPilot.metrics().global[body],body)
   const pending=await page.evaluate(body=>[...__cubeScene.terrain.get(body).wanted].filter(key=>!__cubeScene.terrain.get(body).nodes.get(key)?.mesh).length,body)
   const key=JSON.stringify([metrics.cached,metrics.visible,metrics.maxLevel,pending])
   stable=metrics.ready&&!metrics.requests&&!pending&&last===key?stable+1:0;last=key
   if(stable>=4)return metrics
   if(i%30===0)console.log('Streaming',metrics.maxLevel,metrics.visible,metrics.requests,'pending',pending,'MiB',(metrics.memoryBytes/1048576).toFixed(1))
   await page.waitForTimeout(250)
  }
  throw Error('Cube terrain did not settle: '+JSON.stringify(metrics))
  }finally{
   if(process.argv.includes('--fast-stream'))await page.evaluate(()=>{const s=__cubeScene;s.renderer.render=s.__cubeRender})
  }
 }
 const cases=body==='mars'?[['orbit',-14,-59,3000000],['valles',-14,-59,30000],['north-pole',90,0,30000],['south-pole',-90,0,30000],['face-edge',0,45,30000],['face-corner',35.26438968,45,30000],['dateline',10,179.99,30000]]:process.argv.includes('--quick')?[['hadley',26.13,3.63,6000]]:
  [['orbit',26.13,3.63,2000000],['hadley',26.13,3.63,6000],['north-pole',90,0,6000],['south-pole',-90,0,6000],
   ['face-edge',0,45,6000],['face-corner',35.26438968,45,6000],['dateline',10,179.99,6000],['close',26.13,3.63,100]]
 for(const[name,lat,lon,altitude]of cases.filter(c=>!process.env.CUBE_CASES||process.env.CUBE_CASES.split(',').includes(c[0]))){
  console.log('Checking',name)
  await page.evaluate(({body,lat,lon,altitude})=>terrainPilot.location(body,lat,lon,altitude),{body,lat,lon,altitude})
  await settle()
  await page.evaluate(({body,lat,lon,altitude})=>terrainPilot.location(body,lat,lon,altitude),{body,lat,lon,altitude})
  const metrics=await settle()
  assert.equal(metrics.projection,'cube-sphere');assert.equal(metrics.failed,0)
  assert.ok(metrics.memoryBytes<=128*1048576);assert.ok(metrics.triangles<=400000)
  await page.evaluate(()=>{__cubeScene.pilotAltitude=null})
  const signatures=[]
  for(let i=0;i<8;i++){
   signatures.push(await page.evaluate(body=>{const g=__cubeScene.terrain.get(body);return JSON.stringify([[...g.wanted].sort(),g.surfaceSignature(),__cubeScene.camera.position.toArray()])},body))
   await page.waitForTimeout(150)
  }
  const states=signatures.map(s=>JSON.parse(s))
  if(new Set(signatures).size!==1){report.stationaryStates={name,states}}
  assert.equal(new Set(states.map(s=>JSON.stringify(s.slice(0,2)))).size,1,'Stationary cube selection changed')
  // AU coordinates can settle by a few floating-point ulps after reorienting
  // controls at a cube edge. Require the physical camera drift below 1 mm.
  for(const state of states)assert.ok(Math.hypot(...state[2].map((v,i)=>v-states[0][2][i]))*149597870700<.001,'Stationary camera drift exceeds 1 mm')
  await page.screenshot({path:resolve(output,`${name}.png`)})
  report.cases.push({name,metrics,clearance:await page.evaluate(()=>terrainPilot.metrics().altitudeMeters)})
  await writeFile(resolve(output,'results.json'),JSON.stringify(report,null,2))
 }
 if(body==='moon'&&!process.argv.includes('--quick')){
  const before=await page.evaluate(()=>__cubeScene.terrain.get('moon').surfaceSignature())
  await page.evaluate(()=>{__cubeScene.setSurfaceDetail(true);__cubeScene.setTerrainShadows(true)})
  await page.waitForTimeout(600)
  assert.equal(await page.evaluate(()=>__cubeScene.terrain.get('moon').surfaceSignature()),before,'Surface effects changed cube LOD')
  await page.screenshot({path:resolve(output,'close-with-detail.png')})
 }
 assert.deepEqual(report.errors,[])
 report.completed=true;console.log(`Cube ${body} checks passed`)
}finally{await writeFile(resolve(output,'results.json'),JSON.stringify(report,null,2));await browser.close()}
