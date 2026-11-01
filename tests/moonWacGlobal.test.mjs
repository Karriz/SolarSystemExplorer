import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { MoonWacGlobal } from '../src/MoonWacGlobal.ts'
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)) }

test('global WAC tiles request the geographic source, bind to the correct material, and release memory', async t => {
  const urls = []
  t.mock.method(globalThis, 'fetch', async url => { urls.push(String(url)); return new Response(new Blob(['png'], {type:'image/png'}), {headers: {'content-type':'image/png'}}) })
  let closed = 0
  const oldBitmap = globalThis.createImageBitmap
  globalThis.createImageBitmap = async () => ({ width: 256, height: 256, close() { closed++ } })
  t.after(() => { globalThis.createImageBitmap = oldBitmap })
  const layer = new MoonWacGlobal(), material = new THREE.MeshStandardMaterial()
  layer.configure(material)
  const shader = { uniforms: {}, fragmentShader: '#include <map_fragment>', vertexShader: '' }
  material.onBeforeCompile(shader, {})
  const a = { z: 8, x: 261, y: 90 }
  layer.setEnabled(true); layer.update([a], 1000); await flush()
  assert.equal(urls.length, 1)
  const u = new URL(urls[0]); assert.equal(u.searchParams.get('LAYERS'), 'luna_wac_normalized_reflectance'); assert.equal(u.searchParams.get('SRS'), 'EPSG:4326')
  assert.ok(layer.metrics().memoryBytes <= layer.metrics().budget)
  layer.bind(a); assert.equal(shader.uniforms.wacGlobalActive.value, 1)
  assert.ok(shader.uniforms.wacGlobalMap.value instanceof THREE.Texture)
  layer.bind({ z: 8, x: 300, y: 90 }); assert.equal(shader.uniforms.wacGlobalActive.value, 0)
  layer.setEnabled(false); assert.equal(closed, 1); assert.equal(layer.metrics().memoryBytes, 0)
  layer.dispose()
})

test('cancelled WAC requests cannot attach after clearing or disposal', async t => {
  let done
  t.mock.method(globalThis, 'fetch', (_url, options) => new Promise((resolve, reject) => {
    done = resolve; options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  }))
  const layer = new MoonWacGlobal(); layer.setEnabled(true); layer.update([{z: 5, x: 30, y: 12}], 1000)
  assert.equal(layer.metrics().requests, 1); layer.dispose(); await flush()
  assert.equal(layer.metrics().requests, 0); assert.equal(layer.metrics().memoryBytes, 0); assert.equal(layer.metrics().cached, 0)
  done(new Response(null, {status: 200}))
})

test('global WAC requests stay bounded and cancel off-screen requests', async t => {
  const requests = []
  t.mock.method(globalThis, 'fetch', (_url, options) => new Promise((_resolve, reject) => {
    requests.push(options.signal); options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  }))
  const layer = new MoonWacGlobal(); layer.setEnabled(true)
  const tiles = Array.from({length: 48}, (_, x) => ({z: 8, x, y: 80}))
  layer.update(tiles, 1000)
  assert.equal(layer.metrics().requests, 3)
  assert.ok(layer.metrics().memoryBytes <= layer.metrics().budget)
  layer.update([], 1200); assert.ok(requests.every(signal => signal.aborted)); await flush()
  assert.equal(layer.metrics().requests, 0); assert.equal(layer.metrics().memoryBytes, 0)
  layer.dispose()
})

test('failed WAC responses keep the base color and back off before retrying', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => { count++; return new Response('unavailable', {status: 503}) })
  const layer = new MoonWacGlobal(), material = new THREE.MeshStandardMaterial()
  layer.configure(material)
  const shader = { uniforms: {}, fragmentShader: '#include <map_fragment>', vertexShader: '' }; material.onBeforeCompile(shader, {})
  const address = {z: 8, x: 220, y: 110}; const now = performance.now()
  layer.setEnabled(true); layer.update([address], now); await flush()
  assert.equal(count, 1); assert.equal(layer.metrics().failed, 1)
  layer.bind(address); assert.equal(shader.uniforms.wacGlobalActive.value, 0)
  layer.update([address], now + 1000); await flush(); assert.equal(count, 1)
  layer.update([address], now + 31000); await flush(); assert.equal(count, 2)
  layer.dispose()
})

test('the unstable polar cap uses the base color and does not request WAC tiles', async t => {
  let count = 0; t.mock.method(globalThis, 'fetch', async () => { count++; return new Response(null, {status: 503}) })
  const layer = new MoonWacGlobal(); layer.setEnabled(true)
  layer.update([{z: 8, x: 300, y: 0}, {z: 8, x: 300, y: 255}], performance.now()); await flush()
  assert.equal(count, 0); assert.equal(layer.metrics().memoryBytes, 0); layer.dispose()
})

test('a complete local numeric release replaces WMS and serves polar tiles with coverage', async t => {
  const urls = []
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url))
    if (String(url).endsWith('manifest.json')) return Response.json({ schema: 1, minZoom: 4, maxZoom: 8,
      size: 384, padDegrees: .18, encoding: 'webp-rg10-alpha-coverage' })
    return new Response(new Blob(['webp'], { type: 'image/webp' }), { headers: { 'content-type': 'image/webp' } })
  })
  const oldBitmap = globalThis.createImageBitmap
  globalThis.createImageBitmap = async () => ({ width: 384, height: 384, close() {} })
  t.after(() => { globalThis.createImageBitmap = oldBitmap })
  const layer = new MoonWacGlobal('http://localhost/terrain/moon/wac643-304ppd-v1/')
  const material = new THREE.MeshStandardMaterial(); layer.configure(material)
  const shader = { uniforms: {}, fragmentShader: '#include <map_fragment>', vertexShader: '' }
  material.onBeforeCompile(shader, {})
  layer.setEnabled(true); await flush()
  const polar = { z: 8, x: 256, y: 0 }
  layer.update([polar], performance.now()); await flush()
  assert.equal(layer.metrics().source, 'local-numeric')
  assert.ok(urls.some(url => url.endsWith('/4/16/0.webp')))
  assert.ok(urls.some(url => url.endsWith('/8/256/0.webp')))
  assert.ok(urls.every(url => !url.includes('wms.im-ldi.com')))
  layer.bind(polar); assert.equal(shader.uniforms.wacGlobalLocal.value, 1)
  assert.equal(shader.uniforms.wacGlobalActive.value, 1)
  assert.match(shader.fragmentShader, /centerSampleWac\.y/)
  layer.dispose()
})
