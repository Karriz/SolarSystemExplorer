import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const url=process.env.VECTOR_PREVIEW_URL||'http://127.0.0.1:5175'
const output='.terrain-cache/global-surfaces-browser';await mkdir(output,{recursive:true})
const report={errors:[],cases:[],completed:false}
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
 const page=await browser.newPage({viewport:{width:900,height:700}})
 page.on('pageerror',e=>report.errors.push(e.message))
 page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGLProgram/.test(m.text()))report.errors.push(m.text())})
 const requests=[];page.on('request',r=>requests.push(r.url()))
 await page.route('**/src/ExplorerScene.ts*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('pilotMetrics() {','pilotMetrics() { window.__surface=this;')})})
 await page.goto(`${url}/?terrainPilot=1`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.terrainPilot)
 report.defaults=await page.evaluate(()=>{terrainPilot.metrics();terrainPilot.date('2026-10-26T12:00:00Z');const s=__surface;s.setTerrainShadows(false);s.setSurfaceDetail(false);s.__render=s.renderer.render;s.renderer.render=()=>{};return [...s.planetSurfaces.values()].map(p=>({id:p.id,detail:p.state.detail.value,hillshade:p.hillshade.enabled.value}))})
 assert.deepEqual([...report.defaults].sort((a,b)=>a.id.localeCompare(b.id)),['mars','mercury','moon','venus'].map(id=>({id,detail:0,hillshade:1})))
 const settle=async body=>{
  let previous='',stable=0
  for(let i=0;i<600;i++){
   const state=await page.evaluate(body=>{const s=__surface,l=s.terrain.get(body),h=s.planetSurfaces.get(body).hillshade;return {terrain:l.metrics(),shade:h.metrics(),signature:l.surfaceSignature()+h.selectionSignature(),pending:[...l.wanted].filter(k=>!l.nodes.get(k)?.mesh).length}},body)
   stable=state.terrain.ready&&!state.terrain.requests&&!state.pending&&state.shade.ready&&!state.shade.requests&&!state.shade.missingWanted&&state.signature===previous?stable+1:0
   previous=state.signature
   if(stable>=4)return state
   if(i%120===0)console.log('Settling',body,JSON.stringify(state.shade))
   await page.waitForTimeout(200)
  }
  throw Error('Surface did not settle')
 }
 const cases=[['venus-maxwell','venus',65,3,300000],['venus-maat','venus',.5,-165.4,300000],['venus-north','venus',89,0,100000],['venus-south','venus',-89,45,100000],['venus-date','venus',10,179.9,100000],['venus-grazing','venus',65,3,12000],['moon-hadley','moon',26.13,3.63,100000],['moon-tycho','moon',-43.31,-11.36,300000],['moon-far','moon',-20,140,1000000],['moon-north','moon',89,0,100000],['moon-south','moon',-89,45,100000],['moon-date','moon',10,179.9,100000],['mars-valles','mars',-12,-70,1000000],['mars-syrtis','mars',10,70,1000000],['mars-north','mars',89,0,100000],['mars-south','mars',-89,45,100000],['mars-date','mars',10,179.9,100000],['mars-corner','mars',35.26438968,45,100000],['mercury-caloris','mercury',30.5,160,300000],['mercury-north','mercury',89,0,100000],['mercury-south','mercury',-89,45,100000],['mercury-date','mercury',10,179.9,100000],['moon-grazing','moon',26.13,3.63,12000],['mars-grazing','mars',-12,-70,12000]]
 const filter=process.env.GLOBAL_SURFACE_CASES?.split(',')
 for(const [name,body,lat,lon,altitude]of cases.filter(c=>!filter||filter.includes(c[0]))){
  await page.evaluate(({body,lat,lon,altitude})=>terrainPilot.location(body,lat,lon,altitude),{body,lat,lon,altitude})
  if(name.includes('grazing'))await page.evaluate(({body,lat,lon})=>{
   const s=__surface,b=s.bodies.get(body),phi=(lat+(body==='moon'?3:1.7))*Math.PI/180,lambda=lon*Math.PI/180
   const target=s.camera.position.clone().set(Math.cos(phi)*Math.cos(lambda),Math.sin(phi),-Math.cos(phi)*Math.sin(lambda)).multiplyScalar(b.geometry.parameters.radius)
   b.localToWorld(target);s.camera.lookAt(target);s.camera.updateMatrixWorld();s.pilotAltitude=null
  },{body,lat,lon})
  const state=await settle(body);await page.waitForTimeout(500)
  const result=await page.evaluate(({body,grazing})=>{
   const s=__surface,l=s.terrain.get(body),h=s.planetSurfaces.get(body).hillshade,b=s.bodies.get(body)
   s.pilotAltitude=null
   const before=l.surfaceSignature(),selection=h.selectionSignature(),radial=s.camera.position.clone().sub(b.position).normalize()
   const north=radial.clone().set(0,1,0).applyQuaternion(b.getWorldQuaternion(s.camera.quaternion.clone()))
   north.addScaledVector(radial,-north.dot(radial)).normalize()
   const angle=(grazing?15:90)*Math.PI/180
   s.sunLight.position.copy(b.position).addScaledVector(radial,Math.sin(angle)).addScaledVector(north,Math.cos(angle));s.sunLight.intensity=3
   const gl=s.renderer.getContext()
   // Mercury's coarse measured DEM can already match the mesh-derived field;
   // compare against unshaded color rather than require two valid samplings to differ.
   const render=global=>{if((body==='mercury'||body==='venus')){s.terrainHillshade.value=global?1:0;h.enabled.value=1}else h.enabled.value=global?1:0;s.__render.call(s.renderer,s.scene,s.camera);const p=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4);gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,p);return p}
   const mesh=render(false),meshImage=s.renderer.domElement.toDataURL(),global=render(true),globalImage=s.renderer.domElement.toDataURL(),again=render(false)
   let changed=0,total=0,repeat=0
   for(let i=0;i<mesh.length;i+=4){let d=0;for(let c=0;c<3;c++){d=Math.max(d,Math.abs(mesh[i+c]-global[i+c]));repeat+=Math.abs(mesh[i+c]-again[i+c])}if(d>=2)changed++;total+=d}
   h.enabled.value=1;s.terrainHillshade.value=1
   return {meshImage,globalImage,changed,mean:total/(mesh.length/4),repeat,sameGeometry:before===l.surfaceSignature(),selection}
  },{body,grazing:name.includes('grazing')})
  for(const [key,label]of [['meshImage',(body==='mercury'||body==='venus')?'unshaded':'mesh'],['globalImage','global']]){await writeFile(`${output}/${name}-${label}.png`,Buffer.from(result[key].split(',')[1],'base64'));delete result[key]}
  // Mercury's filtered polar DEM often changes pixels by just one display code.
  // Measure aggregate contrast there; the two-code pixel count hides that signal.
  if(body==='venus'&&(name==='venus-north'||name==='venus-south'))assert.equal(result.mean,0,'Unmeasured polar gaps must remain neutral');else assert.ok((body==='mercury'||body==='venus')?result.mean>.005:result.changed>1000,`${name} (${result.changed} pixels, mean ${result.mean}): global shading must affect visible pixels`);assert.equal(result.repeat,0);assert.ok(result.sameGeometry)
  assert.equal(state.shade.coarseOnly,false,'Full release must load for the detailed comparison');assert.ok(state.shade.gpuPageBytes<10*1048576);assert.ok(state.shade.cached<=128);assert.equal(state.shade.failed,0)
  const stationary=[]
  for(let i=0;i<5;i++){stationary.push(await page.evaluate(body=>__surface.planetSurfaces.get(body).hillshade.selectionSignature(),body));await page.waitForTimeout(100)}
  assert.equal(new Set(stationary).size,1,'Stationary shading selection changed')
  report.cases.push({name,...result,metrics:state.shade});console.log(name,JSON.stringify({changed:result.changed,cache:state.shade.cached,wanted:state.shade.wanted}))
 }
 // A genuine camera pan must keep selection bounded and use the same page pool.
 await page.evaluate(()=>terrainPilot.location('mars',-12,-70,300000));await settle('mars')
 const identity=await page.evaluate(()=>__surface.planetSurfaces.get('mars').hillshade.pages.value.id)
 for(const lon of [-69,-68,-67]){await page.evaluate(lon=>terrainPilot.location('mars',-12,lon,300000),lon);await settle('mars');assert.equal(await page.evaluate(()=>__surface.planetSurfaces.get('mars').hillshade.pages.value.id),identity)}
 // Fine pages must be released when the active body changes.
 await page.evaluate(()=>terrainPilot.location('moon',26.13,3.63,100000));await settle('moon')
 assert.equal(await page.evaluate(()=>__surface.planetSurfaces.get('mars').hillshade.metrics().gpuPageBytes),0)
 // Isolate the sampled field to check fixed ground values while the camera moves.
 const samples=[]
 for(const lon of [3.63,3.65,3.61]){
  await page.evaluate(lon=>terrainPilot.location('moon',26.13,lon,12000),lon);await settle('moon');await page.waitForTimeout(400)
  samples.push(await page.evaluate(()=>{
   const s=__surface,l=s.terrain.get('moon'),body=s.bodies.get('moon')
   const materials=[body.material,...[...l.nodes.values()].filter(n=>n.mesh?.visible).map(n=>n.mesh.material)]
   const restore=[]
   for(const m of materials){
    const previous=m.onBeforeCompile,key=m.customProgramCacheKey;restore.push(()=>{m.onBeforeCompile=previous;m.customProgramCacheKey=key;m.needsUpdate=true})
    m.onBeforeCompile=(shader,r)=>{previous.call(m,shader,r);shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>','gl_FragColor=vec4(vec3((hsFactor-0.55)/0.75),1.0);').replace('#include <tonemapping_fragment>','').replace('#include <colorspace_fragment>','')}
    const old=key.call(m);m.customProgramCacheKey=()=>old+'/field-motion-check';m.needsUpdate=true
   }
   const point=s.camera.position.clone(),normal=point.clone()
   if(!l.sampleSurface(26.13,3.63,point,normal))throw Error('Missing fixed ground point')
   point.multiplyScalar(body.geometry.parameters.radius);body.localToWorld(point);point.project(s.camera)
   s.__render.call(s.renderer,s.scene,s.camera)
   const gl=s.renderer.getContext(),p=new Uint8Array(4)
   gl.readPixels(Math.floor((point.x*.5+.5)*gl.drawingBufferWidth),Math.floor((point.y*.5+.5)*gl.drawingBufferHeight),1,1,gl.RGBA,gl.UNSIGNED_BYTE,p)
   restore.forEach(f=>f());return p[0]
  }))
 }
 assert.ok(Math.max(...samples)-Math.min(...samples)<=3,`Ground shading changed with camera: ${samples}`);report.motionSamples=samples
 await page.setViewportSize({width:412,height:915})
 await page.evaluate(()=>{__surface.renderer.render=__surface.__render})
 assert.equal(await page.locator('.info-card').getByRole('combobox').count(),0)
 assert.equal(await page.getByRole('button',{name:/^(Hillshade|Terrain|Surface detail|Shadows) /}).count(),0)
 assert.ok(!requests.some(u=>/\/textures\/(moon|mars)\.jpg|vectors|color-reference/.test(u)),'Only default surface assets should load')
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
 await page.screenshot({path:`${output}/phone.png`})
 await page.close()
 for(const kind of ['offline','bad-page']){
  const p=await browser.newPage({viewport:{width:600,height:500}})
  p.on('pageerror',e=>report.errors.push(e.message))
  p.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGLProgram/.test(m.text()))report.errors.push(m.text())})
  await p.route('**/src/ExplorerScene.ts*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text()).replace('pilotMetrics() {','pilotMetrics() { window.__surface=this;')})})
  if(kind==='offline')await p.route('**/hillshade/catalog.json',r=>r.abort())
  else await p.route(/\/hillshade\/.*\/\d\/\d+\/\d+\.bin\.gz$/,r=>r.fulfill({body:Buffer.from('corrupt'),contentType:'application/octet-stream'}))
  await p.goto(`${url}/?terrainPilot=1`,{waitUntil:'domcontentloaded'});await p.waitForFunction(()=>window.terrainPilot)
  await p.evaluate(()=>{terrainPilot.metrics();const s=__surface;s.__render=s.renderer.render;s.renderer.render=()=>{};terrainPilot.location('moon',26.13,3.63,100000)})
  await p.waitForFunction(kind=>{const h=__surface.planetSurfaces.get('moon').hillshade.metrics();return h.ready&&(kind==='offline'?h.coarseOnly:h.failed>0)},kind,{timeout:60000})
  const state=await p.evaluate(()=>{const s=__surface;s.__render.call(s.renderer,s.scene,s.camera);return s.planetSurfaces.get('moon').hillshade.metrics()})
  assert.ok(state.ready);assert.equal(state.cached,0)
  if(kind==='offline'){
   assert.equal(state.gpuPageBytes,0);await p.unroute('**/hillshade/catalog.json');await p.evaluate(()=>{__surface.planetSurfaces.get('moon').hillshade.nextMetadata=0})
   await p.waitForFunction(()=>{const m=__surface.planetSurfaces.get('moon').hillshade.metrics();return m.ready&&!m.coarseOnly&&m.cached>0},null,{timeout:60000})
  }
  report[kind]=state;await p.close()
 }
 assert.deepEqual(report.errors,[]);report.completed=true
}finally{await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));await browser.close()}
