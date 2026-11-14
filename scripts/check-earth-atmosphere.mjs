import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { Vector3 } from 'three'
import { earthAtmosphere as profile } from '../src/atmosphereProfiles.ts'
import { integrateAtmosphere } from '../src/atmosphereOptics.ts'

const url = process.env.ATMOSPHERE_PREVIEW_URL || 'http://127.0.0.1:5175'
const output = '.terrain-cache/earth-atmosphere-browser'
await mkdir(output, { recursive: true })
const report = { errors: [], probes: [], views: [], completed: false }
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } })
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && /THREE|shader|WebGL|Framebuffer/i.test(message.text())) report.errors.push(message.text())
  })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__earthAtmosphereScene=this;') })
  })
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => { terrainPilot.metrics(); terrainPilot.date('2026-10-26T12:00:00Z'); terrainPilot.location('earth', 20, 0, 20000000) })
  await page.waitForFunction(() => terrainPilot.metrics().renderPipeline.atmosphere.strength === 1, null, { timeout: 60000 })

  const probes = [
    { h: .1, direction: [0, 1, 0], sunAngle: 45, distance: 1e20 },
    { h: .1, direction: [1, .01, 0], sunAngle: 5, distance: 1e20 },
    { h: .1, direction: [0, 1, 0], sunAngle: -4, distance: 1e20 },
    { h: 1000, direction: [0, -1, 0], sunAngle: 10, distance: 998 },
    { h: 10, direction: [0, -1, 0], sunAngle: 45, distance: 8 },
  ].map(p => {
    const angle = p.sunAngle * Math.PI / 180, origin = new Vector3(0, profile.radiusKm + p.h, 0)
    const direction = new Vector3(...p.direction).normalize(), sun = new Vector3(Math.cos(angle), Math.sin(angle), 0)
    return { ...p, origin: origin.toArray(), direction: direction.toArray(), sun: sun.toArray(),
      reference: integrateAtmosphere(profile, origin, direction, sun, p.distance, 384) }
  })
  report.probes = await page.evaluate(async probes => {
    const THREE = await import('/node_modules/three/build/three.module.js')
    const { atmosphereViewShader } = await import('/src/atmosphereShader.ts')
    const { earthAtmosphere } = await import('/src/atmosphereProfiles.ts')
    const owner = __earthAtmosphereScene, renderer = owner.renderer
    const material = new THREE.ShaderMaterial({
      uniforms: { ...owner.renderPipeline.atmosphere.lighting,
        atmSunDirection: { value: new THREE.Vector3() }, atmSolar: { value: new THREE.Vector3(1, 1, 1) }, atmMultipleStrength: { value: 0 },
        testOrigin: { value: new THREE.Vector3() }, testDirection: { value: new THREE.Vector3() }, testDistance: { value: 0 }, testOutput: { value: 0 },
      },
      vertexShader: 'void main() { gl_Position=vec4(position.xy,0.0,1.0); }',
      fragmentShader: `${atmosphereViewShader(earthAtmosphere)}
        uniform vec3 testOrigin; uniform vec3 testDirection; uniform float testDistance; uniform int testOutput;
        void main() { vec3 transmission,radiance; atmIntegrate(testOrigin,testDirection,testDistance,transmission,radiance);
          gl_FragColor=vec4(testOutput==0?radiance:transmission,1.0); }`,
    })
    const scene = new THREE.Scene(), geometry = new THREE.PlaneGeometry(2, 2)
    scene.add(new THREE.Mesh(geometry, material))
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false, colorSpace: THREE.LinearSRGBColorSpace })
    const previous = renderer.getRenderTarget(), results = []
    try {
      for (const probe of probes) {
        material.uniforms.testOrigin.value.fromArray(probe.origin); material.uniforms.testDirection.value.fromArray(probe.direction)
        material.uniforms.atmSunDirection.value.fromArray(probe.sun); material.uniforms.testDistance.value = probe.distance
        const samples = []
        for (let mode = 0; mode < 2; mode++) {
          material.uniforms.testOutput.value = mode
          renderer.setRenderTarget(target); renderer.render(scene, owner.camera)
          const pixels = new Float32Array(4); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixels)
          samples.push(Array.from(pixels.slice(0, 3)))
        }
        results.push({ ...probe, radiance: samples[0], transmission: samples[1] })
      }
    } finally { renderer.setRenderTarget(previous); target.dispose(); geometry.dispose(); material.dispose() }
    return results
  }, probes)
  for (const probe of report.probes) {
    probe.radiance.forEach((v, c) => assert.ok(Number.isFinite(v) && Math.abs(v - probe.reference.radiance[c]) < .00025 + probe.reference.radiance[c] * .07, JSON.stringify(probe)))
    probe.transmission.forEach((v, c) => assert.ok(Number.isFinite(v) && Math.abs(v - probe.reference.transmission[c]) < .012, JSON.stringify(probe)))
  }

  report.depth = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js')
    const owner = __earthAtmosphereScene, renderer = owner.renderer, earth = owner.bodies.get('earth'), air = owner.renderPipeline.atmosphere
    const km = 149597870.7, radius = 6371
    const camera = new THREE.PerspectiveCamera(48, 1, .01/km, 100/km)
    const up = new THREE.Vector3(0,1,0).applyQuaternion(earth.quaternion)
    camera.position.copy(earth.position).addScaledVector(up,(radius+10)/km)
    camera.up.set(0,0,-1).applyQuaternion(earth.quaternion); camera.lookAt(earth.position); camera.updateMatrixWorld()
    const target = new THREE.WebGLRenderTarget(64,64,{type:THREE.HalfFloatType,depthTexture:new THREE.DepthTexture(64,64,THREE.UnsignedIntType)})
    air.update(camera,target.depthTexture,{body:earth,sun:owner.bodies.get('sun').position,solarColor:owner.sunLight.color})
    const readTarget = new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false})
    const readMaterial = new THREE.ShaderMaterial({
      uniforms:{depthMap:{value:target.depthTexture},inverseProjection:{value:camera.projectionMatrixInverse}},
      vertexShader:'void main(){gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader:`uniform sampler2D depthMap;uniform mat4 inverseProjection;
        void main(){vec4 p=inverseProjection*vec4(vec2(0.0),texture2D(depthMap,vec2(.5)).r*2.0-1.0,1.0);
          gl_FragColor=vec4(-p.z/p.w*149597870.7,0.0,0.0,1.0);}`,
    })
    const readGeometry = new THREE.PlaneGeometry(2,2), readScene = new THREE.Scene()
    readScene.add(new THREE.Mesh(readGeometry,readMaterial))
    const sample = scene => {
      renderer.setRenderTarget(target);renderer.render(scene,camera)
      renderer.setRenderTarget(readTarget);renderer.render(readScene,camera)
      const pixels=new Float32Array(4);renderer.readRenderTargetPixels(readTarget,0,0,1,1,pixels)
      return pixels[0]
    }
    const scene = new THREE.Scene(), sphere = new THREE.Mesh(owner.earthSurface.overviewGeometry,earth.material)
    sphere.position.copy(earth.position);sphere.quaternion.copy(earth.quaternion);scene.add(sphere)
    const sphereDistance=sample(scene);scene.remove(sphere)
    const terrain=[]
    for(const height of [5,-2]){
      const origin=new THREE.Vector3(0,1+height/radius,0)
      const geometry=new THREE.PlaneGeometry(.01,.01).rotateX(-Math.PI/2)
      const material=new THREE.MeshStandardMaterial()
      owner.earthSurface.configurePatch(material,origin,{value:new THREE.Vector3(0,1+10/radius,0)},owner.earthSurface.binding())
      const group=new THREE.Group();group.position.copy(earth.position);group.quaternion.copy(earth.quaternion);group.scale.setScalar(radius/km)
      const patch=new THREE.Mesh(geometry,material);patch.position.copy(origin);group.add(patch);scene.add(group)
      terrain.push({height,distance:sample(scene),expected:10-height})
      scene.remove(group);geometry.dispose();material.dispose()
    }
    renderer.setRenderTarget(null);target.dispose();readTarget.dispose();readGeometry.dispose();readMaterial.dispose()
    return {sphereDistance,terrain}
  })
  assert.ok(Math.abs(report.depth.sphereDistance-10)<.01, 'fallback depth is faceted rather than spherical')
  for(const terrain of report.depth.terrain) assert.ok(Math.abs(terrain.distance-terrain.expected)<.01, 'measured terrain depth was replaced by a sphere')

  // Actual Sun/date/orientation remain authoritative. Select points at known
  // solar elevations, then freeze the camera only for deterministic captures.
  const cases = [
    ['orbit-day', 60, 20000000, 0], ['orbit-terminator', 0, 20000000, 0],
    ['high-air', 20, 80000, 90], ['ground-sky', 45, 300, 120],
    ['ground-horizon', 20, 300, 90], ['sunset', 0, 300, 92],
    ['twilight', -6, 300, 100], ['night', -30, 300, 115],
    ['reference-haze', 35, 12000, 70],
  ]
  for (const [name, elevation, altitude, pitch] of cases) {
    await page.evaluate(async ({ elevation, altitude }) => {
      const THREE = await import('/node_modules/three/build/three.module.js')
      const scene = __earthAtmosphereScene, earth = scene.bodies.get('earth')
      const localSun = scene.bodies.get('sun').position.clone().sub(earth.position).normalize().applyQuaternion(earth.quaternion.clone().invert())
      const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), localSun).normalize()
      const angle = elevation * Math.PI / 180, up = localSun.multiplyScalar(Math.sin(angle)).addScaledVector(east, Math.cos(angle))
      const lat = Math.asin(up.y) * 180 / Math.PI, lon = Math.atan2(-up.z, up.x) * 180 / Math.PI
      cancelAnimationFrame(scene.frame)
      terrainPilot.location('earth', lat, lon, altitude)
      scene.frame = requestAnimationFrame(scene.tick)
    }, { elevation, altitude })
    await page.waitForTimeout(1000)
    const view = await page.evaluate(async ({ pitch, name }) => {
      const THREE = await import('/node_modules/three/build/three.module.js')
      const scene = __earthAtmosphereScene, earth = scene.bodies.get('earth'), camera = scene.camera
      cancelAnimationFrame(scene.frame)
      const up = camera.position.clone().sub(earth.position).normalize()
      const sun = scene.bodies.get('sun').position.clone().sub(earth.position).normalize()
      const tangent = sun.clone().addScaledVector(up, -sun.dot(up)).normalize()
      if (name === 'ground-sky') tangent.negate()
      const angle = pitch * Math.PI / 180
      const direction = up.clone().multiplyScalar(-Math.cos(angle)).addScaledVector(tangent, Math.sin(angle))
      if (pitch > 0) { camera.up.copy(up); camera.lookAt(camera.position.clone().add(direction)) }
      camera.updateMatrixWorld()
      scene.renderFrame()
      const gl = scene.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight
      const pixel = new Uint8Array(4)
      gl.readPixels(Math.floor(w*.5), Math.floor(h*.6), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      return { pixel: Array.from(pixel), pipeline: scene.renderPipeline.metrics(), terrain: scene.earthSurface.terrain.metrics(),
        actualSunElevation: Math.asin(up.dot(sun))*180/Math.PI, cameraKm: scene.renderPipeline.atmosphere.cameraKm.value.toArray(), glError: gl.getError() }
    }, { pitch, name })
    assert.equal(view.glError, 0); assert.equal(view.pipeline.atmosphereEnabled, true)
    assert.ok(Math.abs(view.actualSunElevation - elevation) < 2, `incorrect solar elevation ${name}`)
    report.views.push({ name, elevation, altitude, pitch, ...view })
    if(name==='ground-sky'){
      assert.ok(view.pixel[2]>view.pixel[0], 'daylight sky should be blue away from the Sun')
      assert.equal(view.pipeline.atmosphere.starVisibility,0)
    }
    await page.screenshot({ path: `${output}/${name}.png` })
  }
  // Use the real Alpine numeric fixture at its actual geographic address.
  // A bounded source makes measured-terrain verification independent of CDN
  // availability; no source heights or coordinates are invented or relocated.
  const alpine = await readFile('tests/fixtures/mapterhorn/alps.webp')
  await page.route('https://tiles.mapterhorn.com/14/8556/5791.webp',route=>route.fulfill({body:alpine,contentType:'image/webp',headers:{'access-control-allow-origin':'*'}}))
  await page.evaluate(async()=>{
    const {RegionalTerrainLayer}=await import('/src/RegionalTerrainLayer.ts')
    const {earthPilotSources}=await import('/src/RegionalTerrainSource.ts')
    const {mercatorBounds}=await import('/src/terrainPilot.ts')
    const scene=__earthAtmosphereScene,owner=scene.earthSurface,address={z:14,x:8556,y:5791}
    owner.terrain.dispose()
    const layer=new RegionalTerrainLayer(scene.bodies.get('earth'),'earth',owner.state,owner)
    const source=earthPilotSources()[0]
    layer.addSource({...source,id:'alpine-measured-fixture',root:address,roots:()=>[address],maxZoom:14})
    owner.terrain=layer;scene.regional.set('earth',layer)
    const b=mercatorBounds(address)
    terrainPilot.location('earth',(b.north+b.south)/2,(b.west+b.east)/2,300)
    scene.frame=requestAnimationFrame(scene.tick)
  })
  await page.waitForFunction(()=>terrainPilot.metrics().regional.earth.visible>0,null,{timeout:45000})
  await page.waitForTimeout(500)
  report.measuredTerrain=await page.evaluate(()=>{
    const s=__earthAtmosphereScene
    s.renderFrame()
    return {terrain:terrainPilot.metrics().regional.earth,air:s.renderPipeline.atmosphere.metrics(),glError:s.renderer.getContext().getError()}
  })
  assert.equal(report.measuredTerrain.glError,0);assert.ok(report.measuredTerrain.terrain.visible>0)
  await page.screenshot({path:`${output}/measured-alps.png`})
  report.motion=await page.evaluate(async()=>{
    const THREE=await import('/node_modules/three/build/three.module.js')
    const s=__earthAtmosphereScene,camera=s.camera,earth=s.bodies.get('earth')
    cancelAnimationFrame(s.frame)
    const up=camera.position.clone().sub(earth.position).normalize()
    const sun=s.bodies.get('sun').position.clone().sub(earth.position).normalize()
    const tangent=sun.clone().addScaledVector(up,-sun.dot(up)).normalize()
    const errors=[]
    for(const pitch of [35,50,65,80,95,110,95,80]){
      const angle=pitch*Math.PI/180,direction=up.clone().multiplyScalar(-Math.cos(angle)).addScaledVector(tangent,Math.sin(angle))
      camera.up.copy(up);camera.lookAt(camera.position.clone().add(direction));s.renderFrame()
      errors.push(s.renderer.getContext().getError())
    }
    const a=terrainPilot.sample(),b=terrainPilot.sample()
    return {errors,repeatDifference:a.reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0),
      tables:[s.renderPipeline.atmosphere.lighting.atmTransmittance,s.renderPipeline.atmosphere.lighting.atmMultiple,s.renderPipeline.atmosphere.lighting.atmIrradiance].map(u=>u.value.uuid)}
  })
  assert.ok(report.motion.errors.every(error=>error===0));assert.equal(report.motion.repeatDifference,0)
  await page.screenshot({path:`${output}/moving-measured-horizon.png`})
  // Retreat to the Moon: Earth optics must not tint an airless foreground.
  await page.evaluate(() => { cancelAnimationFrame(__earthAtmosphereScene.frame);terrainPilot.location('moon', 26.13, 3.63, 300000); __earthAtmosphereScene.frame = requestAnimationFrame(__earthAtmosphereScene.tick) })
  await page.waitForTimeout(1000)
  report.moon = await page.evaluate(() => terrainPilot.metrics().renderPipeline.atmosphere)
  assert.equal(report.moon.state, 'ready')
  assert.equal(report.moon.active,false)
  assert.deepEqual(await page.evaluate(()=>{
    const light=__earthAtmosphereScene.renderPipeline.atmosphere.lighting
    return [light.atmTransmittance,light.atmMultiple,light.atmIrradiance].map(u=>u.value.uuid)
  }),report.motion.tables)
  await page.setViewportSize({ width: 412, height: 915 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${output}/phone.png` })
  assert.deepEqual(report.errors, [])
  report.completed = true
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
console.log('Earth atmosphere GPU/reference probes, ground-to-orbit views, twilight/night, terrain and phone rendering passed.')
