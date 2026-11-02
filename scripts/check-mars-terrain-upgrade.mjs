import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { resolve, sep } from 'node:path'

const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'
const catalog = JSON.parse(await readFile('public/terrain/catalog.json', 'utf8'))
const staging = process.env.MARS_TERRAIN_STAGING ? resolve(process.env.MARS_TERRAIN_STAGING) : null
let release = process.env.MARS_TERRAIN_RELEASE || catalog.bodies.mars
const manifest = JSON.parse(await readFile(staging ? `${staging}/manifest.json` : `public/terrain/${release}`, 'utf8'))
if (staging && !process.env.MARS_TERRAIN_RELEASE) release = `mars/${manifest.version}/manifest.json`
const label = process.env.MARS_TERRAIN_LABEL || manifest.version
const output = `.terrain-cache/mars-upgrade/${label}`
await mkdir(output, { recursive: true })
const report = { release, stagingPreview: !!staging, sourceResolutionMeters: manifest.sourceResolutionMeters, errors: [], cases: [], completed: false }
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) report.errors.push(m.text()) })
  await page.route('**/terrain/catalog.json', async route => {
    const response = await route.fetch(), data = await response.json()
    data.bodies.mars = release
    await route.fulfill({ response, json: data })
  })
  if (staging) {
    const directory = release.slice(0, release.lastIndexOf('/') + 1), prefix = `/terrain/${directory}`
    await page.route(`**${prefix}**`, async route => {
      const relative = new URL(route.request().url()).pathname.split(prefix)[1]
      const path = resolve(staging, relative)
      assert.ok(path.startsWith(staging + sep))
      // The publisher moves the already-complete directory atomically after
      // validation. Continue reading it there if that happens during a check.
      const body = await readFile(path).catch(() => readFile(resolve('public/terrain', directory, relative)))
      await route.fulfill({ body, contentType: relative.endsWith('.json') ? 'application/json' : 'application/octet-stream' })
    })
  }
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__marsUpgrade=this;') })
  })
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => {
    terrainPilot.metrics()
    terrainPilot.date('2026-10-26T12:00:00Z')
    const s = __marsUpgrade
    s.setTerrainShadows(false)
    s.__upgradeRender = s.renderer.render
    // Preserve the normal streaming, camera and LOD updates; draw only
    // settled views so software rasterization cannot delay downloads.
    s.renderer.render = () => {}
  })
  await page.waitForFunction(() => __marsUpgrade.marsVectorColor.texture?.image?.width > 0, null, { timeout: 120000 })
  const settle = async () => {
    let previous = '', stable = 0
    for (let i = 0; i < 480; i++) {
      const state = await page.evaluate(() => {
        const layer = __marsUpgrade.terrain.get('mars')
        return { metrics: layer.metrics(), pending: [...layer.wanted].filter(k => !layer.nodes.get(k)?.mesh).length }
      })
      const signature = JSON.stringify([state.metrics.cached, state.metrics.visible, state.metrics.maxLevel, state.pending])
      stable = state.metrics.ready && !state.metrics.requests && !state.pending && signature === previous ? stable + 1 : 0
      previous = signature
      if (stable >= 4) return state.metrics
      if (i % 60 === 0) console.log('Streaming', JSON.stringify(state))
      await page.waitForTimeout(250)
    }
    throw Error('Mars terrain did not settle')
  }
  const cases = [['valles-orbit', -12, -70, 300000], ['valles-wall', -9.38671875, -78.93359375, 12000]]
  if (process.env.MARS_EXTENDED_CHECK) cases.push(['north-pole',90,0,30000],['south-pole',-90,0,30000],['face-edge',0,45,30000],['face-corner',35.26438968,45,30000],['dateline',10,179.99,30000])
  for (const [name, lat, lon, altitude] of cases) {
    console.log('Checking', label, name)
    await page.evaluate(({ lat, lon, altitude }) => terrainPilot.location('mars', lat, lon, altitude), { lat, lon, altitude })
    await settle()
    await page.evaluate(({ lat, lon, altitude }) => terrainPilot.location('mars', lat, lon, altitude), { lat, lon, altitude })
    const metrics = await settle()
    assert.equal(metrics.projection, 'cube-sphere')
    assert.equal(metrics.failed, 0)
    assert.ok(metrics.triangles <= 400000)
    assert.ok(metrics.memoryBytes <= 128 * 1048576)
    if (name === 'valles-wall') assert.equal(metrics.dataMaxLevel, manifest.maxZoom)
    await page.evaluate(() => { __marsUpgrade.pilotAltitude = null })
    const signatures = []
    for (let i = 0; i < 8; i++) {
      signatures.push(await page.evaluate(() => { const layer = __marsUpgrade.terrain.get('mars'); return JSON.stringify([[...layer.wanted].sort(),layer.surfaceSignature()]) }))
      await page.waitForTimeout(150)
    }
    assert.equal(new Set(signatures).size,1,'Stationary terrain selection changed')
    const sample = await page.evaluate(({ lat, lon }) => {
      const s = __marsUpgrade, layer = s.terrain.get('mars')
      const point = s.camera.position.clone(), normal = point.clone()
      if (!layer.sampleSurface(lat, lon, point, normal)) throw Error('Missing physical surface')
      return { heightMeters: (point.length() - 1) * 3389500, normal: normal.toArray(), sunElevationDegrees: s.pilotMetrics().sunElevationDegrees }
    }, { lat, lon })
    for (const enabled of [false, true]) {
      const png = await page.evaluate(enabled => {
        const s = __marsUpgrade
        s.setTerrainHillshade(enabled)
        s.__upgradeRender.call(s.renderer, s.scene, s.camera)
        return s.renderer.domElement.toDataURL('image/png').split(',')[1]
      }, enabled)
      await writeFile(`${output}/${name}-hillshade-${enabled ? 'on' : 'off'}.png`, Buffer.from(png, 'base64'))
    }
    report.cases.push({ name, lat, lon, altitude, metrics, ...sample })
    await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  }
  assert.deepEqual(report.errors, [])
  report.completed = true
  console.log('Mars terrain upgrade comparison passed', label)
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
