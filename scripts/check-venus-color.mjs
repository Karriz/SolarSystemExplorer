import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'
const metadata = JSON.parse(await readFile('public/textures/venus-color.json', 'utf8'))
const output = '.terrain-cache/venus-color/browser'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const report = { errors: [], samples: [], completed: false }
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) report.errors.push(m.text()) })
  const requests = []
  page.on('request', request => requests.push(request.url()))
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__venus=this;') })
  })
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => {
    terrainPilot.metrics()
    terrainPilot.date('2026-10-26T12:00:00Z')
    terrainPilot.location('venus', 20, 160, 300000)
  })
  await page.waitForFunction(() => terrainPilot.metrics().surfaces.venus.color === 'compact', null, { timeout: 120000 })
  await page.evaluate(() => {
    const s = __venus
    s.setTerrain(false, 'venus')
    s.setTerrainHillshade(false)
    s.setTerrainShadows(false)
    const material = s.bodies.get('venus').material
    const previous = material.onBeforeCompile, key = material.customProgramCacheKey()
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer)
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <opaque_fragment>', 'gl_FragColor=vec4(diffuseColor.rgb,1.0);')
        .replace('#include <tonemapping_fragment>', '')
    }
    material.customProgramCacheKey = () => key + '/venus-unlit-source-check'
    material.needsUpdate = true
  })
  for (const control of metadata.controlSamples) {
    // Aim at the recorded texel center; retain real GPU orientation and sRGB decoding.
    const { lat, lon } = control
    await page.evaluate(({ lat, lon }) => terrainPilot.location('venus', lat, lon, 30000), { lat, lon })
    await page.waitForTimeout(250)
    const actual = await page.evaluate(() => {
      const s = __venus
      s.renderer.render(s.scene, s.camera)
      const gl = s.renderer.getContext(), p = new Uint8Array(4)
      gl.readPixels(Math.floor(gl.drawingBufferWidth / 2), Math.floor(gl.drawingBufferHeight / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p)
      return [...p.slice(0, 3)]
    })
    assert.ok(actual.every((v, i) => Math.abs(v - control.srgb[i]) <= 6), `Venus GPU color/orientation ${lat},${lon}: ${actual} vs ${control.srgb}`)
    report.samples.push({ lat, lon, measured: control.measured, expected: control.srgb, actual })
  }
  assert.ok(!requests.some(u => /\/textures\/venus\.jpg/.test(u)), 'No overlapping legacy imagery')
  assert.equal(await page.locator('.info-card').getByRole('combobox').count(), 0)
  await page.screenshot({ path: `${output}/unlit-source-check.png` })
  await page.close()
  const fallback = await browser.newPage({ viewport: { width: 700, height: 600 } })
  fallback.on('pageerror', e => report.errors.push(e.message))
  await fallback.route('**/textures/venus-color.webp', route => route.abort())
  await fallback.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await fallback.waitForFunction(() => window.terrainPilot)
  await fallback.evaluate(() => terrainPilot.location('venus', 20, 160, 300000))
  await fallback.waitForFunction(() => terrainPilot.metrics().surfaces.venus.color === 'original', null, { timeout: 60000 })
  await fallback.getByRole('link', { name: 'Venera-informed basalt color model', exact: true }).waitFor()
  await fallback.getByRole('status').filter({ hasText: 'Compact color unavailable · showing inferred basalt reference' }).waitFor()
  report.inferredFallbackLabeled = true
  await fallback.close()
  assert.deepEqual(report.errors, [])
  report.completed = true
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
console.log('Venus GPU inferred basalt color and labeled fallback passed.')
