import * as THREE from 'three'
import { mercatorBounds, tileKey } from './terrainPilot.ts'
import type { TileAddress } from './surfaceTiles.ts'
import { earthMaskSize, MASK_GUTTER, type EarthMask } from './earthSurfaceData.ts'

export const earthVectorSource = { page: 'https://openfreemap.org/', tileJSON: 'https://tiles.openfreemap.org/planet', maxZoom: 14 }
type Entry = { address: TileAddress; texture?: THREE.DataTexture; mask?: EarthMask; request?: AbortController; used: number; retry: number; bytes: number; version: number }
export function earthVectorAddress(a: TileAddress, maxZoom = 14): TileAddress {
  const z = Math.min(a.z, maxZoom), scale = 2 ** (a.z - z), n = 2 ** z
  return { z, x: ((Math.floor(a.x / scale) % n) + n) % n, y: Math.min(n - 1, Math.max(0, Math.floor(a.y / scale))) }
}

/** One bounded vector stream supplies both water and terrain material masks.
 * No map renderer or geographic canvas readback is involved. */
export class EarthVectorSource {
  private entries = new Map<string, Entry>()
  private wanted = new Set<string>()
  private worker?: Worker
  private nextId = 0
  private pending = new Map<number, { resolve: (mask: EarthMask) => void; reject: (error: Error) => void }>()
  private controller?: AbortController
  private template?: string
  private maxZoom = 14
  private metadataRetry = 0
  private metadataError = ''
  private requests = 0
  private bytes = 0
  private wire = 0
  private disposed = false
  private version = 0
  private focus = { lon: 0, lat: 0 }
  readonly budget = 32 * 1024 * 1024

  private async metadata() {
    if (this.template || this.controller || this.disposed || performance.now() < this.metadataRetry) return
    const request = this.controller = new AbortController(), timeout = setTimeout(() => request.abort(), 15000)
    try {
      const response = await fetch(earthVectorSource.tileJSON, { signal: request.signal, credentials: 'omit', mode: 'cors' })
      if (!response.ok) throw Error(`Vector metadata HTTP ${response.status}`)
      const metadata = await response.json()
      const template = metadata.tiles?.[0]
      if (typeof template !== 'string' || !template.startsWith('https://tiles.openfreemap.org/') || !['{z}', '{x}', '{y}'].every(k => template.includes(k))) throw Error('Invalid vector tile metadata')
      if (!Number.isInteger(metadata.maxzoom) || metadata.maxzoom < 0 || metadata.maxzoom > 22) throw Error('Invalid vector maximum zoom')
      if (this.disposed || request.signal.aborted || !this.wanted.size) return
      this.template = template; this.maxZoom = Math.min(14, metadata.maxzoom); this.metadataError = ''
    } catch (error) { if (!this.disposed && this.wanted.size) { this.metadataRetry = performance.now() + 30000; this.metadataError = String(error) } }
    finally { clearTimeout(timeout); this.controller = undefined; this.pump() }
  }

  update(addresses: TileAddress[], now: number, focus?: { lon: number; lat: number }) {
    if (this.disposed) return
    if (focus) this.focus = focus
    this.wanted.clear()
    const want = (address: TileAddress) => {
      const key = tileKey(address)
      this.wanted.add(key)
      let entry = this.entries.get(key)
      if (!entry) { entry = { address, used: now, retry: 0, bytes: 0, version: 0 }; this.entries.set(key, entry) }
      entry.used = now
    }
    for (const address of addresses) {
      const a = earthVectorAddress(address, this.maxZoom)
      want(a)
      // Keep a broad warm parent while fine data arrives and during LOD changes.
      const z = Math.min(a.z, 8), scale = 2 ** (a.z - z)
      want({ z, x: Math.floor(a.x / scale), y: Math.floor(a.y / scale) })
      let parent = { ...a }
      while (parent.z >= 0) {
        if (this.entries.get(tileKey(parent))?.texture) { want(parent); break }
        parent = { z: parent.z - 1, x: Math.floor(parent.x / 2), y: Math.floor(parent.y / 2) }
      }
    }
    for (const [key, entry] of this.entries) if (!this.wanted.has(key)) {
      entry.request?.abort()
      if (!entry.texture && !entry.request) this.entries.delete(key)
    }
    if (!this.wanted.size) this.controller?.abort()
    else if (!this.template) void this.metadata()
    this.pump()
  }

  entry(address: TileAddress) {
    let a = earthVectorAddress(address, this.maxZoom)
    while (a.z >= 0) {
      const entry = this.entries.get(tileKey(a))
      if (entry?.texture) return entry
      a = { z: a.z - 1, x: Math.floor(a.x / 2), y: Math.floor(a.y / 2) }
    }
  }

