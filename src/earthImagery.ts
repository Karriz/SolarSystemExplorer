import * as THREE from 'three'
import { configureTerrainShadowFade } from './terrainShadows.ts'
import { mercatorBounds, tileKey } from './terrainPilot.ts'
import type { TileAddress, TileBounds } from './surfaceTiles.ts'

export const earthColorSource = {
  label: 'Sentinel-2 · WorldCover 2021 RGB', credit: '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
  page: 'https://esa-worldcover.org/en/data-access', minZoom: 8, maxZoom: 14,
}
export function earthColorAddress(a: TileAddress): TileAddress {
  const z = Math.min(a.z, earthColorSource.maxZoom), divisor = 2 ** (a.z - z)
  return { z, x: Math.floor(a.x / divisor), y: Math.floor(a.y / divisor) }
}
export function earthColorUrl(a: TileAddress) {
  const query = new URLSearchParams({ SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0', LAYER: 'esa-worldcover-s2rgbnir-10m-2021-v2_tcc',
    STYLE: 'default', TILEMATRIXSET: 'EPSG:3857', TILEMATRIX: String(a.z), TILECOL: String(a.x), TILEROW: String(a.y), FORMAT: 'image/png', TIME: '2021-01-01' })
  return `https://wmts.terrascope.be/?${query}`
}
type Entry = { address: TileAddress; texture?: THREE.Texture; bitmap?: ImageBitmap; request?: AbortController; retry: number; error?: string; used: number; bytes: number }

/** Project in double precision before upload. GPU tan/log approximations at
 * globe scale can shift a fine tile by a sizeable fraction of its height. */
export function earthColorUvs(bounds: TileBounds, size: number, address: TileAddress) {
  const values: number[] = [], n = 2 ** address.z
  for (let r = 0; r < size; r++) {
    const lat = bounds.north + (bounds.south - bounds.north) * r / (size - 1)
    const phi = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(lat, -85.0511287798066, 85.0511287798066))
    const v = (.5 + Math.asinh(Math.tan(phi)) / (2 * Math.PI)) * n - (n - address.y - 1)
    for (let c = 0; c < size; c++) {
      const lon = bounds.west + (bounds.east - bounds.west) * c / (size - 1)
      values.push((lon + 180) / 360 * n - address.x, v)
    }
  }
  // Same perimeter order as terrainGeometry; skirt bottoms retain their tops' UVs.
  const edge = [
    ...Array.from({ length: size }, (_, c) => c),
    ...Array.from({ length: size - 1 }, (_, r) => (r + 1) * size + size - 1),
    ...Array.from({ length: size - 1 }, (_, c) => size * size - 2 - c),
    ...Array.from({ length: size - 2 }, (_, r) => (size - 2 - r) * size),
  ]
  for (const i of edge) values.push(values[i * 2], values[i * 2 + 1])
  return new THREE.Float32BufferAttribute(values, 2)
}

/** Convert mesh-local UVs to the currently available image, including parents.
 * Evaluate the global offset subtraction on the CPU, keeping GPU values small. */
export function earthColorTransform(address: TileAddress, texture: THREE.Texture, target = new THREE.Vector4()) {
  const n = 2 ** address.z
  return target.set(texture.repeat.x / n, texture.repeat.y / n,
    address.x / n * texture.repeat.x + texture.offset.x,
    (n - address.y - 1) / n * texture.repeat.y + texture.offset.y)
}

/** Provider-rendered RGB tiles, mapped directly onto terrain meshes. No imagery
 * shell, raster preprocessing, private key, or application tile server. */
