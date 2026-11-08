import * as THREE from 'three'
import { tileKey } from './terrainPilot.ts'
import type { TileAddress } from './surfaceTiles.ts'
import { MASK_GUTTER, type EarthMask, type EarthVectorTile } from './earthSurfaceData.ts'

export const earthVectorSource = { page: 'https://openfreemap.org/', tileJSON: 'https://tiles.openfreemap.org/planet', maxZoom: 14 }
export type EarthMaskRequest = { address: TileAddress; size: number; sourceZoom: number; priority: number }
type Entry = EarthMaskRequest & { key: string; texture?: THREE.DataTexture; surfaceTexture?: THREE.DataTexture; mask?: EarthMask;
  building?: boolean; used: number; retry: number; bytes: number; version: number }
type SourceTile = { address: TileAddress; buffer?: ArrayBuffer; request?: AbortController; retry: number; used: number }
export function earthVectorAddress(a: TileAddress, maxZoom = 14): TileAddress {
  const z = Math.min(a.z, maxZoom), scale = 2 ** (a.z - z), n = 2 ** z
  return { z, x: ((Math.floor(a.x / scale) % n) + n) % n, y: Math.min(n - 1, Math.max(0, Math.floor(a.y / scale))) }
}
export function earthVectorTiles(address: TileAddress, sourceZoom: number): TileAddress[] {
  const z = Math.min(14, sourceZoom, address.z + 1)
  if (z <= address.z) return [earthVectorAddress(address, z)]
  return [0, 1, 2, 3].map(i => ({ z, x: address.x * 2 + i % 2, y: address.y * 2 + Math.floor(i / 2) }))
}
const maskKey = (r: EarthMaskRequest) => `${tileKey(r.address)}/${r.size}/${r.sourceZoom}`
const maskBytes = (size: number) => Math.ceil((size + 2 * MASK_GUTTER) ** 2 * (3 + 8 + 8 * 4 / 3) + 256 * 1024)

/** Source PBFs and view-sized render masks have independent caches. One worker
 * composites/crops vector geometry into filtered material and shoreline data. */
export class EarthVectorSource {
  private entries = new Map<string, Entry>()
  private raw = new Map<string, SourceTile>()
  private wanted = new Set<string>()
  private desired = new Set<string>()
  private rawWanted = new Set<string>()
  private worker?: Worker
  private pending = new Map<number, { resolve: (mask: EarthMask) => void; reject: (error: Error) => void }>()
  private nextId = 0
  private controller?: AbortController
  private template?: string
  private maxZoom = 14
  private metadataRetry = 0
  private metadataError = ''
  private requests = 0
  private builds = 0
  private bytes = 0
  private rawBytes = 0
  private wire = 0
  private version = 0
  private disposed = false
  readonly cacheBudget = 64 * 1024 * 1024
  // A bounded replacement reserve keeps visible masks alive while new ones build.
  readonly budget = 128 * 1024 * 1024
  private readonly rawBudget = 8 * 1024 * 1024

  private async metadata() {
    if (this.template || this.controller || this.disposed || performance.now() < this.metadataRetry) return
    const request = this.controller = new AbortController(), timeout = setTimeout(() => request.abort(), 15000)
    try {
      const response = await fetch(earthVectorSource.tileJSON, { signal: request.signal, credentials: 'omit', mode: 'cors' })
      if (!response.ok) throw Error(`Vector metadata HTTP ${response.status}`)
      const m = await response.json(), template = m.tiles?.[0]
      if (typeof template !== 'string' || !template.startsWith('https://tiles.openfreemap.org/') || !['{z}', '{x}', '{y}'].every(k => template.includes(k))) throw Error('Invalid vector metadata')
      if (!Number.isInteger(m.maxzoom) || m.maxzoom < 0 || m.maxzoom > 22) throw Error('Invalid vector maximum zoom')
      if (this.disposed || request.signal.aborted || !this.wanted.size) return
      this.template = template; this.maxZoom = Math.min(14, m.maxzoom); this.metadataError = ''
    } catch (error) { if (!this.disposed && this.wanted.size) { this.metadataRetry = performance.now() + 30000; this.metadataError = String(error) } }
    finally { clearTimeout(timeout); this.controller = undefined; this.pump() }
  }

