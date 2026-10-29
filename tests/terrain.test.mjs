import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import * as THREE from 'three'
import { decodeTerrain } from '../src/terrainDecode.ts'
import { parseTerrainManifest, parseTerrainPage, terrainBounds, terrainGeometry } from '../src/terrain.ts'
import { GlobeTerrainLayer } from '../src/GlobeTerrainLayer.ts'

const sha = buffer => createHash('sha256').update(buffer).digest('hex')
const raw = Buffer.alloc(65 * 65 * 2)
for (let i = 0; i < 65 * 65; i++) raw.writeInt16LE(i - 2100, i * 2)
const compressed = gzipSync(raw)
const arrayBuffer = buffer => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
function manifest(maxZoom = 1) {
  const tiles = {}
  for (let z = 0; z <= maxZoom; z++) for (let x = 0; x < 2 ** (z + 1); x++) for (let y = 0; y < 2 ** z; y++)
    tiles[`${z}/${x}/${y}`] = { min: -1500, max: 1500, error: 5000, bytes: compressed.length, sha256: sha(compressed) }
  return { schema: 1, body: 'moon', version: 'test', grid: 'geographic-2x1', sampleSize: 65, maxZoom,
    encoding: 'gzip-int16-le', scaleMeters: .5, offsetMeters: 0, referenceRadiusMeters: 1737400,
    frame: 'MEAN EARTH/POLAR AXIS OF DE421', longitude: 'east-positive-minus180-to180', rowOrder: 'north-to-south',
    minHeightMeters: -1500, maxHeightMeters: 1500, credit: 'LOLA', sourceUrl: 'https://example.com',
    tileUrl: 'tiles/{z}/{x}/{y}.bin', tiles }
}

test('terrain decoding verifies compressed checksums and preserves signed half-metre heights', async () => {
  const heights = await decodeTerrain(arrayBuffer(compressed), 65, sha(compressed))
  assert.equal(heights[0], -1050)
  assert.equal(heights[4224], 1062)
  await assert.rejects(decodeTerrain(arrayBuffer(compressed), 65, '0'.repeat(64)), /checksum/)
  const short = gzipSync(raw.subarray(0, 20))
  await assert.rejects(decodeTerrain(arrayBuffer(short), 65, sha(short)), /length/)
})

test('per-body scale and missing elevation survive decoding without clipping Martian peaks', async () => {
  const raw = Buffer.alloc(8)
  ;[-32768, -8000, 0, 22000].forEach((v, i) => raw.writeInt16LE(v, i * 2))
  const payload = gzipSync(raw)
  const mars = await decodeTerrain(arrayBuffer(payload), 2, sha(payload), 1, -32768)
  assert.ok(Number.isNaN(mars[0]))
  assert.deepEqual([...mars.subarray(1)], [-8000, 0, 22000])
  const mercury = await decodeTerrain(arrayBuffer(payload), 2, sha(payload), .5, -32768)
  assert.equal(mercury[1], -4000)
})

function pagedManifest() {
  const m = manifest(4), all = m.tiles
  m.schema = 2; m.noData = -32768; m.sourceResolutionMeters = 473.802
  m.verticalDatum = 'Height above reference sphere'
  m.tiles = Object.fromEntries(Object.entries(all).filter(([key]) => Number(key.split('/')[0]) <= 3))
  m.indexPages = { rootZoom: 3, pages: {} }
  const pages = {}
  for (let x = 0; x < 16; x++) for (let y = 0; y < 8; y++) {
    const key = `${x}/${y}`
    const page = Object.fromEntries(Object.entries(all).filter(([address]) => {
      const [z, tx, ty] = address.split('/').map(Number)
      return z === 4 && Math.floor(tx / 2) === x && Math.floor(ty / 2) === y
    }))
    const payload = Buffer.from(JSON.stringify(page))
    pages[key] = payload
    m.indexPages.pages[key] = { url: `indices/${key}.json`, bytes: payload.length, sha256: sha(payload) }
  }
  return { m, pages }
}