export class EarthImagery {
  private entries = new Map<string, Entry>()
  private wanted = new Set<string>()
  private requests = 0
  private bytes = 0
  private wire = 0
  private disposed = false
  private focus = { lon: 0, lat: 0 }
  readonly budget = 32 * 1024 * 1024
  update(addresses: TileAddress[], now: number, focus?: { lon: number; lat: number }) {
    if (focus) this.focus = focus
    if (this.disposed) return
    this.wanted.clear()
    const want = (a: TileAddress) => {
      const b = mercatorBounds(a)
      if (a.z < 8 || b.north < -60 || b.south > 83) return
      const key = tileKey(a)
      this.wanted.add(key)
      if (!this.entries.has(key)) this.entries.set(key, { address: a, retry: 0, used: now, bytes: 0 })
      this.entries.get(key)!.used = now
    }
    for (const address of addresses) {
      const a = earthColorAddress(address)
      if (a.z < 8) continue
      const scale = 2 ** (a.z - 8)
      want({ z: 8, x: Math.floor(a.x / scale), y: Math.floor(a.y / scale) })
      want(a)
      // A cached parent currently draped on a child is a live texture too.
      let parent = { ...a }
      while (parent.z >= 8) {
        if (this.entries.get(tileKey(parent))?.texture) { want(parent); break }
        parent = { z: parent.z - 1, x: Math.floor(parent.x / 2), y: Math.floor(parent.y / 2) }
      }
    }
    for (const [key, entry] of this.entries) {
      if (!this.wanted.has(key)) entry.request?.abort()
      if (!entry.texture && !entry.request && !this.wanted.has(key)) this.entries.delete(key)
    }
    this.pump(now)
  }
  texture(address: TileAddress) {
    let a = earthColorAddress(address)
    while (a.z >= 8) {
      const entry = this.entries.get(tileKey(a))
      if (entry?.texture) { entry.used = performance.now(); return entry.texture }
      a = { z: a.z - 1, x: Math.floor(a.x / 2), y: Math.floor(a.y / 2) }
    }
  }
  private pump(now: number) {
    if (this.disposed) return
    const pending = [...this.entries.values()].filter(e => this.wanted.has(tileKey(e.address)) && !e.texture && !e.request && e.retry <= now)
      .sort((a, b) => {
        const distance = (entry: Entry) => {
          const bounds = mercatorBounds(entry.address), lon = (bounds.west + bounds.east) / 2
          return Math.hypot(Math.min(Math.abs(lon-this.focus.lon),360-Math.abs(lon-this.focus.lon)), (bounds.north+bounds.south)/2-this.focus.lat)
        }
        return b.address.z - a.address.z || distance(a)-distance(b)
      })
    for (const entry of pending) {
      if (this.requests >= 3) break
      const reserve = Math.ceil(256 * 256 * 4 * (1 + 4 / 3)) // retained bitmap + GPU mips
      const unused = [...this.entries.values()].filter(e => e.texture && !this.wanted.has(tileKey(e.address))).sort((a, b) => a.used - b.used)
      while (this.bytes + reserve > this.budget && unused.length) this.release(unused.shift()!)
      if (this.bytes + reserve > this.budget) break
      entry.bytes = reserve; this.bytes += reserve; this.requests++
      entry.request = new AbortController()
      void this.load(entry, entry.request)
    }
  }
  private async load(entry: Entry, request: AbortController) {
    let bitmap: ImageBitmap | undefined
    const timeout = setTimeout(() => { entry.retry = performance.now() + 30000; entry.error = 'Imagery timeout'; request.abort() }, 30000)
    try {
      const response = await fetch(earthColorUrl(entry.address), { signal: request.signal, mode: 'cors', credentials: 'omit' })
      if (!response.ok) throw Error(`RGB imagery HTTP ${response.status}`)
      const blob = await response.blob(); this.wire += blob.size
      if (request.signal.aborted || this.disposed) return
      bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none' })
      if (request.signal.aborted || this.disposed) return
      if (bitmap.width !== 256 || bitmap.height !== 256) throw Error('Unexpected color tile size')
      const texture = new THREE.Texture(bitmap), n = 2 ** entry.address.z
      texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4
      texture.repeat.set(n, n); texture.offset.set(-entry.address.x, -(n - entry.address.y - 1)); texture.needsUpdate = true
      entry.texture = texture; entry.bitmap = bitmap; bitmap = undefined; entry.retry = 0; entry.error = undefined
    } catch (error) { if (!request.signal.aborted) { entry.retry = performance.now() + 30000; entry.error = String(error) } }
    finally {
      clearTimeout(timeout); bitmap?.close()
      if (!entry.texture) { this.bytes -= entry.bytes; entry.bytes = 0 }
      entry.request = undefined; this.requests--; this.pump(performance.now())
    }
  }
  metrics() { return { ready: [...this.entries.values()].some(e => e.texture && this.wanted.has(tileKey(e.address))), cached: [...this.entries.values()].filter(e => e.texture).length,
    memoryBytes: this.bytes, transferBytes: this.wire, requests: this.requests, failed: [...this.entries.values()].filter(e => e.retry > 0).length, errors: [...this.entries.values()].filter(e => e.error).slice(0,3).map(e => ({ tile: tileKey(e.address), error: e.error })), budget: this.budget } }
  private release(entry: Entry) { entry.texture?.dispose(); entry.bitmap?.close(); entry.texture = undefined; entry.bitmap = undefined; this.bytes -= entry.bytes; entry.bytes = 0 }
  clear() { this.wanted.clear(); for (const entry of this.entries.values()) { entry.request?.abort(); this.release(entry) }; this.entries.clear() }
  dispose() { this.disposed = true; this.clear() }
}

/** Geometry keeps geographic UVs for the bundled fallback. Only the map lookup
 * changes to Web Mercator when a hosted texture exists; normals/positions stay measured. */
export function configureEarthColor(material: THREE.MeshStandardMaterial, active: { value: number }, fallback: { value: THREE.Texture | null }, transform: { value: THREE.Vector4 }) {
  material.onBeforeCompile = shader => {
    shader.uniforms.earthColorTransform = transform; shader.uniforms.earthColorActive = active; shader.uniforms.earthBaseColor = fallback
    shader.vertexShader = 'attribute vec2 earthColorUv; uniform vec4 earthColorTransform; uniform float earthColorActive; varying vec2 vEarthGeoUv;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
      vEarthGeoUv=uv;
      #ifdef USE_MAP
      if(earthColorActive>0.5) {
        vMapUv=earthColorUv*earthColorTransform.xy+earthColorTransform.zw;
      }
      #endif`)
    shader.fragmentShader = 'uniform float earthColorActive; uniform sampler2D earthBaseColor; varying vec2 vEarthGeoUv;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
      vec4 earthSample=texture2D(map,vMapUv);
      if(earthColorActive>0.5) earthSample=mix(texture2D(earthBaseColor,vEarthGeoUv),earthSample,earthSample.a);
      diffuseColor*=earthSample;
      #endif`)
  }
  material.customProgramCacheKey = () => 'earth-rgb-local-mercator-v2'
  configureTerrainShadowFade(material)
}
