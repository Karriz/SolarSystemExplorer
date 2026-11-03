import * as THREE from 'three'
import { MAX_SURFACE_CLIPS, type SurfaceState } from './surfaceMaterial.ts'
import { configureTerrainShadowFade } from './terrainShadows.ts'

export type PlanetShade = {
  camera: { value: THREE.Vector3 }
  origin: { value: THREE.Vector3 }
  metersPerUnit: { value: number }
}

/** Per-body scale of the shared detail system: the triplanar repeat is a
 * physical distance on the surface, so each body needs its radius and the
 * repeat length baked into its textures. */
export type SurfaceDetailProfile = {
  radiusMeters: number
  detailRepeatMeters: number
  mediumRepeatMeters: number
  /** Fractional brightness variation in linear reflectance. */
  albedoStrength: number
  /** Patch-local physical coordinates avoid float loss on Earth-sized bodies. */
  localDetailCoordinates?: boolean
}
export const MOON_DETAIL_PROFILE: SurfaceDetailProfile = { radiusMeters: 1737400, detailRepeatMeters: 64, mediumRepeatMeters: 256, albedoStrength: 0.24 }
export const MARS_DETAIL_PROFILE: SurfaceDetailProfile = { radiusMeters: 3389500, detailRepeatMeters: 128, mediumRepeatMeters: 512, albedoStrength: 0.3 }

export const MERCURY_DETAIL_PROFILE: SurfaceDetailProfile = { radiusMeters: 2439700, detailRepeatMeters: 64, mediumRepeatMeters: 256, albedoStrength: 0.28 }

/** Conservative basalt material; inferred detail never displaces the Magellan DEM. */
export const VENUS_DETAIL_PROFILE: SurfaceDetailProfile = { radiusMeters: 6051800, detailRepeatMeters: 64, mediumRepeatMeters: 256, albedoStrength: 0.12 }

/** Overlapping distance bands keep medium features after grain filters out. */
const DETAIL_NEAR_METERS = 300
const DETAIL_FAR_METERS = 3000
const MEDIUM_NEAR_METERS = 2500
const MEDIUM_FAR_METERS = 18000
/** Screen pixels per color texel. Bilinear looks soft just above one pixel
 * and becomes a flat block after a couple of dozen; sharpen only between. */
export const MOON_COLOR_SHARPEN = { riseStart: 1.15, riseEnd: 2.2, fallStart: 10, fallEnd: 24, limit: 0.5, strength: 1 }
const glslFloat = (value: number) => Number.isInteger(value) ? `${value}.0` : String(value)

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/** 0 outside the mid-zoom window, 1 where a magnified color texel is soft. */
export function moonColorSharpenWeight(pixelsPerTexel: number): number {
  const { riseStart, riseEnd, fallStart, fallEnd } = MOON_COLOR_SHARPEN
  return smoothstep(riseStart, riseEnd, pixelsPerTexel) * (1 - smoothstep(fallStart, fallEnd, pixelsPerTexel))
}

/** Bounded cross unsharp of the color map. Flat albedo is unchanged; the
 * residual cannot exceed half the local contrast, so crater rims do not grow
 * a bright halo. Hardware mips stay in charge when the map is minified. */
