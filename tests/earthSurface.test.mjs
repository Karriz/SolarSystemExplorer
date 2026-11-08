import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { decodeEarthMask, decodeEarthSurface, rasterizeRings, materialClass, EARTH_CLASS, MASK_WIDTH, MASK_GUTTER, filterEarthMaterials, shoreDistance } from '../src/earthSurfaceData.ts'
import { earthMaskTransform } from '../src/earthSurfaceMaterial.ts'
import { EarthVectorSource, earthVectorAddress } from '../src/EarthVectorSource.ts'
import { EarthSurfaceRenderer, planEarthMasks } from '../src/EarthSurfaceRenderer.ts'
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
  assert.equal(fine.width, 520); assert.equal(fine.classes.length, 520 ** 2)
})

test('numeric polygon masks preserve holes, separate outers and buffered edges', () => {
  const rectangle = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
  const data = new Uint8Array(MASK_WIDTH ** 2)
  rasterizeRings([rectangle(-2, -2, 128, 256), rectangle(32, 32, 96, 96), rectangle(160, 0, 256, 256)], 256, i => data[i] = 1)
  const at = (x, y) => data[(y + MASK_GUTTER) * MASK_WIDTH + x + MASK_GUTTER]
  assert.equal(at(-1, 20), 1); assert.equal(at(20, 20), 1)
  assert.equal(at(50, 50), 0); assert.equal(at(140, 50), 0); assert.equal(at(180, 50), 1)
})

test('parent masks use local Mercator UVs with correct north/south and gutters', () => {
  const a = { z: 15, x: 18659, y: 9446 }, parent = earthVectorAddress(a)
  assert.deepEqual(parent, { z: 14, x: 9329, y: 4723 })
  assert.deepEqual(earthVectorAddress({ z: 8, x: -1, y: 10 }), { z: 8, x: 255, y: 10 })
  const t = earthMaskTransform(a, parent)
  assert.ok(Math.abs(t.x - 128 / MASK_WIDTH) < 1e-12)
  assert.ok(Math.abs(t.z - (MASK_GUTTER + 128) / MASK_WIDTH) < 1e-12)
  assert.ok(Math.abs(t.y + t.w - MASK_GUTTER / MASK_WIDTH) < 1e-12)
})

test('fractional coverage preserves subpixel water area and unknown material coverage', () => {
  const width = 8, aa = 4, fine = new Uint8Array((width * aa) ** 2)
  let wet = 0
  for (let y = 0; y < width * aa; y++) for (let x = 0; x < width * aa; x++) {
    if (x + y * .37 < 13.4) { fine[y * width * aa + x] = EARTH_CLASS.ocean; wet++ }
  }
  const { color, surface } = filterEarthMaterials(fine, width, aa)
  let coverage = 0
  for (let i = 0; i < width ** 2; i++) coverage += surface[i * 4] / 255
  assert.ok(surface.some((v, i) => i % 4 === 0 && v > 0 && v < 255), 'thin coverage must survive rasterization')
  assert.ok(Math.abs(coverage - wet / (aa * aa)) < .1, 'coverage must conserve mapped area')
  assert.equal(color.at(-1), 0, 'unmapped land must retain transparent palette coverage')
  assert.ok(color.some((v, i) => i % 4 === 3 && v > 0 && v < 255))
})

test('shore distance has stable sign, a subpixel zero crossing, and bounded interiors', () => {
  const width = 16, coverage = new Float32Array(width ** 2)
  for (let y = 0; y < width; y++) for (let x = 8; x < width; x++) coverage[y * width + x] = 1
  const distance = shoreDistance(coverage, width)
  assert.equal(distance[8 * width + 7], -.5)
  assert.equal(distance[8 * width + 8], .5)
  for (let x = 1; x < width; x++) assert.ok(distance[8 * width + x] > distance[8 * width + x - 1])
  assert.ok(shoreDistance(new Float32Array(width ** 2).fill(1), width).every(d => d === 8))
  assert.ok(shoreDistance(new Float32Array(width ** 2), width).every(d => d === -8))
})

test('surface mask planning follows projected pixels and overzooms vector geometry independently of DEM grids', () => {
  const a = { z: 15, x: 18659, y: 9446 }
  const patches = Array.from({ length: 32 }, (_, i) => ({ address: { ...a, x: a.x + i }, pixels: i === 0 ? 2000 : 30 }))
  const planned = planEarthMasks(patches)
  assert.equal(planned[0].size, 1024)
  assert.equal(planned[0].address.z, 15)
  assert.equal(planned[0].sourceZoom, 14)
  assert.equal(planned.at(-1).size, 128)
  assert.ok(planned.reduce((sum, p) => sum + p.size ** 2, 0) <= 2 * 1024 ** 2)
  const far = planEarthMasks([{ address: { z: 10, x: 480, y: 300 }, pixels: 600 }])[0]
  assert.equal(far.sourceZoom, 11, 'a coarse terrain mesh can use finer vector data')
})

