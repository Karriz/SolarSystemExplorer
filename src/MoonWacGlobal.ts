import * as THREE from 'three'
import { terrainBounds } from './terrain.ts'
import type { TileAddress } from './surfaceTiles.ts'

const REMOTE_SIZE = 256, LOCAL_SIZE = 384, PAD = .18, BUDGET = 64 * 1024 * 1024, RETRY = 30_000
type Entry = { address: TileAddress; bounds: THREE.Vector4; controller?: AbortController; texture?: THREE.Texture; bitmap?: ImageBitmap; bytes: number; retryAt: number; used: number }
const key = (a: TileAddress) => `${a.z}/${a.x}/${a.y}`

/** Bounded WAC imagery. A verified local numeric pyramid takes precedence;
 * the remote WMS is retained as a fallback until that release is installed. */
export class MoonWacGlobal {
  private entries = new Map<string, Entry>()
  private wanted = new Set<string>()
  private enabled = false
  private disposed = false
  private requests = 0
  private bytes = 0
  private readonly hasMap = { value: 0 }
  private readonly localMap = { value: 0 }
  private readonly map = { value: null as THREE.Texture | null }
  private readonly bounds = { value: new THREE.Vector4() }
  private local = false
  private probed = false
  private readonly localRoot?: string
  constructor(localRoot?: string) { this.localRoot = localRoot }

  private async probeLocal() {
    if (!this.localRoot || this.probed) return
    this.probed = true
    try {
      const response = await fetch(new URL('manifest.json', this.localRoot))
      if (!response.ok) return
      const m = await response.json()
      if (m.schema !== 1 || m.minZoom !== 4 || m.maxZoom !== 8 || m.size !== LOCAL_SIZE
        || m.padDegrees !== PAD || m.encoding !== 'webp-rg10-alpha-coverage') return
      if (this.disposed) return
      this.local = true
      this.clear()
    } catch { /* Remote WMS remains available. */ }
  }