  private decode(buffer: ArrayBuffer, address: TileAddress): Promise<EarthMask> {
    if (!this.worker) {
      this.worker = new Worker(new URL('./earthSurface.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = event => {
        const task = this.pending.get(event.data.id)
        if (!task) return
        this.pending.delete(event.data.id)
        if (event.data.error) task.reject(Error(event.data.error)); else task.resolve(event.data)
      }
      this.worker.onerror = () => {
        this.pending.forEach(task => task.reject(Error('Vector decoder unavailable'))); this.pending.clear()
        this.worker?.terminate(); this.worker = undefined
      }
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker!.postMessage({ id, buffer, address }, [buffer]) })
  }

  private pump() {
    if (!this.template || this.disposed) return
    const distance = (e: Entry) => {
      const b = mercatorBounds(e.address), delta = Math.abs((b.west + b.east) / 2 - this.focus.lon)
      return Math.hypot(Math.min(delta, 360 - delta), (b.north + b.south) / 2 - this.focus.lat)
    }
    const pending = [...this.entries.values()].filter(e => this.wanted.has(tileKey(e.address)) && !e.texture && !e.request && e.retry <= performance.now())
      .sort((a, b) => a.address.z - b.address.z || distance(a) - distance(b))
    for (const entry of pending) {
      if (this.requests >= 3) break
      // Numeric class + CPU water ownership + GPU class, plus feature metadata.
      const reserve = (earthMaskSize(entry.address.z) + MASK_GUTTER * 2) ** 2 * 4 + 256 * 1024
      const unused = [...this.entries.values()].filter(e => !e.request && !this.wanted.has(tileKey(e.address))).sort((a, b) => a.used - b.used)
      while (this.bytes + reserve > this.budget && unused.length) this.release(unused.shift()!)
      if (this.bytes + reserve > this.budget) break
      entry.bytes = reserve; this.bytes += reserve; this.requests++
      const request = entry.request = new AbortController()
      void this.load(entry, request)
    }
  }
  private async load(entry: Entry, request: AbortController) {
    const timeout = setTimeout(() => { entry.retry = performance.now() + 30000; request.abort() }, 20000)
    try {
      const a = entry.address, url = this.template!.replace('{z}', String(a.z)).replace('{x}', String(a.x)).replace('{y}', String(a.y))
      const response = await fetch(url, { signal: request.signal, mode: 'cors', credentials: 'omit' })
      if (!response.ok) throw Error(`Vector tile HTTP ${response.status}`)
      const buffer = await response.arrayBuffer(); this.wire += buffer.byteLength
      if (buffer.byteLength > 8 * 1024 * 1024) throw Error('Vector tile exceeds decode budget')
      if (this.disposed || request.signal.aborted) return
      const mask = await this.decode(buffer, entry.address)
      if (this.disposed || request.signal.aborted || !this.wanted.has(tileKey(entry.address))) return
      const texture = new THREE.DataTexture(mask.classes, mask.width, mask.width, THREE.RedFormat)
      texture.minFilter = texture.magFilter = THREE.NearestFilter
      texture.generateMipmaps = false; texture.unpackAlignment = 1; texture.needsUpdate = true
      entry.mask = mask; entry.texture = texture; entry.version = ++this.version; entry.retry = 0
    } catch { if (!request.signal.aborted && !this.disposed) entry.retry = performance.now() + 30000 }
    finally {
      clearTimeout(timeout)
      if (!entry.texture) { this.bytes -= entry.bytes; entry.bytes = 0 }
      entry.request = undefined; this.requests--; this.pump()
    }
  }
  metrics() { return { ready: [...this.entries].some(([key, e]) => this.wanted.has(key) && !!e.texture), cached: [...this.entries.values()].filter(e => e.texture).length,
    wanted: this.wanted.size, missingWanted: [...this.wanted].filter(key => !this.entries.get(key)?.texture).length,
    requests: this.requests, memoryBytes: this.bytes, transferBytes: this.wire, budget: this.budget,
    failed: [...this.entries.values()].filter(e => e.retry > 0).length + Number(!!this.metadataError), error: this.metadataError,
    layers: ['water', 'landcover', 'landuse'], maxZoom: this.maxZoom } }
  private release(entry: Entry) {
    if (entry.texture) {
      entry.texture.dispose()
      // Hidden terrain materials may still reference this Texture object until
      // their next bind. Release its CPU pixels as well as the GPU allocation.
      entry.texture.image.data = new Uint8Array(0)
    }
    entry.texture = undefined; entry.mask = undefined
    this.bytes -= entry.bytes; entry.bytes = 0; this.entries.delete(tileKey(entry.address))
  }
  clear() {
    this.wanted.clear(); this.controller?.abort()
    for (const entry of [...this.entries.values()]) { entry.request?.abort(); if (!entry.request) this.release(entry) }
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true; this.clear()
    this.worker?.terminate(); this.worker = undefined
    this.pending.forEach(task => task.reject(Error('Vector source disposed'))); this.pending.clear()
  }
}
