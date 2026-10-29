import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const value = flag => process.argv[process.argv.indexOf(flag) + 1]
const url = process.argv.includes('--url') ? value('--url') : 'http://127.0.0.1:5173/'
const output = resolve(process.argv.includes('--output') ? value('--output') : '.terrain-cache/pilot/browser')
await mkdir(output, { recursive: true })
const executablePath = process.argv.includes('--executable') ? value('--executable') : undefined
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] })
const report = { generatedAt: new Date().toISOString(), browser: browser.version(), cases: [], failures: [] }

async function settle(page, body) {
  let last = -1, stable = 0
  for (let i = 0; i < 120; i++) {
    const metrics = await page.evaluate(() => window.terrainPilot.metrics())
    const m = metrics.regional[body]
    if (m.ready && m.requests === 0 && m.cached === last) stable++; else stable = 0
    if (stable >= 3) return metrics
    last = m.cached
    await page.waitForTimeout(250)
  }
  throw Error(`Terrain did not settle: ${JSON.stringify(await page.evaluate(() => window.terrainPilot.metrics()))}`)
}

async function frames(page) {
  return page.evaluate(() => new Promise(resolve => {
    const samples = []; let previous
    const tick = now => {
      if (previous !== undefined) samples.push(now - previous)
      previous = now
      if (samples.length < 40) requestAnimationFrame(tick)
      else {
        samples.sort((a,b) => a-b)
        resolve({ medianMs: samples[20], p95Ms: samples[38], samples: samples.length })
      }
    }
    requestAnimationFrame(tick)
  }))
}

try {
  for (const [viewportName, viewport] of [['desktop', {width:1280,height:900}], ['phone',{width:390,height:844}], ['landscape',{width:844,height:390}]]) {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if(message.type() === 'error' && /THREE|shader|WebGLProgram/.test(message.text())) errors.push(message.text().slice(0,2000)) })
    await page.goto(`${url.replace(/\/$/,'')}/?terrainPilot=1`)
    await page.waitForFunction(() => window.terrainPilot)
    await page.getByRole('button',{name:'Close information panel',exact:true}).click()
    const glInfo = await page.evaluate(() => {
      const gl = document.querySelector('canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info')
      return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: gl.getParameter(gl.VENDOR) }
    })
    const cases = viewportName === 'desktop'
      ? [['finland',12000],['alps',12000],['namibia',24000],['hadley',12000],['hadley',100]]
      : [['alps',12000],['hadley',100]]
    for (const [id, altitude] of cases) {
      const body = id === 'hadley' ? 'moon' : 'earth'
      await page.evaluate(({id,altitude,body}) => {
        window.terrainPilot.date(body === 'earth' ? '2026-06-21T10:00:00Z' : '2026-10-26T12:00:00Z')
        window.terrainPilot.visit(id,altitude)
        window.terrainPilot.detail(true)
      },{id,altitude,body})
      const started = Date.now()
      const metrics = await settle(page,body)
      const settleMs = Date.now()-started
      assert.ok(metrics.regional[body].memoryBytes <= 48*1024*1024)
      assert.ok(metrics.regional[body].triangles <= metrics.regional[body].triangleBudget)
      if (body === 'earth') assert.ok(metrics.regional[body].imagery.memoryBytes <= 32*1024*1024)
      assert.equal(metrics.regional[body].failed,0)
      assert.ok(Math.abs(metrics.altitudeMeters-altitude)<2, `Altitude ${metrics.altitudeMeters}`)
      const on = await frames(page)
      await page.screenshot({path:resolve(output,`${viewportName}-${id}-${altitude}-detail.png`)})
      await page.evaluate(() => window.terrainPilot.detail(false))
      const off = await frames(page)
      await page.screenshot({path:resolve(output,`${viewportName}-${id}-${altitude}-plain.png`)})
      const colorMetrics = body === 'earth' ? (await page.evaluate(() => window.terrainPilot.metrics())).regional.earth.imagery : undefined
      const record = {viewportName,viewport,id,requestedAltitudeMeters:altitude,settleMs,metrics,colorMetrics,detailComparison:body === 'moon',detailOn:on,detailOff:off,glInfo,errors:[...errors]}
      report.cases.push(record)
      await writeFile(resolve(output,'results.json'),JSON.stringify(report,null,2)+'\n')
      console.log(`${viewportName} ${id} ${altitude}m: ${metrics.regional[body].visible} patches, ${(metrics.regional[body].memoryBytes/1048576).toFixed(1)} MiB tracked terrain, ${on.p95Ms.toFixed(1)}ms p95 RAF`)
      assert.equal(errors.length,0, errors.join('\n'))
    }
    // Ground-anchored input and zoom remain usable at the floor.
    await page.evaluate(() => window.terrainPilot.detail(true))
    const x=viewport.width*.55,y=viewport.height*.4
    await page.mouse.move(x,y);await page.mouse.down({button:'right'});await page.mouse.move(x+25,y-40,{steps:5});await page.mouse.up({button:'right'})
    await page.mouse.wheel(0,-100)
    await page.waitForTimeout(300)
    assert.equal(errors.length,0)
    await page.close()
  }
  const offline = await browser.newPage({viewport:{width:800,height:600}})
  await offline.route('https://tiles.mapterhorn.com/**',route=>route.abort())
  await offline.goto(`${url.replace(/\/$/,'')}/?terrainPilot=1`)
  await offline.waitForFunction(()=>window.terrainPilot)
  await offline.evaluate(()=>window.terrainPilot.visit('finland',12000))
  await offline.waitForFunction(()=>window.terrainPilot.metrics().regional.earth.failed>0)
  const failed = await offline.evaluate(()=>window.terrainPilot.metrics())
  assert.equal(failed.regional.earth.ready,false)
  await offline.evaluate(()=>window.terrainPilot.visit('hadley',12000))
  await settle(offline,'moon')
  const switched=await offline.evaluate(()=>window.terrainPilot.metrics())
  assert.equal(switched.regional.earth.memoryBytes,0)
  report.failures.push({scenario:'Earth source outage, fallback, then switch to measured Moon',failed,switched})
  await offline.close()
} finally {
  await writeFile(resolve(output,'results.json'),JSON.stringify(report,null,2)+'\n')
  await browser.close()
}
