import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const output='.terrain-cache/solar-glare-browser',url=process.env.ATMOSPHERE_PREVIEW_URL||'http://127.0.0.1:5175'
await mkdir(output,{recursive:true})
const report={errors:[],views:[],completed:false}
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try {
 const page=await browser.newPage({viewport:{width:1000,height:750}})
 page.on('pageerror',e=>report.errors.push(e.message))
 page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGL/i.test(m.text()))report.errors.push(m.text())})
 await page.route('**/src/ExplorerScene.ts*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('pilotMetrics() {','pilotMetrics() { window.__glareScene=this;')})})
 await page.goto(`${url}/?terrainPilot=1`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.terrainPilot)
 await page.evaluate(async()=>{
  terrainPilot.metrics();cancelAnimationFrame(__glareScene.frame)
  const T=await import('/node_modules/three/build/three.module.js'),{AtmosphereRenderPipeline}=await import('/src/AtmosphereRenderPipeline.ts')
  const renderer=new T.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});renderer.setSize(800,600)
  renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.7
  renderer.domElement.dataset.solarFixture='true'
  renderer.domElement.style.cssText='position:fixed;left:0;top:0;z-index:9999;background:#07111d'
  document.body.appendChild(renderer.domElement)
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(48,800/600,1e-7,100),pipeline=new AtmosphereRenderPipeline(renderer)
  const sun=new T.Mesh(new T.SphereGeometry(.004650467,96,64),new T.MeshBasicMaterial());scene.add(sun);pipeline.attachSun(sun)
  const read=()=>{const gl=renderer.getContext(),p=new Uint8Array(800*600*4);gl.readPixels(0,0,800,600,gl.RGBA,gl.UNSIGNED_BYTE,p);return p}
  window.__glareFixture={T,renderer,scene,camera,pipeline,sun,read}
 })
 for(const [name,distance]of [['earth',1],['jupiter',5.2],['neptune',30]]) {
  const result=await page.evaluate(({name,distance})=>{
   const f=__glareFixture;f.sun.position.set(0,0,-distance);f.pipeline.render(f.scene,f.camera,[])
   const first=f.read();f.pipeline.render(f.scene,f.camera,[]);const second=f.read()
   let lit=0,repeat=0;for(let i=0;i<second.length;i+=4){if(second[i]>8&&second[i+3]>8)lit++;for(let c=0;c<4;c++)repeat+=Math.abs(first[i+c]-second[i+c])}
   const sample=(x,y)=>Array.from(second.slice((y*800+x)*4,(y*800+x)*4+4))
   return {name,distance,litPixels:lit,repeat:repeat/second.length,halo:sample(420,300),strength:f.pipeline.solar.metrics().glareStrength,glError:f.renderer.getContext().getError(),image:f.renderer.domElement.toDataURL()}
  },{name,distance})
  await page.locator('canvas[data-solar-fixture]').screenshot({path:`${output}/${name}.png`});delete result.image
  assert.ok(result.litPixels>300,JSON.stringify(result));assert.ok(result.halo[0]>2,JSON.stringify(result));assert.equal(result.glError,0);assert.ok(result.repeat<.002)
  report.views.push(result)
 }
 report.occlusion=await page.evaluate(()=>{
  const f=__glareFixture,T=f.T;f.sun.position.set(0,0,-1)
  f.pipeline.render(f.scene,f.camera,[])
  const sample=p=>p[(300*800+380)*4],clearHalo=sample(f.read())
  const blocker=new T.Mesh(new T.PlaneGeometry(.000003,.000003),new T.MeshBasicMaterial({color:'black'}));blocker.position.z=-.0001;f.scene.add(blocker)
  f.pipeline.render(f.scene,f.camera,[]);const blocked=f.read()
  f.pipeline.solar.uniforms.solarGlareStrength.value=0;f.pipeline.output.render(f.renderer,f.pipeline.target,f.pipeline.target,0,false);const disabled=f.read()
  const difference=blocked.reduce((sum,v,i)=>sum+Math.abs(v-disabled[i]),0)/blocked.length
  blocker.position.x=.0000015;f.pipeline.render(f.scene,f.camera,[]);const partialHalo=sample(f.read())
  f.scene.remove(blocker);blocker.geometry.dispose();blocker.material.dispose()
  // The Sun behind the camera and large close views must have no glare.
  f.sun.position.set(0,0,1);f.pipeline.render(f.scene,f.camera,[]);const behind=f.pipeline.solar.metrics().glareStrength
  f.sun.position.set(0,0,-.02);f.pipeline.render(f.scene,f.camera,[]);const close=f.pipeline.solar.metrics().glareStrength
  f.pipeline.dispose();f.sun.geometry.dispose();f.sun.material.dispose();f.renderer.domElement.remove();f.renderer.dispose()
  return {difference,clearHalo,partialHalo,behind,close}
 })
 assert.ok(report.occlusion.partialHalo>0&&report.occlusion.partialHalo<report.occlusion.clearHalo)
 assert.equal(report.occlusion.difference,0);assert.equal(report.occlusion.behind,0);assert.equal(report.occlusion.close,0)
 // Inspect the real planetary scene looking toward the Sun above Earth's atmosphere.
 await page.evaluate(async()=>{
  const s=__glareScene
  terrainPilot.location('earth',0,0,1000000);s.focusDistance=null;s.focusDirection=null;s.tick();cancelAnimationFrame(s.frame)
  const body=s.bodies.get('earth'),sun=s.bodies.get('sun'),toward=sun.position.clone().sub(body.position).normalize()
  s.camera.position.copy(body.position).addScaledVector(toward,7371/149597870.7)
  s.camera.up.set(0,1,0);s.camera.lookAt(sun.position);s.camera.near=1e-8;s.camera.updateProjectionMatrix();s.renderFrame()
  // Keep source labels from covering the core in the evidence image.
  document.querySelector('.marker-layer').style.visibility='hidden'
 })
 await page.screenshot({path:`${output}/from-earth.png`})
 report.planetView=await page.evaluate(()=>({glError:__glareScene.renderer.getContext().getError(),solar:terrainPilot.metrics().renderPipeline.solar}))
 assert.equal(report.planetView.glError,0);assert.ok(report.planetView.solar.glareStrength>0)
 assert.deepEqual(report.errors,[]);report.completed=true
}finally{await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));await browser.close()}
console.log(JSON.stringify(report,null,2))
