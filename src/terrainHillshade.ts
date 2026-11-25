import * as THREE from 'three'
import { globalHillshadeDeclarations, type GlobalHillshadeLayer } from './GlobalHillshadeLayer.ts'

/** Shared relief-shading enable toggle (0 while dense Venus/Titan clouds obscure ground). */
export type HillshadeState = { value: number }

/** Dynamic streamed RG8 tangent-space normal maps (schema 2), with seamless
 * cross-fade into measured CubeTerrainLayer vertex normals at close range and
 * backward-compatible fallback to legacy R8 cartographic hillshade (schema 1). */
export function configureTerrainHillshade(
  material: THREE.Material,
  enabled: HillshadeState,
  texture?: GlobalHillshadeLayer,
  options: { cubeMesh?: boolean; radiusMeters?: number } = {},
) {
  const cubeMesh = options.cubeMesh ?? false
  const radiusMeters = options.radiusMeters ?? 1737400
  const previous = material.onBeforeCompile
  const previousKey = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    shader.uniforms.terrainHillshadeEnabled = enabled
    if (texture) {
      Object.assign(shader.uniforms, {
        hsGlobalBase: texture.base,
        hsGlobalPages: texture.pages,
        hsGlobalTable: texture.table,
        hsGlobalLevels: texture.levels,
        hsGlobalReady: texture.ready,
        hsGlobalEnabled: texture.enabled,
        hsGlobalPoolReady: texture.poolReady,
        hsGlobalMode: texture.mode,
      })
    }
    shader.vertexShader = `varying vec3 vTerrainHillshadeNormal; varying vec3 vTerrainHillshadeRadial; varying vec3 vHsRotX; varying vec3 vHsRotY; varying vec3 vHsRotZ;\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vTerrainHillshadeNormal = normalize(normal);
      vTerrainHillshadeRadial = normalize(position);
      vHsRotX = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));
      vHsRotY = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
      vHsRotZ = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));`)
    shader.fragmentShader = `varying vec3 vTerrainHillshadeNormal; varying vec3 vTerrainHillshadeRadial; varying vec3 vHsRotX; varying vec3 vHsRotY; varying vec3 vHsRotZ; uniform float terrainHillshadeEnabled;\n${shader.fragmentShader}`
    if (texture) shader.fragmentShader = globalHillshadeDeclarations + shader.fragmentShader

    // Schema 2 (RG8 tangent-space normals): apply before close-range triplanar detail
    // in <normal_fragment_maps> so fine rock/dust normals layer cleanly on top.
    const hasNormalBegin = Boolean(texture && shader.fragmentShader.includes('#include <normal_fragment_begin>'))
    if (hasNormalBegin) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
      vec2 hsDynamicSlope = vec2(0.0);
      float hsDynamicWeight = 0.0;
      if (terrainHillshadeEnabled > 0.0 && hsGlobalEnabled > 0.5 && hsGlobalReady > 0.5 && hsGlobalMode > 1.5) {
        vec3 hsRadN = normalize(vTerrainHillshadeRadial);
        vec3 hsEastN = vec3(hsRadN.z, 0.0, -hsRadN.x);
        float hsEastLenN = length(hsEastN);
        hsEastN = hsEastLenN > 0.0001 ? hsEastN / hsEastLenN : vec3(0.0, 0.0, -1.0);
        vec3 hsNorthN = normalize(cross(hsRadN, hsEastN));
        float hsLon = (hsRadN.x < 0.0 && abs(hsRadN.z) < abs(hsRadN.x) * 1.0e-7)
          ? (hsRadN.z >= 0.0 ? -3.14159265359 : 3.14159265359)
          : atan(-hsRadN.z, hsRadN.x);
        vec2 hsUv = vec2(hsLon / 6.28318530718 + 0.5, asin(clamp(hsRadN.y, -1.0, 1.0)) / 3.14159265359 + 0.5);
        vec2 hsDx = dFdx(hsUv), hsDy = dFdy(hsUv); hsDx.x -= round(hsDx.x); hsDy.x -= round(hsDy.x);
        float hsFootprint = max(length(hsDx * hsGlobalLevels[5].xy), length(hsDy * hsGlobalLevels[5].xy));
        float hsLevel = clamp(5.0 - log2(max(hsFootprint, 1.0)), 0.0, 5.0);
        vec2 hsEnc = mix(hsGlobalSample(hsUv, int(floor(hsLevel))), hsGlobalSample(hsUv, int(ceil(hsLevel))), fract(hsLevel));
        hsDynamicSlope = clamp((hsEnc * 255.0 - 127.0) / 127.0, -1.0, 1.0);
        float hsNz = sqrt(max(0.01, 1.0 - dot(hsDynamicSlope, hsDynamicSlope)));
        vec3 hsMapBodyNormal = normalize(hsEastN * hsDynamicSlope.x + hsNorthN * hsDynamicSlope.y + hsRadN * hsNz);
        ${cubeMesh ? `
        // Cross-fade smoothly from 1 km streamed normals into finer measured cube-mesh
        // vertex normals as camera descends, preventing double-counted slopes.
        float hsTexelMeters = 3.14159265359 * ${radiusMeters.toFixed(1)} / max(1.0, hsGlobalLevels[5].y);
        float hsCamMeters = length(vViewPosition) * 149597870700.0;
        hsDynamicWeight = smoothstep(hsTexelMeters * 35.0, hsTexelMeters * 180.0, hsCamMeters) * terrainHillshadeEnabled;
        ` : `
        hsDynamicWeight = terrainHillshadeEnabled;
        `}
        vec3 hsMeshBodyNormal = normalize(vTerrainHillshadeNormal);
        vec3 hsBlendedBody = normalize(mix(hsMeshBodyNormal, hsMapBodyNormal, hsDynamicWeight));
        normal = normalize(vHsRotX * hsBlendedBody.x + vHsRotY * hsBlendedBody.y + vHsRotZ * hsBlendedBody.z);
      }`)
    }

    // Legacy schema 1 R8 hillshade fallback + subtle direction-independent slope cavity accent for schema 2.
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `
      ${texture ? `
      if (terrainHillshadeEnabled > 0.0 && hsGlobalEnabled > 0.5 && hsGlobalReady > 0.5) {
        if (hsGlobalMode > 1.5) {
          ${hasNormalBegin ? `
          // Restrained direction-independent cavity accent keeps steep scarps legible under frontal sunlight.
          float hsCavity = 1.0 - 0.07 * smoothstep(0.06, 0.65, length(hsDynamicSlope)) * hsDynamicWeight;
          diffuseColor.rgb *= hsCavity;` : ''}
        } else {
          vec3 hsRadial = normalize(vTerrainHillshadeRadial);
          vec2 uv = vec2(atan(-hsRadial.z, hsRadial.x) / 6.28318530718 + 0.5, asin(clamp(hsRadial.y, -1.0, 1.0)) / 3.14159265359 + 0.5);
          vec2 dx = dFdx(uv), dy = dFdy(uv); dx.x -= round(dx.x); dy.x -= round(dy.x);
          float footprint = max(length(dx * hsGlobalLevels[5].xy), length(dy * hsGlobalLevels[5].xy));
          float level = clamp(5.0 - log2(max(footprint, 1.0)), 0.0, 5.0);
          float encoded = mix(hsGlobalSample(uv, int(floor(level))).r, hsGlobalSample(uv, int(ceil(level))).r, fract(level));
          float hsFactor = mix(0.55, 1.30, encoded);
          diffuseColor.rgb *= mix(1.0, hsFactor, terrainHillshadeEnabled);
        }
      }
      ` : `
      vec3 hsRadial = normalize(vTerrainHillshadeRadial);
      vec3 hsNormal = normalize(vTerrainHillshadeNormal);
      vec3 hsEast = vec3(hsRadial.z, 0.0, -hsRadial.x);
      float hsEastLength = length(hsEast);
      hsEast = hsEastLength > 0.0001 ? hsEast / hsEastLength : vec3(0.0, 0.0, -1.0);
      vec3 hsNorth = normalize(cross(hsRadial, hsEast));
      vec4 hsSin = vec4(-0.70710678, -1.0, -0.70710678, 0.0);
      vec4 hsCos = vec4(-0.70710678, 0.0, 0.70710678, 1.0);
      float hsEastSlope = dot(hsNormal, hsEast);
      float hsNorthSlope = dot(hsNormal, hsNorth);
      vec4 hsCrossSlope = hsEastSlope * hsCos - hsNorthSlope * hsSin;
      vec4 hsWeights = hsCrossSlope * hsCrossSlope + vec4(0.0001);
      vec4 hsLight = max(vec4(dot(hsNormal, hsRadial)) + hsEastSlope * hsSin + hsNorthSlope * hsCos, vec4(0.0));
      float hsRelief = dot(hsLight, hsWeights) / dot(hsWeights, vec4(1.0));
      float hsSlope = length(vec2(hsEastSlope, hsNorthSlope));
      float hsAccent = 0.18 * smoothstep(0.03, 0.65, hsSlope);
      float hsFactor = clamp(1.0 + 0.65 * (hsRelief - 1.0) - hsAccent, 0.55, 1.30);
      diffuseColor.rgb *= mix(1.0, hsFactor, terrainHillshadeEnabled);
      `}
      #include <lights_physical_fragment>`)
  }
  material.customProgramCacheKey = () => `${previousKey}/terrain-relief-normals-v6/${texture ? (cubeMesh ? 'cube' : 'globe') : 'mesh'}/${Math.round(radiusMeters)}`
  material.needsUpdate = true
}
