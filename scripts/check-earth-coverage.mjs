import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'

const output = '.terrain-cache/earth-iberia'
const capture = process.env.COVERAGE_CAPTURE || 'after'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1800, height: 850 } })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => {
    if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) errors.push(m.text())
  })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {',
      'pilotMetrics() { window.__earthScene=this; window.__earthTHREE=THREE;') })
  })
  await page.goto(`${process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'}/?terrainPilot=1`)
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => {
    terrainPilot.date('2026-06-21T12:00:00Z')
    terrainPilot.location('earth', 37.02, -8.98, 18000)
    terrainPilot.metrics()
  })
  await page.getByRole('button', { name: 'Close information panel', exact: true }).click()
  await page.evaluate(() => {
    const s = __earthScene, T = __earthTHREE, body = s.bodies.get('earth')
    const lat = 37.65 * Math.PI / 180, lon = -8.4 * Math.PI / 180
    const target = new T.Vector3(Math.cos(lat) * Math.cos(lon), Math.sin(lat), -Math.cos(lat) * Math.sin(lon))
      .multiplyScalar(body.geometry.parameters.radius).applyQuaternion(body.quaternion)
    s.camera.lookAt(target)
    s.camera.rotateZ(.25)
    s.pilotAltitude = null
    s.focusDistance = null
    s.rebaseControls()
  })
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000)
    const m = await page.evaluate(() => terrainPilot.metrics())
    if (i > 20 && !m.regional.earth.requests && !m.surfaces.earth.vectors.requests) break
  }
  const result = await page.evaluate(() => {
    const s = __earthScene, T = __earthTHREE, body = s.bodies.get('earth'), layer = s.regional.get('earth')
    const visible = [...layer.nodes.values()].filter(n => n.mesh?.visible), points = []
    for (let j = 0; j < 12; j++) for (let i = 0; i < 30; i++) {
      const ray = new T.Raycaster()
      ray.setFromCamera(new T.Vector2(-.95 + i / 29 * 1.9, -.8 + j / 11 * 1.5), s.camera)
      const point = ray.ray.intersectSphere(new T.Sphere(body.position, body.geometry.parameters.radius), new T.Vector3())
      if (!point) continue
      body.worldToLocal(point)
      const lon = Math.atan2(-point.z, point.x) * 180 / Math.PI, lat = Math.asin(point.y / point.length()) * 180 / Math.PI
      const node = visible.find(n => {
        const b = n.source.bounds(n.address)
        return lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north
      })
      points.push({ i, j, lon, lat, level: node?.address.z,
        mask: node ? s.earthSurface.vectors.entry(node.address)?.address.z : undefined })
    }
    return { points, metrics: terrainPilot.metrics(), visible: visible.map(n => ({ address: n.address, bounds: n.source.bounds(n.address) })) }
  })
  await page.screenshot({ path: `${output}/${capture}.png` })
  await writeFile(`${output}/${capture}.json`, JSON.stringify({ ...result, errors }, null, 2))
  assert.deepEqual(errors, [])
  assert.ok(result.metrics.regional.earth.memoryBytes <= 48 * 1048576)
  assert.ok(result.metrics.surfaces.earth.vectors.memoryBytes <= result.metrics.surfaces.earth.vectors.budget)
  assert.ok(result.metrics.regional.earth.triangles <= 400000)
  // This level-8 coast tile has 404 western children beside available land.
  // Before the fix, every sampled point remained at terrain/material level 8.
  const coast = result.points.filter(p => p.lon >= -9.84375 && p.lon <= -8.4375 && p.lat >= 36.597889 && p.lat <= 37.718591)
  assert.ok(coast.length > 100, 'the repro must include the affected coastal footprint')
  if (capture !== 'before') {
    assert.ok(coast.every(p => p.level >= 9), 'missing elevation siblings must not freeze the coastal parent')
    assert.ok(coast.every(p => p.mask >= 9), 'coastal materials must refine with the displayed children')
    assert.equal(result.metrics.regional.earth.failed, 0)
  }
  console.log(JSON.stringify({ ground: result.points.length, coast: coast.length,
    minimumCoastLevel: Math.min(...coast.map(p => p.level)), errors }))
} finally {
  await browser.close()
}