test('paged manifests validate complete regional coverage and reject unrelated or missing entries', () => {
  const { m, pages } = pagedManifest()
  assert.equal(parseTerrainManifest(m).schema, 2)
  const page = JSON.parse(pages['0/0'])
  assert.equal(Object.keys(parseTerrainPage(page, m, '0/0')).length, 4)
  assert.throws(() => parseTerrainPage({}, m, '0/0'))
  assert.throws(() => parseTerrainPage({ ...page, '4/20/20': page['4/0/0'] }, m, '0/0'))
  delete m.indexPages.pages['15/7']
  assert.throws(() => parseTerrainManifest(m))
})

test('planetary contracts enforce each body reference surface and scale', () => {
  for (const [body, radius, scale, frame] of [['mars', 3389500, 1, 'IAU2000'], ['mercury', 2439400, .5, 'MESSENGER MDIS body-fixed'], ['venus', 6051000, 1, 'Magellan body-fixed']]) {
    const m = { ...manifest(), schema: 2, body, referenceRadiusMeters: radius, scaleMeters: scale, frame,
      noData: -32768, sourceResolutionMeters: 500, verticalDatum: 'test', indexPages: { rootZoom: 3, pages: {} } }
    assert.equal(parseTerrainManifest(m).body, body)
    assert.throws(() => parseTerrainManifest({ ...m, referenceRadiusMeters: 1737400 }))
  }
})

test('missing height vertices stay finite on the reference sphere and carry explicit neutral coverage', () => {
  const heights = new Float32Array(65 * 65).fill(1000)
  heights[100] = NaN
  const geometry = terrainGeometry(terrainBounds({ z: 3, x: 4, y: 2 }), heights, 65, 6051000, 6051800, 4)
  assert.ok([...geometry.attributes.position.array].every(Number.isFinite))
  const p = new THREE.Vector3().fromBufferAttribute(geometry.attributes.position, 100)
  assert.ok(Math.abs(p.length() - 6051000 / 6051800) < 1e-7)
  assert.equal(geometry.attributes.terrainCoverage.getX(100), 0)
  assert.equal(geometry.attributes.terrainCoverage.getX(101), 1)
  geometry.dispose()
})

test('terrain contract rejects mismatched radius, missing tiles, and malformed bounds', () => {
  assert.equal(parseTerrainManifest(manifest()).body, 'moon')
  assert.throws(() => parseTerrainManifest({ ...manifest(), referenceRadiusMeters: 1738000 }))
  assert.throws(() => parseTerrainManifest({ ...manifest(), rowOrder: 'south-to-north' }))
  assert.throws(() => parseTerrainManifest({ ...manifest(), tiles: {} }))
  const m = manifest(); m.tiles['0/0/0'].min = NaN
  assert.throws(() => parseTerrainManifest(m))
})

test('terrain positions, UVs, normals, and adjacent edges use the same geographic coordinates', () => {
  const heights = new Float32Array(65 * 65).fill(1000)
  const geometries = [0, 1].map(x => terrainGeometry(terrainBounds({ z: 1, x, y: 1 }), heights, 65, 1737400, 1737400, 1))
  for (const geometry of geometries) {
    const positions = geometry.getAttribute('position'), uv = geometry.getAttribute('uv')
    for (let i = 0; i < 65 * 65; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(positions, i)
      assert.ok(Math.abs(p.length() - (1 + 1000 / 1737400)) < 1e-7)
      const lon = Math.atan2(-p.z, p.x) * 180 / Math.PI
      const lat = Math.asin(p.y / p.length()) * 180 / Math.PI
      if (Math.abs(lat) < 89.99 && Math.abs(lon) < 179.99) assert.ok(Math.abs(lon - (uv.getX(i) * 360 - 180)) < 1e-4)
      assert.ok(Math.abs(lat - (uv.getY(i) * 180 - 90)) < 1e-4)
    }
    const a = new THREE.Vector3().fromBufferAttribute(positions, 65 * 20 + 20)
    const b = new THREE.Vector3().fromBufferAttribute(positions, 65 * 21 + 20)
    const c = new THREE.Vector3().fromBufferAttribute(positions, 65 * 20 + 21)
    assert.ok(b.sub(a).cross(c.sub(a)).dot(a) > 0)
  }
  for (let r = 0; r < 65; r++) for (let axis = 0; axis < 3; axis++)
    assert.equal(geometries[0].attributes.position.array[(r * 65 + 64) * 3 + axis], geometries[1].attributes.position.array[r * 65 * 3 + axis])
  geometries.forEach(g => g.dispose())
})

