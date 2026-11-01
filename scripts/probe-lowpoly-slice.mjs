import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] }
const url = option('--url', 'http://127.0.0.1:5173/').replace(/\/$/, '')
const output = resolve(option('--output', '.terrain-cache/lowpoly/probe-slice1'))
await mkdir(output, { recursive: true })
// The packaged headless shell misses system libraries in some environments;
// the full Chromium build carries them.
const executable = option('--executable', process.env.PLAYWRIGHT_CHROMIUM)
const browser = await chromium.launch({ headless: true, executablePath: executable, args: ['--no-sandbox'] })
const report = { cases: [], errors: [], console: [] }
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') report.console.push(m.type() + ': ' + m.text()) })
  await page.goto(url + '/?terrainPilot=1')
  await page.waitForFunction(() => window.terrainPilot)
  await page.getByRole('button', { name: 'Close information panel', exact: true }).click()
  await page.evaluate(() => terrainPilot.date('2026-10-26T12:00:00Z'))
  const views = [
    ['hadley-30km', 26.13, 3.63, 30000],
    ['hadley-1km', 26.13, 3.63, 1000],
    ['hadley-150m', 26.13, 3.63, 150],
    ['tycho-30km', -43.31, -11.36, 30000],
    ['north-polar-12km', 89.9, 45, 12000],
    ['orbit', 0, 0, 3000000],
  ]
  for (const [name, lat, lon, altitude] of views) {
    await page.evaluate(({ lat, lon, altitude }) => terrainPilot.location('moon', lat, lon, altitude), { lat, lon, altitude })
    const metrics = await page.waitForFunction(() => {
      const m = window.terrainPilot.metrics()
      const g = m.global?.moon
      return g && g.ready && g.requests === 0 ? { global: g } : null
    }, { timeout: 120000 }).then(h => h.jsonValue()).catch(() => null)
    await page.waitForTimeout(1500)
    await page.screenshot({ path: resolve(output, name + '.png') })
    const detail = await page.evaluate(() => window.terrainPilot.metrics())
    report.cases.push({ name, lat, lon, altitude, metrics: detail?.global?.moon })
    console.log(name, JSON.stringify(detail?.global?.moon))
  }
  report.completed = true
} finally {
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
  await browser.close()
}
console.log('errors:', JSON.stringify(report.errors), 'console:', JSON.stringify(report.console.slice(0, 10)))
