import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'
const output = '.terrain-cache/hillshade-comparison'
await mkdir(output, { recursive: true })
const report = { errors: [], cases: [], completed: false }
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) report.errors.push(m.text()) })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__relief=this;') })
  })
  // Reintroduce the previous formula only in this diagnostic browser session.
  // Value 2 selects the legacy light; production keeps its boolean toggle.
  await page.route('**/src/terrainHillshade.ts*', async route => {
    const response = await route.fetch()
    const source = (await response.text()).replace('diffuseColor.rgb *= mix(1.0, hsFactor, terrainHillshadeEnabled);', `
      if (terrainHillshadeEnabled > 1.5) {
        vec3 legacyLight = normalize(hsRadial - 0.70710678 * hsEast + 0.70710678 * hsNorth);
        hsFactor = clamp(1.0 + 0.55 * (max(dot(hsNormal, legacyLight), 0.0) / 0.70710678 - 1.0), 0.45, 1.35);
      }
      diffuseColor.rgb *= mix(1.0, hsFactor, min(terrainHillshadeEnabled, 1.0));`)
    assert.notEqual(source, await response.text(), 'Comparison shader injection failed')
    await route.fulfill({ response, body: source })
  })
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => {
    terrainPilot.metrics()
    terrainPilot.date('2026-10-26T12:00:00Z')
    const s = __relief
    s.setSurfaceDetail(false)
    s.setTerrainShadows(false)
    s.setHighResHillshade(false)
    s.__render = s.renderer.render
    s.renderer.render = () => {}
  })
  await page.waitForFunction(() => (__relief.marsColorTexture.texture || __relief.marsVectorColor.texture) && (__relief.moonColorTexture.texture || __relief.moonVectorColor.texture), null, { timeout: 120000 })
  for (const [name, body, lat, lon, altitude] of [
    ['valles', 'mars', -12, -70, 300000],
    ['valles-wall', 'mars', -9.38671875, -78.93359375, 12000],
    ['moon-hadley', 'moon', 26.13, 3.63, 100000],
  ]) {
    await page.evaluate(({ body, lat, lon, altitude }) => terrainPilot.location(body, lat, lon, altitude), { body, lat, lon, altitude })
    let previous = '', stable = 0
    for (let i = 0; i < 480; i++) {
      const state = await page.evaluate(body => {
        const l = __relief.terrain.get(body)
        return { metrics: l.metrics(), pending: [...l.wanted].filter(k => !l.nodes.get(k)?.mesh).length, signature: l.surfaceSignature() }
      }, body)
      const signature = JSON.stringify([state.signature, state.pending])
      stable = state.metrics.ready && !state.metrics.requests && !state.pending && signature === previous ? stable + 1 : 0
      previous = signature
      if (stable >= 4) break
      assert.ok(i < 479, 'Terrain did not settle')
      await page.waitForTimeout(250)
    }
    const result = await page.evaluate(({ body }) => {
      const s = __relief, b = s.bodies.get(body), layer = s.terrain.get(body)
      const signature = layer.surfaceSignature(), geometry = layer.metrics()
      const radial = s.camera.position.clone().sub(b.position).normalize()
      const tangent = radial.clone().set(0, 1, 0).addScaledVector(radial, -radial.y).normalize()
      const gl = s.renderer.getContext(), images = {}, measurements = []
      const render = mode => {
        s.terrainHillshade.value = mode
        s.__render.call(s.renderer, s.scene, s.camera)
        const p = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, p)
        return p
      }
      const difference = (a, b) => {
        let changed = 0, total = 0
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(...[0, 1, 2].map(c => Math.abs(a[i+c] - b[i+c])))
          if (d >= 2) changed++
          total += d
        }
        return { changed, mean: total / (a.length / 4) }
      }
      for (const elevation of [90, 15]) {
        const angle = elevation * Math.PI / 180
        s.sunLight.position.copy(b.position).addScaledVector(radial, Math.sin(angle)).addScaledVector(tangent, Math.cos(angle))
        s.sunLight.intensity = 3
        const off = render(0)
        images[`${elevation}-off`] = s.renderer.domElement.toDataURL()
        const legacy = render(2)
        images[`${elevation}-legacy`] = s.renderer.domElement.toDataURL()
        const multi = render(1)
        images[`${elevation}-multi`] = s.renderer.domElement.toDataURL()
        measurements.push({ elevation, offVsMulti: difference(off, multi), legacyVsMulti: difference(legacy, multi), repeat: difference(off, render(0)) })
      }
      return { images, measurements, geometry, stableGeometry: signature === layer.surfaceSignature() }
    }, { body })
    for (const [mode, data] of Object.entries(result.images)) await writeFile(`${output}/${name}-${mode}.png`, Buffer.from(data.split(',')[1], 'base64'))
    delete result.images
    assert.ok(result.stableGeometry)
    for (const m of result.measurements) {
      assert.ok(m.offVsMulti.changed > 1000, 'Relief enhancement must be visible')
      assert.ok(m.legacyVsMulti.changed > 100, 'New shading must differ from legacy')
      assert.equal(m.repeat.changed, 0, 'Toggle must be reversible')
    }
    report.cases.push({ name, ...result })
    console.log(name, JSON.stringify(result.measurements))
  }
  await page.evaluate(() => terrainPilot.location('mars', -12, -70, 300000))
  await page.setViewportSize({ width: 412, height: 915 })
  // Restore ordinary drawing after the matched raw-canvas comparisons.
  await page.evaluate(() => {
    __relief.renderer.render = __relief.__render
    __relief.setTerrainHillshade(true)
  })
  await page.getByRole('button', { name: 'Hillshade on', exact: true }).click()
  assert.equal(await page.evaluate(() => __relief.terrainHillshade.value), 0)
  await page.getByRole('button', { name: 'Hillshade off', exact: true }).click()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Phone controls overflow horizontally')
  await page.screenshot({ path: `${output}/phone-controls.png` })
  report.phoneControls = true
  assert.deepEqual(report.errors, [])
  report.completed = true
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
