import * as THREE from 'three'
import { RegionalTerrainLayer } from './RegionalTerrainLayer.ts'
import { earthPilotSources } from './RegionalTerrainSource.ts'
import { PlanetColorTexture, disposeColorTexture } from './PlanetColorTexture.ts'
import { EarthVectorSource, type EarthMaskRequest } from './EarthVectorSource.ts'
import { configureEarthSurfaceMaterial, EARTH_DETAIL_PROFILE, earthMaskBinding, earthMaskTransform, type EarthMaskBinding } from './earthSurfaceMaterial.ts'
import { EARTH_CLASS, MASK_GUTTER, MASK_WIDTH } from './earthSurfaceData.ts'
import { loadSurfaceDetail } from './surfaceAssets.ts'
import type { SurfaceState } from './surfaceMaterial.ts'
import type { SolidSurfaceProfile } from './planetRenderProfiles.ts'
import type { SurfaceColorMode } from './PlanetSurfaceRenderer.ts'
import type { TileAddress, TileBounds } from './surfaceTiles.ts'

export const earthRenderProfile: SolidSurfaceProfile = {
  id: 'earth', detail: EARTH_DETAIL_PROFILE, cubeColorSampling: false, originalColorWidth: 5400,
  fallbackColor: { file: 'earth-base.jpg', message: 'Compact color unavailable · showing original NASA base map' },
  generatedDetail: true,
  colorDescription: 'Fixed NASA base composite · mapped local materials · generated ground detail',
  colorSource: { url: 'https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/', label: 'Blue Marble base color', credit: 'NASA Earth Observatory' },
}

/** Earth shares color/detail/material lifecycle with solid planets, while its
 * existing measured provider and mapped water remain independent adapters. */