  configure(material: THREE.Material) {
    const previous = material.onBeforeCompile, oldKey = material.customProgramCacheKey()
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer)
      Object.assign(shader.uniforms, { wacGlobalMap: this.map, wacGlobalBounds: this.bounds, wacGlobalActive: this.hasMap, wacGlobalLocal: this.localMap })
      shader.fragmentShader = `uniform sampler2D wacGlobalMap; uniform vec4 wacGlobalBounds; uniform float wacGlobalActive; uniform float wacGlobalLocal;
        vec2 readWac(vec2 uv) { vec4 p = texture2D(wacGlobalMap, uv);
          return wacGlobalLocal > 0.5 ? vec2((p.r * 255.0 * 4.0 + p.g * 3.0) / 1023.0, p.a)
            : vec2(p.r, smoothstep(0.008, 0.035, p.r)); }\n${shader.fragmentShader}`
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        if (wacGlobalActive > 0.5) {
          vec2 ll = surfaceLonLat();
          vec2 uv = (ll - wacGlobalBounds.xy) / (wacGlobalBounds.zw - wacGlobalBounds.xy);
          vec2 stepWac = vec2(0.1566) / (wacGlobalBounds.zw - wacGlobalBounds.xy);
          float sumWac = 0.0; float weightWac = 0.0;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec2 sampleWac = readWac(uv + vec2(float(x), float(y)) * stepWac);
            float v = sampleWac.x; float valid = sampleWac.y;
            sumWac += (v + 0.035) * valid; weightWac += valid;
          }
          vec2 centerSampleWac = readWac(uv);
          float centerWac = centerSampleWac.x;
          float confidenceWac = centerSampleWac.y * smoothstep(3.0, 8.0, weightWac)
            * (wacGlobalLocal > 0.5 ? 1.0 : 1.0 - smoothstep(72.0, 80.0, abs(ll.y)));
          float meanWac = sumWac / max(weightWac, 0.001);
          float detailWac = clamp((centerWac + 0.035) / max(meanWac, 0.001), 0.65, 1.35);
          diffuseColor.rgb *= mix(1.0, detailWac, confidenceWac);
          // The legacy global Moon color has severe streaks at the poles.
          // The polar WAC source is directly projected and can replace it there.
          if (wacGlobalLocal > 0.5) {
            float polarBlend = smoothstep(72.0, 80.0, abs(ll.y)) * centerSampleWac.y;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(clamp(centerWac * 3.0, 0.0, 0.8)), polarBlend);
          }
        }`)
    }
    material.customProgramCacheKey = () => `${oldKey}/moon-wac-global-v2`
  }

  setEnabled(enabled: boolean) { this.enabled = enabled; if (!enabled) this.clear(); else void this.probeLocal() }
  private address(a: TileAddress): TileAddress { return a }
  update(addresses: TileAddress[], now: number) {
    if (!this.enabled || this.disposed) return
    this.wanted.clear()
    for (const raw of addresses.flatMap(a => this.local && a.z > 4
      ? [{ z: 4, x: Math.floor(a.x / 2 ** (a.z - 4)), y: Math.floor(a.y / 2 ** (a.z - 4)) }, a] : [a])) {
      const a = this.address(raw)
      if (a.z < 4) continue
      const geographic = terrainBounds(a)
      if (!this.local && (geographic.south >= 80 || geographic.north <= -80)) continue
      const k = key(a); this.wanted.add(k)
      let entry = this.entries.get(k)
      if (!entry) {
        const b = terrainBounds(a)
        entry = { address: a, bounds: new THREE.Vector4(b.west - PAD, Math.max(-90, b.south - PAD), b.east + PAD, Math.min(90, b.north + PAD)), bytes: 0, retryAt: 0, used: now }
        this.entries.set(k, entry)
      }
      entry.used = now
    }
    for (const e of this.entries.values()) if (!this.wanted.has(key(e.address))) e.controller?.abort()
    this.pump(now)
    for (const [k, e] of this.entries) if (!this.wanted.has(k) && !e.texture && !e.controller && now - e.used > RETRY) this.entries.delete(k)
  }

  bind(address: TileAddress) {
    this.hasMap.value = 0
    if (!this.enabled || this.disposed) return
    let a = this.address(address)
    while (a.z >= 4) {
      const e = this.entries.get(key(a))
      if (e?.texture) { e.used = performance.now(); this.map.value = e.texture; this.bounds.value.copy(e.bounds); this.localMap.value = this.local ? 1 : 0; this.hasMap.value = 1; return }
      a = { z: a.z - 1, x: Math.floor(a.x / 2), y: Math.floor(a.y / 2) }
    }
  }

  private pump(now: number) {
    if (!this.enabled || this.disposed) return
    for (const k of this.wanted) {
      if (this.requests >= 3) break
      const e = this.entries.get(k)!
      if (e.texture || e.controller || e.retryAt > now) continue
      const size = this.local ? LOCAL_SIZE : REMOTE_SIZE
      const reserved = Math.ceil(size * size * 4 * (1 + 4 / 3))
      const unused = [...this.entries.values()].filter(v => v.texture && !this.wanted.has(key(v.address)) && now - v.used > 500).sort((a, b) => a.used - b.used)
      while (this.bytes + reserved > BUDGET && unused.length) this.release(unused.shift()!)
      if (this.bytes + reserved > BUDGET) break
      e.bytes = reserved; this.bytes += reserved; this.requests++
      e.controller = new AbortController()
      void this.load(e, e.controller)
    }
  }

  private async load(e: Entry, controller: AbortController) {
    let bitmap: ImageBitmap | undefined
    const timeout = setTimeout(() => { e.retryAt = performance.now() + RETRY; controller.abort() }, 20_000)
    try {
      const b = e.bounds
      const local = this.local
      const params = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetMap', LAYERS: 'luna_wac_normalized_reflectance', STYLES: '', SRS: 'EPSG:4326', BBOX: `${b.x},${b.y},${b.z},${b.w}`, WIDTH: `${REMOTE_SIZE}`, HEIGHT: `${REMOTE_SIZE}`, FORMAT: 'image/png', TRANSPARENT: 'TRUE' })
      const url = local ? new URL(`${e.address.z}/${e.address.x}/${e.address.y}.webp`, this.localRoot!) : `https://wms.im-ldi.com/?${params}`
      const response = await fetch(url, { signal: controller.signal, mode: 'cors', credentials: 'omit' })
      if (!response.ok || !response.headers.get('content-type')?.startsWith(local ? 'image/webp' : 'image/png')) throw new Error('WAC image unavailable')
      bitmap = await createImageBitmap(await response.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none' })
      if (this.disposed || !this.enabled || controller.signal.aborted || this.entries.get(key(e.address)) !== e) return
      if (bitmap.width !== (local ? LOCAL_SIZE : REMOTE_SIZE) || bitmap.height !== (local ? LOCAL_SIZE : REMOTE_SIZE)) throw new Error('Invalid WAC image size')
      const texture = new THREE.Texture(bitmap); texture.colorSpace = THREE.NoColorSpace; texture.anisotropy = 4; texture.needsUpdate = true
      e.texture = texture; e.bitmap = bitmap; bitmap = undefined; e.retryAt = 0
    } catch {
      if (!controller.signal.aborted) e.retryAt = performance.now() + RETRY
    } finally {
      clearTimeout(timeout); bitmap?.close(); if (!e.texture) this.release(e)
      if (e.controller === controller) e.controller = undefined
      this.requests--; this.pump(performance.now())
    }
  }
  private release(e: Entry) {
    e.texture?.dispose(); e.bitmap?.close(); e.texture = undefined; e.bitmap = undefined
    this.bytes -= e.bytes; e.bytes = 0
  }
  clear() {
    this.wanted.clear(); this.hasMap.value = 0; this.map.value = null
    for (const e of this.entries.values()) { e.controller?.abort(); if (!e.controller) this.release(e) }
    this.entries.clear()
  }
  metrics() { return { enabled: this.enabled, source: this.local ? 'local-numeric' : 'remote-display', requests: this.requests, memoryBytes: this.bytes, budget: BUDGET, cached: [...this.entries.values()].filter(e => e.texture).length, failed: [...this.entries.values()].filter(e => e.retryAt > 0).length } }
  dispose() { this.disposed = true; this.enabled = false; this.clear() }
}
