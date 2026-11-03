import assert from 'node:assert/strict'
import {chromium} from 'playwright'
const url=process.env.VECTOR_PREVIEW_URL||'http://127.0.0.1:5175'
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
 const page=await browser.newPage({viewport:{width:500,height:400}}),errors=[]
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGLProgram/.test(m.text()))errors.push(m.text())})
 await page.route('**/src/ExplorerScene.ts*',async r=>{const response=await r.fetch();await r.fulfill({response,body:(await response.text()).replace('pilotMetrics() {','pilotMetrics() { window.__memory=this;')})})
 await page.goto(url+'/?terrainPilot=1',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.terrainPilot)
 await page.evaluate(()=>{terrainPilot.metrics();__memory.setHighResHillshade(false);__memory.setTerrain(false);__memory.__render=__memory.renderer.render;__memory.renderer.render=()=>{}})
 await page.waitForFunction(()=>__memory.moonColorTexture.texture&&__memory.marsColorTexture.texture,null,{timeout:60000})
 for(const body of ['moon','mars']){
  await page.evaluate(body=>terrainPilot.location(body,0,0,1000000),body)
  await page.evaluate(async body=>{
   const s=__memory;await s[body==='moon'?'setMoonColor':'setMarsColor']('raster')
   window.__original=s[body+'RasterColor'];s.__render.call(s.renderer,s.scene,s.camera)
  },body)
  assert.equal(await page.evaluate(()=>__original.image.width),body==='moon'?8192:1440)
  await page.evaluate(async body=>{const s=__memory;await s[body==='moon'?'setMoonColor':'setMarsColor']('compact')},body)
  await page.waitForTimeout(100)
  const result=await page.evaluate(body=>{const s=__memory;s.__render.call(s.renderer,s.scene,s.camera);return {closed:__original.image.width===0,released:!s[body+'RasterColor'],compact:s.bodies.get(body).material.map.image.width===4096}},body)
  assert.deepEqual(result,{closed:true,released:true,compact:true});console.log(body,JSON.stringify(result))
 }
 assert.deepEqual(errors,[])
}finally{await browser.close()}