export class EarthSurfaceRenderer {
  readonly terrain: RegionalTerrainLayer
  readonly color = new PlanetColorTexture('earth', earthRenderProfile)
  readonly vectors = new EarthVectorSource()
  private placeholder = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat)
  readonly materialState = { global: { value: this.placeholder as THREE.Texture }, globalReady: { value: 0 }, time: { value: 0 } }
  private readonly shade
  private readonly material: THREE.MeshStandardMaterial
  private started = false
  private disposed = false
  private controller = new AbortController()
  private colorMode: SurfaceColorMode = 'loading'
  private lakeHeights = new Map<string, number>()
  private lakeAttempts = new Map<string, number>()
  private waterRevision = 0
  private maskPlan: EarthMaskRequest[] = []
  private globalError = false
  private readonly body: THREE.Mesh
  readonly state: SurfaceState
  private readonly renderer: THREE.WebGLRenderer
  constructor(body: THREE.Mesh, state: SurfaceState, renderer: THREE.WebGLRenderer) {
    this.body = body; this.state = state; this.renderer = renderer
    this.placeholder.needsUpdate = true
    state.detail.value = 1; state.colorSharpen.value = 0
    this.material = body.material as THREE.MeshStandardMaterial
    this.shade = configureEarthSurfaceMaterial(this.material, state, this.materialState, 149_597_870_700, true)
    body.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    // Shared clipping/depth contract; appearance masks do not alter depth programs.
    configureEarthSurfaceMaterial(body.customDepthMaterial, state, this.materialState, 149_597_870_700, true)
    this.terrain = new RegionalTerrainLayer(body, 'earth', state, this)
    earthPilotSources().forEach(source => this.terrain.addSource(source))
  }

  private async loadColor() {
    for (const mode of ['compact', 'original'] as const) {
      try {
        const texture = await this.color.load(mode)
        if (!texture || this.disposed) { if (texture) disposeColorTexture(texture); return }
        const previous = this.material.map
        this.material.map = texture; this.material.emissiveMap = null; this.material.emissiveIntensity = 0
        this.material.needsUpdate = true; this.color.replace(texture); previous?.dispose()
        this.colorMode = mode; return
      } catch { if (this.disposed) return }
    }
    this.colorMode = 'unavailable'
  }
  private async loadGlobal() {
    const timeout = setTimeout(() => this.controller.abort(), 15000)
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}textures/earth-surface-base.bin.gz?v=coverage-4k-v2`, { signal: this.controller.signal })
      if (!response.ok || !response.body) throw Error('Global water mask unavailable')
      let data = new Uint8Array(await response.arrayBuffer())
      // Vite and some static hosts set Content-Encoding:gzip; browsers then
      // deliver the decompressed body. Other hosts serve the gzip file as-is.
      if (data[0] === 0x1f && data[1] === 0x8b) data = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
      if (data.length !== 4096 * 2048 && data.length !== 2048 * 1024) throw Error('Invalid global water mask')
      if (this.disposed) return
      // Decode class IDs into coverage before enabling interpolation/mips.
      const width = data.length === 4096 * 2048 ? 4096 : 2048
      if (width === 2048) data = data.map(value => value === 9 ? 255 : 0)
      const texture = new THREE.DataTexture(data, width, width / 2, THREE.RedFormat)
      texture.wrapS = THREE.RepeatWrapping; texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter
      texture.generateMipmaps = true; texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
      texture.unpackAlignment = 1; texture.needsUpdate = true
      this.materialState.global.value = texture; this.materialState.globalReady.value = 1
    } catch { if (!this.disposed) this.globalError = true }
    finally { clearTimeout(timeout) }
  }
  update(camera: THREE.PerspectiveCamera, _height: number, now: number, selected: boolean) {
    if (this.disposed) return
    if (selected && !this.started) {
      this.started = true; void this.loadColor(); void this.loadGlobal()
      loadSurfaceDetail('earth', this.state, this.renderer, () => this.disposed)
    }
    this.materialState.time.value = (now / 1000) % 3600
    this.body.updateWorldMatrix(true, false)
    this.shade.camera.value.copy(this.body.worldToLocal(camera.position.clone()))
    if (!selected) { this.lakeHeights.clear(); this.lakeAttempts.clear(); this.maskPlan = [] }
  }
  configurePatch(material: THREE.Material, origin: THREE.Vector3, camera: { value: THREE.Vector3 }, binding: EarthMaskBinding) {
    return configureEarthSurfaceMaterial(material, this.state, this.materialState, 6371000, false, origin, camera, binding)
  }
  binding() { return earthMaskBinding() }
  bind(address: TileAddress, binding: EarthMaskBinding) {
    const entry = this.vectors.entry(address)
    binding.active.value = entry ? 1 : 0
    binding.map.value = entry?.texture ?? this.placeholder
    binding.surface.value = entry?.surfaceTexture ?? this.placeholder
    if (entry) {
      binding.width.value = entry.mask!.width
      earthMaskTransform(address, entry.address, binding.transform.value, entry.mask!.width)
    }
  }
  prepare(addresses: { address: TileAddress; pixels: number }[], now: number, focus: { lon: number; lat: number }) {
    const requests = this.maskPlan = planEarthMasks(addresses, this.maskPlan)
    this.vectors.update(requests, now, focus)
    for (const { address } of addresses) {
      const mask = this.vectors.entry(address)?.mask
      for (const water of mask?.waters ?? []) {
        if (this.lakeHeights.has(water.key) || this.lakeHeights.size >= 512 || now - (this.lakeAttempts.get(water.key) ?? -Infinity) < 2000) continue
        if (this.lakeAttempts.size >= 1024) this.lakeAttempts.delete(this.lakeAttempts.keys().next().value!)
        this.lakeAttempts.set(water.key, now)
        const samples = water.shore.map(([lat, lon]) => this.terrain.sampleMeasuredHeight(lat, lon)).filter(Number.isFinite).sort((a, b) => a - b)
        // A bounded robust shoreline estimate; no guessed sea-level lake fallback.
        if (samples.length >= 3 && samples[Math.floor(samples.length * .75)] - samples[Math.floor(samples.length * .25)] < 30) {
          this.lakeHeights.set(water.key, samples[Math.floor(samples.length * .25)]); this.waterRevision++
        }
      }
    }
  }
  geometryVersion(address: TileAddress) { return `${this.vectors.entry(address)?.version ?? 0}/${this.waterRevision}` }
  waterHeights(address: TileAddress, bounds: TileBounds, size: number, heights: Float32Array) {
    const entry = this.vectors.entry(address)
    // A generalized parent may omit small islands. It can supply temporary
    // appearance, but must not flatten finer measured land to sea level.
    if (!entry?.mask || (entry.sourceZoom ?? entry.address.z) < Math.min(address.z, 14)) return heights
    const result = heights.slice(), n = 2 ** entry.address.z, mask = entry.mask, width = mask.width ?? MASK_WIDTH, sizePixels = width - MASK_GUTTER * 2
    for (let r = 0; r < size; r++) {
      const lat = bounds.north + (bounds.south - bounds.north) * r / (size - 1)
      const y = (.5 - Math.asinh(Math.tan(lat * Math.PI / 180)) / (2 * Math.PI)) * n - entry.address.y
      for (let c = 0; c < size; c++) {
        const lon = bounds.west + (bounds.east - bounds.west) * c / (size - 1), x = (lon + 180) / 360 * n - entry.address.x
        const index = Math.max(0, Math.min(width - 1, Math.floor(MASK_GUTTER + y * sizePixels))) * width
          + Math.max(0, Math.min(width - 1, Math.floor(MASK_GUTTER + x * sizePixels)))
        const id = mask.classes[index]
        if (id === EARTH_CLASS.ocean) result[r * size + c] = 0
        if (id === EARTH_CLASS.lake) {
          const water = mask.waters[mask.water[index] - 1], height = water ? this.lakeHeights.get(water.key) : undefined
          if (height !== undefined) result[r * size + c] = height
        }
      }
    }
    return result
  }
  metrics() {
    const pixels = (texture: THREE.Texture | null | undefined) => {
      const image = texture?.image as { width?: number; height?: number } | undefined
      return image ? (Number(image.width) || 0) * (Number(image.height) || 0) : 0
    }
    const colorPixels = pixels(this.color.texture), detailPixels = pixels(this.state.detailMap.value) + pixels(this.state.mediumDetailMap.value)
    const waterPixels = this.materialState.globalReady.value ? pixels(this.materialState.global.value) : 0
    const assets = { colorGpuBytes: Math.ceil(colorPixels * 4 * 4 / 3), colorDecodedBytes: colorPixels * 4,
      detailGpuBytes: Math.ceil(detailPixels * 4 * 4 / 3), detailDecodedBytes: detailPixels * 4,
      waterGpuBytes: Math.ceil(waterPixels * 4 / 3), waterDecodedBytes: waterPixels }
    return { color: this.colorMode, water: this.materialState.globalReady.value > 0 ? 'mapped overview' : this.globalError ? 'unavailable' : 'loading',
    vectors: this.vectors.metrics(), lakeLevels: this.lakeHeights.size,
    assets, estimatedGlobalBytes: Object.values(assets).reduce((sum, bytes) => sum + bytes, 0),
    detail: this.state.detailMapReady.value > 0, classification: 'OpenFreeMap local polygons; unclassified global land' }
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true; this.controller.abort(); this.vectors.dispose(); this.terrain.dispose()
    if (this.material.map === this.color.texture) this.material.map = null
    this.color.dispose(); this.placeholder.dispose()
    if (this.materialState.globalReady.value) this.materialState.global.value.dispose()
    this.materialState.global.value = this.placeholder
    this.materialState.globalReady.value = 0
    this.lakeHeights.clear(); this.lakeAttempts.clear()
    for (const layer of [{ map: this.state.detailMap, ready: this.state.detailMapReady }, { map: this.state.mediumDetailMap, ready: this.state.mediumDetailReady }]) {
      layer.map.value?.dispose(); layer.map.value = null; layer.ready.value = 0
    }
  }
}

/** Spend render texels on projected surface area. Native PBF detail and mask
 * density are independent of the terrain vertex grid, including overzoom. */
export function planEarthMasks(patches: { address: TileAddress; pixels: number }[], previous: EarthMaskRequest[] = []): EarthMaskRequest[] {
  const retained = new Map(previous.map(r => [`${r.address.z}/${r.address.x}/${r.address.y}`, r]))
  let texels = 0
  const ordered = [...patches].sort((a, b) => b.pixels - a.pixels)
  return ordered.map(({ address, pixels }, index) => {
    let size = pixels > 900 ? 1024 : pixels > 300 ? 512 : pixels > 100 ? 256 : 128
    const old = retained.get(`${address.z}/${address.x}/${address.y}`)
    if (old) {
      size = old.size
      // Separate promotion and demotion thresholds prevent camera jitter from
      // rebuilding the same tile at alternating resolutions.
      while (size < 1024 && pixels > (size === 128 ? 100 : size === 256 ? 300 : 900) * 1.2) size *= 2
      while (size > 128 && pixels < (size === 256 ? 100 : size === 512 ? 300 : 900) * .8) size /= 2
    }
    const remaining = (ordered.length - index - 1) * 128 ** 2
    while (size > 128 && texels + size ** 2 + remaining > 2 * 1024 ** 2) size /= 2
    texels += size ** 2
    const finerSource = old ? pixels > (old.sourceZoom > address.z ? 144 : 216) : pixels > 180
    return { address, size, sourceZoom: Math.min(14, address.z + (finerSource ? 1 : 0)), priority: pixels }
  })
}
