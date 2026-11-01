import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] }
const output = resolve(option('--output', '.terrain-cache/moon-material'))
const url = option('--url', 'http://127.0.0.1:5173').replace(/\/$/, '')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM, args: ['--no-sandbox'] })
const report = { cases: [], errors: [], completed: false }
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) report.errors.push(m.text()) })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__materialScene=this;') })
  })
  async function settle() {
    let stable = 0, last = ''
    for (let i = 0; i < 160 && stable < 5; i++) {
      const m = await page.evaluate(() => __materialScene.terrain.get('moon').metrics())
      const key = JSON.stringify([m.visible, m.cached, m.maxLevel])
      stable = m.ready && !m.requests && key === last ? stable + 1 : 0; last = key
      await page.waitForTimeout(200)
    }
    assert.ok(stable >= 5)
    await page.evaluate(() => { __materialScene.pilotAltitude = null })
  }
  async function open() {
    await page.goto(`${url}/?terrainPilot=1`)
    await page.waitForFunction(() => window.terrainPilot)
    await page.evaluate(() => {
      terrainPilot.metrics()
      const s = __materialScene, g = s.terrain.get('moon')
      s.setTerrainShadows(false)
      window.__materialWork = { builds: 0, buildMs: 0, longTasks: [] }
      const original = g.geometry.bind(g)
      g.geometry = (...args) => {
        const start = performance.now(), result = original(...args)
        __materialWork.builds++; __materialWork.buildMs += performance.now() - start
        return result
      }
      new PerformanceObserver(list => __materialWork.longTasks.push(...list.getEntries().map(e => e.duration))).observe({ type: 'longtask' })
      terrainPilot.date('2026-10-19T12:00:00Z')
      terrainPilot.location('moon', 26.13, 3.63, 100)
    })
    await page.getByRole('button', { name: 'Close information panel', exact: true }).click()
    await settle()
  }
  const snapshot = () => page.evaluate(() => {
    const s = __materialScene, g = s.terrain.get('moon'), texture = s.surfaces.moon.detailMap.value, medium = s.surfaces.moon.mediumDetailMap.value
    return { work: { ...__materialWork }, metrics: g.metrics(), signature: g.surfaceSignature(),
      geometries: [...g.nodes.values()].filter(n => n.mesh).map(n => n.mesh.geometry.id),
      wanted: [...g.wanted].sort(), textureReady: s.surfaces.moon.detailMapReady.value,
      mediumReady: s.surfaces.moon.mediumDetailReady.value,
      materialTexture: texture ? { width: texture.image.width, height: texture.image.height, mipmaps: texture.generateMipmaps } : null,
      mediumTexture: medium ? { width: medium.image.width, height: medium.image.height, mipmaps: medium.generateMipmaps } : null,
      programs: s.renderer.info.programs.length, textures: s.renderer.info.memory.textures }
  })
  await open()
  await page.waitForFunction(() => __materialScene.surfaces.moon.detailMapReady.value === 1 && __materialScene.surfaces.moon.mediumDetailReady.value === 1)
  const baseline = await snapshot()
  assert.equal(baseline.metrics.maxLevel, 8)
  assert.deepEqual(baseline.materialTexture, { width: 512, height: 512, mipmaps: true })
  assert.deepEqual(baseline.mediumTexture, { width: 512, height: 512, mipmaps: true })
  report.cases.push({ name: 'cold', ...baseline })
  for (const enabled of [false, true, false, true]) {
    await page.evaluate(enabled => {
      __materialWork.builds = 0; __materialWork.buildMs = 0; __materialWork.longTasks = []
      terrainPilot.detail(enabled)
    }, enabled)
    await page.waitForTimeout(700)
    const current = await snapshot()
    assert.equal(current.work.builds, 0)
    assert.equal(current.metrics.requests, 0)
    assert.equal(current.signature, baseline.signature)
    assert.deepEqual(current.geometries, baseline.geometries)
    assert.deepEqual(current.wanted, baseline.wanted)
    assert.equal(current.metrics.memoryBytes, baseline.metrics.memoryBytes)
    assert.equal(current.programs, baseline.programs)
    assert.equal(current.textures, baseline.textures)
    report.cases.push({ name: enabled ? 'on' : 'off', ...current })
    await page.screenshot({ path: resolve(output, `detail-${enabled ? 'on' : 'off'}.png`) })
  }
  report.frameTimes = await page.evaluate(() => new Promise(resolve => {
    const times = []; let last
    function frame(now) {
      if (last !== undefined) times.push(now - last)
      last = now
      if (times.length < 30) requestAnimationFrame(frame)
      else { times.sort((a, b) => a - b); resolve({ medianMs: times[15], p95Ms: times[28] }) }
    }
    requestAnimationFrame(frame)
  }))
  report.renderer = await page.evaluate(() => {
    const gl = __materialScene.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  })
  for (const altitude of [500, 2500, 8000, 12000]) {
    console.log('Checking material scale', altitude)
    await page.evaluate(altitude => { terrainPilot.detail(true); terrainPilot.location('moon', 26.13, 3.63, altitude) }, altitude)
    await settle()
    const current = await snapshot()
    const onPixels = await page.evaluate(() => terrainPilot.sample())
    await page.screenshot({ path: resolve(output, `scale-${altitude}-on.png`) })
    await page.evaluate(() => terrainPilot.detail(false))
    await page.waitForTimeout(300)
    const offPixels = await page.evaluate(() => terrainPilot.sample())
    const meanDifference = onPixels.reduce((sum, value, i) => sum + Math.abs(value - offPixels[i]), 0) / onPixels.length
    assert.ok(meanDifference > 0, `material detail disappeared at ${altitude} m`)
    const off = await snapshot()
    assert.deepEqual(off.geometries, current.geometries)
    assert.equal(off.signature, current.signature)
    report.cases.push({ name: `scale-${altitude}`, meanDifference, ...current })
    await page.screenshot({ path: resolve(output, `scale-${altitude}-off.png`) })
    await page.evaluate(() => terrainPilot.detail(true))
  }
  await page.route('**/textures/moon-detail.png', route => route.abort())
  await open()
  const fallback = await snapshot()
  assert.equal(fallback.textureReady, 0)
  assert.equal(fallback.mediumReady, 1, 'medium detail remains usable without the fine texture')
  assert.equal(fallback.metrics.maxLevel, 8)
  assert.ok(fallback.metrics.ready)
  report.cases.push({ name: 'fine-texture-unavailable', ...fallback })
  await page.route('**/textures/moon-medium-detail.png', route => route.abort())
  await open()
  const noDetail = await snapshot()
  assert.equal(noDetail.textureReady, 0); assert.equal(noDetail.mediumReady, 0)
  assert.ok(noDetail.metrics.ready)
  report.cases.push({ name: 'textures-unavailable', ...noDetail })
  assert.deepEqual(report.errors, [])
  report.completed = true
} finally {
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
