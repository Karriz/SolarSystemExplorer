import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const output = '.terrain-cache/venus-views'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const report = { errors: [], views: [], completed: false }
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) report.errors.push(m.text()) })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__venusViews=this;') })
  })
  await page.goto(`${process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  const subsolar = await page.evaluate(() => {
    terrainPilot.date('2026-10-26T12:00:00Z'); terrainPilot.metrics()
    const s = __venusViews, body = s.bodies.get('venus')
    s.setOrbits(false); body.updateWorldMatrix(true, false)
    const local = body.worldToLocal(s.bodies.get('sun').position.clone()).normalize()
    return { lat: Math.asin(local.y)*180/Math.PI, lon: Math.atan2(-local.z,local.x)*180/Math.PI }
  })
  await page.getByRole('button', { name: 'Close information panel' }).click()
  for (const [name, lat, lon, altitude] of [['daylight-globe', subsolar.lat, subsolar.lon, 15000000], ['maxwell-daylight',65,3,300000], ['basalt-close',65,3,100]]) {
    await page.evaluate(({lat,lon,altitude}) => {
      terrainPilot.location('venus',lat,lon,altitude)
      const s=__venusViews;s.__render ??= s.renderer.render;s.renderer.render=()=>{}
    }, {lat,lon,altitude})
    await page.waitForTimeout(800)
    await page.waitForFunction(() => {
      const s=__venusViews, surface=s.planetSurfaces.get('venus'), l=surface.terrain, h=surface.hillshade.metrics()
      return l.metrics().ready && !l.metrics().requests && ![...l.wanted].some(k=>!l.nodes.get(k)?.mesh)
        && h.ready && !h.requests && !h.missingWanted && surface.metrics().color==='compact'
        && surface.state.detailMapReady.value && surface.state.mediumDetailReady.value
    }, null, { timeout:120000 })
    await page.waitForTimeout(500)
    const state=await page.evaluate(({name}) => {
      const s=__venusViews,b=s.bodies.get('venus'),surface=s.planetSurfaces.get('venus')
      const radial=s.camera.position.clone().sub(b.position).normalize()
      if(name!=='daylight-globe')s.sunLight.position.copy(b.position).add(radial)
      s.__render.call(s.renderer,s.scene,s.camera)
      const gl=s.renderer.getContext(),pixels=new Uint8Array(gl.drawingBufferWidth*gl.drawingBufferHeight*4)
      gl.readPixels(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
      let visible=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>45&&pixels[i+1]>40&&pixels[i+2]>35)visible++
      return {png:s.renderer.domElement.toDataURL(),visible,terrain:surface.terrain.metrics(),hillshade:surface.hillshade.metrics()}
    },{name})
    assert.ok(state.visible>10000, `${name} must contain a lit surface`)
    const {png}=state;delete state.png
    await writeFile(`${output}/${name}.png`,Buffer.from(png.split(',')[1],'base64'))
    report.views.push({name,...state})
  }
  assert.deepEqual(report.errors,[]);report.completed=true
} finally { await writeFile(`${output}/results.json`,JSON.stringify(report,null,2));await browser.close() }
console.log('Venus daylight globe, measured highlands and generated close material rendered.')