function moonColorSharpenChunk() {
  const { riseStart, riseEnd, fallStart, fallEnd, limit, strength } = MOON_COLOR_SHARPEN
  return `#ifdef USE_MAP
        vec2 moonLonLat = surfaceLonLat();
        vec2 moonUv = vec2(moonLonLat.x / 360.0 + 0.5, moonLonLat.y / 180.0 + 0.5);
        vec2 moonUvDx = dFdx(moonUv), moonUvDy = dFdy(moonUv);
        moonUvDx.x -= round(moonUvDx.x); moonUvDy.x -= round(moonUvDy.x);
        vec4 moonColor = textureGrad(map, moonUv, moonUvDx, moonUvDy);
        vec2 moonTexel = 1.0 / vec2(textureSize(map, 0));
        float moonMagX = moonTexel.x / max(length(vec2(moonUvDx.x, moonUvDy.x)), 1.0e-8);
        float moonMagY = moonTexel.y / max(length(vec2(moonUvDx.y, moonUvDy.y)), 1.0e-8);
        float moonSharpX = smoothstep(${glslFloat(riseStart)}, ${glslFloat(riseEnd)}, moonMagX) * (1.0 - smoothstep(${glslFloat(fallStart)}, ${glslFloat(fallEnd)}, moonMagX));
        float moonSharpY = smoothstep(${glslFloat(riseStart)}, ${glslFloat(riseEnd)}, moonMagY) * (1.0 - smoothstep(${glslFloat(fallStart)}, ${glslFloat(fallEnd)}, moonMagY));
        float moonSharp = max(moonSharpX, moonSharpY) * moonColorSharpen;
        if (moonSharp > 0.001) {
          vec3 moonEast = textureGrad(map, moonUv + vec2(moonTexel.x, 0.0), moonUvDx, moonUvDy).rgb;
          vec3 moonWest = textureGrad(map, moonUv - vec2(moonTexel.x, 0.0), moonUvDx, moonUvDy).rgb;
          vec3 moonNorth = textureGrad(map, moonUv + vec2(0.0, moonTexel.y), moonUvDx, moonUvDy).rgb;
          vec3 moonSouth = textureGrad(map, moonUv - vec2(0.0, moonTexel.y), moonUvDx, moonUvDy).rgb;
          vec3 moonCenter = moonColor.rgb;
          vec3 moonMin = min(moonCenter, min(min(moonEast, moonWest), min(moonNorth, moonSouth)));
          vec3 moonMax = max(moonCenter, max(max(moonEast, moonWest), max(moonNorth, moonSouth)));
          vec3 moonBlur = ((moonEast + moonWest) * moonSharpX + (moonNorth + moonSouth) * moonSharpY)
            / max(2.0 * (moonSharpX + moonSharpY), 1.0e-4);
          vec3 moonDelta = moonCenter - moonBlur;
          vec3 moonLimit = vec3(${glslFloat(limit)}) * max(abs(moonCenter - moonMin), abs(moonMax - moonCenter));
          moonDelta = clamp(moonDelta, -moonLimit, moonLimit);
          moonColor.rgb = clamp(moonCenter + moonDelta * (${glslFloat(strength)} * moonSharp), 0.0, 1.0);
        }
        if (moonVectorReady > 0.5) {
          vec2 ll = surfaceLonLat();
          float centerLon = (moonVectorBounds.x + moonVectorBounds.z) * 0.5;
          float localLon = mod(ll.x - centerLon + 180.0, 360.0) - 180.0;
          vec2 patchUv = vec2(0.5 + localLon / (moonVectorBounds.z - moonVectorBounds.x),
            (ll.y - moonVectorBounds.y) / (moonVectorBounds.w - moonVectorBounds.y));
          vec2 edge = min(patchUv, 1.0 - patchUv);
          float weight = smoothstep(0.0, 0.08, min(edge.x, edge.y));
          weight *= 1.0 - smoothstep(78.0, 80.0, abs(ll.y));
          vec2 safePatchUv = clamp(patchUv, 0.0, 1.0);
          vec3 patchColor = texture2D(moonVectorMap, safePatchUv).rgb;
          if (moonVectorSoftReady > 0.5) {
            vec3 softColor = texture2D(moonVectorSoftMap, safePatchUv).rgb;
            patchColor = softColor;
          }
          moonColor.rgb = mix(moonColor.rgb, patchColor, weight);
        }
        diffuseColor *= moonColor;
        #endif`
}

/** Shared, mipmapped packed normal/reflectance/roughness textures supply material
 * detail. Triplanar body-fixed sampling avoids seams and polar stretching.
 * It never displaces the measured mesh or runs a procedural field per pixel. */
