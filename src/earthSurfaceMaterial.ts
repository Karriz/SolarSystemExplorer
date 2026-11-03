import * as THREE from 'three'
import { configurePlanetSurfaceMaterial, type SurfaceDetailProfile } from './planetSurfaceMaterial.ts'
import type { SurfaceState } from './surfaceMaterial.ts'
import { MASK_WIDTH, MASK_GUTTER } from './earthSurfaceData.ts'
import type { TileAddress } from './surfaceTiles.ts'

export const EARTH_DETAIL_PROFILE: SurfaceDetailProfile = { radiusMeters: 6371000, detailRepeatMeters: 64, mediumRepeatMeters: 256, albedoStrength: .12, localDetailCoordinates: true }
export type EarthMaterialState = {
  global: { value: THREE.Texture }; globalReady: { value: number }; time: { value: number }
}
export function earthMaskBinding() { return { map: { value: null as THREE.Texture | null }, active: { value: 0 }, width: { value: MASK_WIDTH }, transform: { value: new THREE.Vector4() } } }
export type EarthMaskBinding = ReturnType<typeof earthMaskBinding>

/** Used by the material and the independent WebGL projection regression. */
export function configureEarthMaskProjection(shader: Parameters<THREE.Material['onBeforeCompile']>[0], binding: EarthMaskBinding) {
  shader.uniforms.earthMaskTransform = binding.transform
  shader.vertexShader = 'attribute vec2 earthColorUv; uniform vec4 earthMaskTransform; varying vec2 vEarthMaskUv;\n' + shader.vertexShader
  shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\nvEarthMaskUv=earthColorUv*earthMaskTransform.xy+earthMaskTransform.zw;')
}

/** Projection stays CPU-local, including when a child uses a retained parent. */
export function earthMaskTransform(address: TileAddress, parent: TileAddress, target = new THREE.Vector4(), width = MASK_WIDTH) {
  const scale = 2 ** (parent.z - address.z), size = width - MASK_GUTTER * 2, k = size / width
  return target.set(scale * k, -scale * k, (MASK_GUTTER + (address.x * scale - parent.x) * size) / width,
    (MASK_GUTTER + (address.y * scale - parent.y + scale) * size) / width)
}

/** Shared planet normal/roughness detail, with Earth's mapped surface response.
 * Class masks change materials; measured mesh heights remain separate. */
