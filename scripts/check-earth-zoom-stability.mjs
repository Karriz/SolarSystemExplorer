import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const output = '.terrain-cache/earth-zoom-stability'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
let page
try {
  page = await browser.newPage({ viewport: { width: 1200, height: 850 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) errors.push(m.text()) })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__earthScene=this;') })
  })
  await page.goto(`${process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'}/?terrainPilot=1`)
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => {
    terrainPilot.date('2026-06-21T10:00:00Z')
    terrainPilot.location('earth', 37.0235, -8.9955, 18000)
    terrainPilot.metrics()
  })
  await page.waitForFunction(() => {
    const owner = __earthScene.earthSurface
    const visible = [...owner.terrain.nodes.values()].filter(n => n.mesh?.visible)
    return visible.length > 0 && visible.every(n => owner.vectors.entry(n.address))
  }, null, { timeout: 90000 })
  await page.waitForTimeout(10000)
  console.log('Initial Iberian ground mapped')
  // Observe the same ground points every frame while the camera crosses terrain
  // and material LOD thresholds. End-state screenshots cannot catch a flash.
  await page.evaluate(() => {
    const scene = __earthScene, owner = scene.earthSurface
    window.__zoomFrames = []
    const original = owner.bind.bind(owner)
    owner.bind = (address, binding) => {
      original(address, binding)
      const entry = owner.vectors.entry(address)
      const b = owner.terrain.nodes.values()
      const node = [...b].find(n => n.mesh?.visible && n.address.z === address.z && n.address.x === address.x && n.address.y === address.y)
      if (!node) return
      const bounds = node.source.bounds(address)
      for (let i = 0; i < 3; i++) {
        const lat = 37.0235 + (i - 1) * .001, lon = -8.9955
        if (lat < bounds.south || lat > bounds.north || lon < bounds.west || lon > bounds.east) continue
        __zoomFrames.push({ i, time: performance.now(), terrain: address.z, mask: entry?.address.z,
          source: entry?.sourceZoom, density: entry ? entry.address.z + Math.log2(entry.size) : 0,
          bytes: owner.vectors.metrics().memoryBytes })
      }
    }
  })
  for (const altitude of [14000, 10000, 7000, 4500, 3000, 2000, 1300, 850, 550, 350, 300]) {
    console.log('Zoom altitude', altitude)
    await page.evaluate(altitude => terrainPilot.location('earth', 37.0235, -8.9955, altitude), altitude)
    await page.waitForTimeout(900)
  }
  await page.waitForFunction(() => {
    const m = terrainPilot.metrics()
    return !m.regional.earth.requests && !m.surfaces.earth.vectors.requests && !m.surfaces.earth.vectors.missingWanted
  }, null, { timeout: 120000 })
  await page.waitForTimeout(2000)
  const result = await page.evaluate(() => ({ frames: __zoomFrames, metrics: terrainPilot.metrics() }))
  await page.screenshot({ path: `${output}/close.png` })
  await writeFile(`${output}/results.json`, JSON.stringify({ ...result, errors }, null, 2))
  assert.deepEqual(errors, [])
  assert.ok(result.frames.length > 100)
  const regressions = []
  for (let i = 0; i < 3; i++) {
    let previous
    for (const frame of result.frames.filter(f => f.i === i)) {
      assert.ok(frame.mask !== undefined, 'previously mapped ground must remain mapped while replacements load')
      assert.ok(frame.bytes <= result.metrics.surfaces.earth.vectors.budget)
      if (previous && (previous.source - frame.source >= 2 || previous.density - frame.density >= 3)) regressions.push({ previous, frame })
      previous = frame
    }
  }
  assert.deepEqual(regressions, [], 'zooming must not flash back to coarse overview masks')
  assert.ok(result.metrics.surfaces.earth.vectors.memoryBytes <= result.metrics.surfaces.earth.vectors.cacheBudget,
    'settled allocations must release the replacement reserve')
  console.log(JSON.stringify({ samples: result.frames.length, regressions: regressions.length,
    bytes: result.metrics.surfaces.earth.vectors.memoryBytes, errors }))
} catch (error) {
  if (page) {
    try { await writeFile(`${output}/failure.json`, JSON.stringify(await page.evaluate(() => terrainPilot.metrics()), null, 2)) } catch {}
  }
  throw error
} finally { await browser.close() }
