import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] }
const output = resolve(option('--output', '.terrain-cache/shadows'))
const url = option('--url', 'http://127.0.0.1:5173').replace(/\/$/, '')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM, args: ['--no-sandbox'] })
const report = { cases: [], errors: [], completed: false }
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /shader|THREE|WebGLProgram/.test(m.text())) report.errors.push(m.text()) })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__shadowScene=this;') })
  })
  await page.goto(`${url}/?terrainPilot=1`)
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => terrainPilot.metrics())
  await page.getByRole('button', { name: 'Close information panel', exact: true }).click()
  // Let the new date/origin settle before placing the camera on the Moon.
  await page.evaluate(date => terrainPilot.date(date), option('--date', '2026-10-19T12:00:00Z'))
  await page.waitForTimeout(500)
  let anchoredMatrix
  for (const [name, altitude, tilt, phone] of [
    ['orbit', 12000, 0, false], ['close', 100, 0, false], ['tilted', 100, 75, false],
    ['rim', 100, 85, false], ['horizon', 100, 89, false], ['sky', 100, 95, false],
    ['gesture', 100, 0, false], ['phone', 100, 75, true],
  ]) {
    console.log('Checking', name)
    if (phone) await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(altitude => {
      terrainPilot.location('moon', 26.13, 3.63, altitude)
    }, altitude)
    let stable = 0, last = ''
    for (let i = 0; i < 120 && stable < 4; i++) {
      const m = await page.evaluate(() => __shadowScene.terrain.get('moon').metrics())
      const key = JSON.stringify([m.visible, m.cached, m.maxLevel])
      stable = m.ready && !m.requests && key === last ? stable + 1 : 0
      last = key
      await page.waitForTimeout(300)
    }
    assert.ok(stable >= 4, 'terrain did not settle')
    await page.evaluate(tilt => {
      const s = __shadowScene
      s.pilotAltitude = null
      // Rotate about camera right, retaining roll and position as on pitch-up.
      s.camera.rotateX(tilt * Math.PI / 180)
    }, tilt)
    if (name === 'gesture') {
      const rect = await page.locator('canvas').boundingBox()
      assert.ok(rect)
      // The canvas extends behind the timeline; keep the drag in the exposed view.
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height * .65)
      await page.mouse.down({ button: 'right' })
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height * .2, { steps: 20 })
      await page.mouse.up({ button: 'right' })
    }
    await page.waitForTimeout(2000)
    const data = await page.evaluate(async () => {
      const THREE = await import('/node_modules/three/build/three.module.js')
      const s = __shadowScene, light = s.terrainSun, points = []
      const radial = s.camera.position.clone().sub(s.bodies.get('moon').position).normalize()
      const pitch = Math.acos(Math.max(-1, Math.min(1, -s.camera.getWorldDirection(radial.clone()).dot(radial)))) * 180 / Math.PI
      for (const x of [-.8, -.4, 0, .4, .8]) for (const y of [-.8, -.4, 0, .4, .8]) {
        const direction = new THREE.Vector3(x, y, .5).unproject(s.camera).sub(s.camera.position).normalize()
        const hit = s.hitGround(new THREE.Ray(s.camera.position.clone(), direction))
        if (!hit) continue
        points.push(hit.applyMatrix4(light.shadow.matrix).toArray())
      }
      return { altitude: s.lastAltitudeMeters, pitch, intensity: light.intensity, points,
        shadowMatrix: light.shadow.matrix.toArray(), metrics: s.pilotMetrics() }
    })
    assert.ok(data.intensity > 0)
    assert.ok(data.altitude >= 99)
    if (name === 'gesture') assert.ok(data.pitch > 70, 'right drag did not pitch toward the horizon')
    assert.ok(data.points.length > 0, 'no visible ground was checked')
    for (const [x, y, z] of data.points) {
      assert.ok(x > .08 && x < .92 && y > .08 && y < .92 && z > 0 && z < 1, 'visible receiver clipped by shadow map')
    }
    if (name === 'close') anchoredMatrix = data.shadowMatrix
    // A ground-anchored right drag can move the camera slightly around its
    // picked pivot. Pure rotation and resizing must keep sampling identical.
    if (altitude === 100 && anchoredMatrix && name !== 'gesture') {
      data.shadowMatrix.forEach((n, i) => assert.ok(Math.abs(n - anchoredMatrix[i]) < 1e-5,
        'pitch or viewport change moved coverage of existing shadows'))
    }
    await page.screenshot({ path: resolve(output, `${name}-on.png`) })
    await page.evaluate(() => __shadowScene.setTerrainShadows(false))
    await page.waitForTimeout(200)
    await page.screenshot({ path: resolve(output, `${name}-off.png`) })
    await page.evaluate(() => __shadowScene.setTerrainShadows(true))
    report.cases.push({ name, ...data })
  }
  assert.deepEqual(report.errors, [])
  report.completed = true
} finally {
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