export function configureEarthSurfaceMaterial(material: THREE.Material, state: SurfaceState, earth: EarthMaterialState,
  metersPerUnit: number, clip: boolean, origin = new THREE.Vector3(), camera = { value: new THREE.Vector3() }, binding?: EarthMaskBinding) {
  const shade = configurePlanetSurfaceMaterial(material, state, metersPerUnit, clip, origin, camera, EARTH_DETAIL_PROFILE)
  const previous = material.onBeforeCompile, previousKey = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    if (!shader.fragmentShader.includes('#include <lights_physical_fragment>')) return
    Object.assign(shader.uniforms, { earthGlobal: earth.global, earthGlobalReady: earth.globalReady, earthTime: earth.time })
    if (binding) Object.assign(shader.uniforms, { earthMask: binding.map, earthMaskActive: binding.active, earthMaskTransform: binding.transform, earthMaskWidth: binding.width })
    if (binding) configureEarthMaskProjection(shader, binding)
    shader.vertexShader = `varying float vEarthDistance;\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
      vEarthDistance = distance(position + moonOrigin, moonCamera) * moonMetersPerUnit;`)
    shader.fragmentShader = `uniform sampler2D earthGlobal; uniform float earthGlobalReady; uniform float earthTime;
      varying float vEarthDistance;
      ${binding ? 'uniform sampler2D earthMask; uniform float earthMaskActive; uniform float earthMaskWidth; varying vec2 vEarthMaskUv;' : ''}
      vec4 earthMaterial(float id, vec3 base) {
        if(id<0.5) return vec4(base,0.0);
        if(id<1.5) return vec4(0.035,0.075,0.025,0.0);
        if(id<2.5) return vec4(0.11,0.16,0.045,0.0);
        if(id<3.5) return vec4(0.19,0.20,0.075,0.0);
        if(id<4.5) return vec4(0.50,0.39,0.22,0.0);
        if(id<5.5) return vec4(0.21,0.20,0.18,0.0);
        if(id<6.5) return vec4(0.75,0.80,0.82,0.0);
        if(id<7.5) return vec4(0.20,0.19,0.17,0.0);
        if(id<8.5) return vec4(0.06,0.12,0.07,0.0);
        return vec4(0.008,0.045,0.075,1.0);
      }
      ${binding ? `vec4 earthLocal(vec3 base) {
        vec2 pixel=vEarthMaskUv*earthMaskWidth-0.5, f=fract(pixel), uv=(floor(pixel)+0.5)/earthMaskWidth;
        vec2 d=vec2(1.0/earthMaskWidth,0.0);
        vec4 a=earthMaterial(texture2D(earthMask,uv).r*255.0,base);
        vec4 b=earthMaterial(texture2D(earthMask,uv+d.xy).r*255.0,base);
        vec4 c=earthMaterial(texture2D(earthMask,uv+d.yx).r*255.0,base);
        vec4 e=earthMaterial(texture2D(earthMask,uv+d.xx).r*255.0,base);
        return mix(mix(a,b,f.x),mix(c,e,f.x),f.y);
      }` : ''}
      ${shader.fragmentShader}`
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nvec3 earthMeasuredNormal=normal; float earthGeneratedTint=0.0;')
    // Material palettes are applied after the shared detail chunk. Preserve
    // its generated tint so mapped ground does not erase most of that detail.
    shader.fragmentShader = shader.fragmentShader.replace('diffuseColor.rgb *= 1.0 + moonTint;', 'diffuseColor.rgb *= 1.0 + moonTint; earthGeneratedTint=moonTint;')
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `
      vec2 earthLl=surfaceLonLat();
      float earthId=earthGlobalReady>0.5 ? texture2D(earthGlobal,vec2(earthLl.x/360.0+0.5,0.5-earthLl.y/180.0)).r*255.0 : 0.0;
      vec4 earthSample=earthMaterial(earthId,diffuseColor.rgb);
      ${binding ? 'if(earthMaskActive>0.5) { earthSample=earthLocal(diffuseColor.rgb); earthId=texture2D(earthMask,vEarthMaskUv).r*255.0; }' : ''}
      // Retain the fixed composite's bright polar sea-ice appearance. This is
      // an appearance heuristic, not a dated observed sea-ice classification.
      float earthIce=smoothstep(0.35,0.65,max(diffuseColor.r,max(diffuseColor.g,diffuseColor.b)))*smoothstep(55.0,75.0,abs(earthLl.y));
      earthSample=mix(earthSample,vec4(diffuseColor.rgb,0.0),earthIce);
      float earthClose=1.0-smoothstep(20000.0,180000.0,vEarthDistance);
      float earthWater=earthSample.a;
      float earthRelief=0.5;
      if(earthId>0.5 && earthId<3.5) earthRelief=0.14;
      if(earthId>3.5 && earthId<4.5) earthRelief=0.18;
      if(earthId>4.5 && earthId<5.5) earthRelief=1.0;
      if(earthId>5.5 && earthId<8.5) earthRelief=0.12;
      normal=normalize(mix(earthMeasuredNormal,normal,earthRelief));
      // Keep broad geographic color variation rather than painting flat biome swatches.
      float earthBrightness=clamp(dot(diffuseColor.rgb,vec3(0.2126,0.7152,0.0722))*2.0+0.7,0.75,1.25);
      diffuseColor.rgb=mix(diffuseColor.rgb,earthSample.rgb*earthBrightness,earthClose*0.82);
      diffuseColor.rgb=mix(diffuseColor.rgb,earthSample.rgb,earthWater*0.94);
      if(earthId>0.5 && earthId<8.5) diffuseColor.rgb*=1.0+earthGeneratedTint*earthClose*0.82;
      roughnessFactor=mix(roughnessFactor,0.24,earthWater);
      // Water has a radial surface normal even when unresolved DEM noise remains.
      vec3 earthDir=normalize(vMoonDir);
      vec3 wave=vec3(sin(earthDir.z*210000.0+earthTime*0.55),sin(earthDir.x*190000.0-earthTime*0.4),sin(earthDir.y*220000.0+earthTime*0.35));
      wave-=earthDir*dot(wave,earthDir);
      float earthWaveFade=1.0-smoothstep(300.0,18000.0,vEarthDistance);
      vec3 waterNormal=normalize(normalMatrix*(earthDir+wave*0.025*earthWaveFade));
      normal=normalize(mix(normal,waterNormal,earthWater));
      #include <lights_physical_fragment>`)
  }
  material.customProgramCacheKey = () => `${previousKey}/earth-mapped-v1/${binding ? 'patch' : 'global'}`
  return shade
}
