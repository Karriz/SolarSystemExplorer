import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { surfaceTileSources, tileBounds, tileChildren } from '../src/surfaceTiles.ts'
import { GlobeTileLayer, tileGeometry, tileBoundingSphere } from '../src/GlobeTileLayer.ts'

test('GIBS edge tiles crop padded pixels at the antimeridian and south pole', () => {
  const bounds = tileBounds(surfaceTileSources.earth, { z: 0, x: 1, y: 0 })
  assert.deepEqual(bounds, { west: 108, east: 180, north: 90, south: -90, span: 288 })
  const geometry = tileGeometry(bounds, 0)
  const uv = geometry.getAttribute('uv')
  const u = [], v = []
  for (let i = 0; i < uv.count; i++) { u.push(uv.getX(i)); v.push(uv.getY(i)) }
  assert.equal(Math.min(...u), 0)
  assert.equal(Math.max(...u), .25)
  assert.equal(Math.min(...v), .375)
  assert.equal(Math.max(...v), 1)
  geometry.dispose()
})

test('tile children cover their parent without invalid GIBS padding requests', () => {
  for (const source of Object.values(surfaceTileSources)) {
    let level = [{ z: 0, x: 0, y: 0 }, { z: 0, x: 1, y: 0 }]
    for (let z = 0; z <= 3; z++) {
      let area = 0
      for (const tile of level) {
        const b = tileBounds(source, tile)
        assert.ok(b)
        area += (b.east - b.west) * (b.north - b.south)
      }
      assert.equal(area, 360 * 180)
      level = level.flatMap(tile => tileChildren(source, tile))
    }
    assert.deepEqual(tileChildren(source, { z: source.maxZoom, x: 0, y: 0 }), [])
  }
})

test('visibility bounds contain geometry at poles, the equator, and padded edges', () => {
  for (const source of Object.values(surfaceTileSources)) {
    for (const address of [{ z: 0, x: 0, y: 0 }, { z: 0, x: 1, y: 0 }, { z: 3, x: 2, y: 0 }, { z: 3, x: 2, y: 3 }]) {
      const bounds = tileBounds(source, address)
      const sphere = tileBoundingSphere(bounds)
      const geometry = tileGeometry(bounds, address.z)
      const positions = geometry.getAttribute('position')
      for (let i = 0; i < positions.count; i++) assert.ok(sphere.containsPoint(new THREE.Vector3().fromBufferAttribute(positions, i)))
      geometry.dispose()
    }
  }
})

test('patch geometry preserves eastward longitude, north-up images, and outward normals', () => {
  const geometry = tileGeometry({ west: -10, east: 10, north: 10, south: -10, span: 20 }, 4)
  const positions = geometry.getAttribute('position'), uv = geometry.getAttribute('uv')
  for (let i = 0; i < positions.count; i++) {
    const p = new THREE.Vector3().fromBufferAttribute(positions, i)
    const lon = Math.atan2(-p.z, p.x) * 180 / Math.PI
    const lat = Math.asin(p.y / p.length()) * 180 / Math.PI
    assert.ok(Math.abs(lon - (-10 + uv.getX(i) * 20)) < 1e-4)
    assert.ok(Math.abs(lat - (-10 + uv.getY(i) * 20)) < 1e-4)
  }
  const index = geometry.getIndex()
  const a = new THREE.Vector3().fromBufferAttribute(positions, index.getX(0))
  const b = new THREE.Vector3().fromBufferAttribute(positions, index.getX(1))
  const c = new THREE.Vector3().fromBufferAttribute(positions, index.getX(2))
  assert.ok(b.sub(a).cross(c.sub(a)).dot(a) > 0)
  geometry.dispose()
})

test('provider URL templates use WMTS row/column order and fixed composite imagery', () => {
  for (const source of Object.values(surfaceTileSources)) {
    const url = source.url({ z: 3, x: 5, y: 2 })
    assert.match(url, /\/3\/2\/5\.(jpg|jpeg)$/)
    assert.ok(url.startsWith('https://'))
  }
  assert.match(surfaceTileSources.earth.url({ z: 0, x: 0, y: 0 }), /BlueMarble_NextGeneration\/default\/500m/)
})

function setupLayer() {
  const bodies = new Map(['earth', 'moon', 'mars'].map((id, i) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial())
    mesh.position.x = i * 100
    return [id, mesh]
  }))
  const renderer = { capabilities: { getMaxAnisotropy: () => 8 } }
  const layer = new GlobeTileLayer(bodies, renderer)
  const camera = new THREE.PerspectiveCamera(48, 1, .001, 1000)
  camera.position.set(0, 0, 3)
  camera.lookAt(0, 0, 0)
  return { layer, bodies, camera }
}

