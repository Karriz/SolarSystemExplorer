import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const option = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] }
const url = option('--url', 'http://127.0.0.1:5173/')
const output = resolve(option('--output', '.terrain-cache/pilot/continuity'))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: !process.argv.includes('--headed'), executablePath: option('--executable', undefined), args: ['--no-sandbox'] })
const report = { generatedAt: new Date().toISOString(), browser: browser.version(), cases: [], errors: [], completed: false }
try {
  const viewport = process.argv.includes('--phone') ? { width: 390, height: 844 } : { width: 1280, height: 900 }
  report.viewport = viewport
  const page = await browser.newPage({ viewport })
  page.on('pageerror', e => report.errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' && /THREE|shader|WebGLProgram/.test(m.text())) report.errors.push(m.text().slice(0,2000)) })
  let networkBytes = 0, requests = 0
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  cdp.on('Network.loadingFinished', e => { networkBytes += e.encodedDataLength })
  cdp.on('Network.requestWillBeSent', () => requests++)
  console.log('Opening terrain preview…')
  await page.goto(`${url.replace(/\/$/, '')}/?terrainPilot=1`)
  console.log('Waiting for scene…')
  await page.waitForFunction(() => window.terrainPilot)
  await page.getByRole('button', { name: 'Close information panel', exact: true }).click()
  report.hardware = await page.evaluate(() => {
    const gl = document.querySelector('canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    return { renderer, software: /SwiftShader|llvmpipe|software/i.test(renderer), userAgent: navigator.userAgent, cores: navigator.hardwareConcurrency, deviceMemoryGiB: navigator.deviceMemory }
  })
  // Neighboring points straddle a native zoom-8 root-selection change near 25°E.
  // Coast/ocean and below-sea-level land are deliberately separate checks.
  let startedCase = !option('--start-at', '')
  for (const [name, lat, lon, altitude] of [
    ['coast',60.15,24.98,1000], ['open-sea',59.9,24.98,1000],
    ['below-sea-level-land',52.58,4.82,1000],
    ['root-west',60.38,24.60,12000], ['root-east',60.38,24.62,12000],
    ['orbit-fallback',60.38,25,4000000],
  ]) {
    if (name === option('--start-at', '')) startedCase = true
    if (!startedCase || option('--case', name) !== name) continue
    report.currentCase = name
    console.log(`Checking ${name}…`)
    const before = { networkBytes, requests }, started = Date.now()
    await page.evaluate(({lat,lon,altitude}) => { window.terrainPilot.date('2026-06-21T10:00:00Z'); window.terrainPilot.point(lat,lon,altitude) }, {lat,lon,altitude})
    let peakTrackedBytes = 0, metrics, settled = false, stable = 0, previous = ''
    while (Date.now() - started < 90000) {
      metrics = await page.evaluate(() => window.terrainPilot.metrics())
      const m = metrics.regional.earth, image = m.imagery
      const total = Object.values(metrics.regional).reduce((sum, r) => sum + r.memoryBytes + (r.imagery?.memoryBytes ?? 0), 0)
      peakTrackedBytes = Math.max(peakTrackedBytes, total)
      assert.ok(m.memoryBytes <= 48*1024*1024); assert.ok(image.memoryBytes <= 32*1024*1024)
      assert.ok(m.triangles <= m.triangleBudget)
      const signature = JSON.stringify([m.cached, m.visible, image.cached])
      stable = m.requests === 0 && image.requests === 0 && signature === previous ? stable + 1 : 0
      previous = signature
      if (stable >= 6 && (altitude > 319000 || m.ready)) { settled = true; break }
      await page.waitForTimeout(500)
    }
    const frameTimes = await page.evaluate(() => new Promise(resolve => {
      const samples=[]; let previous
      function frame(now) { if(previous!==undefined)samples.push(now-previous);previous=now
        if(samples.length<60)requestAnimationFrame(frame);else {samples.sort((a,b)=>a-b);resolve({medianMs:samples[30],p95Ms:samples[57],samples:samples.length})} }
      requestAnimationFrame(frame)
    }))
    const heap = await cdp.send('Runtime.getHeapUsage')
    await page.screenshot({ path: resolve(output, `${name}.png`) })
    const record = { name, lat, lon, altitude, settled, elapsedMs:Date.now()-started, peakTrackedBytes,
      networkBytes:networkBytes-before.networkBytes, requests:requests-before.requests, frameTimes, heap, metrics }
    report.cases.push(record)
    await writeFile(resolve(output,'results.json'),JSON.stringify(report,null,2)+'\n')
    console.log(JSON.stringify({name,settled,peakTrackedMiB:peakTrackedBytes/1048576,p95Ms:frameTimes.p95Ms,failed:metrics.regional.earth.failed}))
    if(altitude>319000) assert.equal(metrics.regional.earth.ready,false)
    else assert.ok(settled,`${name} did not settle`)
    assert.equal(report.errors.length,0)
  }
  report.completed = true
} catch (error) {
  report.failure = String(error)
  throw error
} finally {
  await writeFile(resolve(output,'results.json'),JSON.stringify(report,null,2)+'\n')
  await browser.close()
}
