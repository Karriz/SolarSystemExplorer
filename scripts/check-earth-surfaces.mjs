import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'
const output = '.terrain-cache/earth-rendering'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const report = { cases: [], errors: [], forbiddenRequests: [], completed: false }
async function open(fail = '') {
  const page = await browser.newPage({ viewport: { width: 1200, height: 850 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) report.errors.push(m.text()) })
  page.on('request', r => { if (/terrascope|sentinel|gibs\.earthdata/.test(r.url())) report.forbiddenRequests.push(r.url()) })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__earthScene=this;') })
  })
  if (fail === 'vectors') await page.route('https://tiles.openfreemap.org/**', route => route.abort())
  if (fail === 'terrain') await page.route('https://tiles.mapterhorn.com/**', route => route.abort())
  if (fail === 'compact' || fail === 'all-color') await page.route('**/textures/earth-color.webp', route => route.abort())
  if (fail === 'all-color') await page.route('**/textures/earth-base.jpg', route => route.abort())
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => terrainPilot.metrics())
  return page
}
async function visit(page, name, lat, lon, altitude, mapped = true) {
  console.log('Checking', name)
  await page.evaluate(({ lat, lon, altitude }) => {
    terrainPilot.date('2026-06-21T10:00:00Z'); terrainPilot.location('earth', lat, lon, altitude)
  }, { lat, lon, altitude })
  await page.waitForFunction(() => terrainPilot.metrics().surfaces.earth.color !== 'loading', null, { timeout: 30000 })
  if (mapped) await page.waitForFunction(() => {
    const m = terrainPilot.metrics(), layer = __earthScene.regional.get('earth')
    return m.regional.earth.ready && m.surfaces.earth.vectors.ready
      && [...layer.nodes.values()].filter(n => n.mesh?.visible).every(n => n.surface?.active.value > 0)
      && m.regional.earth.maxLevel >= 12
  }, null, { timeout: 90000 })
  if (mapped && altitude <= 1000) await page.waitForFunction(() => {
    const m = terrainPilot.metrics(), layer = __earthScene.regional.get('earth'), owner = __earthScene.earthSurface
    const visible = [...layer.nodes.values()].filter(n => n.mesh?.visible)
    return m.regional.earth.maxLevel >= 14 && !m.regional.earth.requests && !m.surfaces.earth.vectors.requests
      && visible.every(n => owner.vectors.entry(n.address)?.address.z === Math.min(n.address.z, 14))
  }, null, { timeout: 90000 })
  // Allow loaded fine masks to replace retained parent masks before inspection.
  await page.waitForTimeout(mapped ? 8000 : 1500)
  const metrics = await page.evaluate(() => terrainPilot.metrics())
  assert.equal(metrics.surfaces.earth.water, 'mapped overview')
  assert.ok(metrics.regional.earth.memoryBytes <= 48 * 1048576)
  assert.ok(metrics.surfaces.earth.vectors.memoryBytes <= 32 * 1048576)
  assert.ok(metrics.regional.earth.triangles <= 400000)
  let detailComparison
  if (name === 'forest-ground') {
    detailComparison = await page.evaluate(() => {
      const triangles = terrainPilot.metrics().regional.earth.triangles
      terrainPilot.detail(true); const on = terrainPilot.sample()
      terrainPilot.detail(false); const off = terrainPilot.sample()
      terrainPilot.detail(true); const restored = terrainPilot.sample()
      let difference = 0, restoreDifference = 0
      for (let i = 0; i < on.length; i++) if (i % 4 !== 3) {
        difference += Math.abs(on[i] - off[i]); restoreDifference += Math.abs(on[i] - restored[i])
      }
      return { meanChannelDifference: difference / (32 * 32 * 3), restoreDifference,
        trianglesBefore: triangles, trianglesAfter: terrainPilot.metrics().regional.earth.triangles }
    })
    assert.ok(detailComparison.meanChannelDifference > 0, 'Detail must affect actual ground pixels')
    assert.equal(detailComparison.restoreDifference, 0)
    assert.equal(detailComparison.trianglesBefore, detailComparison.trianglesAfter)
  }
  const detail = await page.evaluate(() => {
    const scene = __earthScene, owner = scene.earthSurface
    const nodes = [...owner.terrain.nodes.values()].filter(n => n.mesh?.visible)
    return { colorSize: [owner.color.texture?.image.width, owner.color.texture?.image.height],
      maskLevels: nodes.map(n => owner.vectors.entry(n.address)?.address.z),
      owner: owner.constructor.name, baseShader: scene.bodies.get('earth').material.customProgramCacheKey(),
      maskCount: nodes.filter(n => n.surface?.active.value).length }
  })
  await page.screenshot({ path: `${output}/${name}.png` })
  report.cases.push({ name, lat, lon, altitude, detail, detailComparison, metrics })
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  assert.equal(report.errors.length, 0, report.errors.join('\n'))
  console.log(name, JSON.stringify({ terrain: metrics.regional.earth.maxLevel, vectors: detail.maskLevels, water: metrics.surfaces.earth.water }))
}
try {
  const page = await open()
  assert.equal(await page.evaluate(() => __earthScene.earthSurface.started), false)
  const cases = process.env.EARTH_CASES?.split(',')
  for (const [name, lat, lon, altitude, mapped] of [
    ['finland-coast', 60.15, 24.98, 12000, true],
    ['forest-ground', 60.38, 24.6, 300, true],
    ['elevated-lake', 46.68, 7.74, 3000, true],
    ['dry-below-sea-level', 52.58, 4.82, 1000, true],
    ['desert-coast', -21.12, 14.58, 12000, true],
    ['dateline', -16.8, 179.9, 12000, true],
    ['north-pole', 89.9, 0, 400000, false],
    ['south-pole', -89.9, 0, 400000, false],
    ['orbit', 20, 20, 9000000, false],
  ]) if (!cases || cases.includes(name)) await visit(page, name, lat, lon, altitude, mapped)
  // Inspect actual close camera-motion behavior and allocation bounds.
  await page.evaluate(() => terrainPilot.location('earth', 60.38, 24.6, 500))
  await page.waitForTimeout(1500)
  await page.mouse.move(570, 350); await page.mouse.down({ button: 'right' })
  await page.mouse.move(600, 310, { steps: 8 }); await page.mouse.up({ button: 'right' })
  await page.mouse.wheel(0, -50); await page.waitForTimeout(1000)
  await page.screenshot({ path: `${output}/ground-motion.png` })
  await page.evaluate(() => __earthScene.focus('moon'))
  await page.waitForTimeout(1800)
  const left = await page.evaluate(() => terrainPilot.metrics().surfaces.earth.vectors)
  assert.equal(left.requests, 0); assert.equal(left.cached, 0); assert.equal(left.memoryBytes, 0)
  await page.evaluate(() => terrainPilot.location('earth', 60.15, 24.98, 12000))
  await page.waitForFunction(() => terrainPilot.metrics().surfaces.earth.vectors.ready, null, { timeout: 45000 })
  await page.setViewportSize({ width: 412, height: 915 }); await page.waitForTimeout(1000)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: `${output}/phone.png` })
  await page.close()
  for (const failure of ['vectors', 'terrain', 'compact', 'all-color']) {
    console.log('Checking failure', failure)
    const p = await open(failure)
    await p.evaluate(() => { terrainPilot.date('2026-06-21T10:00:00Z'); terrainPilot.location('earth', 60.15, 24.98, 12000) })
    await p.waitForFunction(() => terrainPilot.metrics().surfaces.earth.color !== 'loading')
    await p.waitForTimeout(2000)
    const m = await p.evaluate(() => terrainPilot.metrics())
    if (failure === 'vectors') { assert.equal(m.surfaces.earth.vectors.ready, false); assert.ok(m.surfaces.earth.vectors.failed) }
    if (failure === 'compact') assert.equal(m.surfaces.earth.color, 'original')
    if (failure === 'all-color') assert.equal(m.surfaces.earth.color, 'unavailable')
    await p.screenshot({ path: `${output}/failure-${failure}.png` })
    report.cases.push({ name: `failure-${failure}`, metrics: m })
    // Delayed work cannot attach assets after scene disposal.
    await p.evaluate(() => { __earthScene.dispose() })
    await p.waitForTimeout(300)
    assert.equal(await p.evaluate(() => __earthScene.earthSurface.vectors.metrics().cached), 0)
    await p.close()
  }
  assert.deepEqual(report.forbiddenRequests, [])
  assert.deepEqual(report.errors, [])
  report.completed = true
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
