import * as THREE from 'three'
import { planetRenderProfiles, type SolidSurfaceProfile, type SolidSurfaceBody } from './planetRenderProfiles.ts'


export function disposeColorTexture(texture: THREE.Texture) {
  texture.dispose()
  if (texture.image instanceof ImageBitmap) texture.image.close()
}

/** Continuous measured or explicitly inferred surface color, decoded once without path rasterization. */
export class PlanetColorTexture {
  private readonly body:SolidSurfaceBody | 'earth'
  private readonly profile: SolidSurfaceProfile
  constructor(body:SolidSurfaceBody | 'earth'='mars', profile?: SolidSurfaceProfile){
    this.body=body
    this.profile=profile ?? planetRenderProfiles[body as SolidSurfaceBody]
    if (!this.profile) throw Error('Missing surface color profile')
  }
  texture?: THREE.Texture
  private request?: AbortController
  private disposed = false
  cancel() { this.request?.abort(); this.request = undefined }
  async load(mode: 'compact' | 'source' | 'original'): Promise<THREE.Texture | null> {
    this.cancel()
    if (this.disposed) return null
    const request = this.request = new AbortController()
    const timeout = setTimeout(() => request.abort(), 30000)
    try {
      const profile = this.profile
      const file = mode === 'original' ? (profile.fallbackColor?.file ?? `${this.body}.jpg`) : mode === 'compact' ? `${this.body}-color.webp` : `${this.body}-color-reference.png`
      const response = await fetch(`${import.meta.env.BASE_URL}textures/${file}`, { signal: request.signal })
      if (!response.ok) throw Error('Planet color unavailable')
      const bitmap = await createImageBitmap(await response.blob(), {
        imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none',
      })
      if (this.disposed || request.signal.aborted || this.request !== request) { bitmap.close(); return null }
      const width=mode==='original'?profile.originalColorWidth:4096
      if (bitmap.width !== width || bitmap.height !== width/2) { bitmap.close(); throw Error('Invalid planet color dimensions') }
      const texture = new THREE.Texture(bitmap)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.flipY = false
      texture.wrapS = THREE.RepeatWrapping
      texture.minFilter = THREE.LinearMipmapLinearFilter
      texture.magFilter = THREE.LinearFilter
      texture.anisotropy = 8
      texture.needsUpdate = true
      return texture
    } catch (error) {
      if (this.disposed || this.request !== request) return null
      throw error
    } finally { clearTimeout(timeout) }
  }
  replace(texture?: THREE.Texture) {
    if (this.texture && this.texture !== texture) disposeColorTexture(this.texture)
    this.texture = texture
  }
  dispose() { this.disposed = true; this.cancel(); this.replace() }
}
