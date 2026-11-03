import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'
const output = '.terrain-cache/mars-color-review/browser'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const report = { errors: [], cases: [], completed: false }
const sourceMetadata=JSON.parse(await readFile('public/textures/mars-color.json','utf8'))
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) report.errors.push(m.text()) })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__colorReview=this;') })
  })
  await page.route('**/textures/mars.jpg',async route=>{
    const response=await route.fetch()
    await new Promise(resolve=>setTimeout(resolve,1500))
    await route.fulfill({response})
  })
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => {
    terrainPilot.metrics()
    terrainPilot.date('2026-10-26T12:00:00Z')
    const s = __colorReview
    s.setTerrainHillshade(false); s.setTerrainShadows(false); s.setSurfaceDetail(false)
    s.__render = s.renderer.render; s.renderer.render = () => {}
    s.__neutral = { value: 0 }
    s.__renderMode = neutral => {
      s.__neutral.value = neutral ? 1 : 0
      const materials = new Set([s.bodies.get('mars').material])
      const layer = s.terrain.get('mars')
      layer.group.traverse(o => { if (o.isMesh) materials.add(o.material) })
      for (const material of materials) if (!material.__colorReview) {
        material.__colorReview = true
        const previous = material.onBeforeCompile, key = material.customProgramCacheKey()
        material.onBeforeCompile = (shader, renderer) => {
          previous.call(material, shader, renderer)
          shader.uniforms.colorReviewNeutral = s.__neutral
          shader.fragmentShader = 'uniform float colorReviewNeutral;\n' + shader.fragmentShader
          shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
            if (colorReviewNeutral > 0.5) { gl_FragColor = vec4(diffuseColor.rgb, 1.0); }
            else {
              #include <opaque_fragment>
            }`)
          shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>', `
            if (colorReviewNeutral < 0.5) {
              #include <tonemapping_fragment>
            }`)
        }
        material.customProgramCacheKey = () => key + '/color-review'
        material.needsUpdate = true
      }
      const body = s.bodies.get('mars')
      const radial = s.camera.position.clone().sub(body.position).normalize()
      const north = radial.clone().set(0, 1, 0).addScaledVector(radial, -radial.y).normalize()
      s.sunLight.position.copy(body.position).addScaledVector(radial, .70710678).addScaledVector(north, .70710678)
      s.sunLight.intensity = 3
      s.__render.call(s.renderer, s.scene, s.camera)
      const gl = s.renderer.getContext(), pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
      return { pixels, png: s.renderer.domElement.toDataURL() }
    }
  })
  await page.waitForFunction(() => __colorReview.marsColorTexture.texture, null, { timeout: 120000 })
  report.initialMode = await page.evaluate(() => __colorReview.marsColorMode)
  assert.equal(report.initialMode, 'compact')
  await page.waitForTimeout(1600)
  assert.equal(await page.evaluate(()=>__colorReview.bodies.get('mars').material.map===__colorReview.marsColorTexture.texture),true,'Late fallback replaced compact color')
  const settle = async () => {
    let previous = '', stable = 0
    for (let i = 0; i < 480; i++) {
      const state = await page.evaluate(() => {
        const l = __colorReview.terrain.get('mars')
        return { metrics:l.metrics(), pending:[...l.wanted].filter(k=>!l.nodes.get(k)?.mesh).length, signature:l.surfaceSignature() }
      })
      const signature = JSON.stringify([state.signature,state.pending])
      stable = state.metrics.ready && !state.metrics.requests && !state.pending && previous === signature ? stable + 1 : 0
      previous = signature
      if (stable >= 4) return state.metrics
      await page.waitForTimeout(250)
    }
    throw Error('Mars terrain did not settle')
  }
  for (const [name, lat, lon, altitude] of [
    ['valles',-12,-70,1000000], ['arabia',20,20,1000000], ['syrtis',10,70,1000000],
    ['dateline',10,179.9,300000], ['north',85,0,300000], ['close',-12,-70,12000],
  ]) {
    await page.evaluate(({lat,lon,altitude}) => terrainPilot.location('mars',lat,lon,altitude), {lat,lon,altitude})
    const metrics = await settle()
    await page.evaluate(() => { __colorReview.pilotAltitude = null })
    const before = await page.evaluate(() => JSON.stringify([...__colorReview.terrain.get('mars').nodes.values()].filter(n=>n.mesh?.visible).map(n=>n.mesh.geometry.id)))
    const results = {}
    for (const mode of ['10-smooth','source','compact']) {
      const timing = await page.evaluate(async mode => { const t=performance.now(); const applied=await __colorReview.setMarsColor(mode); return {applied,ms:performance.now()-t} }, mode)
      assert.ok(timing.applied)
      await page.waitForTimeout(300)
      results[mode] = await page.evaluate(mode => {
        const s=__colorReview, neutral=s.__renderMode(true), lit=s.__renderMode(false)
        window.__colorCaptures ??= {}
        __colorCaptures[mode]=neutral.pixels
        const gl=s.renderer.getContext(),center=(Math.floor(gl.drawingBufferHeight/2)*gl.drawingBufferWidth+Math.floor(gl.drawingBufferWidth/2))*4
        return {neutralPng:neutral.png,litPng:lit.png,center:[...neutral.pixels.slice(center,center+3)]}
      },mode)
      for (const lighting of ['neutral','lit']) {
        await writeFile(`${output}/${name}-${mode}-${lighting}.png`,Buffer.from(results[mode][`${lighting}Png`].split(',')[1],'base64'))
        delete results[mode][`${lighting}Png`]
      }
      results[mode].loadMs=timing.ms
    }
    const {compactError,previousError}=await page.evaluate(()=>{
      const difference=(a,b)=>{
        let total=0,count=0,max=0
        for(let i=0;i<a.length;i+=4)for(let c=0;c<3;c++){const d=Math.abs(a[i+c]-b[i+c]);total+=d;count++;max=Math.max(max,d)}
        return {mean:total/count,max}
      }
      return {compactError:difference(__colorCaptures.compact,__colorCaptures.source),previousError:difference(__colorCaptures['10-smooth'],__colorCaptures.source)}
    })
    const after=await page.evaluate(() => JSON.stringify([...__colorReview.terrain.get('mars').nodes.values()].filter(n=>n.mesh?.visible).map(n=>n.mesh.geometry.id)))
    assert.ok(compactError.mean<2,`${name}: compact color departs from reference`)
    assert.ok(compactError.mean<previousError.mean,`${name}: compact must be closer to source`)
    const control=sourceMetadata.controlSamples.find(p=>p.lat===lat&&p.lon===lon)
    if(control)assert.ok(control.srgb.every((v,i)=>Math.abs(v-results.source.center[i])<5),`${name}: GPU orientation/color mismatch ${results.source.center} versus ${control.srgb}`)
    assert.equal(before,after,'Color switching changed geometry')
    report.cases.push({name,metrics,compactError,previousError,sourceCenter:results.source.center,expected:control?.srgb,loadMs:Object.fromEntries(Object.entries(results).map(([mode,r])=>[mode,r.loadMs]))})
    console.log(name,JSON.stringify({compactError,previousError}))
  }
  // Rapid changes must leave the requested reference visible and dispose the
  // superseded bitmap even if its download/decode completes late.
  assert.equal(await page.evaluate(async () => {
    const s=__colorReview
    const a=s.setMarsColor('10-smooth'),b=s.setMarsColor('compact'),c=s.setMarsColor('source')
    await Promise.all([a,b,c])
    return s.marsColorMode==='source' && s.bodies.get('mars').material.map===s.marsColorTexture.texture && !s.marsVectorColor.texture
  }),true)
  await page.route('**/textures/mars-color.webp',route=>route.abort())
  report.failure=await page.evaluate(async () => {
    const s=__colorReview, before=s.bodies.get('mars').material.map
    try { await s.setMarsColor('compact'); return false }
    catch { return s.bodies.get('mars').material.map===before }
  })
  assert.equal(report.failure,true)
  await page.unroute('**/textures/mars-color.webp')
  assert.equal(await page.evaluate(()=>__colorReview.setMarsColor('compact')),true)
  report.lifecycle=await page.evaluate(async () => {
    const Type=__colorReview.marsColorTexture.constructor, loader=new Type()
    const pending=loader.load('compact');loader.dispose()
    return !(await pending) && !loader.texture && !(await loader.load('source'))
  })
  assert.equal(report.lifecycle,true)
  report.lateDecode=await page.evaluate(async()=>{
    const Type=__colorReview.marsColorTexture.constructor, loader=new Type(), original=createImageBitmap
    let bitmap,release
    const gate=new Promise(resolve=>{release=resolve})
    window.createImageBitmap=async(...args)=>{bitmap=await original(...args);await gate;return bitmap}
    try {
      const pending=loader.load('compact')
      for(let i=0;i<500&&!bitmap;i++)await new Promise(resolve=>setTimeout(resolve,10))
      if(!bitmap)throw Error('Bitmap did not decode')
      loader.dispose();release()
      const attached=await pending
      return !attached && bitmap.width===0 && !loader.texture
    } finally {release();window.createImageBitmap=original;loader.dispose()}
  })
  assert.equal(report.lateDecode,true)
  await page.evaluate(()=>terrainPilot.location('mars',-12,-70,1000000))
  await settle()
  await page.setViewportSize({width:412,height:915})
  await page.evaluate(()=>{__colorReview.renderer.render=__colorReview.__render;__colorReview.__neutral.value=0})
  await page.getByRole('combobox',{name:'Mars color',exact:true}).selectOption('10-smooth')
  await page.waitForFunction(()=>__colorReview.marsVectorColor.texture)
  await page.getByRole('combobox',{name:'Mars color',exact:true}).selectOption('compact')
  await page.waitForFunction(()=>__colorReview.marsColorMode==='compact' && __colorReview.marsColorTexture.texture)
  await page.getByRole('combobox',{name:'Mars color',exact:true}).selectOption('source')
  await page.waitForFunction(()=>__colorReview.marsColorMode==='source' && __colorReview.marsColorTexture.texture)
  await page.route('**/textures/mars-color.webp',route=>route.abort())
  await page.getByRole('combobox',{name:'Mars color',exact:true}).selectOption('compact')
  await page.waitForFunction(()=>document.querySelector('select[aria-label="Mars color"]').value==='raster')
  assert.equal(await page.getByRole('combobox',{name:'Mars color',exact:true}).inputValue(),'raster')
  await page.unroute('**/textures/mars-color.webp')
  await page.getByRole('combobox',{name:'Mars color',exact:true}).selectOption('compact')
  await page.waitForFunction(()=>__colorReview.marsColorMode==='compact' && __colorReview.marsColorTexture.texture)
  await page.evaluate(()=>{__colorReview.setTerrainHillshade(true);__colorReview.setSurfaceDetail(true)})
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  await page.screenshot({path:`${output}/phone.png`})
  report.phone=true
  assert.deepEqual(report.errors,[])
  report.completed=true
} finally {
  await writeFile(`${output}/results.json`,JSON.stringify(report,null,2))
  await browser.close()
}
