import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.VECTOR_PREVIEW_URL || 'http://127.0.0.1:5175'
const output = '.terrain-cache/hillshade-check'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
const report = { errors: [], cases: [] }
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => {
    if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) report.errors.push(m.text())
  })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__hillshadeScene=this;') })
  })
  await page.goto(`${url}/?terrainPilot=1`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => {
    terrainPilot.metrics()
    __hillshadeScene.setSurfaceDetail(false)
    __hillshadeScene.setTerrainShadows(false)
  })
  for (const [body, lat, lon, altitude] of [['moon', 26.13, 3.63, 100000], ['mars', -14, -59, 500000]]) {
    await page.evaluate(({ body, lat, lon, altitude }) => terrainPilot.location(body, lat, lon, altitude), { body, lat, lon, altitude })
    await page.waitForFunction(body => {
      const m = terrainPilot.metrics().global[body]
      return m.ready && m.visible > 0 && !m.requests
    }, body, { timeout: 120000 })
    await page.waitForTimeout(1500)
    const result = await page.evaluate(() => {
      const s = __hillshadeScene, gl = s.renderer.getContext()
      const render = enabled => {
        s.setTerrainHillshade(enabled)
        s.renderer.render(s.scene, s.camera)
        const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4)
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
        return pixels
      }
      const off = render(false), offImage = s.renderer.domElement.toDataURL('image/png')
      const on = render(true), onImage = s.renderer.domElement.toDataURL('image/png')
      const offAgain = render(false)
      let changedPixels = 0, maxDifference = 0, totalDifference = 0, repeatDifference = 0
      for (let i = 0; i < off.length; i += 4) {
        let difference = 0
        for (let c = 0; c < 3; c++) {
          difference = Math.max(difference, Math.abs(off[i+c] - on[i+c]))
          repeatDifference += Math.abs(off[i+c] - offAgain[i+c])
        }
        if (difference >= 2) changedPixels++
        maxDifference = Math.max(maxDifference, difference)
        totalDifference += difference
      }
      s.setTerrainHillshade(true)
      return { changedPixels, maxDifference, meanDifference: totalDifference / (off.length / 4), repeatDifference, metrics: s.pilotMetrics().global[s.selected], offImage, onImage }
    })
    for (const mode of ['off', 'on']) {
      await writeFile(`${output}/${body}-${mode}.png`, Buffer.from(result[`${mode}Image`].split(',')[1], 'base64'))
      delete result[`${mode}Image`]
    }
    report.cases.push({ body, ...result })
    console.log(body, JSON.stringify(result))
    assert.ok(result.changedPixels > 1000, `${body}: hillshade must visibly change terrain pixels`)
    assert.ok(result.maxDifference >= 5, `${body}: hillshade contrast is too small`)
    assert.equal(result.repeatDifference, 0, `${body}: toggle must be reversible with a fixed scene`)
  }
  assert.deepEqual(report.errors, [])
  report.completed = true
} finally {
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2))
  await browser.close()
}
