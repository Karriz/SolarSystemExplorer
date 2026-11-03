import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'
const output = '.terrain-cache/planet-surfaces-browser'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const report = { errors: [], cases: [], completed: false }

async function open(options = {}) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } })
  page.on('pageerror', error => report.errors.push(error.message))
  page.on('console', message => {
    if (message.type() === 'error' && /THREE|shader|WebGLProgram/.test(message.text())) report.errors.push(message.text())
  })
  // Inspect ownership without exposing a scene reference in the application UI.
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__planetScene=this;') })
  })
  if (options.failColor) await page.route('**/textures/moon-color.webp', route => route.abort())
  if (options.failOriginal) await page.route('**/textures/moon.jpg', route => route.abort())
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => { terrainPilot.metrics(); terrainPilot.date('2026-10-26T12:00:00Z') })
  return page
}

async function visit(page, body, lat, lon, altitude = 300000) {
  await page.evaluate(({ body, lat, lon, altitude }) => terrainPilot.location(body, lat, lon, altitude), { body, lat, lon, altitude })
  await page.waitForFunction(body => {
    const m = terrainPilot.metrics()
    const layer = __planetScene.terrain.get(body)
    const pendingMeshes = [...layer.wanted].some(key => !layer.nodes.get(key)?.mesh)
    return m.global[body].ready && !m.global[body].requests && !pendingMeshes
      && m.surfaces[body].color !== 'loading' && m.hillshade[body].ready
      && !m.hillshade[body].requests && !m.hillshade[body].missingWanted
  }, body, { timeout: 120000 })
  await page.waitForTimeout(800)
}

async function noRenderingControls(page) {
  const panel = page.locator('.info-card')
  assert.equal(await panel.getByRole('combobox').count(), 0)
  assert.equal(await panel.getByRole('button', { name: /^(Terrain|Shadows|Hillshade|Surface detail|View Valles|Hadley|Tycho|Boundary)/ }).count(), 0)
  assert.equal(await panel.locator('.pilot-places').count(), 0)
}

try {
  const page = await open()
  const requests = []
  page.on('request', request => requests.push(request.url()))
  // Neither surface's color/detail should load while viewing the Solar System.
  assert.ok(await page.evaluate(() => [...__planetScene.planetSurfaces.values()].every(s => !s.started)))
  for (const [body, lat, lon] of [['moon', 26.13, 3.63], ['mars', -12, -70], ['mercury', 20, 160], ['venus', 65, 3]]) {
    await visit(page, body, lat, lon)
    await noRenderingControls(page)
    const state = await page.evaluate(body => {
      const scene = __planetScene, surface = scene.planetSurfaces.get(body)
      return {
        owner: surface.constructor.name, color: surface.metrics().color,
        detail: surface.state.detail.value, hillshade: scene.terrainHillshade.value,
        exaggeration: surface.terrain.exaggeration, terrain: surface.terrain.metrics(),
        colorDimensions: [surface.color.texture.image.width, surface.color.texture.image.height],
        ownsTerrain: surface.terrain === scene.terrain.get(body),
      }
    }, body)
    assert.equal(state.owner, 'PlanetSurfaceRenderer')
    assert.equal(state.color, 'compact')
    assert.equal(state.detail, 1)
    assert.equal(state.hillshade, 1)
    assert.equal(state.exaggeration, 1)
    assert.equal(state.terrain.projection, 'cube-sphere')
    assert.ok(state.ownsTerrain)
    assert.deepEqual(state.colorDimensions, [4096, 2048])
    if (body === 'moon') assert.ok(!requests.some(u => /mars-(color|detail|medium-detail)/.test(u)))
    const screenshot = await page.screenshot({ path: `${output}/${body}-after.png` })
    let baselineMeanDifference
    if (process.env.PLANET_SURFACE_BASELINE && body !== 'mercury') {
      const before = await readFile(`${process.env.PLANET_SURFACE_BASELINE}/${body}-before.png`)
      baselineMeanDifference = await page.evaluate(async ({ before, after }) => {
        const pixels = async data => {
          const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode()
          const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height
          const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0)
          return ctx.getImageData(270, 100, 450, 440).data
        }
        const a = await pixels(before), b = await pixels(after)
        let sum = 0
        for (let i = 0; i < a.length; i++) if (i % 4 !== 3) sum += Math.abs(a[i] - b[i])
        return sum / (a.length / 4 * 3)
      }, { before: before.toString('base64'), after: screenshot.toString('base64') })
      console.log(body, 'baseline mean channel difference:', baselineMeanDifference)
    }
    report.cases.push({ body, ...state, baselineMeanDifference })
  }
  assert.ok(!requests.some(u => /\/textures\/(moon|mars)\.jpg|vectors|color-reference/.test(u)))
  // Other bodies' controls cannot alter the fixed Moon/Mars defaults.
  await page.evaluate(() => {
    __planetScene.setTerrain(false, 'earth')
    __planetScene.setTerrainExaggeration(4, 'earth')
    __planetScene.setTerrainShadows(false, 'earth')
  })
  for (const body of ['moon', 'mars']) {
    await visit(page, body, 10, 179.9, 100000)
    assert.ok(await page.evaluate(body => {
      const s = __planetScene.planetSurfaces.get(body)
      return s.terrain.enabled && s.terrain.exaggeration === 1 && s.state.detail.value === 1
    }, body))
  }
  await page.setViewportSize({ width: 412, height: 915 })
  await noRenderingControls(page)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: `${output}/phone.png` })
  await page.close()

  for (const failOriginal of [false, true]) {
    const fallback = await open({ failColor: true, failOriginal })
    await visit(fallback, 'moon', 26.13, 3.63)
    assert.equal(await fallback.evaluate(() => terrainPilot.metrics().surfaces.moon.color), failOriginal ? 'unavailable' : 'original')
    await fallback.getByRole('status').filter({ hasText: failOriginal ? 'placeholder' : 'original image' }).waitFor()
    await noRenderingControls(fallback)
    await fallback.close()
  }
  // An image decoded after disposal must be closed rather than attached.
  const late = await open()
  await late.evaluate(() => {
    const surface = __planetScene.planetSurfaces.get('moon')
    surface.loadDetail = () => {}
    const bitmap = { closed: false, close() { this.closed = true } }
    window.__lateBitmap = bitmap
    surface.color.load = () => new Promise(resolve => { window.__finishColor = () => resolve({ image: bitmap, dispose() { bitmap.close() } }) })
    terrainPilot.location('moon', 26.13, 3.63, 300000)
  })
  await late.waitForFunction(() => window.__finishColor)
  await late.evaluate(() => {
    __planetScene.planetSurfaces.get('moon').dispose()
    __finishColor()
  })
  await late.waitForFunction(() => __lateBitmap.closed)
  await late.close()
  assert.deepEqual(report.errors, [])
  report.completed = true
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
console.log('Shared Moon/Mars/Mercury/Venus rendering, fixed defaults, lazy assets, fallback, disposal and phone UI passed.')
