import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

// Requires the Vite dev server. Pass --executable /path/to/brave to reproduce
// the privacy-protected canvas path in Brave without changing its settings.
const option = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback
const base = option('--url', 'http://localhost:5173/').replace(/\/$/, '')
const executablePath = option('--executable', undefined)
const fixtures = JSON.parse(await readFile(new URL('../tests/fixtures/mapterhorn/reference.json', import.meta.url), 'utf8'))
const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/?terrainPilot=1`)
  await page.waitForFunction(() => window.terrainPilot)
  console.log('Browser:', browser.version(), await page.evaluate(async () => ({ brave: !!navigator.brave && await navigator.brave.isBrave() })))
  for (const fixture of fixtures) {
    const result = await page.evaluate(async fixture => {
      const bytes = await (await fetch(`/tests/fixtures/mapterhorn/${fixture.file}`)).arrayBuffer()
      const { default: decode, init } = await import('/node_modules/@jsquash/webp/decode.js')
      await init({ locateFile: () => '/node_modules/@jsquash/webp/codec/dec/webp_dec.wasm' })
      const pixels = await decode(bytes)
      const hash = data => crypto.subtle.digest('SHA-256', data).then(value => Array.from(new Uint8Array(value), b => b.toString(16).padStart(2, '0')).join(''))
      const exactHash = await hash(pixels.data)
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
      const canvas = new OffscreenCanvas(512, 512), ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(bitmap, 0, 0)
      const readback = ctx.getImageData(0, 0, 512, 512).data
      let changedPixels = 0, maxHeightError = 0
      for (let i = 0; i < readback.length; i += 4) {
        const error = (readback[i] - pixels.data[i]) * 256 + readback[i + 1] - pixels.data[i + 1] + (readback[i + 2] - pixels.data[i + 2]) / 256
        if (error !== 0) changedPixels++
        maxHeightError = Math.max(maxHeightError, Math.abs(error))
      }
      bitmap.close()
      // Exercise the actual worker and its Vite-resolved WASM asset as well.
      const worker = new Worker('/src/earthTerrain.worker.ts', { type: 'module' })
      const heights = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Elevation worker timed out')), 15000)
        worker.onerror = event => { clearTimeout(timer); reject(Error(event.message)) }
        worker.onmessage = event => { clearTimeout(timer); event.data.error ? reject(Error(event.data.error)) : resolve(event.data.heights) }
        worker.postMessage({ id: 1, buffer: bytes, address: fixture.address }, [bytes])
      }).finally(() => worker.terminate())
      return { exactHash, canvasMatches: await hash(readback) === exactHash, changedPixels, maxHeightError,
        samples: heights.length, min: Math.min(...heights), max: Math.max(...heights), finite: heights.every(Number.isFinite) }
    }, fixture)
    console.log(fixture.name, JSON.stringify(result))
    assert.equal(result.exactHash, fixture.rgbaSha256, 'WASM pixels must match independent GDAL reference')
    assert.equal(result.samples, 129 * 129); assert.ok(result.finite)
    assert.ok(result.min >= fixture.min && result.max <= fixture.max, 'Worker must preserve source height bounds')
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}
