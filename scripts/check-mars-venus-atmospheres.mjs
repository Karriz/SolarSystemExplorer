import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Vector3 } from 'three'
import { chromium } from 'playwright'
import { atmosphereProfiles } from '../src/atmosphereProfiles.ts'
import { buildAtmosphereTables, integrateAtmosphere, sampleTable, multiUv, transmissionUv } from '../src/atmosphereOptics.ts'

const url=process.env.ATMOSPHERE_PREVIEW_URL||'http://127.0.0.1:5175'
const output='.terrain-cache/mars-venus-atmospheres-browser'
await mkdir(output,{recursive:true})
const report={errors:[],profiles:{},probes:[],views:[],completed:false}
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
  const page=await browser.newPage({viewport:{width:1000,height:750}})
  page.on('pageerror',e=>report.errors.push(e.message))
  page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGL|Framebuffer/i.test(m.text()))report.errors.push(m.text())})
  await page.route('**/src/ExplorerScene.ts*',async route=>{
    const response=await route.fetch()
    await route.fulfill({response,body:(await response.text()).replace('pilotMetrics() {','pilotMetrics() { window.__atmospherePlanets=this;')})
  })
  await page.goto(`${url}/?terrainPilot=1`,{waitUntil:'domcontentloaded'})
  await page.waitForFunction(()=>window.terrainPilot)
  await page.evaluate(()=>{terrainPilot.metrics();terrainPilot.date('2026-10-26T12:00:00Z')})
  for(const body of ['mars','venus']){
    await page.evaluate(body=>terrainPilot.location(body,20,0,20000000),body)
    if(body==='venus'){
      await page.waitForFunction(()=>terrainPilot.metrics().renderPipeline.atmospheres.venus.cloudPlaceholder)
      report.loading=await page.evaluate(()=>terrainPilot.metrics().renderPipeline.atmospheres.venus)
      await page.screenshot({path:`${output}/venus-loading-clouds.png`})
    }
    await page.waitForFunction(body=>terrainPilot.metrics().renderPipeline.atmospheres[body].strength===1,body,{timeout:60000})
    report.profiles[body]=await page.evaluate(body=>terrainPilot.metrics().renderPipeline.atmospheres[body],body)
    if(body==='venus')assert.equal(report.profiles.venus.validation.accepted,true)
    const profile=atmosphereProfiles[body],t=buildAtmosphereTables(profile)
    const lookup=(r,mu)=>sampleTable(t.transmittance,t.transWidth,t.transHeight,...transmissionUv(profile,r,mu))
    const multiple=(r,mu)=>sampleTable(t.multiple,t.multiWidth,t.multiHeight,...multiUv(profile,r,mu))
    const cases=body==='mars'?[[.1,[0,1,0],45,1e20],[.1,[1,.005,0],0,1e20],[10,[0,-1,0],45,8]]
      :[[150,[0,-1,0],45,150],[60,[0,1,0],45,1e20],[1,[1,.02,0],45,5]]
    const probes=cases.map(([h,dir,angle,distance])=>{
      const origin=new Vector3(0,profile.radiusKm+h,0),direction=new Vector3(...dir).normalize(),sun=new Vector3(Math.cos(angle*Math.PI/180),Math.sin(angle*Math.PI/180),0)
      return {body,origin:origin.toArray(),direction:direction.toArray(),sun:sun.toArray(),distance,
        reference:integrateAtmosphere(profile,origin,direction,sun,distance,512,lookup,multiple)}
    })
    const results=await page.evaluate(async({body,probes})=>{
      const THREE=await import('/node_modules/three/build/three.module.js')
      const {atmosphereViewShader}=await import('/src/atmosphereShader.ts')
      const {atmosphereProfiles}=await import('/src/atmosphereProfiles.ts')
      const scene=__atmospherePlanets,renderer=scene.renderer,air=scene.renderPipeline.atmospheres[body]
      const material=new THREE.ShaderMaterial({
        uniforms:{...air.lighting,atmSunDirection:{value:new THREE.Vector3()},atmSolar:{value:new THREE.Vector3(1,1,1)},atmCloudVariation:{value:0},
          origin:{value:new THREE.Vector3()},direction:{value:new THREE.Vector3()},endpoint:{value:0},mode:{value:0}},
        vertexShader:'void main(){gl_Position=vec4(position.xy,0.0,1.0);}',
        fragmentShader:`${atmosphereViewShader(atmosphereProfiles[body])}
          uniform vec3 origin;uniform vec3 direction;uniform float endpoint;uniform int mode;
          void main(){vec3 T,L;atmIntegrate(origin,direction,endpoint,T,L);gl_FragColor=vec4(mode==0?L:T,1.0);}`,
      })
      const geometry=new THREE.PlaneGeometry(2,2),fixture=new THREE.Scene();fixture.add(new THREE.Mesh(geometry,material))
      const target=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false}),results=[]
      try{
        for(const probe of probes){
          material.uniforms.origin.value.fromArray(probe.origin);material.uniforms.direction.value.fromArray(probe.direction)
          material.uniforms.atmSunDirection.value.fromArray(probe.sun);material.uniforms.endpoint.value=probe.distance
          const values=[]
          for(let mode=0;mode<2;mode++){
            material.uniforms.mode.value=mode;renderer.setRenderTarget(target);renderer.render(fixture,scene.camera)
            const pixels=new Float32Array(4);renderer.readRenderTargetPixels(target,0,0,1,1,pixels);values.push(Array.from(pixels.slice(0,3)))
          }
          results.push({...probe,radiance:values[0],transmission:values[1]})
        }
      }finally{renderer.setRenderTarget(null);target.dispose();geometry.dispose();material.dispose()}
      return results
    },{body,probes})
    for(const probe of results){
      probe.radiance.forEach((v,c)=>assert.ok(Number.isFinite(v)&&Math.abs(v-probe.reference.radiance[c])<.0007+probe.reference.radiance[c]*.09,JSON.stringify(probe)))
      probe.transmission.forEach((v,c)=>assert.ok(Number.isFinite(v)&&Math.abs(v-probe.reference.transmission[c])<.012,JSON.stringify(probe)))
    }
    if(body==='venus')assert.ok(results[0].transmission.every(v=>v<.0002))
    report.probes.push(...results)
  }
  const cases=[
    ['mars','orbit',60,10000000,0],['mars','day-sky',45,500,115],['mars','blue-sunset',0,500,90],
    ['mars','terrain-haze',25,12000,65],['venus','orbit',60,20000000,0],
    ['venus','above-clouds',45,80000,80],['venus','inside-clouds',45,60000,100],
    ['venus','below-clouds',45,40000,100],['venus','surface',45,1000,65],
  ]
  for(const [body,name,elevation,altitude,pitch] of cases){
    await page.evaluate(async({body,elevation,altitude})=>{
      const THREE=await import('/node_modules/three/build/three.module.js'),scene=__atmospherePlanets,mesh=scene.bodies.get(body)
      const sun=scene.bodies.get('sun').position.clone().sub(mesh.position).normalize().applyQuaternion(mesh.quaternion.clone().invert())
      const east=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),sun).normalize(),angle=elevation*Math.PI/180
      const up=sun.multiplyScalar(Math.sin(angle)).addScaledVector(east,Math.cos(angle))
      cancelAnimationFrame(scene.frame)
      terrainPilot.location(body,Math.asin(up.y)*180/Math.PI,Math.atan2(-up.z,up.x)*180/Math.PI,altitude)
      scene.frame=requestAnimationFrame(scene.tick)
    },{body,elevation,altitude})
    await page.waitForTimeout(1000)
    if(body==='mars'||altitude<100000){
      await page.waitForFunction(body=>terrainPilot.metrics().global[body].visible>0,body,{timeout:60000})
    }
    const view=await page.evaluate(async({body,name,pitch})=>{
      const THREE=await import('/node_modules/three/build/three.module.js'),s=__atmospherePlanets,camera=s.camera,mesh=s.bodies.get(body)
      cancelAnimationFrame(s.frame)
      const up=camera.position.clone().sub(mesh.position).normalize(),sun=s.bodies.get('sun').position.clone().sub(mesh.position).normalize()
      const tangent=sun.clone().addScaledVector(up,-sun.dot(up)).normalize();if(name==='day-sky')tangent.negate()
      const angle=pitch*Math.PI/180,direction=up.clone().multiplyScalar(-Math.cos(angle)).addScaledVector(tangent,Math.sin(angle))
      if(pitch){camera.up.copy(up);camera.lookAt(camera.position.clone().add(direction))}
      s.renderFrame()
      const a=terrainPilot.sample(),b=terrainPilot.sample(),gl=s.renderer.getContext()
      return {air:s.renderPipeline.atmospheres[body].metrics(),terrain:terrainPilot.metrics().global[body],
        repeatDifference:a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0),glError:gl.getError()}
    },{body,name,pitch})
    assert.equal(view.air.active,true);assert.equal(view.glError,0);assert.equal(view.repeatDifference,0)
    report.views.push({body,name,elevation,altitude,pitch,...view})
    await page.screenshot({path:`${output}/${body}-${name}.png`})
  }
  // A deliberate surface reveal restores the measured surface and hillshade;
  // returning to visible-light mode reuses tables and hides terrain from orbit.
  await page.evaluate(()=>{terrainPilot.location('venus',20,0,20000000);__atmospherePlanets.frame=requestAnimationFrame(__atmospherePlanets.tick)})
  await page.waitForTimeout(500)
  await page.getByRole('button',{name:'Reveal surface',exact:true}).click()
  await page.waitForFunction(()=>terrainPilot.metrics().global.venus.visible>0&&!terrainPilot.metrics().renderPipeline.atmospheres.venus.active,null,{timeout:60000})
  report.reveal=await page.evaluate(()=>({air:terrainPilot.metrics().renderPipeline.atmospheres.venus,hillshade:__atmospherePlanets.venusHillshade.value}))
  assert.equal(report.reveal.hillshade,1);assert.equal(report.reveal.air.cloudPlaceholder,false)
  await page.getByText('Scientific surface view · atmosphere and clouds hidden',{exact:true}).waitFor()
  await page.screenshot({path:`${output}/venus-reveal-surface.png`})
  await page.getByRole('button',{name:'Show atmosphere and clouds',exact:true}).click()
  await page.waitForFunction(()=>terrainPilot.metrics().renderPipeline.atmospheres.venus.active)
  await page.screenshot({path:`${output}/venus-restored-clouds.png`})
  report.motion=await page.evaluate(()=>{
    const s=__atmospherePlanets,p=s.renderPipeline,a=p.atmospheres.venus,renderer=s.renderer
    cancelAnimationFrame(s.frame);s.renderFrame()
    const gl=renderer.getContext(),width=gl.drawingBufferWidth,height=gl.drawingBufferHeight
    const read=()=>{const data=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,data);return data}
    const first=read(),phase=a.lighting.atmCloudPhase.value
    a.lighting.atmCloudPhase.value=phase+.7;p.output.render(renderer,p.target,p.target,0,false);const second=read()
    a.lighting.atmCloudPhase.value=phase+2*Math.PI;p.output.render(renderer,p.target,p.target,0,false);const wrapped=read()
    let changed=0,seam=0
    for(let i=0;i<first.length;i++)if(i%4!==3){changed+=Math.abs(first[i]-second[i]);seam+=Math.abs(first[i]-wrapped[i])}
    a.lighting.atmCloudPhase.value=phase;s.renderFrame()
    return {cloudMotionMean:changed/(width*height*3),wrappedMean:seam/(width*height*3),hillshade:s.venusHillshade.value}
  })
  assert.ok(report.motion.cloudMotionMean>0);assert.ok(report.motion.wrappedMean<.01);assert.equal(report.motion.hillshade,0)
  await page.setViewportSize({width:412,height:915});await page.evaluate(()=>__atmospherePlanets.renderFrame())
  await page.screenshot({path:`${output}/phone.png`})
  report.disposal=await page.evaluate(()=>{
    const scene=__atmospherePlanets,air=scene.renderPipeline.atmospheres.venus,proxy=air.cloudPlaceholder.mesh
    let proxyReleases=0,tableReleases=0
    for(const resource of [proxy.geometry,proxy.material])resource.addEventListener('dispose',()=>proxyReleases++)
    for(const uniform of [air.lighting.atmTransmittance,air.lighting.atmMultiple,air.lighting.atmIrradiance])uniform.value.addEventListener('dispose',()=>tableReleases++)
    scene.dispose()
    return {proxyReleases,tableReleases,detached:proxy.parent===null,state:air.metrics().state}
  })
  assert.deepEqual(report.disposal,{proxyReleases:2,tableReleases:3,detached:true,state:'disposed'})
  assert.deepEqual(report.errors,[])
  report.completed=true
}finally{
  await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));await browser.close()
}
console.log('Mars/Venus GPU reference, clouds/descent, measured terrain, surface reveal, motion/seams and phone checks passed.')
