import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const option = (flag, fallback) => { const i = process.argv.indexOf(flag); return i < 0 ? fallback : process.argv[i + 1] }
const url = option('--url', 'http://127.0.0.1:5173').replace(/\/$/, '')
const output = resolve(option('--output', '.terrain-cache/wac-global/browser'))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: option('--executable', undefined), args: ['--no-sandbox'] })
const errors = [], results = []
async function settle(page) {
  let stable = 0, previous = ''
  for (let i = 0; i < 180; i++) {
    const sample = await page.evaluate(() => { const g = window.__wacScene.terrain.get('moon'); return { signature: g.surfaceSignature(), metrics: terrainPilot.metrics() } })
    const m = sample.metrics.global.moon
    stable = m.ready && !m.requests && sample.signature === previous ? stable + 1 : 0
    previous = sample.signature
    if (stable >= 5) return sample.metrics
    await page.waitForTimeout(300)
  }
  throw new Error('Moon terrain did not settle')
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.route('**/src/ExplorerScene.ts*', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, body: (await response.text()).replace('pilotMetrics() {', 'pilotMetrics() { window.__wacScene=this;') })
  })
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/i.test(m.text())) errors.push(m.text()) })
  await page.goto(`${url}/?terrainPilot=1`)
  await page.waitForFunction(() => window.terrainPilot)
  await page.evaluate(() => { terrainPilot.date('2026-10-22T12:00:00Z'); terrainPilot.metrics() })
  for (const [name, lat, lon, date] of [['hadley', 26.13, 3.63, '2026-10-22T12:00:00Z'], ['far-side', -15, 170, '2026-11-06T12:00:00Z'], ['dateline', 10, 179.9, '2026-11-06T12:00:00Z'], ['north', 85, 45, '2026-10-22T12:00:00Z'], ['south', -85, 45, '2026-10-22T12:00:00Z']]) {
    if (option('--case', name) !== name) continue
    await page.evaluate(({lat, lon, date}) => { terrainPilot.date(date); terrainPilot.location('moon', lat, lon, 30000) }, {lat, lon, date})
    await settle(page)
    await page.evaluate(({lat, lon}) => terrainPilot.location('moon', lat, lon, 30000), {lat, lon})
    await settle(page)
    await page.getByRole('button', {name:'WAC detail on'}).click()
    const button = page.getByRole('button', { name: 'WAC detail off' })
    await button.waitFor()
    const before = await page.evaluate(() => ({ pixels: terrainPilot.sample(), position: __wacScene.camera.position.toArray() }))
    await page.screenshot({ path: resolve(output, `${name}-off.png`) })
    await button.click()
    await page.getByRole('button', { name: 'WAC detail on' }).waitFor()
    for (let i=0;i<(Math.abs(lat) >= 80 ? 5 : 90);i++) { const v=await page.evaluate(()=>terrainPilot.metrics().global.moon.wac); if(v.cached >= 5 && v.requests===0) break; await page.waitForTimeout(1000) }
    const after = await page.evaluate(() => ({ pixels: terrainPilot.sample(), position: __wacScene.camera.position.toArray(), metrics: terrainPilot.metrics() }))
    await page.screenshot({ path: resolve(output, `${name}-on.png`) })
    const difference = before.pixels.reduce((sum, value, i) => sum + Math.abs(value - after.pixels[i]), 0) / before.pixels.length
    if (Math.abs(lat) >= 80 && after.metrics.global.moon.wac.source === 'remote-display') assert.ok(difference < .1, `${name}: polar fallback changed (${difference})`)
    else assert.ok(after.metrics.global.moon.wac.cached > 0, `${name}: no WAC imagery loaded`)
    assert.ok(after.metrics.global.moon.wac.memoryBytes <= after.metrics.global.moon.wac.budget)
    if (name === 'hadley' || name === 'far-side') assert.ok(difference > .05, `${name}: WAC did not alter the rendered sample (${difference})`)
    assert.deepEqual(after.position, before.position)
    assert.ok(Math.abs(after.metrics.altitudeMeters - 30000) < 2)
    results.push({ name, difference, sunElevation: after.metrics.sunElevationDegrees, wac: after.metrics.global.moon.wac })
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, errors }, null, 2))
    console.log(name, 'difference', difference.toFixed(3), 'cached', after.metrics.global.moon.wac.cached)
    await page.getByRole('button', { name: 'WAC detail on' }).waitFor()
  }
  assert.deepEqual(errors, [])
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ results, errors }, null, 2))
  console.log(JSON.stringify(results))
} finally { await browser.close() }
