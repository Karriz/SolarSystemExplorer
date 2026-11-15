import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url=process.env.ATMOSPHERE_PREVIEW_URL||'http://127.0.0.1:5175'
const output='.terrain-cache/giant-atmospheres-browser'
await mkdir(output,{recursive:true})
const report={errors:[],views:[],completed:false}
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try {
  const page=await browser.newPage({viewport:{width:1200,height:850},deviceScaleFactor:1})
  page.on('pageerror',e=>report.errors.push(e.message))
  page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGL|Framebuffer/i.test(m.text()))report.errors.push(m.text())})
  await page.route('**/src/ExplorerScene.ts*',async route=>{
    const response=await route.fetch()
    await route.fulfill({response,body:(await response.text()).replace('pilotMetrics() {','pilotMetrics() { window.__giantScene=this;')})
  })
  await page.goto(`${url}/?terrainPilot=1`,{waitUntil:'domcontentloaded'})
  await page.waitForFunction(()=>window.terrainPilot)
  await page.evaluate(()=>{terrainPilot.metrics();terrainPilot.date('2026-11-15T12:00:00Z');cancelAnimationFrame(__giantScene.frame)})
  // Independent fixed-light fixture uses the production pipeline and materials.
  await page.evaluate(async()=>{
    const T=await import('/node_modules/three/build/three.module.js')
    const {AtmosphereRenderPipeline}=await import('/src/AtmosphereRenderPipeline.ts')
    const {giantPlanetProfiles,AU_KM}=await import('/src/giantPlanetProfiles.ts')
    const renderer=new T.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true})
    renderer.setSize(800,650);renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.7
    const scene=new T.Scene(),camera=new T.PerspectiveCamera(48,800/650,1e-8,200)
    const pipeline=new AtmosphereRenderPipeline(renderer)
    const sun=new T.Mesh(new T.SphereGeometry(695700/AU_KM,96,64),new T.MeshBasicMaterial())
    sun.position.set(8,3,10);pipeline.attachSun(sun)
    const bodies=new Map()
    for(const id of Object.keys(giantPlanetProfiles)) {
      const body=new T.Mesh(new T.SphereGeometry(1),new T.MeshBasicMaterial())
      bodies.set(id,body);scene.add(body);pipeline.attachGiant(id,body)
    }
    const date=new Date('2026-11-15T12:00:00Z')
    const read=()=>{const gl=renderer.getContext(),pixels=new Uint8Array(800*650*4);gl.readPixels(0,0,800,650,gl.RGBA,gl.UNSIGNED_BYTE,pixels);return pixels}
    const render=(id,view='day',offsetDays=0)=>{
      scene.remove(sun)
      for(const [key,body]of bodies)body.visible=key===id
      const r=id==='sun'?695700/AU_KM:giantPlanetProfiles[id].equatorialKm/AU_KM
      sun.visible=true;sun.position.set(8,3,10)
      if(id==='sun'){sun.position.set(0,0,0);scene.add(sun)}
      if(view==='crescent')sun.position.set(10,.6,-8)
      if(view==='night')sun.position.set(1,1,-12)
      if(view==='shadow')sun.position.set(10,1.8,0)
      if(view==='ring-back')sun.position.set(10,-2,7)
      camera.position.set(0,.3,id==='saturn'?6:3.8).multiplyScalar(r)
      if(view==='pole')camera.position.set(.08,3.8,.04).multiplyScalar(r)
      if(view==='close')camera.position.set(0,.10,1.03).multiplyScalar(r)
      if(view==='shadow'||view==='ring-back')camera.position.set(0,3,5).multiplyScalar(r)
      if(view==='edge-on')camera.position.set(0,.001,6).multiplyScalar(r)
      camera.up.set(0,1,0);camera.lookAt(0,0,0);camera.near=r*.001;camera.updateProjectionMatrix()
      pipeline.render(scene,camera,[],new Date(date.getTime()+offsetDays*86400000))
      return read()
    }
    const pixelAt=(pixels,point)=>{
      const ndc=point.clone().project(camera),x=Math.floor((ndc.x*.5+.5)*800),y=Math.floor((ndc.y*.5+.5)*650)
      return Array.from(pixels.slice((y*800+x)*4,(y*800+x)*4+4))
    }
    const delta=(a,b)=>a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0)/a.length
    window.__giantFixture={T,renderer,scene,camera,pipeline,sun,bodies,read,render,pixelAt,delta,AU_KM,profiles:giantPlanetProfiles}
  })
  for(const id of ['jupiter','saturn','uranus','neptune','sun']) {
    for(const view of id==='sun'?['day','close']:id==='saturn'?['day','crescent','pole','shadow','ring-back','edge-on','close']:['day','crescent','night','pole','close']) {
      const result=await page.evaluate(({id,view})=>{
        const f=__giantFixture,first=f.render(id,view),second=f.render(id,view)
        const gl=f.renderer.getContext(),center=Array.from(second.slice((325*800+400)*4,(325*800+400)*4+4))
        return {id,view,center,repeatDifference:f.delta(first,second),glError:gl.getError(),image:f.renderer.domElement.toDataURL('image/png')}
      },{id,view})
      await writeFile(`${output}/${id}-${view}.png`,Buffer.from(result.image.split(',')[1],'base64'));delete result.image
      assert.equal(result.glError,0,`${id}/${view}: GL error`)
      assert.ok(result.repeatDifference<.002,`${id}/${view}: stationary rendering changed: ${result.repeatDifference}`)
      if(view==='day'||view==='close')assert.ok(result.center.slice(0,3).some(v=>v>60),`${id}/${view}: black disc`)
      report.views.push(result)
    }
  }
  report.motion=await page.evaluate(()=>{
    const f=__giantFixture,a=f.render('jupiter'),b=f.render('jupiter','day',3),wrapped=f.render('jupiter','day',2*Math.PI/.035)
    return {movingDifference:f.delta(a,b),periodicDifference:f.delta(a,wrapped)}
  })
  assert.ok(report.motion.movingDifference>.01);assert.ok(report.motion.periodicDifference<.005)
  report.ringShadow=await page.evaluate(()=>{
    const f=__giantFixture,pixels=f.render('saturn','shadow'),r=f.profiles.saturn.equatorialKm/f.AU_KM
    return {shadow:f.pixelAt(pixels,new f.T.Vector3(-1.7*r,0,0)),lit:f.pixelAt(pixels,new f.T.Vector3(1.7*r,0,0))}
  })
  assert.ok(report.ringShadow.lit[0]>report.ringShadow.shadow[0]+30,JSON.stringify(report.ringShadow))
  report.solar=await page.evaluate(()=>{
    const f=__giantFixture,first=f.render('sun'),r=695700/f.AU_KM
    const center=f.pixelAt(first,new f.T.Vector3()),limb=f.pixelAt(first,new f.T.Vector3(.94*r,0,0))
    const occluder=new f.T.Mesh(new f.T.SphereGeometry(r*.12,64,48),new f.T.MeshBasicMaterial({color:'black'}))
    occluder.position.set(.75*r,0,1.4*r);f.scene.add(occluder)
    f.pipeline.render(f.scene,f.camera,[]);const blocked=f.pixelAt(f.read(),occluder.position)
    f.scene.remove(occluder);occluder.geometry.dispose();occluder.material.dispose()
    return {center,limb,blocked}
  })
  assert.ok(report.solar.center[0]>report.solar.limb[0]+5,JSON.stringify(report.solar))
  assert.ok(report.solar.center[0]-report.solar.center[2]<15)
  assert.deepEqual(report.solar.blocked,[0,0,0,255],'corona leaked through foreground occluder')

  // Actual UI selection, zoom and pointer gestures use production camera safety.
  for(const id of ['jupiter','saturn','uranus','neptune','sun']) {
    await page.locator('.body-row').filter({hasText:new RegExp(id,'i')}).click()
    await page.evaluate(id=>{
      const s=__giantScene;s.focusDistance=null;s.focusDirection=null;s.tick();cancelAnimationFrame(s.frame)
      terrainPilot.location(id,id==='uranus'?80:15,70,id==='sun'?1.5e9:1.6e8)
      s.focusDistance=null;s.focusDirection=null;s.tick();cancelAnimationFrame(s.frame);s.setOrbits(false);s.renderFrame()
    },id)
    await page.screenshot({path:`${output}/${id}-app.png`})
  }
  report.camera=await page.evaluate(async()=>{
    const T=await import('/node_modules/three/build/three.module.js'),s=__giantScene
    terrainPilot.location('jupiter',70,30,20000);s.focusDistance=null;s.tick();cancelAnimationFrame(s.frame)
    const mesh=s.bodies.get('jupiter'),local=s.camera.position.clone().sub(mesh.position).applyQuaternion(mesh.quaternion.clone().invert())
    const p=s.renderPipeline.giants.get('jupiter').profile,axes=new T.Vector3(p.equatorialKm,p.polarKm,p.equatorialKm).divideScalar(149597870.7)
    return {ellipsoidRadius:local.clone().divide(axes).length(),near:s.camera.near,altitude:terrainPilot.metrics().altitudeMeters}
  })
  assert.ok(report.camera.ellipsoidRadius>1);assert.ok(report.camera.altitude>=99)
  await page.mouse.move(600,350);await page.mouse.wheel(0,-2000)
  await page.evaluate(()=>{for(let i=0;i<40;i++){__giantScene.tick(performance.now()+i*16.7);cancelAnimationFrame(__giantScene.frame)}})
  await page.mouse.down({button:'right'});await page.mouse.move(700,380,{steps:10});await page.mouse.up({button:'right'})
  report.gesture=await page.evaluate(()=>{const s=__giantScene;s.tick();cancelAnimationFrame(s.frame);return {altitude:terrainPilot.metrics().altitudeMeters,glError:s.renderer.getContext().getError()}})
  assert.ok(report.gesture.altitude>=99);assert.equal(report.gesture.glError,0)
  await page.setViewportSize({width:412,height:915})
  await page.evaluate(()=>{
    const s=__giantScene;terrainPilot.location('saturn',30,80,2e8)
    s.focusDistance=null;s.focusDirection=null;s.tick();cancelAnimationFrame(s.frame);s.resize();s.renderFrame()
  })
  // A resize may not start the transition until the first layout flush.
  await page.waitForFunction(()=>document.querySelector('.sidebar').getBoundingClientRect().right<=1,null,{timeout:10000})
  report.phone=await page.evaluate(()=>{
    const card=document.querySelector('.info-card').getBoundingClientRect()
    return {width:innerWidth,cardLeft:card.left,cardRight:card.right,sidebarRight:document.querySelector('.sidebar').getBoundingClientRect().right}
  })
  assert.ok(report.phone.cardLeft>=0&&report.phone.cardRight<=report.phone.width)
  assert.ok(report.phone.sidebarRight<=1)
  await page.screenshot({path:`${output}/phone.png`})
  report.allocations=await page.evaluate(()=>{
    const f=__giantFixture,gl=f.renderer.getContext(),info=gl.getExtension('WEBGL_debug_renderer_info')
    return {pipeline:f.pipeline.metrics(),renderer:info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)}
  })
  report.disposal=await page.evaluate(()=>{
    const f=__giantFixture;let proxyReleases=0,photosphereReleases=0
    f.pipeline.giants.forEach(g=>{g.proxy.geometry.addEventListener('dispose',()=>proxyReleases++);g.proxy.material.addEventListener('dispose',()=>proxyReleases++)})
    f.sun.material.addEventListener('dispose',()=>photosphereReleases++)
    f.pipeline.dispose();f.pipeline.dispose()
    const detached=[...f.pipeline.giants.values()].every(g=>!g.proxy.parent&&g.metrics().disposed)
    for(const body of [...f.bodies.values(),f.sun]){body.geometry.dispose();body.material.dispose()}
    f.renderer.dispose();__giantScene.dispose()
    return {proxyReleases,photosphereReleases,detached}
  })
  assert.deepEqual(report.disposal,{proxyReleases:8,photosphereReleases:1,detached:true})
  assert.deepEqual(report.errors,[])
  report.completed=true
} finally {
  await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));await browser.close()
}
console.log(JSON.stringify(report,null,2))