const flush = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
function setup(t, decoder = { decode: async () => new Float32Array(65 * 65), dispose() {} }, tileResponse, config = {}) {
  const status = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('catalog.json')) return Response.json({ schema: 1, bodies: { moon: 'moon/test/manifest.json' } })
    if (String(url).endsWith('manifest.json')) return Response.json(config.manifest ?? manifest())
    if (String(url).includes('/indices/')) return config.pageResponse(url, options)
    return tileResponse ? tileResponse(url, options) : new Response(compressed)
  })
  const body = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial())
  const layer = new GlobeTerrainLayer(body, value => status.push(value), 'http://localhost/terrain/', () => decoder)
  const camera = new THREE.PerspectiveCamera(48, 1, .001, 100)
  camera.position.set(0, 0, 1.2); camera.lookAt(0, 0, 0)
  t.after(() => layer.dispose())
  return { layer, body, camera, status }
}

test('close camera envelope includes maximum terrain height and exaggeration before tiles load', async t => {
  const { layer } = setup(t)
  assert.equal(layer.cameraSurfaceRadius(new THREE.Vector3(0, 0, 2)), 1)
  await flush()
  assert.equal(layer.cameraSurfaceRadius(new THREE.Vector3(0, 0, 2)), 1 + 1500 / 1737400)
  layer.setExaggeration(4)
  assert.equal(layer.cameraSurfaceRadius(new THREE.Vector3(0, 0, 2)), 1 + 6000 / 1737400)
  layer.setEnabled(false)
  assert.equal(layer.cameraSurfaceRadius(new THREE.Vector3(0, 0, 2)), 1)
})

test('ground picking uses visible terrain elevation and stops when terrain is disabled', async t => {
  const decoder = { decode: async () => new Float32Array(65 * 65).fill(1000), dispose() {} }
  const { layer, camera } = setup(t, decoder)
  const ray = new THREE.Ray(new THREE.Vector3(0, 0, 2), new THREE.Vector3(0, 0, -1))
  assert.equal(layer.hitGround(ray), null)
  await flush()
  layer.update(camera, 900, performance.now(), true)
  await flush()
  layer.update(camera, 900, performance.now() + 200, true)
  const ground = layer.hitGround(ray)
  assert.ok(ground)
  assert.ok(Math.abs(ground.length() - (1 + 1000 / 1737400)) < 1e-6)
  const localRadius = layer.cameraSurfaceRadius(new THREE.Vector3(0, 0, 1.01))
  assert.ok(Math.abs(localRadius - ground.length()) < 1e-10)
  // The local floor follows rendered ground instead of the global maximum.
  assert.ok(localRadius < layer.cameraSurfaceRadius(new THREE.Vector3(0, 0, 2)))
  layer.setExaggeration(4)
  const exaggerated = layer.cameraSurfaceRadius(new THREE.Vector3(0, 0, 1.01))
  assert.ok(Math.abs(exaggerated - (1 + 4000 / 1737400)) < 1e-6)
  layer.setEnabled(false)
  assert.equal(layer.hitGround(ray), null)
})

test('terrain keeps the base until roots load, replaces parents without overlap, and toggles cleanly', async t => {
  const { layer, body, camera } = setup(t)
  await flush()
  layer.update(camera, 900, performance.now(), true)
  assert.equal(body.material.visible, true)
  await flush()
  layer.update(camera, 900, performance.now() + 200, true)
  assert.equal(layer.active, true)
  assert.equal(body.material.visible, false)
  assert.ok(layer.bytes <= 48 * 1024 * 1024)
  const visible = [...layer.nodes.values()].filter(n => n.mesh?.visible)
  assert.ok(visible.length > 0)
  for (const a of visible) for (const b of visible) if (a.address.z < b.address.z) {
    const factor = 2 ** (b.address.z - a.address.z)
    assert.ok(Math.floor(b.address.x / factor) !== a.address.x || Math.floor(b.address.y / factor) !== a.address.y)
  }
  layer.setEnabled(false)
  assert.equal(layer.active, false)
  assert.equal(body.material.visible, true)
  assert.equal(layer.group.visible, false)
  layer.setEnabled(true)
  layer.update(camera, 900, performance.now() + 400, true)
  assert.equal(layer.active, true)
  layer.dispose()
  assert.equal(body.children.length, 0)
  assert.equal(layer.bytes, 0)
})