  update(requests: EarthMaskRequest[] | TileAddress[], now: number, _focus?: { lon: number; lat: number }) {
    if (this.disposed) return
    this.wanted.clear(); this.desired.clear(); this.rawWanted.clear()
    const want = (r: EarthMaskRequest) => {
      const request = { ...r, sourceZoom: Math.min(this.maxZoom, r.sourceZoom) }, key = maskKey(request)
      this.wanted.add(key)
      this.desired.add(key)
      let e = this.entries.get(key)
      if (!e) { e = { ...request, key, used: now, retry: 0, bytes: 0, version: 0 }; this.entries.set(key, e) }
      e.used = now; e.priority = r.priority
      if (!e.texture && !e.building) for (const address of earthVectorTiles(e.address, e.sourceZoom)) {
        const rawKey = tileKey(address)
        this.rawWanted.add(rawKey)
        const tile = this.raw.get(rawKey)
        if (tile) tile.used = now
        else this.raw.set(rawKey, { address, used: now, retry: 0 })
      }
    }
    for (const input of requests) {
      const r: EarthMaskRequest = 'address' in input ? input : { address: input, size: 256, sourceZoom: Math.min(input.z, this.maxZoom), priority: 1 }
      want(r)
      // A tiny coarse parent supplies geographic continuity during cold loads.
      const parent = earthVectorAddress(r.address, Math.min(8, r.address.z))
      want({ address: parent, size: 128, sourceZoom: parent.z, priority: r.priority + 1e6 })
      const fallback = this.entry(r.address)
      if (fallback?.texture) { this.wanted.add(fallback.key); fallback.used = now }
    }
    for (const [key, tile] of this.raw) if (!this.rawWanted.has(key)) {
      tile.request?.abort()
      if (!tile.buffer && !tile.request) this.raw.delete(key)
    }
    for (const [key, e] of this.entries) if (!this.wanted.has(key) && !e.texture && !e.building) this.entries.delete(key)
    // Visible fallbacks stay pinned until their replacements are ready. Evicting
    // them to reserve future work causes a coarse/fine flash on every zoom step.
    this.reserve(0)
    if (!this.wanted.size) this.controller?.abort()
    else if (!this.template) void this.metadata()
    this.trimRaw(); this.pump()
  }

  entry(address: TileAddress) {
    let a = { ...address }
    while (a.z >= 0) {
      const matches = [...this.entries.values()].filter(e => e.texture && tileKey(e.address) === tileKey(a))
      // Prefer the requested resolution; retain an older mask during upgrades.
      const selected = matches.sort((x, y) => Number(this.wanted.has(y.key)) - Number(this.wanted.has(x.key)) || y.sourceZoom - x.sourceZoom || y.size - x.size)[0]
      if (selected) return selected
      a = { z: a.z - 1, x: Math.floor(a.x / 2), y: Math.floor(a.y / 2) }
    }
  }

