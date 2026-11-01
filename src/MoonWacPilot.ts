import * as THREE from 'three'

/** Two bounded, opt-in WAC reflectance-detail patches. The texture's red
 * channel encodes a linear brightness multiplier divided by two; alpha fades
 * it into the existing global color. */
export class MoonWacPilot {
  private readonly enabled = { value: 0 }
  private readonly maps = [{ value: null as THREE.Texture | null }, { value: null as THREE.Texture | null }]
  private loading?: Promise<void>
  private disposed = false
  private wanted = false

  configure(material: THREE.Material) {
    const previous = material.onBeforeCompile
    const key = material.customProgramCacheKey()
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer)
      Object.assign(shader.uniforms, { wacPilotEnabled: this.enabled, wacHadley: this.maps[0], wacTycho: this.maps[1] })
      shader.fragmentShader = `uniform float wacPilotEnabled; uniform sampler2D wacHadley; uniform sampler2D wacTycho;\n${shader.fragmentShader}`
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        if (wacPilotEnabled > 0.5) {
          vec2 ll = surfaceLonLat();
          vec4 bounds = vec4(1.63, 24.13, 5.63, 28.13);
          if (surfaceInside(ll, bounds)) {
            vec4 sampleWac = texture2D(wacHadley, (ll - bounds.xy) / (bounds.zw - bounds.xy));
            diffuseColor.rgb *= mix(1.0, sampleWac.r * 2.0, sampleWac.a);
          }
          bounds = vec4(-13.36, -45.31, -9.36, -41.31);
          if (surfaceInside(ll, bounds)) {
            vec4 sampleWac = texture2D(wacTycho, (ll - bounds.xy) / (bounds.zw - bounds.xy));
            diffuseColor.rgb *= mix(1.0, sampleWac.r * 2.0, sampleWac.a);
          }
        }`)
    }
    material.customProgramCacheKey = () => `${key}/moon-wac-pilot-v1`
  }

  async setEnabled(value: boolean) {
    this.wanted = value
    if (!value) { this.enabled.value = 0; return }
    if (this.disposed) throw new Error('Moon detail is unavailable')
    if (!this.maps[0].value || !this.maps[1].value) {
      this.loading ??= this.load().finally(() => { this.loading = undefined })
      await this.loading
    }
    if (this.disposed) throw new Error('Moon detail is unavailable')
    if (this.wanted) this.enabled.value = 1
  }

  private async load() {
    const loader = new THREE.TextureLoader()
    const results = await Promise.allSettled(['hadley', 'tycho'].map(name =>
      loader.loadAsync(`${import.meta.env?.BASE_URL ?? "/"}textures/wac-${name}-detail.png`)))
    if (this.disposed || results.some(result => result.status === 'rejected')) {
      for (const result of results) if (result.status === 'fulfilled') result.value.dispose()
      throw new Error('Could not load WAC detail')
    }
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return
      result.value.colorSpace = THREE.NoColorSpace
      result.value.anisotropy = 4
      this.maps[index].value = result.value
    })
  }

  dispose() {
    this.disposed = true
    this.wanted = false
    this.enabled.value = 0
    for (const map of this.maps) { map.value?.dispose(); map.value = null }
  }
}
