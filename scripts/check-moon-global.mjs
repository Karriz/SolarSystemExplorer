import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const option=(flag,fallback)=>{const i=process.argv.indexOf(flag);return i<0?fallback:process.argv[i+1]}
const url=option('--url','http://127.0.0.1:5173/').replace(/\/$/,'')
const output=resolve(option('--output','.terrain-cache/moon-global/browser'))
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true,executablePath:option('--executable',undefined),args:['--no-sandbox']})
const report={errors:[],cases:[],completed:false}
async function settle(page){let stable=0,last='',latest;for(let i=0;i<180;i++){
 const metrics=await page.evaluate(()=>terrainPilot.metrics()),m=metrics.global.moon,key=JSON.stringify([m.cached,m.visible,m.maxLevel])
 latest=metrics
 stable=m.ready&&!m.requests&&key===last?stable+1:0;last=key
 if(stable>=5)return metrics
 await page.waitForTimeout(500)
}throw Error('Global lunar terrain did not settle: '+JSON.stringify(latest?.global.moon))}
try{
 const context=await browser.newContext({viewport:{width:800,height:600}})
 if(process.argv.includes('--baseline'))await context.route('**/terrain/catalog.json',async route=>{
  const r=await route.fetch(),catalog=await r.json();catalog.bodies.moon='moon/lola64-1c4958699d4c-g65-z7-v3/manifest.json';await route.fulfill({json:catalog})
 })
 const page=await context.newPage(),failed=[],pilotRequests=[]
 page.on('pageerror',e=>report.errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGLProgram/.test(m.text()))report.errors.push(m.text())})
 page.on('response',r=>{if(r.status()>=400&&r.url().includes('/terrain/'))failed.push({url:r.url(),status:r.status()})})
 page.on('request',r=>{if(r.url().includes('moon-hadley'))pilotRequests.push(r.url())})
 await page.goto(url+'/?terrainPilot=1');await page.waitForFunction(()=>window.terrainPilot)
 await page.getByRole('button',{name:'Close information panel',exact:true}).click()
 await page.evaluate(()=>terrainPilot.date('2026-10-26T12:00:00Z'))
 report.renderer=await page.evaluate(()=>{const gl=document.querySelector('canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)})
 const cases=process.argv.includes('--baseline')?[['hadley',26.13,3.63,6000]]:[['hadley',26.13,3.63,6000],['close',26.13,3.63,100],['north-polar',89.9,45,12000],['south-polar',-89.9,-45,12000],['far-side',-15,170,12000],['tycho',-43.31,-11.36,25000],['dateline',10,179.99,6000]]
 for(const[name,lat,lon,altitude]of cases){
  console.log('Checking',name)
  await page.evaluate(({lat,lon,altitude})=>terrainPilot.location('moon',lat,lon,altitude),{lat,lon,altitude})
  let metrics=await settle(page)
  // Re-anchor the requested clearance after cold streaming has warmed the view.
  await page.evaluate(({lat,lon,altitude})=>terrainPilot.location('moon',lat,lon,altitude),{lat,lon,altitude})
  metrics=await settle(page)
  const m=metrics.global.moon
  assert.equal(m.sampleSize,process.argv.includes('--baseline')?65:129)
  assert.equal(metrics.regional.moon.sources.length,0)
  assert.ok(m.triangles<=m.triangleBudget);assert.ok(m.memoryBytes<=48*1048576)
  assert.equal(m.failed,0);assert.ok(Math.abs(metrics.altitudeMeters-altitude)<2,`${name}: clearance ${metrics.altitudeMeters}`)
  await page.screenshot({path:resolve(output,name+'.png')})
  report.cases.push({name,lat,lon,altitude,metrics});console.log(name,m.maxLevel,m.visible,m.triangles,(m.memoryBytes/1048576).toFixed(1)+' MiB')
  await writeFile(resolve(output,'results.json'),JSON.stringify(report,null,2))
 }
 if(!process.argv.includes('--baseline')){
  await page.setViewportSize({width:390,height:844})
  await page.evaluate(()=>terrainPilot.location('moon',26.13,3.63,1000))
  const metrics=await settle(page)
  assert.ok(metrics.global.moon.memoryBytes<=48*1048576)
  await page.mouse.move(250,300);await page.mouse.down({button:'right'});await page.mouse.move(270,250,{steps:6});await page.mouse.up({button:'right'})
  const tilted=await settle(page);assert.ok(tilted.altitudeMeters>=99)
  await page.screenshot({path:resolve(output,'phone-tilt.png')});report.cases.push({name:'phone-tilt',metrics:tilted})
  await page.evaluate(()=>terrainPilot.location('earth',60.38,25,4000000));await page.waitForTimeout(500)
  const switched=await page.evaluate(()=>terrainPilot.metrics());assert.equal(switched.global.moon.memoryBytes,0)
  report.switched=switched
 }
 assert.deepEqual(pilotRequests,[]);assert.deepEqual(failed,[]);assert.deepEqual(report.errors,[])
 report.completed=true
}catch(error){report.failure=String(error);throw error}
finally{await writeFile(resolve(output,'results.json'),JSON.stringify(report,null,2));await browser.close()}
