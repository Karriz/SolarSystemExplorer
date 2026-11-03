import * as THREE from 'three'
import { CubeTerrainLayer } from './CubeTerrainLayer.ts'
import type { TerrainStatus } from './GlobeTerrainLayer.ts'
import { GlobalHillshadeLayer } from './GlobalHillshadeLayer.ts'
import { PlanetColorTexture, disposeColorTexture } from './PlanetColorTexture.ts'
import { configurePlanetSurfaceMaterial, type PlanetShade } from './planetSurfaceMaterial.ts'
import { configureCubeColorMaterial } from './cubeColorMaterial.ts'
import { configureTerrainHillshade, type HillshadeState } from './terrainHillshade.ts'
import type { SurfaceState } from './surfaceMaterial.ts'
import { planetRenderProfiles, type SolidSurfaceProfile, type SolidSurfaceBody } from './planetRenderProfiles.ts'
import { loadSurfaceDetail } from './surfaceAssets.ts'

export type SurfaceColorMode = 'loading' | 'compact' | 'original' | 'unavailable'
export type SurfaceColorStatus = { mode: SurfaceColorMode; message: string }

/** One solid body's material, measured terrain, color and hillshade lifecycle.
 * Geographic scientific releases remain independent of cube rendering meshes. */
export class PlanetSurfaceRenderer {
  readonly terrain: CubeTerrainLayer
  readonly hillshade: GlobalHillshadeLayer
  readonly color: PlanetColorTexture
  private readonly shade: PlanetShade
  private readonly material: THREE.MeshStandardMaterial
  private disposed = false
  private started = false
  private colorMode: SurfaceColorMode = 'loading'

  readonly id: SolidSurfaceBody
  readonly state: SurfaceState
  private readonly body: THREE.Mesh
  private readonly renderer: THREE.WebGLRenderer
  private readonly hillshadeEnabled: HillshadeState
  private readonly onColorStatus: (body: SolidSurfaceBody, status: SurfaceColorStatus) => void

  constructor(id: SolidSurfaceBody, body: THREE.Mesh,
    state: SurfaceState, renderer: THREE.WebGLRenderer,
    terrainUrl: string, hillshadeEnabled: HillshadeState,
    onTerrainStatus: (status: TerrainStatus) => void,
    onColorStatus: (body: SolidSurfaceBody, status: SurfaceColorStatus) => void) {
    this.id = id
    this.body = body
    this.state = state
    this.renderer = renderer
    this.hillshadeEnabled = hillshadeEnabled
    this.onColorStatus = onColorStatus
    const profile = planetRenderProfiles[id]
    this.material = body.material as THREE.MeshStandardMaterial
    state.colorSharpen.value = 0
    state.detail.value = profile.generatedDetail ? 1 : 0
    this.color = new PlanetColorTexture(id)
    this.hillshade = new GlobalHillshadeLayer(id)
    this.shade = configurePlanetSurfaceMaterial(this.material, state, 149_597_870_700,
      true, undefined, undefined, profile.detail)
    if (profile.cubeColorSampling) configureCubeColorMaterial(this.material)
    configureTerrainHillshade(this.material, hillshadeEnabled, this.hillshade)
    body.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
    configurePlanetSurfaceMaterial(body.customDepthMaterial, state, 149_597_870_700,
      true, undefined, this.shade.camera, profile.detail)
    this.terrain = new CubeTerrainLayer(body, onTerrainStatus, terrainUrl, state,
      hillshadeEnabled, id, this.hillshade, profile)
  }

  private async loadColor() {
    for (const mode of ['compact', 'original'] as const) {
      try {
        const texture = await this.color.load(mode)
        if (!texture || this.disposed) {
          if (texture) disposeColorTexture(texture)
          return
        }
        const previous = this.material.map
        this.material.map = texture
        this.material.emissiveMap = texture
        this.material.needsUpdate = true
        this.state.colorSharpen.value = mode === 'original' ? 1 : 0
        this.color.replace(texture)
        previous?.dispose()
        this.colorMode = mode
        const profile: SolidSurfaceProfile = planetRenderProfiles[this.id]
        this.onColorStatus(this.id, { mode, message: mode === 'compact' ? '' : (profile.fallbackColor?.message ?? 'Default color unavailable · showing original image') })
        return
      } catch {
        if (this.disposed) return
      }
    }
    this.colorMode = 'unavailable'
    this.onColorStatus(this.id, { mode: 'unavailable', message: 'Color unavailable · showing placeholder surface' })
  }

  private loadDetail() {
    if (!planetRenderProfiles[this.id].generatedDetail) return
    loadSurfaceDetail(this.id, this.state, this.renderer, () => this.disposed)
  }

  update(camera: THREE.PerspectiveCamera, viewportHeight: number, now: number, selected: boolean) {
    if (this.disposed) return
    if (selected && !this.started) {
      this.started = true
      this.onColorStatus(this.id, { mode: 'loading', message: 'Loading surface color…' })
      void this.loadColor()
      this.loadDetail()
    }
    this.body.updateWorldMatrix(true, false)
    this.shade.camera.value.copy(this.body.worldToLocal(camera.position.clone()))
    this.terrain.updateShadeCamera(camera)
    this.hillshade.update(camera, this.body, viewportHeight, now,
      selected && this.hillshadeEnabled.value > 0)
  }

  metrics() { return { color: this.colorMode, hillshade: this.hillshade.metrics() } }

  dispose() {
    this.disposed = true
    this.terrain.dispose()
    this.hillshade.dispose()
    // Scene traversal owns material disposal; this owner releases its assets.
    if (this.material.map === this.color.texture) {
      this.material.map = null
      this.material.emissiveMap = null
    }
    this.color.dispose()
    for (const layer of [
      { map: this.state.detailMap, ready: this.state.detailMapReady },
      { map: this.state.mediumDetailMap, ready: this.state.mediumDetailReady },
    ]) {
      layer.map.value?.dispose()
      layer.map.value = null
      layer.ready.value = 0
    }
  }
}