  private trimRaw(reserve = 0) {
    const unused = [...this.raw].filter(([key, t]) => t.buffer && !t.request && !this.rawWanted.has(key)).sort((a, b) => a[1].used - b[1].used)
    while (this.rawBytes + reserve > this.rawBudget && unused.length) {
      const [key, tile] = unused.shift()!; this.rawBytes -= tile.buffer!.byteLength; this.raw.delete(key)
    }
  }
  private reserve(bytes: number) {
    const unused = [...this.entries.values()].filter(e => e.texture && !this.wanted.has(e.key) && !e.building).sort((a, b) => a.used - b.used)
    while (this.bytes + this.rawBytes + bytes > this.cacheBudget && unused.length) this.release(unused.shift()!)
    return this.bytes + this.rawBytes + bytes <= this.budget
  }
  private pump() {
    if (!this.template || this.disposed) return
    const pending = [...this.entries.values()].filter(e => this.wanted.has(e.key) && !e.texture && !e.building && e.retry <= performance.now())
      .sort((a, b) => b.priority - a.priority)
    for (const entry of pending) {
      const tiles = earthVectorTiles(entry.address, entry.sourceZoom).map(a => this.raw.get(tileKey(a)))
      if (tiles.every(t => t?.buffer)) {
        if (this.builds || !this.reserve(maskBytes(entry.size))) continue
        entry.building = true; entry.bytes = maskBytes(entry.size); this.bytes += entry.bytes; this.builds++
        void this.build(entry, tiles as SourceTile[])
      } else for (const tile of tiles) {
        if (!tile || tile.buffer || tile.request || tile.retry > performance.now() || this.requests >= 3) continue
        tile.request = new AbortController(); this.requests++; void this.fetchTile(tile, tile.request)
      }
    }
  }
  private async fetchTile(tile: SourceTile, request: AbortController) {
    const timeout = setTimeout(() => { tile.retry = performance.now() + 30000; request.abort() }, 20000)
    try {
      const a = tile.address, url = this.template!.replace('{z}', String(a.z)).replace('{x}', String(a.x)).replace('{y}', String(a.y))
      const response = await fetch(url, { signal: request.signal, mode: 'cors', credentials: 'omit' })
      if (!response.ok) throw Error(`Vector tile HTTP ${response.status}`)
      const buffer = await response.arrayBuffer(); this.wire += buffer.byteLength
      if (buffer.byteLength > 8 * 1024 * 1024) throw Error('Vector tile exceeds decode budget')
      if (this.disposed || request.signal.aborted || !this.rawWanted.has(tileKey(tile.address))) return
      this.trimRaw(buffer.byteLength)
      if (this.rawBytes + buffer.byteLength > this.rawBudget || !this.reserve(buffer.byteLength)) throw Error('Vector source cache full')
      tile.buffer = buffer; this.rawBytes += buffer.byteLength; tile.retry = 0
    } catch { if (!this.disposed && !request.signal.aborted) tile.retry = performance.now() + 30000 }
    finally { clearTimeout(timeout); tile.request = undefined; this.requests--; this.pump() }
  }
  private async build(entry: Entry, tiles: SourceTile[]) {
    try {
      const copies: EarthVectorTile[] = tiles.map(t => ({ address: t.address, buffer: t.buffer!.slice(0) }))
      const mask = await this.decode(copies, entry)
      if (this.disposed || !this.wanted.has(entry.key)) return
      const texture = new THREE.DataTexture(mask.color, mask.width, mask.width, THREE.RGBAFormat)
      texture.colorSpace = THREE.SRGBColorSpace
      const surfaceTexture = new THREE.DataTexture(mask.surface, mask.width, mask.width, THREE.RGBAFormat)
      for (const t of [texture, surfaceTexture]) {
        t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter
        t.generateMipmaps = true; t.anisotropy = 8; t.unpackAlignment = 1; t.needsUpdate = true
      }
      entry.mask = mask; entry.texture = texture; entry.surfaceTexture = surfaceTexture; entry.version = ++this.version; entry.retry = 0
    } catch { if (!this.disposed && this.wanted.has(entry.key)) entry.retry = performance.now() + 30000 }
    finally {
      if (!entry.texture) { this.bytes -= entry.bytes; entry.bytes = 0 }
      entry.building = false; this.builds--; this.pump()
    }
  }
  private decode(tiles: EarthVectorTile[], entry: Entry): Promise<EarthMask> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./earthSurface.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = event => {
        const p = this.pending.get(event.data.id)
        if (!p) return
        this.pending.delete(event.data.id)
        if (event.data.error) p.reject(Error(event.data.error)); else p.resolve(event.data)
      }
      this.worker.onerror = () => {
        this.pending.forEach(p => p.reject(Error('Vector decoder unavailable'))); this.pending.clear()
        this.worker?.terminate(); this.worker = undefined
      }
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker!.postMessage({ id, tiles, address: entry.address, size: entry.size }, tiles.map(t => t.buffer))
    })
  }
  metrics() { return { ready: [...this.entries.values()].some(e => e.texture && this.wanted.has(e.key)),
    cached: [...this.entries.values()].filter(e => e.texture).length, wanted: this.wanted.size,
    missingWanted: [...this.wanted].filter(key => !this.entries.get(key)?.texture).length,
    requests: this.requests + this.builds, memoryBytes: this.bytes + this.rawBytes, sourceBytes: this.rawBytes, transferBytes: this.wire, budget: this.budget, cacheBudget: this.cacheBudget,
    failed: [...this.entries.values()].filter(e => e.retry > 0).length + [...this.raw.values()].filter(t => t.retry > 0).length + Number(!!this.metadataError),
    error: this.metadataError, layers: ['water', 'landcover', 'landuse'], maxZoom: this.maxZoom,
    resolutions: [...new Set([...this.entries.values()].filter(e => e.texture && this.wanted.has(e.key)).map(e => e.size))] } }
  private release(entry: Entry) {
    for (const t of [entry.texture, entry.surfaceTexture]) if (t) { t.dispose(); t.image.data = new Uint8Array(0) }
    entry.texture = undefined; entry.surfaceTexture = undefined; entry.mask = undefined
    this.bytes -= entry.bytes; entry.bytes = 0; this.entries.delete(entry.key)
  }
  clear() {
    this.wanted.clear(); this.desired.clear(); this.rawWanted.clear(); this.controller?.abort()
    this.worker?.terminate(); this.worker = undefined
    this.pending.forEach(p => p.reject(Error('Vector surface work cancelled'))); this.pending.clear()
    for (const [key, t] of this.raw) {
      t.request?.abort()
      if (t.buffer) { this.rawBytes -= t.buffer.byteLength; t.buffer = undefined }
      if (!t.request) this.raw.delete(key)
    }
    for (const entry of [...this.entries.values()]) if (!entry.building) this.release(entry)
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true; this.clear(); this.worker?.terminate(); this.worker = undefined
    this.pending.forEach(p => p.reject(Error('Vector source disposed'))); this.pending.clear()
  }
}
