import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
const option=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1]}
const output=resolve(option('--output','.terrain-cache/moon-global/stability'))
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
const report={cases:[],errors:[],completed:false}
try {
 const page=await browser.newPage({viewport:{width:800,height:600}})
 // Inspect selection without adding a public runtime control or API.
 await page.route('**/src/ExplorerScene.ts*',async route=>{
  const response=await route.fetch()
  await route.fulfill({response,body:(await response.text()).replace('pilotMetrics() {','pilotMetrics() { window.__lodScene=this;')})
 })
 page.on('pageerror',e=>report.errors.push(e.message))
 await page.goto(option('--url','http://127.0.0.1:5174')+'/?terrainPilot=1')
 await page.waitForFunction(()=>window.terrainPilot)
 report.renderer=await page.evaluate(()=>{const gl=document.querySelector('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)})
 await page.getByRole('button',{name:'Close information panel',exact:true}).click()
 await page.evaluate(()=>{terrainPilot.metrics();__lodScene.setTerrainShadows(false);terrainPilot.date('2026-10-26T12:00:00Z')})
 for(const[name,lat,lon,altitude]of [['hadley-close',26.13,3.63,100],['tycho-close',-43.31,-11.36,100]]){
  console.log('Checking',name)
  await page.evaluate(({lat,lon,altitude})=>terrainPilot.location('moon',lat,lon,altitude),{lat,lon,altitude})
  let stable=0,last=''
  for(let i=0;i<180;i++){
   const value=await page.evaluate(()=>{const g=__lodScene.terrain.get('moon');return{signature:g.surfaceSignature(),m:g.metrics()}})
   stable=value.m.ready&&!value.m.requests&&value.signature===last?stable+1:0;last=value.signature
   if(stable>=8)break
   assert.ok(i<179,'stationary view did not settle')
   await page.waitForTimeout(300)
  }
  await page.evaluate(()=>{__lodScene.pilotAltitude=null})
  const samples=[]
  for(let i=0;i<30;i++){
   samples.push(await page.evaluate(()=>{const g=__lodScene.terrain.get('moon');return{wanted:[...g.wanted].sort().join('|'),drawn:g.surfaceSignature(),camera:__lodScene.camera.position.toArray(),rotation:__lodScene.camera.quaternion.toArray(),m:g.metrics()}}))
   await page.waitForTimeout(300)
  }
  assert.equal(new Set(samples.map(s=>s.wanted)).size,1,'requested LOD changed while stationary')
  assert.equal(new Set(samples.map(s=>s.drawn)).size,1,'displayed LOD changed while stationary')
  for(const sample of samples){assert.ok(sample.m.memoryBytes<=48*1048576);assert.ok(sample.m.triangles<=400000);assert.equal(sample.m.requests,0);assert.equal(sample.m.failed,0)}
  const spread=Math.max(...samples.flatMap(s=>s.camera.map((v,i)=>Math.abs(v-samples[0].camera[i]))))
  assert.ok(spread<1e-12,'camera moved during stability check')
  assert.ok(samples.every(s=>s.rotation.every((v,i)=>Math.abs(v-samples[0].rotation[i])<1e-12)),'camera rotated during stability check')
  await page.screenshot({path:resolve(output,name+'.png')})
  report.cases.push({name,samples,cameraSpread:spread});console.log(name,samples[0].m)
 }
 assert.deepEqual(report.errors,[])
 report.completed=true
}finally{await writeFile(resolve(output,'results.json'),JSON.stringify(report,null,2));await browser.close()}