test('tile requests are bounded and abort on overview and disposal', async t => {
  const pending = []
  t.mock.method(globalThis, 'fetch', (_url, options) => new Promise((resolve, reject) => {
    pending.push(options.signal)
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  }))
  const { layer, camera } = setupLayer()
  layer.update(camera, 1000, performance.now())
  assert.equal(pending.length, 6)
  camera.position.z = 500
  layer.update(camera, 1000, performance.now() + 200)
  assert.ok(pending.every(signal => signal.aborted))
  await new Promise(resolve => setImmediate(resolve))
  camera.position.z = 3
  layer.update(camera, 1000, performance.now() + 400)
  assert.equal(pending.length, 12)
  layer.dispose()
  assert.ok(pending.every(signal => signal.aborted))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pending.length, 12)
})

test('failed tiles back off without removing local globe surfaces', async t => {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(null, { status: 503 }) })
  const { layer, bodies, camera } = setupLayer()
  layer.update(camera, 1000, performance.now())
  await new Promise(resolve => setImmediate(resolve))
  const first = requests
  assert.ok(first > 0)
  layer.update(camera, 1000, performance.now() + 200)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests, first)
  assert.ok(bodies.get('earth').visible)
  layer.dispose()
})

test('late image decoding after disposal closes its bitmap and cannot attach a mesh', async t => {
  let closed = 0
  const old = globalThis.createImageBitmap
  t.after(() => { if (old) globalThis.createImageBitmap = old; else delete globalThis.createImageBitmap })
  t.mock.method(globalThis, 'fetch', async () => new Response(new Blob(['image'])))
  const { layer, bodies, camera } = setupLayer()
  t.after(() => layer.dispose())
  // One pending decode per request; resolve all of them after disposal.
  const decodes = []
  globalThis.createImageBitmap = () => new Promise(resolve => { decodes.push(resolve) })
  layer.update(camera, 1000, performance.now())
  for (let i = 0; i < 100 && decodes.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(decodes.length, 6)
  layer.dispose()
  decodes.forEach(resolve => resolve({ close: () => closed++ }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, decodes.length)
  assert.equal(bodies.get('earth').children.length, 0)
})

test('loaded children replace parents without overlap and cache eviction respects its budget', async t => {
  let decoded = 0, closed = 0
  const old = globalThis.createImageBitmap
  globalThis.createImageBitmap = async () => {
    decoded++
    return { width: 512, height: 512, close: () => closed++ }
  }
  t.after(() => { if (old) globalThis.createImageBitmap = old; else delete globalThis.createImageBitmap })
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, blob: async () => new Blob() }))
  const { layer, camera } = setupLayer()
  t.after(() => layer.dispose())
  const start = performance.now()
  for (let i = 0; i < 8; i++) {
    camera.position.set(Math.sin(i * .7) * 1.2, .2, Math.cos(i * .7) * 1.2)
    camera.lookAt(0, 0, 0)
    layer.update(camera, 800, start + i * 400)
    await new Promise(resolve => setImmediate(resolve))
    layer.update(camera, 800, start + i * 400 + 200)
    assert.ok(layer.bytes <= 96 * 1024 * 1024 + 1)
    const visible = [...layer.nodes.values()].filter(node => node.mesh?.visible)
    assert.ok(visible.length > 0)
    for (const a of visible) for (const b of visible) {
      if (a.body !== b.body || a.address.z >= b.address.z) continue
      const factor = 2 ** (b.address.z - a.address.z)
      assert.ok(Math.floor(b.address.x / factor) !== a.address.x || Math.floor(b.address.y / factor) !== a.address.y,
        `${a.key} overlaps descendant ${b.key}`)
    }
  }
  assert.ok(closed > 0, 'moving between regions should evict old tiles')
  layer.dispose()
  assert.equal(closed, decoded)
  assert.ok(Math.abs(layer.bytes) < 1)
})


test('excluded Earth and Moon imagery never creates overlapping globe patch groups', () => {
  const bodies=new Map(['earth','moon','mars'].map(id=>[id,new THREE.Mesh(new THREE.SphereGeometry(1),new THREE.MeshStandardMaterial())]))
  const layer=new GlobeTileLayer(bodies,{capabilities:{getMaxAnisotropy:()=>1}},new Set(['earth','moon']))
  assert.equal(bodies.get('earth').children.length,0)
  assert.equal(bodies.get('moon').children.length,0)
  assert.equal(bodies.get('mars').children.length,1)
  layer.dispose()
  for(const body of bodies.values()){body.geometry.dispose();body.material.dispose()}
})
