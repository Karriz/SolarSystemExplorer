import * as THREE from 'three'

/** A body-fixed cartographic hillshade toggle shared by each body's base and LOD materials. */
export type HillshadeState = { value: number }

export function configureTerrainHillshade(material: THREE.Material, enabled: HillshadeState) {
  const previous = material.onBeforeCompile
  const previousKey = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    shader.uniforms.terrainHillshadeEnabled = enabled
    shader.vertexShader = `varying vec3 vTerrainHillshadeNormal; varying vec3 vTerrainHillshadeRadial;\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vTerrainHillshadeNormal = normalize(normal);
      vTerrainHillshadeRadial = normalize(position);`)
    shader.fragmentShader = `varying vec3 vTerrainHillshadeNormal; varying vec3 vTerrainHillshadeRadial; uniform float terrainHillshadeEnabled;\n${shader.fragmentShader}`
    // Physical materials copy diffuseColor into their lighting state here.
    // Apply hillshade before that copy so it affects the rendered lighting.
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `
      vec3 hsRadial = normalize(vTerrainHillshadeRadial);
      vec3 hsNormal = normalize(vTerrainHillshadeNormal);
      vec3 hsEast = vec3(hsRadial.z, 0.0, -hsRadial.x);
      float hsEastLength = length(hsEast);
      hsEast = hsEastLength > 0.0001 ? hsEast / hsEastLength : vec3(0.0, 0.0, -1.0);
      vec3 hsNorth = normalize(cross(hsRadial, hsEast));
      float hsAzimuth = 5.4977871438; // 315 degrees clockwise from north
      float hsAltitude = 0.7853981634; // 45 degrees
      vec3 hsLight = normalize(hsRadial * sin(hsAltitude)
        + (hsNorth * cos(hsAzimuth) + hsEast * sin(hsAzimuth)) * cos(hsAltitude));
      float hsFlatLight = sin(hsAltitude);
      float hsTerrainLight = max(dot(hsNormal, hsLight), 0.0);
      float hsFactor = clamp(1.0 + 0.55 * (hsTerrainLight / hsFlatLight - 1.0), 0.45, 1.35);
      diffuseColor.rgb *= mix(1.0, hsFactor, terrainHillshadeEnabled);
      #include <lights_physical_fragment>`)
  }
  material.customProgramCacheKey = () => `${previousKey}/terrain-hillshade-v2`
  material.needsUpdate = true
}
