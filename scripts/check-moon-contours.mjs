import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const output = resolve('.terrain-cache/moon-vectors/contours')
const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5173'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const report = { cases: [], errors: [], completed: false }
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) report.errors.push(m.text()) })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__vectorScene=this;') })
  })
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => {
    terrainPilot.date('2026-10-26T12:00:00Z')
    terrainPilot.location('moon', 26.13, 3.63, 12000)
    terrainPilot.metrics()
    __vectorScene.setTerrainShadows(false)
    __vectorScene.setSurfaceDetail(false)
  })
  await page.waitForFunction(() => terrainPilot.metrics().global.moon.ready, null, { timeout: 60000 })
  const snapshot = () => page.evaluate(() => ({ mode: __vectorScene.moonColorMode,
    patch: __vectorScene.moonVectorColor.metrics(), terrain: terrainPilot.metrics().global.moon,
    camera: __vectorScene.camera.position.toArray() }))
  let point
  for (const mode of ['10-diagonal', '10-smooth', '10']) {
    console.log('Checking', mode)
    await page.getByLabel('Moon color', { exact: true }).selectOption(mode)
    await page.waitForFunction(mode => __vectorScene.moonColorMode === mode, mode, { timeout: 60000 })
    if (mode !== '10') {
      point = await page.evaluate(() => __vectorScene.moonVectorColor.previewPoint())
      assert.ok(point)
      await page.getByRole('button', { name: 'Boundary close-up', exact: true }).click()
      await page.waitForFunction(() => __vectorScene.surfaces.moon.vectorColorReady.value === 1, null, { timeout: 60000 })
    }
    await page.waitForTimeout(1200)
    // Pixel-exact checks on safe interiors of the exported global coverage.
    const mismatches = await page.evaluate(async mode => {
      const manifest = await (await fetch(`/moon-vectors/${mode}/manifest.json`)).json()
      const ctx = __vectorScene.moonVectorColor.texture.image.getContext('2d')
      return manifest.checkSamples.filter(([x,y,index]) => {
        const p = ctx.getImageData(x,y,1,1).data, hex = manifest.palette[index].slice(1)
        return p[3] !== 255 || [0,1,2].some(i => p[i] !== parseInt(hex.slice(i*2,i*2+2),16))
      })
    }, mode)
    assert.deepEqual(mismatches, [])
    if (mode !== '10') {
      const comparison = await page.evaluate(() => {
        const state = __vectorScene.surfaces.moon
        state.vectorColorReady.value = 0
        const base = terrainPilot.sample()
        state.vectorColorReady.value = 1
        const sharp = terrainPilot.sample()
        return { base, sharp }
      })
      const difference = comparison.base.reduce((sum, value, i) => sum + Math.abs(value - comparison.sharp[i]), 0) / comparison.base.length
      assert.ok(difference > .02, `Close redraw did not change GPU pixels: ${difference}`)
      const patch = await snapshot()
      assert.ok(patch.patch.ready)
      assert.ok(patch.patch.patchBytes < 12 * 1048576)
      const texture = await page.evaluate(() => __vectorScene.surfaces.moon.vectorColorMap.value.image.toDataURL())
      await writeFile(resolve(output, `${mode}-patch.png`), Buffer.from(texture.split(',')[1], 'base64'))
      report.cases.push({ mode, difference, ...patch })
    }
    await page.screenshot({ path: resolve(output, `${mode}.png`) })
  }
  // Same smooth geometry with and without adaptive redraw, same camera/mesh.
  await page.getByLabel('Moon color', { exact: true }).selectOption('10-smooth')
  await page.waitForFunction(() => __vectorScene.moonColorMode === '10-smooth', null, { timeout: 60000 })
  await page.evaluate(point => terrainPilot.location('moon', point.lat, point.lon, 1000), point)
  await page.waitForFunction(() => __vectorScene.moonVectorColor.metrics().ready, null, { timeout: 60000 })
  await page.waitForTimeout(2000)
  await page.evaluate(() => { __vectorScene.pilotAltitude = null })
  await page.screenshot({ path: resolve(output, 'close-sharp.png') })
  const before = await snapshot()
  await page.waitForTimeout(1500)
  const after = await snapshot()
  assert.deepEqual(after.camera, before.camera)
  assert.equal(after.patch.builds, before.patch.builds, 'Stationary view must reuse its color window')
  await page.evaluate(() => { __vectorScene.surfaces.moon.vectorColorReady.value = 0 })
  await page.screenshot({ path: resolve(output, 'close-atlas.png') })
  await page.evaluate(() => { __vectorScene.surfaces.moon.vectorColorReady.value = 1 })
  // Release a live close texture, rather than only testing cleanup after a
  // polar fallback has already dropped it.
  await page.evaluate(() => {
    window.__patchDisposed = false
    __vectorScene.moonVectorColor.patch.addEventListener('dispose', () => { window.__patchDisposed = true })
  })
  await page.getByLabel('Moon color', { exact: true }).selectOption('raster')
  assert.equal((await snapshot()).patch.ready, false)
  assert.equal(await page.evaluate(() => window.__patchDisposed && __vectorScene.surfaces.moon.vectorColorMap.value === null), true)
  await page.getByLabel('Moon color', { exact: true }).selectOption('10-smooth')
  await page.waitForFunction(() => __vectorScene.moonColorMode === '10-smooth' && __vectorScene.moonVectorColor.metrics().ready, null, { timeout: 60000 })
  for (const [name, lat, lon] of [['dateline',10,179.999], ['tile-edge',26,0], ['pole',89,45]]) {
    await page.evaluate(({lat,lon}) => terrainPilot.location('moon',lat,lon,12000), {lat,lon})
    await page.waitForTimeout(2500)
    const current = await snapshot()
    assert.equal(current.patch.ready, name !== 'pole')
    report.cases.push({ name, ...current })
    await page.screenshot({ path: resolve(output, `${name}.png`) })
  }
  // Switching away cancels pending loads and drops the close texture/uniform.
  await page.getByLabel('Moon color', { exact: true }).selectOption('10-diagonal')
  await page.getByLabel('Moon color', { exact: true }).selectOption('raster')
  await page.waitForTimeout(700)
  assert.equal((await snapshot()).mode, 'raster')
  assert.equal((await snapshot()).patch.ready, false)
  assert.equal(await page.evaluate(() => __vectorScene.surfaces.moon.vectorColorMap.value), null)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Moon color', { exact: true }).selectOption('10-smooth')
  await page.waitForFunction(() => __vectorScene.moonColorMode === '10-smooth', null, { timeout: 60000 })
  await page.getByRole('button', { name: 'Boundary close-up', exact: true }).click()
  await page.waitForFunction(() => __vectorScene.moonVectorColor.metrics().ready, null, { timeout: 60000 })
  await page.screenshot({ path: resolve(output, 'phone.png') })
  await page.evaluate(() => __vectorScene.focus('mars'))
  await page.waitForFunction(() => !__vectorScene.moonVectorColor.metrics().ready)
  assert.equal(await page.evaluate(() => __vectorScene.surfaces.moon.vectorColorMap.value), null)
  // Three palette entries, with black unused: an antialiased diagonal between
  // gray 180 and gray 220 must blend near 200, never leak the black background.
  await page.route('**/moon-vectors/10/manifest.json', route => route.fulfill({ json: {
    schema: 1, width: 16, height: 16, tileSize: 16,
    palette: ['#000000', '#b4b4b4', '#dcdcdc', ...Array(7).fill('#000000')],
    tiles: [{ x: 0, y: 0, file: 'fixture.json' }],
  } }))
  await page.route('**/moon-vectors/10/fixture.json', route => route.fulfill({ json: {
    paths: ['', 'M0,0L16,16L0,16Z', 'M0,0L16,0L16,16Z', ...Array(7).fill('')],
  } }))
  const edge = await page.evaluate(async () => {
    const { MoonVectorColor } = await import('/src/MoonVectorColor.ts')
    const renderer = new MoonVectorColor(), texture = await renderer.load('10')
    const pixel = Array.from(texture.image.getContext('2d').getImageData(8,8,1,1).data)
    texture.dispose(); renderer.dispose()
    return pixel
  })
  assert.equal(edge[3], 255)
  assert.ok(edge.slice(0,3).every(v => v >= 198 && v <= 202), `Antialiasing introduced a seam: ${edge}`)
  report.antialiasedEdge = edge
  assert.deepEqual(report.errors, [])
  report.completed = true
  console.log('Shared contours, close redraw, stationary reuse, wrap, cancellation, and phone checks passed')
} finally {
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
