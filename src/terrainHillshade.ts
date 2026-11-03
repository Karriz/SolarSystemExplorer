import * as THREE from 'three'
import { globalHillshadeDeclarations, type GlobalHillshadeLayer } from './GlobalHillshadeLayer.ts'

/** A body-fixed cartographic hillshade toggle shared by each body's base and LOD materials. */
export type HillshadeState = { value: number }

export function configureTerrainHillshade(material: THREE.Material, enabled: HillshadeState, texture?: GlobalHillshadeLayer) {
  const previous = material.onBeforeCompile
  const previousKey = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    shader.uniforms.terrainHillshadeEnabled = enabled
    if (texture) Object.assign(shader.uniforms, { hsGlobalBase:texture.base,hsGlobalPages:texture.pages,hsGlobalTable:texture.table,
      hsGlobalLevels:texture.levels,hsGlobalReady:texture.ready,hsGlobalEnabled:texture.enabled,hsGlobalPoolReady:texture.poolReady })
    shader.vertexShader = `varying vec3 vTerrainHillshadeNormal; varying vec3 vTerrainHillshadeRadial;\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vTerrainHillshadeNormal = normalize(normal);
      vTerrainHillshadeRadial = normalize(position);`)
    shader.fragmentShader = `varying vec3 vTerrainHillshadeNormal; varying vec3 vTerrainHillshadeRadial; uniform float terrainHillshadeEnabled;\n${shader.fragmentShader}`
    if (texture) shader.fragmentShader = globalHillshadeDeclarations + shader.fragmentShader
    // Physical materials copy diffuseColor into their lighting state here.
    // Apply hillshade before that copy so it affects the rendered lighting.
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `
      vec3 hsRadial = normalize(vTerrainHillshadeRadial);
      vec3 hsNormal = normalize(vTerrainHillshadeNormal);
      vec3 hsEast = vec3(hsRadial.z, 0.0, -hsRadial.x);
      float hsEastLength = length(hsEast);
      hsEast = hsEastLength > 0.0001 ? hsEast / hsEastLength : vec3(0.0, 0.0, -1.0);
      vec3 hsNorth = normalize(cross(hsRadial, hsEast));
      // Four 45-degree-elevation lights: southwest, west, northwest, north.
      // Cross-slope weights retain features parallel to any one light.
      // The regularizer gives almost-flat ground a continuous, neutral limit.
      vec4 hsSin = vec4(-0.70710678, -1.0, -0.70710678, 0.0);
      vec4 hsCos = vec4(-0.70710678, 0.0, 0.70710678, 1.0);
      float hsEastSlope = dot(hsNormal, hsEast);
      float hsNorthSlope = dot(hsNormal, hsNorth);
      vec4 hsCrossSlope = hsEastSlope * hsCos - hsNorthSlope * hsSin;
      vec4 hsWeights = hsCrossSlope * hsCrossSlope + vec4(0.0001);
      vec4 hsLight = max(vec4(dot(hsNormal, hsRadial))
        + hsEastSlope * hsSin + hsNorthSlope * hsCos, vec4(0.0));
      // Divide each light by its flat-ground response before mixing.
      float hsRelief = dot(hsLight, hsWeights) / dot(hsWeights, vec4(1.0));
      // A restrained direction-independent slope accent keeps canyon walls
      // legible under frontal sunlight, where opposing lights flatten relief.
      // These are measured mesh normals, before generated material detail.
      float hsSlope = length(vec2(hsEastSlope, hsNorthSlope));
      float hsAccent = 0.18 * smoothstep(0.03, 0.65, hsSlope);
      float hsFactor = clamp(1.0 + 0.65 * (hsRelief - 1.0) - hsAccent, 0.55, 1.30);
      ${texture ? `
      if(hsGlobalEnabled>0.5 && hsGlobalReady>0.5){
        vec2 uv=vec2(atan(-hsRadial.z,hsRadial.x)/6.28318530718+0.5,asin(clamp(hsRadial.y,-1.0,1.0))/3.14159265359+0.5);
        vec2 dx=dFdx(uv),dy=dFdy(uv);dx.x-=round(dx.x);dy.x-=round(dy.x);
        float footprint=max(length(dx*hsGlobalLevels[5].xy),length(dy*hsGlobalLevels[5].xy));
        float level=clamp(5.0-log2(max(footprint,1.0)),0.0,5.0);
        float encoded=mix(hsGlobalSample(uv,int(floor(level))),hsGlobalSample(uv,int(ceil(level))),fract(level));
        hsFactor=mix(0.55,1.30,encoded);
      }` : ''}
      diffuseColor.rgb *= mix(1.0, hsFactor, terrainHillshadeEnabled);
      #include <lights_physical_fragment>`)
  }
  material.customProgramCacheKey = () => `${previousKey}/terrain-hillshade-global-v5/${texture ? 'texture' : 'mesh'}`
  material.needsUpdate = true
}
