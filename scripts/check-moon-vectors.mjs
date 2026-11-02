import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const output = resolve('.terrain-cache/moon-vectors/browser')
const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5173'
const terrainOnly = process.argv.includes('--terrain')
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const report = { cases: [], errors: [] }
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
    terrainPilot.location('moon', 10, -15, 6000000)
    terrainPilot.metrics()
    window.__vectorScene.setTerrainShadows(false)
  })
  await page.waitForFunction(() => {
    const scene = window.__vectorScene
    return scene.terrain.get('moon').metrics().ready && scene.moonRasterColor?.image?.width === 8192
  }, null, { timeout: 60000 })
  const snapshot = () => page.evaluate(() => {
    const s = window.__vectorScene, map = s.bodies.get('moon').material.map
    const meshes = [...s.terrain.get('moon').nodes.values()].filter(n => s.terrain.get('moon').group.visible && n.mesh?.visible)
    return { mode: s.moonColorMode, canvas: map.image instanceof HTMLCanvasElement,
      size: [map.image.width, map.image.height], position: s.camera.position.toArray(),
      sameTerrainMap: meshes.every(n => n.mesh.material.map === map), metrics: terrainPilot.metrics().global.moon,
      pixels: terrainPilot.sample() }
  })
  // Compare palettes on the same globe geometry, then check measured terrain
  // separately. This avoids conflating color changes with ongoing terrain LOD.
  await page.getByRole('button', { name: 'Terrain on', exact: true }).click()
  await page.waitForTimeout(500)
  await page.evaluate(() => { window.__vectorScene.pilotAltitude = null })
  const baseline = await snapshot()
  await page.screenshot({ path: resolve(output, 'original.png') })
  report.cases.push({ name: 'original', ...baseline })
  for (const mode of terrainOnly ? ['10'] : ['6', '10', '16']) {
    console.log('Checking palette', mode)
    await page.getByLabel('Moon color', { exact: true }).selectOption(mode)
    await page.waitForFunction(mode => window.__vectorScene.moonColorMode === mode, mode, { timeout: 60000 })
    await page.waitForTimeout(500)
    const current = await snapshot()
    assert.equal(current.canvas, true)
    assert.equal(current.sameTerrainMap, true)
    assert.deepEqual(current.size, [4096, 2048])
    assert.deepEqual(current.position, baseline.position)
    assert.notDeepEqual(current.pixels, baseline.pixels)
    const mismatches = await page.evaluate(async mode => {
      const manifest = await (await fetch(`/moon-vectors/${mode}/manifest.json`)).json()
      const context = window.__vectorScene.moonVectorColor.texture.image.getContext('2d')
      return manifest.checkSamples.filter(([x, y, index]) => {
        const actual = context.getImageData(x, y, 1, 1).data
        const hex = manifest.palette[index].slice(1)
        return actual[3] !== 255 || [0, 1, 2].some(i => actual[i] !== parseInt(hex.slice(i*2, i*2+2), 16))
      })
    }, mode)
    assert.deepEqual(mismatches, [], 'Vector tracing must preserve classified samples at every tile corner')
    report.cases.push({ name: mode, ...current })
    await writeFile(resolve(output, `results${terrainOnly ? '-terrain' : ''}.json`), JSON.stringify(report, null, 2))
    await page.screenshot({ path: resolve(output, `colors-${mode}.png`) })
    if (mode === '10') {
      const url = await page.evaluate(() => window.__vectorScene.moonVectorColor.texture.image.toDataURL())
      await writeFile(resolve(output, 'atlas-10.png'), Buffer.from(url.split(',')[1], 'base64'))
    }
  }
  if (terrainOnly) {
    await page.getByRole('button', { name: 'Terrain off', exact: true }).click()
    for (const [name, lat, lon, altitude] of [['dateline', 10, 179.99, 80000], ['north-pole', 89, 45, 80000], ['close', 26.13, 3.63, 1000]]) {
      console.log('Checking terrain', name)
      await page.evaluate(({lat, lon, altitude}) => terrainPilot.location('moon', lat, lon, altitude), {lat, lon, altitude})
      await page.waitForFunction(() => window.__vectorScene.terrain.get('moon').active, null, { timeout: 60000 })
      await page.waitForTimeout(2000)
      const current = await snapshot()
      assert.equal(current.sameTerrainMap, true)
      assert.ok(current.metrics.visible > 0)
      report.cases.push({ name, ...current })
      await page.screenshot({ path: resolve(output, `${name}.png`) })
    }
    assert.deepEqual(report.errors, [])
    report.completed = true
  } else {
  // Return to original while a new palette is in flight: late work cannot win.
  await page.getByLabel('Moon color', { exact: true }).selectOption('6')
  await page.getByLabel('Moon color', { exact: true }).selectOption('raster')
  await page.waitForTimeout(1000)
  const restored = await snapshot()
  assert.equal(restored.mode, 'raster'); assert.equal(restored.canvas, false)
  assert.deepEqual(restored.size, [8192, 4096])
  assert.equal(await page.evaluate(() => window.__vectorScene.bodies.get('moon').material.map === window.__vectorScene.moonRasterColor), true)
  report.cases.push({ name: 'cancel-and-restore', ...restored })
  // An unavailable tile must leave a usable original, with an honest UI state.
  await page.route('**/moon-vectors/6/0-0.json.gz', route => route.fulfill({ status: 503, body: '' }))
  await page.getByLabel('Moon color', { exact: true }).selectOption('6')
  await page.getByText('Vector colors unavailable · showing original image', { exact: true }).waitFor()
  assert.equal((await snapshot()).mode, 'raster')
  await page.unroute('**/moon-vectors/6/0-0.json.gz')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByLabel('Moon color', { exact: true }).selectOption('raster')
  await page.getByLabel('Moon color', { exact: true }).selectOption('6')
  await page.waitForFunction(() => window.__vectorScene.moonColorMode === '6', null, { timeout: 60000 })
  await page.screenshot({ path: resolve(output, 'phone.png') })
  assert.deepEqual(report.errors, [])
  report.completed = true
  }
  console.log('Vector color checks passed', terrainOnly ? '(terrain)' : '(palettes and controls)')
} finally {
  await writeFile(resolve(output, `results${terrainOnly ? '-terrain' : ''}.json`), JSON.stringify(report, null, 2))
  await browser.close()
}
