import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'
const output = '.terrain-cache/enceladus/browser'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const report = { errors: [], failedLocalAssets: [], cases: [], completed: false }
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && /THREE|shader|WebGLProgram/.test(message.text())) report.errors.push(message.text()) })
  page.on('response', response => { if (response.status() >= 400 && /enceladus/.test(response.url())) report.failedLocalAssets.push(response.url()) })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__enceladus=this;') })
  })
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => { terrainPilot.metrics(); terrainPilot.date('2005-01-14T12:00:00Z') })
  await page.locator('.body-row').filter({ hasText: 'Enceladus' }).click()
  await page.waitForFunction(() => terrainPilot.metrics().surfaces.enceladus.color === 'compact', null, { timeout: 120000 })
  await page.locator('.info-actions').getByRole('button', { name: 'Saturn', exact: true }).waitFor()
  const sun = await page.evaluate(() => {
    const s = __enceladus, b = s.bodies.get('enceladus')
    const d = s.bodies.get('sun').position.clone().sub(b.position).applyQuaternion(b.quaternion.clone().invert()).normalize()
    return { lat: Math.asin(d.y) * 180 / Math.PI, lon: Math.atan2(-d.z, d.x) * 180 / Math.PI }
  })
  async function settle() {
    if (process.argv.includes('--fast-stream')) await page.evaluate(() => {
      const s = __enceladus; s.__streamRender ??= s.renderer.render; s.renderer.render = () => {}
    })
    let previous = '', stable = 0, m
    try {
    for (let i = 0; i < 180; i++) {
      m = await page.evaluate(() => {
        const s = __enceladus, g = s.terrain.get('enceladus')
        return { ...g.metrics(), signature: g.surfaceSignature(), pending: [...g.wanted].filter(k => !g.nodes.get(k)?.mesh).length }
      })
      stable = m.ready && !m.requests && !m.pending && previous === m.signature ? stable + 1 : 0
      previous = m.signature
      if (stable >= 4) return m
      await page.waitForTimeout(200)
    }
    throw Error('Enceladus did not settle: ' + JSON.stringify(m))
    } finally {
      if (process.argv.includes('--fast-stream')) await page.evaluate(() => { const s = __enceladus; s.renderer.render = s.__streamRender })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
  }
  const cases = [
    ['day-orbit', sun.lat, sun.lon + 25, 700000],
    ['south-polar-terrain', -80, sun.lon, 12000],
    ['north-pole', 90, 0, 12000],
    ['dateline', 10, 179.99, 12000],
    ['cube-corner', 35.26438968, 45, 12000],
    ['close-ice', -75, sun.lon, 100],
  ]
  for (const [name, lat, lon, altitude] of cases.filter(c => !process.env.ENCELADUS_CASES || process.env.ENCELADUS_CASES.split(',').includes(c[0]))) {
    console.log('Checking', name)
    await page.evaluate(p => terrainPilot.location('enceladus', ...p), [lat, lon, altitude])
    await settle()
    await page.evaluate(p => terrainPilot.location('enceladus', ...p), [lat, lon, altitude])
    const metrics = await settle()
    assert.equal(metrics.failed, 0)
    assert.ok(metrics.memoryBytes <= 128 * 1048576)
    assert.ok(metrics.triangles <= 400000)
    const clearance = await page.evaluate(() => terrainPilot.metrics().altitudeMeters)
    assert.ok(clearance >= 99, `Camera clearance ${clearance}`)
    await page.evaluate(() => { __enceladus.pilotAltitude = null })
    const signature = await page.evaluate(() => __enceladus.terrain.get('enceladus').surfaceSignature())
    await page.waitForTimeout(600)
    assert.equal(await page.evaluate(() => __enceladus.terrain.get('enceladus').surfaceSignature()), signature)
    await page.screenshot({ path: `${output}/${name}.png` })
    report.cases.push({ name, metrics, clearance })
    if (name === 'close-ice') {
      const detail = await page.evaluate(() => {
        const s = __enceladus, surface = s.planetSurfaces.get('enceladus'), layer = surface.terrain
        if (!surface.state.detailMapReady.value || !surface.state.mediumDetailReady.value) throw Error('Ice material did not load')
        const before = layer.surfaceSignature(), off = [], on = []
        for (const [value, samples] of [[0, off], [1, on]]) {
          surface.state.detail.value = value
          samples.push(...s.pilotImageSample())
        }
        let difference = 0
        for (let i = 0; i < off.length; i++) if (i % 4 !== 3) difference += Math.abs(off[i] - on[i])
        return { meanDifference: difference / (32 * 32 * 3), geometryUnchanged: before === layer.surfaceSignature() }
      })
      assert.ok(detail.meanDifference > .1, 'Generated frost should be visible at close range')
      assert.ok(detail.geometryUnchanged)
      report.detail = detail
    }
    await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  }
  // Ground pivot and moving camera exercise actual gestures and terrain LOD.
  await page.mouse.move(520, 500)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(625, 130, { steps: 16 })
  await page.mouse.up({ button: 'right' })
  await settle()
  assert.ok(await page.evaluate(() => terrainPilot.metrics().altitudeMeters >= 99))
  report.groundTiltRadians = await page.evaluate(() => {
    const s = __enceladus, d = s.camera.getWorldDirection(s.camera.position.clone())
    return Math.acos(Math.max(-1, Math.min(1, -d.dot(s.camera.position.clone().normalize()))))
  })
  assert.ok(report.groundTiltRadians > .8, 'Right drag must produce a grazing ground view')
  await page.screenshot({ path: `${output}/ground-tilt.png` })
  // Parent navigation/date changes must preserve the planet-relative orbit.
  for (const date of ['1900-01-01T12:00:00Z', '2026-11-15T12:00:00Z', '2049-12-31T12:00:00Z']) {
    await page.evaluate(date => terrainPilot.date(date), date)
    await page.waitForTimeout(100)
    const distance = await page.evaluate(() => {
      const s = __enceladus
      return s.bodies.get('enceladus').position.distanceTo(s.bodies.get('saturn').position) * 149597870.7
    })
    assert.ok(Math.abs(distance - 238037) < .01)
  }
  await page.locator('.info-actions').getByRole('button', { name: 'Saturn', exact: true }).click()
  await page.waitForFunction(() => terrainPilot.metrics().selected === 'saturn')
  await page.waitForTimeout(500)
  assert.equal(await page.evaluate(() => terrainPilot.metrics().global.enceladus.ready), false)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => terrainPilot.location('enceladus', -30, 50, 700000))
  await settle()
  await page.screenshot({ path: `${output}/phone.png` })
  await page.close()
  // Failed streamed products retain the ice reference color and correct
  // ellipsoidal fallback, rather than exposing a spherical/dark placeholder.
  const fallback = await browser.newPage({ viewport: { width: 800, height: 650 } })
  fallback.on('pageerror', error => report.errors.push(error.message))
  await fallback.route('**/textures/enceladus-color.webp', route => route.abort())
  await fallback.route('**/terrain/enceladus/**', route => route.abort())
  await fallback.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await fallback.waitForFunction(() => window.terrainPilot)
  await fallback.evaluate(() => terrainPilot.location('enceladus', -30, 50, 700000))
  await fallback.waitForFunction(() => terrainPilot.metrics().surfaces.enceladus.color === 'original', null, { timeout: 60000 })
  await fallback.getByRole('status').filter({ hasText: 'Compact color unavailable · showing reconstructed ice reference' }).waitFor()
  await fallback.screenshot({ path: `${output}/data-failure-fallback.png` })
  report.fallback = { color: 'reconstructed-reference', terrain: 'reference-ellipsoid' }
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.failedLocalAssets, [])
  report.completed = true
  console.log('Enceladus browser checks passed')
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
