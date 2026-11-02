import assert from 'node:assert/strict'
import {writeFile,mkdir} from 'node:fs/promises'
import {chromium} from 'playwright'
const url=process.env.VECTOR_PREVIEW_URL||'http://127.0.0.1:5175'
const body=process.env.CUBE_BODY||'moon'
assert.ok(['moon','mars'].includes(body))
const output=`.terrain-cache/${body}-cube/colors`;await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
const report={errors:[],cases:[]}
try{
 const page=await browser.newPage({viewport:{width:800,height:600}})
 page.on('pageerror',e=>report.errors.push(e.message))
 page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGLProgram/.test(m.text()))report.errors.push(m.text())})
 await page.route('**/src/ExplorerScene.ts*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('pilotMetrics() {','pilotMetrics() { window.__colorScene=this;')})})
 await page.goto(`${url}/?terrainPilot=1`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.terrainPilot)
 await page.evaluate(body=>{terrainPilot.location(body,0,0,12000);terrainPilot.metrics()},body)
 await page.waitForFunction(body=>__colorScene[`${body}RasterColor`]?.image?.width>0,body)
 await page.getByRole('button',{name:'Terrain on',exact:true}).click()
 await page.evaluate(async body=>{
  if(body==='mars')await __colorScene.setMarsColor('raster');else await __colorScene.setMoonColor('raster')
  const THREE=await import('/node_modules/three/build/three.module.js'),s=__colorScene,w=1024,h=512,data=new Uint8Array(w*h*4)
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
   const lon=((x+.5)/w*360-180)*Math.PI/180,lat=((y+.5)/h*180-90)*Math.PI/180,i=(y*w+x)*4
   data[i]=Math.round((Math.cos(lat)*Math.cos(lon)*.5+.5)*255);data[i+1]=Math.round((Math.sin(lat)*.5+.5)*255)
   data[i+2]=Math.round((-Math.cos(lat)*Math.sin(lon)*.5+.5)*255);data[i+3]=255
  }
  const texture=new THREE.DataTexture(data,w,h);texture.colorSpace=THREE.LinearSRGBColorSpace;texture.wrapS=THREE.RepeatWrapping
  texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;texture.needsUpdate=true
  const material=s.bodies.get(body).material,previous=material.onBeforeCompile,key=material.customProgramCacheKey()
  material.map=texture;material.onBeforeCompile=(shader,renderer)=>{
   previous.call(material,shader,renderer)
   shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>','gl_FragColor=vec4(diffuseColor.rgb,1.0);')
    .replace('#include <tonemapping_fragment>','').replace('#include <colorspace_fragment>','')
  }
  material.customProgramCacheKey=()=>key+'/cube-color-check';material.needsUpdate=true
  s.setSurfaceDetail(false);s.setTerrainShadows(false);s.setTerrainHillshade(false)
 },body)
 for(const [lat,lon]of [[0,0],[0,90],[0,180],[0,-90],[90,0],[-90,0],[35.26438968,45],[0,45],[10,179.999],[10,-179.999]]){
  await page.evaluate(({body,lat,lon})=>terrainPilot.location(body,lat,lon,12000),{body,lat,lon});await page.waitForTimeout(250)
  const actual=await page.evaluate(()=>{
   const s=__colorScene;s.renderer.render(s.scene,s.camera)
   const gl=s.renderer.getContext(),p=new Uint8Array(4);gl.readPixels(gl.drawingBufferWidth/2,gl.drawingBufferHeight/2,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return Array.from(p)
  })
  const phi=lat*Math.PI/180,l=lon*Math.PI/180,expected=[Math.cos(phi)*Math.cos(l),Math.sin(phi),-Math.cos(phi)*Math.sin(l)].map(v=>Math.round((v*.5+.5)*255))
  assert.ok(expected.every((v,i)=>Math.abs(v-actual[i])<=2),`GPU color mapping ${lat},${lon}: ${actual} != ${expected}`)
  report.cases.push({lat,lon,actual,expected})
 }
 assert.deepEqual(report.errors,[]);report.completed=true;console.log(`Actual ${body} shader matches geographic colors on all cube faces, poles, corners, and dateline`)
}finally{await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));await browser.close()}
