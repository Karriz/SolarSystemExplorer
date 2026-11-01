import * as THREE from 'three'
import { MAX_SURFACE_CLIPS, type SurfaceState } from './surfaceMaterial.ts'
import { configureTerrainShadowFade } from './terrainShadows.ts'

export type MoonShade = {
  camera: { value: THREE.Vector3 }
  origin: { value: THREE.Vector3 }
  metersPerUnit: { value: number }
}

/** Overlapping distance bands keep medium features after grain filters out. */
const DETAIL_NEAR_METERS = 300
const DETAIL_FAR_METERS = 3000
const MEDIUM_NEAR_METERS = 2500
const MEDIUM_FAR_METERS = 18000
/** Shared, mipmapped normal/roughness textures supply fine and medium material
 * detail. Triplanar body-fixed sampling avoids seams and polar stretching.
 * It never displaces the measured mesh or runs a procedural field per pixel. */
export function configureMoonSurfaceMaterial(material: THREE.Material, state: SurfaceState, metersPerUnit: number, clip: boolean, origin = new THREE.Vector3(), camera = { value: new THREE.Vector3() }): MoonShade {
  const shade: MoonShade = { camera, origin: { value: origin }, metersPerUnit: { value: metersPerUnit } }
  const previous = material.onBeforeCompile
  const previousKey = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    Object.assign(shader.uniforms, {
      moonCamera: shade.camera, moonOrigin: shade.origin, moonMetersPerUnit: shade.metersPerUnit, moonDetail: state.detail,
    })
    const shaded = shader.fragmentShader.includes('#include <normal_fragment_maps>')
    if (shaded) Object.assign(shader.uniforms, { moonDetailMap: state.detailMap, moonDetailReady: state.detailMapReady,
      moonMediumMap: state.mediumDetailMap, moonMediumReady: state.mediumDetailReady })
    if (clip) Object.assign(shader.uniforms, { surfaceClips: state.clips, surfaceClipCount: state.clipCount })
    shader.vertexShader = `varying float vMoonFade; varying float vMoonMediumFade; varying vec3 vMoonDir; uniform vec3 moonCamera; uniform vec3 moonOrigin; uniform float moonMetersPerUnit; uniform float moonDetail;
      ${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec3 moonPlaced = position + moonOrigin;
      float moonMeters = distance(moonPlaced, moonCamera) * moonMetersPerUnit;
      vMoonFade = 0.0;
      vMoonMediumFade = 0.0;
      if (moonDetail > 0.0 && moonMeters > 0.0 && moonMeters < 1.0e8) {
        vMoonFade = moonDetail * (1.0 - smoothstep(${DETAIL_NEAR_METERS}.0, ${DETAIL_FAR_METERS}.0, moonMeters));
        vMoonMediumFade = moonDetail * (1.0 - smoothstep(${MEDIUM_NEAR_METERS}.0, ${MEDIUM_FAR_METERS}.0, moonMeters));
      }
      float moonLen2 = dot(moonPlaced, moonPlaced);
      vMoonDir = moonLen2 > 1.0e-20 ? moonPlaced * inversesqrt(moonLen2) : vec3(0.0, 1.0, 0.0);`)
    shader.fragmentShader = `varying float vMoonFade; varying float vMoonMediumFade; varying vec3 vMoonDir;
      ${clip ? `uniform vec4 surfaceClips[${MAX_SURFACE_CLIPS}]; uniform int surfaceClipCount;` : ''}
      vec2 surfaceLonLat() { vec3 p = normalize(vMoonDir); return vec2(atan(-p.z, p.x), asin(clamp(p.y, -1.0, 1.0))) * 57.295779513; }
      bool surfaceInside(vec2 p, vec4 b) { return p.x >= b.x && p.x <= b.z && p.y >= b.y && p.y <= b.w; }
      ${shader.fragmentShader}`
    if (clip) shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
      vec2 clipLonLat = surfaceLonLat();
      for (int i = 0; i < ${MAX_SURFACE_CLIPS}; i++) { if (i >= surfaceClipCount) break; if (surfaceInside(clipLonLat, surfaceClips[i])) discard; }`)
    if (shaded) {
      shader.fragmentShader = `uniform sampler2D moonDetailMap; uniform float moonDetailReady;
        uniform sampler2D moonMediumMap; uniform float moonMediumReady;
        #ifndef OBJECTSPACE_NORMALMAP
        uniform mat3 normalMatrix;
        #endif
        float moonSurfaceSample(sampler2D detailTexture, vec3 coords, vec3 weights, out vec3 slope) {
          vec4 sx = texture2D(detailTexture, coords.zy);
          vec4 sy = texture2D(detailTexture, coords.xz);
          vec4 sz = texture2D(detailTexture, coords.xy);
          vec3 nx = sx.xyz * 2.0 - 1.0, ny = sy.xyz * 2.0 - 1.0, nz = sz.xyz * 2.0 - 1.0;
          slope = vec3(0.0, nx.y, nx.x) / max(0.25, nx.z) * weights.x
            + vec3(ny.x, 0.0, ny.y) / max(0.25, ny.z) * weights.y
            + vec3(nz.x, nz.y, 0.0) / max(0.25, nz.z) * weights.z;
          return dot(vec3(sx.a, sy.a, sz.a), weights);
        }
        ${shader.fragmentShader}`
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        bool moonFineOn = vMoonFade > 0.001 && moonDetailReady > 0.5;
        bool moonMediumOn = vMoonMediumFade > 0.001 && moonMediumReady > 0.5;
        if (moonFineOn || moonMediumOn) {
          vec3 moonDirection = normalize(vMoonDir);
          vec3 moonWeights = pow(abs(moonDirection), vec3(4.0));
          moonWeights /= moonWeights.x + moonWeights.y + moonWeights.z;
          vec3 moonSlope = vec3(0.0);
          float moonTint = 0.0;
          if (moonFineOn) {
            vec3 fineSlope;
            float fineRoughness = moonSurfaceSample(moonDetailMap, moonDirection * (1737400.0 / 64.0), moonWeights, fineSlope);
            moonSlope += fineSlope * (0.4 * vMoonFade);
            roughnessFactor = mix(roughnessFactor, fineRoughness, vMoonFade);
            moonTint += (fineRoughness - 0.96) * (0.55 * vMoonFade);
          }
          if (moonMediumOn) {
            vec3 mediumSlope;
            // Blend more broadly between projections at this scale. Their
            // different surface footprints break up repeated outcrop motifs
            // without additional texture fetches or per-pixel noise.
            vec3 mediumWeights = abs(moonDirection);
            mediumWeights /= mediumWeights.x + mediumWeights.y + mediumWeights.z;
            float mediumRoughness = moonSurfaceSample(moonMediumMap, moonDirection * (1737400.0 / 256.0), mediumWeights, mediumSlope);
            moonSlope += mediumSlope * (0.45 * vMoonMediumFade);
            roughnessFactor = mix(roughnessFactor, mediumRoughness, 0.65 * vMoonMediumFade);
            moonTint += (mediumRoughness - 0.96) * (0.8 * vMoonMediumFade);
          }
          moonSlope -= moonDirection * dot(moonSlope, moonDirection);
          // The scene uses uniform AU scaling. Remove that scale from the
          // normal transform so strength is identical on globe and tile meshes.
          normal = normalize(normal + normalMatrix * moonSlope / length(normalMatrix[0]));
          diffuseColor.rgb *= 1.0 + moonTint;
        }`)
    }
  }
  material.customProgramCacheKey = () => `${previousKey}/moon-normal-texture-v2/${clip ? 'clip' : 'open'}`
  configureTerrainShadowFade(material)
  return shade
}

/** Skirts never cast shadows. Depth programs only clip coverage and skirts;
 * they do not sample the detail texture or modify measured geometry. */
export function configureMoonTerrainDepth(material: THREE.Material, state: SurfaceState, metersPerUnit: number, clip: boolean, origin = new THREE.Vector3(), camera = { value: new THREE.Vector3() }) {
  configureMoonSurfaceMaterial(material, state, metersPerUnit, clip, origin, camera)
  const previous = material.onBeforeCompile, key = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    shader.vertexShader = 'attribute float terrainSkirt; varying float vTerrainSkirt;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainSkirt = terrainSkirt;')
    shader.fragmentShader = 'varying float vTerrainSkirt;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (vTerrainSkirt > 0.000001) discard;')
  }
  material.customProgramCacheKey = () => key + '/moon-depth'
}
