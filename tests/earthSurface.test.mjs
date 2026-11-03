import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { decodeEarthMask, rasterizeRings, materialClass, EARTH_CLASS, MASK_WIDTH } from '../src/earthSurfaceData.ts'
import { earthMaskTransform } from '../src/earthSurfaceMaterial.ts'
import { EarthVectorSource, earthVectorAddress } from '../src/EarthVectorSource.ts'
import { EarthSurfaceRenderer } from '../src/EarthSurfaceRenderer.ts'
import { mercatorBounds } from '../src/terrainPilot.ts'

const fixture = readFileSync(new URL('./fixtures/openfreemap/finland-z12.pbf', import.meta.url))
const buffer = () => fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength)
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }

test('real OpenFreeMap tile retains geographic surface classes and water ownership', () => {
  const mask = decodeEarthMask(buffer(), { z: 12, x: 2329, y: 1181 })
  assert.deepEqual(mask.counts, { landcover: 63, landuse: 11, water: 11, waterway: 4 })
  const ids = new Set(mask.classes)
  for (const name of ['forest', 'grass', 'crop', 'urban', 'wetland', 'lake']) assert.ok(ids.has(EARTH_CLASS[name]), name)
  assert.equal(materialClass('landcover', { class: 'rock' }), EARTH_CLASS.rock)
  assert.equal(mask.waters.length, 11)
  assert.ok(mask.waters.some(w => w.shore.length >= 3))
  assert.ok(mask.classes.some((id, i) => id === EARTH_CLASS.lake && mask.water[i] > 0))
  assert.equal(materialClass('water', { class: 'lake', brunnel: 'tunnel' }), 0)
  assert.equal(materialClass('water', { class: 'river', intermittent: 1 }), 0)
  assert.equal(materialClass('landuse', { class: 'unsupported' }), 0)
  const fine = decodeEarthMask(buffer(), { z: 14, x: 9329, y: 4723 })
  assert.equal(fine.width, 516); assert.equal(fine.classes.length, 516 ** 2)
})

test('numeric polygon masks preserve holes, separate outers and buffered edges', () => {
  const rectangle = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
  const data = new Uint8Array(MASK_WIDTH ** 2)
  rasterizeRings([rectangle(-2, -2, 128, 256), rectangle(32, 32, 96, 96), rectangle(160, 0, 256, 256)], 256, i => data[i] = 1)
  const at = (x, y) => data[(y + 2) * MASK_WIDTH + x + 2]
  assert.equal(at(-1, 20), 1); assert.equal(at(20, 20), 1)
  assert.equal(at(50, 50), 0); assert.equal(at(140, 50), 0); assert.equal(at(180, 50), 1)
})

test('parent masks use local Mercator UVs with correct north/south and gutters', () => {
  const a = { z: 15, x: 18659, y: 9446 }, parent = earthVectorAddress(a)
  assert.deepEqual(parent, { z: 14, x: 9329, y: 4723 })
  assert.deepEqual(earthVectorAddress({ z: 8, x: -1, y: 10 }), { z: 8, x: 255, y: 10 })
  const t = earthMaskTransform(a, parent)
  assert.ok(Math.abs(t.x - 128 / 260) < 1e-12)
  assert.ok(Math.abs(t.z - 130 / 260) < 1e-12)
  assert.ok(Math.abs(t.y + t.w - 2 / 260) < 1e-12)
})

test('water placement preserves negative dry land, flattens mapped ocean and uses lake-specific height', () => {
  const address = { z: 14, x: 9329, y: 4723 }, bounds = mercatorBounds(address)
  const classes = new Uint8Array(MASK_WIDTH ** 2), water = new Uint16Array(MASK_WIDTH ** 2)
  for (let y = 0; y < MASK_WIDTH; y++) for (let x = 0; x < MASK_WIDTH; x++) {
    const i = y * MASK_WIDTH + x
    if (x > MASK_WIDTH / 3 && x < MASK_WIDTH * 2 / 3) classes[i] = EARTH_CLASS.ocean
    if (x >= MASK_WIDTH * 2 / 3) { classes[i] = EARTH_CLASS.lake; water[i] = 1 }
  }
  let entry = { address, mask: { classes, water, waters: [{ key: 'lake' }] } }
  const owner = { vectors: { entry: () => entry }, lakeHeights: new Map([['lake', 123.5]]) }
  const original = new Float32Array(9 * 9).fill(-75)
  const heights = EarthSurfaceRenderer.prototype.waterHeights.call(owner, address, bounds, 9, original)
  assert.equal(heights[4 * 9], -75); assert.equal(heights[4 * 9 + 4], 0); assert.equal(heights[4 * 9 + 8], 123.5)
  assert.ok(original.every(h => h === -75), 'original measured grids remain authoritative')
  owner.lakeHeights.clear()
  assert.equal(EarthSurfaceRenderer.prototype.waterHeights.call(owner, address, bounds, 9, original)[4 * 9 + 8], -75)
  entry = { ...entry, address: { z: 13, x: Math.floor(address.x / 2), y: Math.floor(address.y / 2) } }
  assert.equal(EarthSurfaceRenderer.prototype.waterHeights.call(owner, address, bounds, 9, original), original, 'generalized parent cannot flood finer islands')
})

test('vector stream resolves metadata, shares masks, respects memory cap and rejects late results', async t => {
  const oldFetch = globalThis.fetch, oldWorker = globalThis.Worker
  let requests = 0, delayed = false, complete
  globalThis.Worker = class {
    postMessage({ id, buffer, address }) {
      const deliver = () => this.onmessage?.({ data: { id, ...decodeEarthMask(buffer, address) } })
      if (delayed) complete = deliver; else queueMicrotask(deliver)
    }
    terminate() {}
  }
  globalThis.fetch = async url => {
    requests++
    return url.endsWith('/planet') ? { ok: true, json: async () => ({ maxzoom: 14, tiles: ['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'] }) }
      : { ok: true, arrayBuffer: async () => buffer() }
  }
  t.after(() => { globalThis.fetch = oldFetch; globalThis.Worker = oldWorker })
  const source = new EarthVectorSource(), a = { z: 8, x: 145, y: 73 }
  t.after(() => source.dispose())
  source.update([a, a], performance.now()); await flush()
  assert.equal(requests, 2); assert.ok(source.metrics().ready)
  assert.ok(source.metrics().memoryBytes <= source.budget)
  assert.equal(source.entry({ z: 10, x: 580, y: 292 }), source.entry(a))
  const retainedTexture = source.entry(a).texture
  source.clear(); await flush(); assert.equal(source.metrics().memoryBytes, 0)
  assert.equal(retainedTexture.image.data.byteLength, 0, 'hidden bindings cannot retain evicted CPU mask pixels')
  delayed = true
  const late = new EarthVectorSource(); late.update([a], performance.now()); await flush(); late.dispose(); complete(); await flush()
  assert.equal(late.metrics().cached, 0); assert.equal(late.metrics().memoryBytes, 0)
})

test('failed vector tiles back off without removing the compact-color fallback', async t => {
  const oldFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async url => {
    if (url.endsWith('/planet')) return { ok: true, json: async () => ({ maxzoom: 14, tiles: ['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'] }) }
    requests++; throw Error('offline')
  }
  t.after(() => globalThis.fetch = oldFetch)
  const source = new EarthVectorSource(), a = { z: 8, x: 145, y: 73 }; t.after(() => source.dispose())
  source.update([a], performance.now()); await flush()
  assert.equal(source.entry(a), undefined); assert.equal(source.metrics().failed, 1)
  source.update([a], performance.now()); await flush(); assert.equal(requests, 1)
})
