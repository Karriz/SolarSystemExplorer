import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const output = '.terrain-cache/camera-controls'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const report = { errors: [], cases: [], completed: false }
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } })
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && /THREE|shader|WebGLProgram/.test(message.text())) report.errors.push(message.text())
  })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__cameraScene = this;') })
  })
  await page.goto(`${process.env.CAMERA_PREVIEW_URL || 'http://127.0.0.1:5175'}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => {
    terrainPilot.metrics()
    __cameraScene.renderer.setPixelRatio(.75)
    __cameraScene.setOrbits(false)
    // Keep all camera fixtures lit, including polar and lunar night locations.
    // This affects only this browser test, so screenshots show the terrain.
    __cameraScene.setTerrainShadows(false)
    const render = __cameraScene.renderer.render.bind(__cameraScene.renderer)
    __cameraScene.renderer.render = (scene, camera) => {
      const radial = camera.position.clone().normalize(), tangent = camera.up.clone().addScaledVector(radial, -camera.up.dot(radial)).normalize()
      __cameraScene.sunLight.position.copy(radial).multiplyScalar(.5).addScaledVector(tangent, .866).multiplyScalar(.1)
      render(scene, camera)
    }
    terrainPilot.date('2026-06-21T10:00:00Z')
  })
  const closePanel = page.getByRole('button', { name: 'Close information panel' })
  if (await closePanel.isVisible()) await closePanel.click()

  for (const [body, radiusMeters] of [['moon', 1737400], ['earth', 6371000]]) {
    console.log('Checking off-center approach', body)
    await page.evaluate(({ body, radiusMeters }) => terrainPilot.location(body, 26.13, 3.63, radiusMeters * 4), { body, radiusMeters })
    await page.waitForTimeout(500)
    const approach = await page.evaluate(async () => {
      const s = __cameraScene, element = s.renderer.domElement, rect = element.getBoundingClientRect()
      const point = s.controls.viewCenter().set(rect.left + rect.width * .65, rect.top + rect.height * .55)
      if (!s.controls.hit(point)) throw new Error('Approach must start over the planet limb')
      let normalError = 0
      const heights = []
      for (let step = 0; step < 12; step++) {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -3000, clientX: point.x, clientY: point.y, cancelable: true }))
        // Advance the same eased control path between rendered samples so the
        // full orbit-to-ground approach is practical on a software renderer.
        for (let frame = 0; frame < 20; frame++) {
          s.controls.update(.1)
          const normal = s.camera.position.clone().sub(s.controls.target).normalize()
            .applyQuaternion(s.camera.quaternion.clone().invert())
          normalError = Math.max(normalError, Math.hypot(normal.x, normal.y, normal.z - 1))
        }
        await new Promise(requestAnimationFrame)
        const normal = s.camera.position.clone().sub(s.controls.target).normalize()
          .applyQuaternion(s.camera.quaternion.clone().invert())
        normalError = Math.max(normalError, Math.hypot(normal.x, normal.y, normal.z - 1))
        heights.push(s.controls.height())
      }
      return { normalError, heights, surfaceWeight: s.controls.surfaceWeight }
    })
    assert.ok(approach.normalError < 1e-6, `${body}: limb approach must stay downward-facing`)
    assert.equal(approach.surfaceWeight, 1, `${body}: approach must reach full surface control`)
    await page.screenshot({ path: `${output}/${body}-approach.png` })
    report.cases.push({ name: `${body}-approach`, approach })
  }

  for (const [name, body, lat, lon, altitude] of [
    ['moon-ground', 'moon', 26.13, 3.63, 12000],
    ['moon-horizon', 'moon', 26.13, 3.63, 12000],
    ['earth-ground', 'earth', 46.57, 8.02, 18000],
    ['moon-north', 'moon', 90, 0, 12000],
    ['moon-south', 'moon', -90, 0, 12000],
  ]) {
    console.log('Checking', name)
    await page.evaluate(({ body, lat, lon, altitude }) => terrainPilot.location(body, lat, lon, altitude), { body, lat, lon, altitude })
    await page.waitForTimeout(2500)
    await page.waitForFunction(body => {
      const s = __cameraScene
      return body === 'earth' ? s.regional.get('earth').metrics().ready : s.terrain.get(body).metrics().ready
    }, body, { timeout: 60000 })
    // Use native mouse input and observe the real frame loop. Capture a pivot
    // after terrain has had an opportunity to load at the starting footprint.
    await page.mouse.move(500, 375)
    await page.mouse.down({ button: 'right' })
    await page.mouse.move(580, name === 'moon-horizon' ? -25 : 215, { steps: 10 })
    const pivot = await page.evaluate(() => {
      const s = __cameraScene, p = s.controls.drag?.grab
      if (!p) throw new Error('Right drag did not acquire a ground pivot')
      const projected = p.clone().project(s.camera)
      return { x: projected.x, y: projected.y, height: s.controls.height() * 149597870700 }
    })
    assert.ok(Math.abs(pivot.x) < 1e-5 && Math.abs(pivot.y) < 1e-5, `${name}: pivot must stay centered`)
    await page.mouse.up({ button: 'right' })
    if (body === 'moon') await page.waitForFunction(() => {
      const s = __cameraScene, layer = s.terrain.get('moon')
      return layer.metrics().visible > 0 && s.planetSurfaces.get('moon').metrics().color === 'compact'
    }, null, { timeout: 60000 })
    await page.screenshot({ path: `${output}/${name}-tilted.png` })
    await page.mouse.move(500, 420)
    await page.mouse.down()
    await page.mouse.move(550, 440, { steps: 8 })
    await page.mouse.up()
    await page.mouse.move(500, 375)
    const zoom = await page.evaluate(async () => {
      const s = __cameraScene, frames = [], element = s.renderer.domElement
      const before = s.controls.height()
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: 500, clientY: 375, bubbles: true, cancelable: true }))
      const immediate = s.controls.height()
      for (let i = 0; i < 12; i++) {
        await new Promise(requestAnimationFrame)
        frames.push(s.controls.height())
      }
      return { before, immediate, frames }
    })
    assert.equal(zoom.before, zoom.immediate, 'Wheel input must wait for animation frames')
    assert.ok(zoom.frames.at(-1) < zoom.before, 'Wheel zoom must advance')
    assert.ok(zoom.frames.every(Number.isFinite), 'Zoom must remain finite')
    const edgeZoom = await page.evaluate(async () => {
      const s = __cameraScene, element = s.renderer.domElement
      const rect = element.getBoundingClientRect()
      const localNormal = () => s.camera.position.clone().sub(s.controls.target).normalize()
        .applyQuaternion(s.camera.quaternion.clone().invert())
      const normal = localNormal(), point = s.controls.viewCenter()
      point.set(rect.left + rect.width * .92, rect.top + rect.height * .8)
      const anchor = s.controls.hit(point)
      if (!anchor) throw new Error('Edge zoom fixture must point at the ground')
      const projected = anchor.clone().project(s.camera)
      let normalError = 0, anchorError = 0
      for (const deltaY of [-600, 600]) {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY, clientX: point.x, clientY: point.y, cancelable: true }))
        for (let frame = 0; frame < 12; frame++) {
          await new Promise(requestAnimationFrame)
          normalError = Math.max(normalError, localNormal().distanceTo(normal))
          const p = anchor.clone().project(s.camera)
          anchorError = Math.max(anchorError, Math.hypot(p.x - projected.x, p.y - projected.y))
        }
      }
      return { normalError, anchorError }
    })
    assert.ok(edgeZoom.normalError < 1e-6, `${name}: edge zoom must preserve surface-relative orientation`)
    // Terrain can replace the sampled hill during this live stroke. Record
    // anchor drift; exact anchoring is asserted with fixed terrain in unit tests.
    await page.screenshot({ path: `${output}/${name}-edge-zoom.png` })
    report.cases.push({ name, pivot, zoom, edgeZoom, metrics: await page.evaluate(() => terrainPilot.metrics()) })
  }

  console.log('Checking surface-to-orbit transition')
  await page.evaluate(() => terrainPilot.location('moon', 26.13, 3.63, 600000))
  await page.waitForTimeout(1500)
  await page.mouse.move(500, 375)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(550, 275, { steps: 8 })
  await page.mouse.up({ button: 'right' })
  await page.mouse.move(500, 375)
  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 1000)
    await page.waitForTimeout(250)
  }
  await page.waitForTimeout(1000)
  const orbit = await page.evaluate(() => {
    const s = __cameraScene, toward = s.controls.target.clone().sub(s.camera.position).normalize()
    const forward = toward.clone(); s.camera.getWorldDirection(forward)
    return { weight: s.controls.surfaceWeight, aim: forward.dot(toward), height: s.controls.height() }
  })
  assert.equal(orbit.weight, 0)
  assert.ok(orbit.aim > .999999, 'Exiting surface view must restore body-centered aim')
  await page.screenshot({ path: `${output}/moon-orbit.png` })
  report.cases.push({ name: 'surface-to-orbit', orbit })

  // Verify pointer capture survives a small viewport, then dispose during zoom.
  await page.setViewportSize({ width: 390, height: 720 })
  await page.evaluate(() => terrainPilot.location('moon', 26.13, 3.63, 12000))
  await page.waitForTimeout(1000)
  await page.mouse.move(180, 280)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(220, 210, { steps: 8 })
  const phonePivot = await page.evaluate(() => {
    const s = __cameraScene, p = s.controls.drag?.grab?.clone().project(s.camera)
    return { close: s.controls.close, finite: s.camera.quaternion.toArray().every(Number.isFinite), x: p?.x, y: p?.y }
  })
  assert.ok(phonePivot.close && phonePivot.finite)
  assert.ok(Math.abs(phonePivot.x) < 1e-5 && Math.abs(phonePivot.y) < 1e-5)
  await page.mouse.up({ button: 'right' })
  await page.screenshot({ path: `${output}/phone-tilted.png` })
  await page.evaluate(() => {
    const s = __cameraScene, element = s.renderer.domElement
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, clientX: 195, clientY: 360, cancelable: true }))
    s.dispose()
  })
  assert.deepEqual(report.errors, [])
  report.completed = true
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
console.log('Camera ground pivots, animated zoom, poles, orbit transition and phone view passed.')
