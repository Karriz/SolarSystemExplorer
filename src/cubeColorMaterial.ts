import type * as THREE from 'three'

/** Sample geographic color per fragment so cube faces never interpolate
 * longitude across the dateline or stretch a triangle's UVs over a pole. */
export function configureCubeColorMaterial(material: THREE.Material) {
  const previous = material.onBeforeCompile
  const key = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    shader.vertexShader = `varying vec3 vCubeColorDirection;\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vCubeColorDirection = normalize(position);`)
    shader.fragmentShader = `varying vec3 vCubeColorDirection;
      vec4 cubeColorSample(sampler2D colorTexture) {
        vec3 direction = normalize(vCubeColorDirection);
        float longitude = dot(direction.xz, direction.xz) > 1.0e-20 ? atan(-direction.z, direction.x) : 0.0;
        vec2 uv = vec2(longitude / 6.28318530718 + 0.5, asin(clamp(direction.y, -1.0, 1.0)) / 3.14159265359 + 0.5);
        vec2 dx = dFdx(uv), dy = dFdy(uv);
        dx.x -= round(dx.x); dy.x -= round(dy.x);
        return textureGrad(colorTexture, uv, dx, dy);
      }
      ${shader.fragmentShader}`
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #ifdef USE_MAP
        diffuseColor *= cubeColorSample(map);
      #endif`)
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
      #ifdef USE_EMISSIVEMAP
        totalEmissiveRadiance *= cubeColorSample(emissiveMap).rgb;
      #endif`)
  }
  material.customProgramCacheKey = () => `${key}/cube-geographic-color-v1`
  material.needsUpdate = true
}
