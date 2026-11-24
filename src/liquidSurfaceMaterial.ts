import * as THREE from 'three'

export type LiquidSurfaceProfile = {
  /** Linear reflectance of the liquid body under neutral white light. */
  color: readonly [number, number, number]
  /** Glossy liquid roughness (low values yield realistic specular Sun glints). */
  roughness: number
  /** Gentle capillary-wave slope strength at close range. */
  waveStrength: number
}

export type LiquidMaterialState = {
  mask: { value: THREE.Texture | null }
  ready: { value: number }
  time: { value: number }
}

export function liquidMaterialState(): LiquidMaterialState {
  return { mask: { value: null }, ready: { value: 0 }, time: { value: 0 } }
}

/** Lazily load an equirectangular grayscale liquid sea/lake mask (0 = land, 1 = liquid). */
export function loadLiquidMask(id: string, state: LiquidMaterialState, renderer: THREE.WebGLRenderer, disposed: () => boolean) {
  const loader = new THREE.TextureLoader()
  const url = `${import.meta.env.BASE_URL}textures/${id}-liquid-mask.png`
  loader.load(url, texture => {
    if (disposed()) { texture.dispose(); return }
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.colorSpace = THREE.NoColorSpace
    texture.generateMipmaps = true
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
    const previous = state.mask.value
    state.mask.value = texture
    state.ready.value = 1
    previous?.dispose()
  }, undefined, () => {})
}

/** Apply glassy liquid shading (radial flat normal, subtle animated capillary
 * ripples, low specular roughness, and suppressed rock-bump detail) wherever
 * the body's geographic liquid mask is non-zero. */
export function configureLiquidSurfaceMaterial(material: THREE.Material, state: LiquidMaterialState, profile: LiquidSurfaceProfile) {
  const previous = material.onBeforeCompile
  const previousKey = material.customProgramCacheKey()
  const [cr, cg, cb] = profile.color
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    if (!shader.fragmentShader.includes('#include <lights_physical_fragment>')) return
    // Guard narrow negative-X WebGL atan seam before wrapping UV gradients.
    shader.fragmentShader = shader.fragmentShader.replace('atan(-p.z,p.x)',
      '(p.x<0.0 && abs(p.z)<abs(p.x)*1.0e-7 ? (p.z>=0.0 ? -3.14159265359 : 3.14159265359) : atan(-p.z,p.x))')
    Object.assign(shader.uniforms, {
      liquidMask: state.mask,
      liquidReady: state.ready,
      liquidTime: state.time,
    })
    shader.vertexShader = `varying float vLiquidDistance;\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vLiquidDistance = distance(position + moonOrigin, moonCamera) * moonMetersPerUnit;`)
    shader.fragmentShader = `uniform sampler2D liquidMask; uniform float liquidReady; uniform float liquidTime;
      varying float vLiquidDistance;
      ${shader.fragmentShader}`
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `
      if (liquidReady > 0.5) {
        vec2 liqLl = surfaceLonLat();
        vec2 liqUv = vec2(liqLl.x / 360.0 + 0.5, 0.5 + liqLl.y / 180.0);
        vec2 liqDx = dFdx(liqUv), liqDy = dFdy(liqUv);
        liqDx.x -= round(liqDx.x); liqDy.x -= round(liqDy.x);
        float liq = smoothstep(0.08, 0.85, textureGrad(liquidMask, liqUv, liqDx, liqDy).r);
        if (liq > 0.001) {
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${cr}, ${cg}, ${cb}), liq * 0.92);
          roughnessFactor = mix(roughnessFactor, ${profile.roughness}, liq);
          vec3 liqDir = normalize(vMoonDir);
          vec3 liqWave = vec3(
            sin(liqDir.z * 140000.0 + liquidTime * 0.45) + 0.5 * sin(liqDir.x * 290000.0 - liquidTime * 0.35),
            sin(liqDir.x * 130000.0 - liquidTime * 0.38) + 0.5 * sin(liqDir.y * 270000.0 + liquidTime * 0.30),
            sin(liqDir.y * 150000.0 + liquidTime * 0.32)
          );
          liqWave -= liqDir * dot(liqWave, liqDir);
          float liqWaveFade = 1.0 - smoothstep(400.0, 35000.0, vLiquidDistance);
          vec3 liqNormal = normalize(normalMatrix * (liqDir + liqWave * (${profile.waveStrength} * liqWaveFade)));
          normal = normalize(mix(normal, liqNormal, liq));
        }
      }
      #include <lights_physical_fragment>`)
  }
  material.customProgramCacheKey = () => `${previousKey}/liquid-sea-v1/${profile.roughness}/${profile.waveStrength}`
  material.needsUpdate = true
}
