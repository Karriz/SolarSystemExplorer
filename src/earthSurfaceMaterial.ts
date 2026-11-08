import * as THREE from 'three'
import { configurePlanetSurfaceMaterial, type SurfaceDetailProfile } from './planetSurfaceMaterial.ts'
import type { SurfaceState } from './surfaceMaterial.ts'
import { MASK_WIDTH, MASK_GUTTER, SHORE_DISTANCE } from './earthSurfaceData.ts'
import type { TileAddress } from './surfaceTiles.ts'

export const EARTH_DETAIL_PROFILE: SurfaceDetailProfile = { radiusMeters: 6371000, detailRepeatMeters: 64, mediumRepeatMeters: 256, albedoStrength: .12, localDetailCoordinates: true }
export type EarthMaterialState = {
  global: { value: THREE.Texture }; globalReady: { value: number }; time: { value: number }
}
export function earthMaskBinding() { return { map: { value: null as THREE.Texture | null }, surface: { value: null as THREE.Texture | null }, active: { value: 0 }, width: { value: MASK_WIDTH }, transform: { value: new THREE.Vector4() } } }
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
    // Some WebGL atan implementations return zero on the negative X axis.
    // Resolve that narrow angular case explicitly before wrapping gradients;
    // otherwise the longitude jumps to Greenwich for one pixel at the seam.
    shader.fragmentShader = shader.fragmentShader.replace('atan(-p.z,p.x)',
      '(p.x<0.0 && abs(p.z)<abs(p.x)*1.0e-7 ? (p.z>=0.0 ? -3.14159265359 : 3.14159265359) : atan(-p.z,p.x))')
    Object.assign(shader.uniforms, { earthGlobal: earth.global, earthGlobalReady: earth.globalReady, earthTime: earth.time })
    if (binding) Object.assign(shader.uniforms, { earthMask: binding.map, earthSurface: binding.surface, earthMaskActive: binding.active, earthMaskTransform: binding.transform, earthMaskWidth: binding.width })
    if (binding) configureEarthMaskProjection(shader, binding)
    shader.vertexShader = `varying float vEarthDistance;\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
      vEarthDistance = distance(position + moonOrigin, moonCamera) * moonMetersPerUnit;`)
    shader.fragmentShader = `uniform sampler2D earthGlobal; uniform float earthGlobalReady; uniform float earthTime;
      varying float vEarthDistance;
      ${binding ? 'uniform sampler2D earthMask; uniform sampler2D earthSurface; uniform float earthMaskActive; uniform float earthMaskWidth; varying vec2 vEarthMaskUv;' : ''}
      ${shader.fragmentShader}`
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nvec3 earthMeasuredNormal=normal; float earthGeneratedTint=0.0;')
    // Material palettes are applied after the shared detail chunk. Preserve
    // its generated tint so mapped ground does not erase most of that detail.
    shader.fragmentShader = shader.fragmentShader.replace('diffuseColor.rgb *= 1.0 + moonTint;', 'diffuseColor.rgb *= 1.0 + moonTint; earthGeneratedTint=moonTint;')
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `
      vec2 earthLl=surfaceLonLat();
      vec2 earthGlobalUv=vec2(earthLl.x/360.0+0.5,0.5-earthLl.y/180.0);
      vec2 earthGlobalDx=dFdx(earthGlobalUv), earthGlobalDy=dFdy(earthGlobalUv);
      earthGlobalDx.x-=round(earthGlobalDx.x); earthGlobalDy.x-=round(earthGlobalDy.x);
      float globalWater=earthGlobalReady>0.5 ? textureGrad(earthGlobal,earthGlobalUv,earthGlobalDx,earthGlobalDy).r : 0.0;
      vec3 waterColor=vec3(0.008,0.045,0.075);
      vec4 earthSample=vec4(mix(diffuseColor.rgb,waterColor,globalWater),globalWater);
      float earthMapped=0.0;
      float earthRelief=mix(0.5,0.0,globalWater);
      float earthRoughness=mix(roughnessFactor,0.24,globalWater);
      ${binding ? `if(earthMaskActive>0.5) {
        vec4 palette=texture2D(earthMask,vEarthMaskUv);
        vec4 response=texture2D(earthSurface,vEarthMaskUv);
        float distanceTexels=(response.g*2.0-1.0)*${SHORE_DISTANCE}.0;
        float footprint=max(length(dFdx(vEarthMaskUv)*earthMaskWidth),length(dFdy(vEarthMaskUv)*earthMaskWidth));
        float edgeWidth=max(0.001,max(fwidth(distanceTexels),footprint*0.5));
        float crispWater=smoothstep(-edgeWidth*0.5,edgeWidth*0.5,distanceTexels);
        // Averaged signed distances are invalid when minified. Fractional area
        // coverage and its mip chain preserve distant islands without shimmer.
        float wet=mix(crispWater,response.r,smoothstep(0.7,1.5,footprint));
        vec3 land=diffuseColor.rgb;
        if(response.r<0.995) land=max(vec3(0.0),palette.rgb-waterColor*response.r+diffuseColor.rgb*(1.0-palette.a))/max(0.005,1.0-response.r);
        earthSample=vec4(mix(land,waterColor,wet),wet);
        earthMapped=palette.a;
        earthRelief=response.b;
        earthRoughness=response.a;
      }` : ''}
      // Retain the fixed composite's bright polar sea-ice appearance. This is
      // an appearance heuristic, not a dated observed sea-ice classification.
      float earthIce=smoothstep(0.35,0.65,max(diffuseColor.r,max(diffuseColor.g,diffuseColor.b)))*smoothstep(55.0,75.0,abs(earthLl.y));
      earthSample=mix(earthSample,vec4(diffuseColor.rgb,0.0),earthIce);
      float earthClose=1.0-smoothstep(20000.0,180000.0,vEarthDistance);
      float earthWater=earthSample.a;
      normal=normalize(mix(earthMeasuredNormal,normal,earthRelief));
      // Keep broad geographic color variation rather than painting flat biome swatches.
      float earthBrightness=clamp(dot(diffuseColor.rgb,vec3(0.2126,0.7152,0.0722))*2.0+0.7,0.75,1.25);
      diffuseColor.rgb=mix(diffuseColor.rgb,earthSample.rgb*earthBrightness,earthClose*0.82);
      diffuseColor.rgb=mix(diffuseColor.rgb,earthSample.rgb,earthWater*0.94);
      diffuseColor.rgb*=1.0+earthGeneratedTint*earthClose*0.82*earthMapped*(1.0-earthWater);
      roughnessFactor=mix(roughnessFactor,earthRoughness,max(earthMapped,earthWater));
      // Water has a radial surface normal even when unresolved DEM noise remains.
      vec3 earthDir=normalize(vMoonDir);
      vec3 wave=vec3(sin(earthDir.z*210000.0+earthTime*0.55),sin(earthDir.x*190000.0-earthTime*0.4),sin(earthDir.y*220000.0+earthTime*0.35));
      wave-=earthDir*dot(wave,earthDir);
      float earthWaveFade=1.0-smoothstep(300.0,18000.0,vEarthDistance);
      vec3 waterNormal=normalize(normalMatrix*(earthDir+wave*0.025*earthWaveFade));
      normal=normalize(mix(normal,waterNormal,earthWater));
      #include <lights_physical_fragment>`)
  }
  material.customProgramCacheKey = () => `${previousKey}/earth-coverage-v2/${binding ? 'patch' : 'global'}`
  return shade
}
