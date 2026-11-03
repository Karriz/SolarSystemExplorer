import * as THREE from 'three'
import type { SurfaceState } from './surfaceMaterial.ts'

/** Shared lazy packed detail assets; late completions cannot attach to disposed owners. */
export function loadSurfaceDetail(id: string, state: SurfaceState, renderer: THREE.WebGLRenderer, disposed: () => boolean) {
  const loader = new THREE.TextureLoader()
  for (const layer of [
    { file: `${id}-detail.png`, map: state.detailMap, ready: state.detailMapReady },
    { file: `${id}-medium-detail.png`, map: state.mediumDetailMap, ready: state.mediumDetailReady },
  ]) loader.load(`${import.meta.env.BASE_URL}textures/${layer.file}`, texture => {
    if (disposed()) { texture.dispose(); return }
    texture.colorSpace = THREE.NoColorSpace
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy())
    layer.map.value = texture; layer.ready.value = 1
  }, undefined, () => { /* Measured terrain remains available without generated detail. */ })
}