test('failed terrain requests back off and keep the original globe visible', async t => {
  let requests = 0
  const { layer, body, camera, status } = setup(t, undefined, async () => { requests++; return new Response(null, { status: 503 }) })
  await flush()
  const now = performance.now()
  layer.update(camera, 900, now, true)
  await flush()
  const first = requests
  layer.update(camera, 900, now + 200, true)
  await flush()
  assert.equal(requests, first)
  assert.ok(status.at(-1).failedTiles > 0)
  assert.equal(body.material.visible, true)
  assert.equal(layer.active, false)
})

test('late terrain worker results cannot attach after disposal', async t => {
  const decodes = []
  const { layer, body, camera } = setup(t, { decode: () => new Promise(resolve => decodes.push(resolve)), dispose() {} })
  await flush()
  layer.update(camera, 900, performance.now(), true)
  await flush()
  assert.equal(decodes.length, 4)
  layer.dispose()
  decodes.forEach(resolve => resolve(new Float32Array(65 * 65)))
  await flush()
  assert.equal(body.children.length, 0)
  assert.equal(layer.bytes, 0)
})

test('leaving the Moon aborts pending terrain and restores the base immediately on update', async t => {
  const signals = []
  const { layer, camera, body } = setup(t, undefined, (_url, options) => new Promise((_resolve, reject) => {
    signals.push(options.signal)
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  }))
  await flush()
  const now = performance.now()
  layer.update(camera, 900, now, true)
  assert.equal(signals.length, 4)
  layer.update(camera, 900, now + 200, false)
  assert.ok(signals.every(signal => signal.aborted))
  assert.equal(body.material.visible, true)
  await flush()
  assert.equal(layer.bytes, 0)
})

test('regional metadata loads on demand and parent terrain remains available through paging failures', async t => {
  const { m, pages } = pagedManifest()
  let pageRequests = 0
  const { layer, camera, body, status } = setup(t, undefined, undefined, {
    manifest: m,
    pageResponse: async url => {
      pageRequests++
      const key = String(url).split('/indices/')[1].replace('.json', '')
      return new Response(pages[key])
    },
  })
  await flush()
  const start = performance.now()
  for (let i = 0; i < 12; i++) {
    layer.update(camera, 900, start + i * 200, true)
    await flush()
  }
  assert.ok(pageRequests > 0 && pageRequests < 128, 'fetch regional pages, not the entire planet index')
  assert.ok([...layer.nodes.values()].some(node => node.address.z === 4 && node.mesh))
  assert.equal(layer.active, true)
  assert.equal(status.at(-1).failedTiles, 0)
  layer.update(camera, 900, start + 3000, false)
  await flush()
  assert.equal(body.material.visible, true)
  assert.equal(layer.bytes, 0)
  assert.equal(layer.pages.size, 0)
})

test('unavailable detail metadata backs off while loaded parent geometry stays visible', async t => {
  const { m } = pagedManifest()
  let requests = 0
  const { layer, camera, status } = setup(t, undefined, undefined, {
    manifest: m,
    pageResponse: async () => { requests++; return new Response(null, { status: 503 }) },
  })
  await flush()
  const start = performance.now()
  for (let i = 0; i < 8; i++) {
    layer.update(camera, 900, start + i * 200, true)
    await flush()
  }
  assert.ok(requests > 0)
  assert.equal(layer.active, true)
  assert.ok([...layer.nodes.values()].some(node => node.mesh?.visible))
  assert.ok(status.at(-1).failedTiles > 0)
  const first = requests
  layer.update(camera, 900, start + 1800, true)
  await flush()
  assert.equal(requests, first)
})
