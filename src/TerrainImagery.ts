import * as THREE from 'three'
import { surfaceTileSources, type TileAddress, type SurfaceTileSource } from './surfaceTiles.ts'
import type { TerrainBody } from './terrain.ts'

const MAX_BYTES = 32 * 1024 * 1024
const RETRY_MS = 30_000
type Entry = { address: TileAddress; texture?: THREE.Texture; bitmap?: ImageBitmap; request?: AbortController;
  retryAt: number; lastUsed: number; bytes: number }

/** Geographic imagery draped onto the terrain's global UVs, with independent LOD. */
export class TerrainImagery {
  private source?: SurfaceTileSource
  private entries = new Map<string, Entry>()
  private wanted = new Set<string>()
  private requests = 0
  private bytes = 0
  private disposed = false

  constructor(body: TerrainBody) {
    if (body in surfaceTileSources) this.source = surfaceTileSources[body as keyof typeof surfaceTileSources]
  }

  private address(address: TileAddress): TileAddress {
    const z = Math.min(address.z, this.source!.maxZoom), factor = 2 ** (address.z - z)
    return { z, x: Math.floor(address.x / factor), y: Math.floor(address.y / factor) }
  }
  private key(a: TileAddress) { return `${a.z}/${a.x}/${a.y}` }

  update(addresses: TileAddress[], now: number) {
    if (!this.source || this.disposed) return
    this.wanted.clear()
    for (const address of addresses) {
      const a = this.address(address), key = this.key(a)
      this.wanted.add(key)
      let entry = this.entries.get(key)
      if (!entry) {
        entry = { address: a, retryAt: 0, lastUsed: now, bytes: 0 }
        this.entries.set(key, entry)
      }
      entry.lastUsed = now
    }
    for (const entry of this.entries.values()) if (!this.wanted.has(this.key(entry.address))) entry.request?.abort()
    this.pump(now)
    for (const [key, entry] of this.entries) if (!this.wanted.has(key) && !entry.texture && !entry.request
      && now - entry.lastUsed > RETRY_MS) this.entries.delete(key)
  }

  texture(address: TileAddress): THREE.Texture | undefined {
    if (!this.source) return
    let a = this.address(address)
    while (a.z >= 0) {
      const entry = this.entries.get(this.key(a))
      if (entry?.texture) { entry.lastUsed = performance.now(); return entry.texture }
      a = { z: a.z - 1, x: Math.floor(a.x / 2), y: Math.floor(a.y / 2) }
    }
  }

  private pump(now: number) {
    if (this.disposed || !this.source) return
    for (const key of this.wanted) {
      if (this.requests >= 3) break
      const entry = this.entries.get(key)!
      if (entry.texture || entry.request || entry.retryAt > now) continue
      const reserve = Math.ceil(this.source.tileSize ** 2 * 4 * (1 + 4 / 3))
      const unused = [...this.entries.values()].filter(e => e.texture && !this.wanted.has(this.key(e.address)) && now - e.lastUsed > 500)
        .sort((a, b) => a.lastUsed - b.lastUsed)
      while (this.bytes + reserve > MAX_BYTES && unused.length) this.release(unused.shift()!)
      if (this.bytes + reserve > MAX_BYTES) break
      entry.bytes = reserve
      this.bytes += reserve
      this.requests++
      entry.request = new AbortController()
      void this.load(entry, entry.request)
    }
  }

  private async load(entry: Entry, request: AbortController) {
    let bitmap: ImageBitmap | undefined
    const timeout = setTimeout(() => { entry.retryAt = performance.now() + RETRY_MS; request.abort() }, 20_000)
    try {
      const response = await fetch(this.source!.url(entry.address), { signal: request.signal, mode: 'cors', credentials: 'omit' })
      if (!response.ok) throw new Error('Terrain imagery unavailable')
      const blob = await response.blob()
      if (this.disposed || request.signal.aborted) return
      bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none' })
      if (this.disposed || request.signal.aborted) return
      if (bitmap.width !== this.source!.tileSize || bitmap.height !== this.source!.tileSize) throw new Error('Invalid imagery dimensions')
      const texture = new THREE.Texture(bitmap)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = 4
      const span = 180 / 2 ** entry.address.z
      texture.repeat.set(360 / span, 180 / span)
      texture.offset.set(-entry.address.x, -(2 ** entry.address.z - entry.address.y - 1))
      texture.needsUpdate = true
      entry.texture = texture
      entry.bitmap = bitmap
      bitmap = undefined
    } catch {
      if (!request.signal.aborted) entry.retryAt = performance.now() + RETRY_MS
    } finally {
      clearTimeout(timeout)
      bitmap?.close()
      if (!entry.texture) { this.bytes -= entry.bytes; entry.bytes = 0 }
      entry.request = undefined
      this.requests--
      this.pump(performance.now())
    }
  }

  private release(entry: Entry) {
    entry.texture?.dispose()
    entry.bitmap?.close()
    entry.texture = undefined
    entry.bitmap = undefined
    this.bytes -= entry.bytes
    entry.bytes = 0
  }

  metrics() {
    return { memoryBytes: this.bytes, requests: this.requests, cached: [...this.entries.values()].filter(e => e.texture).length,
      failed: [...this.entries.values()].filter(e => e.retryAt > 0).length, budget: MAX_BYTES }
  }

  clear() {
    this.wanted.clear()
    for (const entry of this.entries.values()) { entry.request?.abort(); this.release(entry) }
    this.entries.clear()
  }

  dispose() { this.disposed = true; this.clear() }
}