export function configurePlanetSurfaceMaterial(material: THREE.Material, state: SurfaceState, metersPerUnit: number, clip: boolean, origin = new THREE.Vector3(), camera = { value: new THREE.Vector3() }, profile: SurfaceDetailProfile = MOON_DETAIL_PROFILE): PlanetShade {
  const shade: PlanetShade = { camera, origin: { value: origin }, metersPerUnit: { value: metersPerUnit } }
  const fineScale = profile.radiusMeters / profile.detailRepeatMeters
  const mediumScale = profile.radiusMeters / profile.mediumRepeatMeters
  const previous = material.onBeforeCompile
  const previousKey = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    Object.assign(shader.uniforms, {
      moonCamera: shade.camera, moonOrigin: shade.origin, moonMetersPerUnit: shade.metersPerUnit, moonDetail: state.detail,
    })
    if (profile.localDetailCoordinates) {
      const phase = (repeat: number) => new THREE.Vector3(...origin.toArray().map(value => THREE.MathUtils.euclideanModulo(value * metersPerUnit / repeat, 1)))
      shader.uniforms.planetFineOrigin = { value: phase(profile.detailRepeatMeters) }
      shader.uniforms.planetMediumOrigin = { value: phase(profile.mediumRepeatMeters) }
      shader.vertexShader = 'varying vec3 vPlanetFineCoords; varying vec3 vPlanetMediumCoords; uniform vec3 planetFineOrigin; uniform vec3 planetMediumOrigin;\n' + shader.vertexShader
      shader.fragmentShader = 'varying vec3 vPlanetFineCoords; varying vec3 vPlanetMediumCoords;\n' + shader.fragmentShader
    }
    const shaded = shader.fragmentShader.includes('#include <normal_fragment_maps>')
    if (shaded) Object.assign(shader.uniforms, { moonDetailMap: state.detailMap, moonDetailReady: state.detailMapReady,
      moonMediumMap: state.mediumDetailMap, moonMediumReady: state.mediumDetailReady, moonColorSharpen: state.colorSharpen,
      moonVectorMap: state.vectorColorMap, moonVectorBounds: state.vectorColorBounds, moonVectorReady: state.vectorColorReady,
      moonVectorSoftMap: state.vectorColorSoftMap, moonVectorSoftReady: state.vectorColorSoftReady })
    if (clip) Object.assign(shader.uniforms, { surfaceClips: state.clips, surfaceClipCount: state.clipCount })
    shader.vertexShader = `varying float vMoonFade; varying float vMoonMediumFade; varying vec3 vMoonDir; uniform vec3 moonCamera; uniform vec3 moonOrigin; uniform float moonMetersPerUnit; uniform float moonDetail;
      ${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      ${profile.localDetailCoordinates ? `vPlanetFineCoords = position * ${glslFloat(metersPerUnit / profile.detailRepeatMeters)} + planetFineOrigin;
      vPlanetMediumCoords = position * ${glslFloat(metersPerUnit / profile.mediumRepeatMeters)} + planetMediumOrigin;` : ''}
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
      vec2 surfaceLonLat() { vec3 p = normalize(vMoonDir); float lon = dot(p.xz,p.xz) > 1.0e-20 ? atan(-p.z,p.x) : 0.0; return vec2(lon, asin(clamp(p.y, -1.0, 1.0))) * 57.295779513; }
      bool surfaceInside(vec2 p, vec4 b) { return p.x >= b.x && p.x <= b.z && p.y >= b.y && p.y <= b.w; }
      ${shader.fragmentShader}`
    if (clip) shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
      vec2 clipLonLat = surfaceLonLat();
      for (int i = 0; i < ${MAX_SURFACE_CLIPS}; i++) { if (i >= surfaceClipCount) break; if (surfaceInside(clipLonLat, surfaceClips[i])) discard; }`)
    if (shaded && shader.fragmentShader.includes('#include <map_fragment>')) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', moonColorSharpenChunk())
    }
    if (shaded) {
      shader.fragmentShader = `uniform sampler2D moonVectorMap; uniform vec4 moonVectorBounds; uniform float moonVectorReady;
        uniform sampler2D moonVectorSoftMap; uniform float moonVectorSoftReady;
        uniform sampler2D moonDetailMap; uniform float moonDetailReady;
        uniform sampler2D moonMediumMap; uniform float moonMediumReady;
        uniform float moonColorSharpen;
        #ifndef OBJECTSPACE_NORMALMAP
        uniform mat3 normalMatrix;
        #endif
        vec2 moonSurfaceSample(sampler2D detailTexture, vec3 coords, vec3 weights, out vec3 slope) {
          vec4 sx = texture2D(detailTexture, coords.zy);
          vec4 sy = texture2D(detailTexture, coords.xz);
          vec4 sz = texture2D(detailTexture, coords.xy);
          vec2 tx = sx.rg * 2.0 - 1.0, ty = sy.rg * 2.0 - 1.0, tz = sz.rg * 2.0 - 1.0;
          vec3 nx = vec3(tx, sqrt(max(0.01, 1.0 - dot(tx, tx))));
          vec3 ny = vec3(ty, sqrt(max(0.01, 1.0 - dot(ty, ty))));
          vec3 nz = vec3(tz, sqrt(max(0.01, 1.0 - dot(tz, tz))));
          slope = vec3(0.0, nx.y, nx.x) / max(0.25, nx.z) * weights.x
            + vec3(ny.x, 0.0, ny.y) / max(0.25, ny.z) * weights.y
            + vec3(nz.x, nz.y, 0.0) / max(0.25, nz.z) * weights.z;
          return vec2(dot(vec3(sx.a, sy.a, sz.a), weights), dot(vec3(sx.b, sy.b, sz.b), weights));
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
            vec2 fineMaterial = moonSurfaceSample(moonDetailMap, ${profile.localDetailCoordinates ? 'vPlanetFineCoords' : `moonDirection * (${glslFloat(fineScale)})`}, moonWeights, fineSlope);
            moonSlope += fineSlope * (0.4 * vMoonFade);
            roughnessFactor = mix(roughnessFactor, fineMaterial.x, vMoonFade);
            moonTint += (fineMaterial.y * 2.0 - 1.0) * (${glslFloat(profile.albedoStrength * 0.6)} * vMoonFade);
          }
          if (moonMediumOn) {
            vec3 mediumSlope;
            // Blend more broadly between projections at this scale. Their
            // different surface footprints break up repeated outcrop motifs
            // without additional texture fetches or per-pixel noise.
            vec3 mediumWeights = abs(moonDirection);
            mediumWeights /= mediumWeights.x + mediumWeights.y + mediumWeights.z;
            vec2 mediumMaterial = moonSurfaceSample(moonMediumMap, ${profile.localDetailCoordinates ? 'vPlanetMediumCoords' : `moonDirection * (${glslFloat(mediumScale)})`}, mediumWeights, mediumSlope);
            moonSlope += mediumSlope * (0.45 * vMoonMediumFade);
            roughnessFactor = mix(roughnessFactor, mediumMaterial.x, 0.65 * vMoonMediumFade);
            moonTint += (mediumMaterial.y * 2.0 - 1.0) * (${glslFloat(profile.albedoStrength)} * vMoonMediumFade);
          }
          moonSlope -= moonDirection * dot(moonSlope, moonDirection);
          // The scene uses uniform AU scaling. Remove that scale from the
          // normal transform so strength is identical on globe and tile meshes.
          normal = normalize(normal + normalMatrix * moonSlope / length(normalMatrix[0]));
          diffuseColor.rgb *= 1.0 + moonTint;
        }`)
    }
  }
  material.customProgramCacheKey = () => `${previousKey}/planet-packed-detail-v8/${profile.radiusMeters}/${profile.detailRepeatMeters}/${profile.mediumRepeatMeters}/${profile.albedoStrength}/${profile.localDetailCoordinates ? 'local/' : ''}${clip ? 'clip' : 'open'}`
  configureTerrainShadowFade(material)
  return shade
}

/** Skirts never cast shadows. Depth programs only clip coverage and skirts;
 * they do not sample the detail texture or modify measured geometry. */
export function configurePlanetTerrainDepth(material: THREE.Material, state: SurfaceState, metersPerUnit: number, clip: boolean, origin = new THREE.Vector3(), camera = { value: new THREE.Vector3() }, profile: SurfaceDetailProfile = MOON_DETAIL_PROFILE) {
  configurePlanetSurfaceMaterial(material, state, metersPerUnit, clip, origin, camera, profile)
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