test('overzoomed masks crop retained native geometry before filtering', () => {
  const native = { z: 12, x: 2329, y: 1181 }
  const child = { z: 13, x: native.x * 2, y: native.y * 2 }
  const mask = decodeEarthSurface([{ buffer: buffer(), address: native }], child, 128)
  assert.equal(mask.width, 136)
  assert.equal(mask.color.length, 136 ** 2 * 4)
  assert.equal(mask.surface.length, 136 ** 2 * 4)
  assert.ok(mask.classes.some(id => id === EARTH_CLASS.crop || id === EARTH_CLASS.forest))
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
    postMessage({ id, tiles, address, size }) {
      const deliver = () => this.onmessage?.({ data: { id, ...decodeEarthSurface(tiles, address, size) } })
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

test('surface refinement keeps detailed fallbacks drawable under replacement pressure', async t => {
  const oldFetch = globalThis.fetch, oldWorker = globalThis.Worker
  let requests = 0
  globalThis.Worker = class {
    postMessage({ id, tiles, address, size }) {
      queueMicrotask(() => this.onmessage?.({ data: { id, ...decodeEarthSurface(tiles, address, size) } }))
    }
    terminate() {}
  }
  globalThis.fetch = async url => {
    requests++
    return url.endsWith('/planet') ? { ok: true, json: async () => ({ maxzoom: 14, tiles: ['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'] }) }
      : { ok: true, arrayBuffer: async () => buffer() }
  }
  t.after(() => { globalThis.fetch = oldFetch; globalThis.Worker = oldWorker })
  const source = new EarthVectorSource(); t.after(() => source.dispose())
  const parents = [2329, 2330].map(x => ({ address: { z: 12, x, y: 1181 }, size: 1024, sourceZoom: 12, priority: 2000 }))
  source.update(parents, performance.now()); await flush()
  assert.equal(source.metrics().missingWanted, 0)
  const oldRequests = requests
  const children = parents.flatMap(p => [0, 1, 2, 3].map(i => ({ address: { z: 13, x: p.address.x * 2 + i % 2, y: p.address.y * 2 + Math.floor(i / 2) }, size: 512, sourceZoom: 12, priority: 1000 })))
  source.update(children, performance.now())
  // Exercise repeated render updates before the asynchronous replacement can
  // finish. Every child must retain its detailed parent, not the zoom-8 backup.
  for (let frame = 0; frame < 8; frame++) {
    for (const child of children) assert.equal(source.entry(child.address)?.address.z, 12,
      'visible detail must remain resident until replacement masks are ready')
    assert.ok(source.metrics().memoryBytes <= source.budget)
    source.update(children, performance.now())
  }
  await flush()
  source.update(children, performance.now()); await flush()
  assert.equal(source.metrics().missingWanted, 0, 'retained parents must not block replacement masks')
  assert.equal(requests, oldRequests, 'overzoom re-rasterizes cached native vectors without new downloads')
  for (const child of children) assert.equal(source.entry(child.address).address.z, 13)
  assert.ok(source.metrics().memoryBytes <= source.cacheBudget, 'retired masks release the replacement reserve')
  source.clear(); await flush()
  assert.equal(source.metrics().memoryBytes, 0)
})

test('cancelling a worker build allows immediate reuse without a failure backoff', async t => {
  const oldFetch = globalThis.fetch, oldWorker = globalThis.Worker
  let pause = true
  globalThis.Worker = class {
    postMessage({ id, tiles, address, size }) {
      if (!pause) queueMicrotask(() => this.onmessage?.({ data: { id, ...decodeEarthSurface(tiles, address, size) } }))
    }
    terminate() {}
  }
  globalThis.fetch = async url => url.endsWith('/planet')
    ? { ok: true, json: async () => ({ maxzoom: 14, tiles: ['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'] }) }
    : { ok: true, arrayBuffer: async () => buffer() }
  t.after(() => { globalThis.fetch = oldFetch; globalThis.Worker = oldWorker })
  const source = new EarthVectorSource(), a = { z: 8, x: 145, y: 73 }; t.after(() => source.dispose())
  source.update([a], performance.now()); await flush()
  assert.ok(source.metrics().requests > 0)
  source.clear(); await flush()
  assert.equal(source.metrics().failed, 0)
  pause = false
  source.update([a], performance.now()); await flush()
  assert.ok(source.metrics().ready, 'returning to Earth must not wait for an artificial retry delay')
})

test('surface LOD hysteresis retains mask resolution and native source detail near thresholds', () => {
  const address = { z: 10, x: 480, y: 300 }
  let plan = planEarthMasks([{ address, pixels: 950 }])
  assert.equal(plan[0].size, 1024)
  for (const pixels of [890, 910, 850, 901]) {
    plan = planEarthMasks([{ address, pixels }], plan)
    assert.equal(plan[0].size, 1024)
  }
  plan = planEarthMasks([{ address, pixels: 700 }], plan)
  assert.equal(plan[0].size, 512)
  for (const pixels of [899, 901, 1000]) {
    plan = planEarthMasks([{ address, pixels }], plan)
    assert.equal(plan[0].size, 512)
  }
  plan = planEarthMasks([{ address, pixels: 150 }])
  assert.equal(plan[0].sourceZoom, 10)
  for (const pixels of [179, 181, 200]) {
    plan = planEarthMasks([{ address, pixels }], plan)
    assert.equal(plan[0].sourceZoom, 10)
  }
  plan = planEarthMasks([{ address, pixels: 220 }], plan)
  assert.equal(plan[0].sourceZoom, 11)
  for (const pixels of [181, 179, 150]) {
    plan = planEarthMasks([{ address, pixels }], plan)
    assert.equal(plan[0].sourceZoom, 11)
  }
})
