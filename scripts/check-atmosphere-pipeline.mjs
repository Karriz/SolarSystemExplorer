import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.ATMOSPHERE_PREVIEW_URL || 'http://127.0.0.1:5175'
const output = '.terrain-cache/atmosphere-pipeline-browser'
await mkdir(output, { recursive: true })
const report = { errors: [], views: [], completed: false }
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1 })
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && /THREE|shader|WebGL|Framebuffer/i.test(message.text())) report.errors.push(message.text())
  })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__atmosphereScene=this;') })
  })
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => {
    terrainPilot.metrics(); terrainPilot.date('2026-10-26T12:00:00Z')
    // This regression isolates the neutral HDR pipeline from optical changes.
    for (const air of Object.values(__atmosphereScene.renderPipeline.atmospheres)) air.enabled = false
  })

  // Deterministic colors, alpha, actual sampled depth, fallback and lifecycle.
  report.fixture = await page.evaluate(async () => {
    const THREE = await import('/node_modules/three/build/three.module.js')
    const { AtmosphereRenderPipeline } = await import('/src/AtmosphereRenderPipeline.ts')
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    renderer.setSize(96, 64); renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.7
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(48, 1.5, .1, 100)
    const geometry = new THREE.PlaneGeometry(1, 1)
    const opaque = new THREE.MeshBasicMaterial({ color: new THREE.Color(2, .25, .05) })
    const transparent = new THREE.MeshBasicMaterial({ color: new THREE.Color(.1, .3, .6), transparent: true, opacity: .35, depthWrite: false })
    const left = new THREE.Mesh(geometry, opaque), right = new THREE.Mesh(geometry, transparent)
    left.position.set(-.6, 0, -2); right.position.set(.6, 0, -2); scene.add(left, right)
    const pipeline = new AtmosphereRenderPipeline(renderer)
    const read = () => {
      const pixels = new Uint8Array(96 * 64 * 4), gl = renderer.getContext()
      gl.readPixels(0, 0, 96, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      return pixels
    }
    renderer.render(scene, camera); const direct = read()
    pipeline.render(scene, camera); const hdr = read()
    const pixel = (pixels, x, y) => Array.from(pixels.slice((y * 96 + x) * 4, (y * 96 + x) * 4 + 4))
    const colors = [24, 72].map(x => ({ direct: pixel(direct, x, 32), hdr: pixel(hdr, x, 32) }))
    // Transparent overlap must blend linear radiance before tone mapping.
    // Compare with a separately rendered opaque swatch of the analytic mixture.
    const background = new THREE.MeshBasicMaterial({ color: new THREE.Color(.02, .05, .2) })
    const back = new THREE.Mesh(geometry, background); back.position.set(.6, 0, -2.01); scene.add(back)
    pipeline.render(scene, camera); const blended = pixel(read(), 72, 32)
    const mixture = new THREE.MeshBasicMaterial({ color: transparent.color.clone().multiplyScalar(.35).add(background.color.clone().multiplyScalar(.65)) })
    right.material = mixture; back.visible = false
    renderer.render(scene, camera); const expectedBlend = pixel(read(), 72, 32)
    right.material = transparent; scene.remove(back)
    pipeline.render(scene, camera)
    // Sample the actual depth attachment on the GPU, reconstruct view z, and
    // encode distance/10 directly in red (without tone mapping or sRGB).
    const depthMaterial = new THREE.ShaderMaterial({
      uniforms: { depthMap: { value: pipeline.target.depthTexture }, inverseProjection: { value: camera.projectionMatrixInverse } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D depthMap; uniform mat4 inverseProjection;
        void main() { vec2 uv = vec2(.25, .5); float depth = texture2D(depthMap, uv).x;
          vec4 p = inverseProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          gl_FragColor = vec4(-p.z / p.w / 10.0, 0.0, 0.0, 1.0); }`,
    })
    const depthScene = new THREE.Scene(), depthGeometry = new THREE.PlaneGeometry(2, 2)
    depthScene.add(new THREE.Mesh(depthGeometry, depthMaterial))
    renderer.render(depthScene, camera); const depthRed = pixel(read(), 48, 32)[0]
    pipeline.render(scene, camera)
    const memory = renderer.info.memory.textures
    for (let i = 0; i < 8; i++) {
      renderer.setPixelRatio(i % 2 + 1); renderer.setSize(96 + i, 64 + i)
      pipeline.render(scene, camera)
    }
    const afterResize = renderer.info.memory.textures
    const dimensions = pipeline.metrics()
    const preserved = { toneMapping: renderer.toneMapping === THREE.ACESFilmicToneMapping, autoReset: renderer.info.autoReset, target: renderer.getRenderTarget() === null }
    const render = renderer.render
    let threw = false
    renderer.render = () => { throw new Error('Injected rendering failure') }
    try { pipeline.render(scene, camera) } catch { threw = true } finally { renderer.render = render }
    const failureRestoredState = threw && renderer.getRenderTarget() === null && renderer.info.autoReset
    const fallback = new AtmosphereRenderPipeline(renderer, { forceDirect: true })
    fallback.render(scene, camera); const fallbackMetrics = fallback.metrics(); fallback.dispose()
    // Exercise a missing extension independently from the explicit bypass.
    const has = renderer.extensions.has.bind(renderer.extensions)
    renderer.extensions.has = name => name === 'EXT_color_buffer_float' ? false : has(name)
    const unsupported = new AtmosphereRenderPipeline(renderer)
    unsupported.render(scene, camera); const unsupportedMetrics = unsupported.metrics(); unsupported.dispose()
    renderer.extensions.has = has
    pipeline.dispose(); pipeline.dispose()
    const afterDispose = renderer.info.memory.textures
    geometry.dispose(); opaque.dispose(); transparent.dispose(); background.dispose(); mixture.dispose(); depthGeometry.dispose(); depthMaterial.dispose(); renderer.dispose()
    return { colors, blended, expectedBlend, depthRed, memory, afterResize, afterDispose, dimensions, preserved, failureRestoredState, fallbackMetrics, unsupportedMetrics }
  })
  for (const color of report.fixture.colors) {
    color.hdr.forEach((value, channel) => assert.ok(Math.abs(value - color.direct[channel]) <= 2, JSON.stringify(color)))
  }
  assert.ok(Math.abs(report.fixture.depthRed - 51) <= 1, 'resolved scene depth is not sampleable/reconstructable')
  report.fixture.blended.forEach((value, channel) => assert.ok(Math.abs(value - report.fixture.expectedBlend[channel]) <= 2, 'transparent layers did not blend linear radiance'))
  assert.equal(report.fixture.memory, report.fixture.afterResize)
  assert.equal(report.fixture.afterDispose, 0)
  assert.deepEqual(report.fixture.preserved, { toneMapping: true, autoReset: true, target: true })
  assert.equal(report.fixture.failureRestoredState, true)
  assert.equal(report.fixture.fallbackMetrics.mode, 'direct')
  assert.equal(report.fixture.unsupportedMetrics.mode, 'direct')
  assert.match(report.fixture.unsupportedMetrics.fallbackReason, /unavailable/)

  for (const [body, lat, lon, altitude] of [
    ['sun', 0, 0, 2e9], ['earth', 40, -5, 2e7], ['moon', 26.13, 3.63, 300000],
    ['mars', -12, -70, 300000], ['venus', 65, 3, 300000], ['saturn', 25, 15, 2e8],
    ['earth', 60.38, 25, 12000], ['moon', 26.13, 3.63, 12000], ['mars', -12, -70, 12000],
  ]) {
    await page.evaluate(({ body, lat, lon, altitude }) => terrainPilot.location(body, lat, lon, altitude), { body, lat, lon, altitude })
    await page.waitForTimeout(1800)
    if (['moon', 'mars', 'venus'].includes(body)) {
      await page.waitForFunction(body => terrainPilot.metrics().global[body].visible > 0, body, { timeout: 45000 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    }
    const comparison = await page.evaluate(() => {
      const scene = __atmosphereScene, renderer = scene.renderer, gl = renderer.getContext()
      const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight
      const a = new Uint8Array(width * height * 4), b = new Uint8Array(a.length)
      renderer.render(scene.scene, scene.camera)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, a)
      scene.renderFrame()
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, b)
      let sum = 0, opaqueSum = 0, count = 0, changed = 0
      for (let i = 0; i < a.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(a[i + c] - b[i + c]); sum += d
          if (a[i + 3] === 255 && b[i + 3] === 255) { opaqueSum += d; count++ }
          if (d > 8) changed++
        }
      }
      const before = scene.renderPipeline.metrics().frames
      terrainPilot.sample()
      const metrics = terrainPilot.metrics()
      return { meanChannelDifference: sum / (width * height * 3), opaqueMeanDifference: opaqueSum / Math.max(1, count), changedChannels: changed,
        terrain: metrics.global[scene.selected] ?? metrics.regional[scene.selected] ?? null,
        screenshotUsesPipeline: scene.renderPipeline.metrics().frames === before + 1, ...scene.renderPipeline.metrics() }
    })
    await page.screenshot({ path: `${output}/${body}-${altitude}.png` })
    assert.equal(comparison.mode, 'linear-hdr')
    assert.equal(comparison.screenshotUsesPipeline, true)
    // Rings over the globe now blend in linear HDR rather than after each
    // material's tone mapping. The analytic overlap fixture above validates
    // that deliberate change; allow it separately from opaque surface parity.
    assert.ok(comparison.opaqueMeanDifference < (body === 'saturn' ? 6 : 2), `${body}: opaque rendering differs: ${JSON.stringify(comparison)}`)
    assert.ok(comparison.meanChannelDifference < 3, `${body}: overall rendering differs: ${JSON.stringify(comparison)}`)
    report.views.push({ body, altitude, ...comparison })
  }
  const canvas = page.locator('.scene canvas')
  const bounds = await canvas.boundingBox()
  await page.mouse.move(bounds.width * .5, bounds.height * .4)
  await page.mouse.down()
  await page.mouse.move(bounds.width * .62, bounds.height * .46, { steps: 16 })
  await page.mouse.up()
  await page.mouse.wheel(0, -160)
  await page.waitForTimeout(800)
  report.motion = await page.evaluate(() => {
    const scene = __atmosphereScene
    scene.renderFrame()
    return { finiteCamera: scene.camera.position.toArray().every(Number.isFinite), glError: scene.renderer.getContext().getError(), ...scene.renderPipeline.metrics() }
  })
  assert.equal(report.motion.finiteCamera, true); assert.equal(report.motion.glError, 0)
  await page.screenshot({ path: `${output}/moving-close-terrain.png` })
  for (const viewport of [{ width: 412, height: 915 }, { width: 1300, height: 800 }]) {
    await page.setViewportSize(viewport)
    await page.waitForTimeout(300)
    const metrics = await page.evaluate(() => terrainPilot.metrics().renderPipeline)
    assert.equal(metrics.width, viewport.width); assert.equal(metrics.height, viewport.height)
    assert.ok(metrics.estimatedAttachmentBytes <= 80 * 1024 * 1024)
  }
  await page.screenshot({ path: `${output}/resized.png` })
  assert.deepEqual(report.errors, [])
  report.completed = true
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
console.log('HDR output, alpha, sampled depth, fallback, resize/disposal, nine real scene comparisons and close camera motion passed.')
