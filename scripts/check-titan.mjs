import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'
const output = '.terrain-cache/titan/browser'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const part = process.argv.find(a => a.startsWith('--part='))?.split('=')[1] || 'all'
const reportPath = `${output}/${part === 'all' ? 'results' : part + '-results'}.json`
const report = { errors: [], failedLocalAssets: [], cases: [], completed: false }
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error' && /THREE|shader|WebGLProgram/.test(message.text())) report.errors.push(message.text()) })
  page.on('response', response => { if (response.status() >= 400 && /(?:terrain\/titan\/|hillshade\/titan\/|textures\/titan-)/.test(response.url())) report.failedLocalAssets.push(response.url()) })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__titan=this;') })
  })
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => { terrainPilot.metrics(); terrainPilot.date('2005-01-14T12:00:00Z') })
  await page.locator('.body-row').filter({ hasText: 'Titan' }).click()
  await page.locator('.info-actions').getByRole('button', { name: 'Saturn', exact: true }).waitFor()
  // Orbital view with dense golden-orange haze enabled
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${output}/haze-orbit.png` })
  // Reveal surface scientific view to inspect global color & terrain streaming
  await page.getByRole('button', { name: 'Reveal surface', exact: true }).click()
  await page.waitForFunction(() => terrainPilot.metrics().surfaces.titan.color === 'compact', null, { timeout: 120000 })
  async function settle() {
    if (process.argv.includes('--fast-stream')) await page.evaluate(() => {
      const s = __titan; s.__streamRender ??= s.renderer.render; s.renderer.render = () => {}
    })
    let previous = '', stable = 0, m
    try {
      for (let i = 0; i < 180; i++) {
        m = await page.evaluate(() => {
          const s = __titan, g = s.terrain.get('titan')
          return { ...g.metrics(), hillshade: s.planetSurfaces.get('titan').hillshade.metrics(), signature: g.surfaceSignature(), pending: [...g.wanted].filter(k => !g.nodes.get(k)?.mesh).length }
        })
        stable = m.ready && !m.requests && !m.pending && m.hillshade.ready && !m.hillshade.requests && !m.hillshade.missingWanted && previous === m.signature ? stable + 1 : 0
        previous = m.signature
        if (stable >= 4) return m
        await page.waitForTimeout(200)
      }
      throw Error('Titan did not settle: ' + JSON.stringify(m))
    } finally {
      if (process.argv.includes('--fast-stream')) await page.evaluate(() => { const s = __titan; s.renderer.render = s.__streamRender })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
  }
  const cases = [
    ['surface-orbit', 10, -100, 4800000],
    ['kraken-mare', 68.0, 50.0, 40000],
    ['ligeia-mare', 79.7, 112.1, 40000],
    ['xanadu', -15.0, -100.0, 40000],
    ['huygens-site', -10.2, 167.6, 20000],
    ['north-pole', 90, 0, 40000],
    ['south-pole', -90, 0, 40000],
    ['close-surface', -10.2, 167.6, 100],
  ]
  for (const [name, lat, lon, altitude] of (part === 'navigation' ? [] : cases)) {
    console.log('Checking', name)
    await page.evaluate(p => terrainPilot.location('titan', ...p), [lat, lon, altitude])
    await settle()
    await page.evaluate(p => terrainPilot.location('titan', ...p), [lat, lon, altitude])
    const metrics = await settle()
    assert.equal(metrics.failed, 0)
    assert.ok(metrics.memoryBytes <= 128 * 1048576)
    assert.ok(metrics.triangles <= 400000)
    const clearance = await page.evaluate(() => terrainPilot.metrics().altitudeMeters)
    assert.ok(clearance >= 99, `Camera clearance ${clearance}`)
    await page.screenshot({ path: `${output}/${name}.png` })
    report.cases.push({ name, metrics, clearance })
    await writeFile(reportPath, JSON.stringify(report, null, 2))
  }
  if (!part.startsWith('surface')) {
    for (const date of ['1900-01-01T12:00:00Z', '2026-11-15T12:00:00Z', '2049-12-31T12:00:00Z']) {
      await page.evaluate(date => terrainPilot.date(date), date)
      await page.waitForTimeout(100)
      const distance = await page.evaluate(() => {
        const s = __titan
        return s.bodies.get('titan').position.distanceTo(s.bodies.get('saturn').position) * 149597870.7
      })
      assert.ok(Math.abs(distance - 1221870) < .01)
    }
    await page.locator('.info-actions').getByRole('button', { name: 'Saturn', exact: true }).click()
    await page.waitForFunction(() => terrainPilot.metrics().selected === 'saturn')
    await page.waitForTimeout(500)
    assert.equal(await page.evaluate(() => terrainPilot.metrics().global.titan.ready), false)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => terrainPilot.location('titan', 10, -100, 4800000))
    await page.screenshot({ path: `${output}/phone.png` })
  }
  assert.deepEqual(report.errors, [])
  assert.deepEqual(report.failedLocalAssets, [])
  report.completed = true
  console.log('Titan browser checks passed')
} finally {
  await writeFile(reportPath, JSON.stringify(report, null, 2))
  await browser.close()
}
