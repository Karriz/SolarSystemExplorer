import * as THREE from 'three'

export type SurfaceState = {
  detail: { value: number }; clips: { value: THREE.Vector4[] }; clipCount: { value: number }
  classification: { value: THREE.Texture | null }; classBounds: { value: THREE.Vector4 }; hasClassification: { value: number }
}
export function surfaceState(): SurfaceState {
  return { detail: { value: 1 }, clips: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) }, clipCount: { value: 0 },
    classification: { value: null }, classBounds: { value: new THREE.Vector4() }, hasClassification: { value: 0 } }
}

/** Shared body-fixed detail, with stable regional mean color. Coverage clipping
 * is used only on fallback surfaces, never on the replacing measured patch. */
export function configureSurfaceMaterial(material: THREE.Material, state: SurfaceState, radiusMeters: number, unitScale: number, clip: boolean, origin = new THREE.Vector3()) {
  const previous = material.onBeforeCompile
  const previousKey = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    Object.assign(shader.uniforms, { surfaceDetail: state.detail, surfaceClips: state.clips, surfaceClipCount: state.clipCount,
      surfaceClass: state.classification, surfaceClassBounds: state.classBounds, surfaceHasClass: state.hasClassification,
      surfaceRadius: { value: radiusMeters }, surfaceUnitScale: { value: unitScale }, surfaceOrigin: { value: origin },
      surfaceNoiseOrigin: { value: origin.clone().multiplyScalar(radiusMeters).set(THREE.MathUtils.euclideanModulo(origin.x * radiusMeters, 10240), THREE.MathUtils.euclideanModulo(origin.y * radiusMeters, 10240), THREE.MathUtils.euclideanModulo(origin.z * radiusMeters, 10240)) } })
    shader.vertexShader = `varying vec3 vSurfaceUnit; varying vec3 vSurfaceDetailPosition; varying float vSurfaceSlope; uniform float surfaceUnitScale; uniform vec3 surfaceOrigin; uniform float surfaceRadius;\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vSurfaceUnit = position * surfaceUnitScale + surfaceOrigin;
      vSurfaceDetailPosition = position * surfaceUnitScale * surfaceRadius;
      vSurfaceSlope = 1.0 - clamp(dot(normalize(normal), normalize(vSurfaceUnit)), 0.0, 1.0);`)
    shader.fragmentShader = `
      varying vec3 vSurfaceUnit; varying vec3 vSurfaceDetailPosition; varying float vSurfaceSlope; uniform vec3 surfaceNoiseOrigin;
      uniform float surfaceRadius; uniform float surfaceDetail;
      uniform vec4 surfaceClips[4]; uniform int surfaceClipCount;
      uniform sampler2D surfaceClass; uniform vec4 surfaceClassBounds; uniform float surfaceHasClass;
      vec2 surfaceLonLat() { vec3 p = normalize(vSurfaceUnit); return vec2(atan(-p.z,p.x), asin(clamp(p.y,-1.0,1.0))) * 57.295779513; }
      bool surfaceInside(vec2 p, vec4 b) { return p.x >= b.x && p.x <= b.z && p.y >= b.y && p.y <= b.w; }
      float surfaceHash(vec3 p) { p=mod(p,1024.0); p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x+p.y)*p.z); }
      float surfaceNoise(vec3 p) {
        vec3 a=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
        return mix(mix(mix(surfaceHash(a),surfaceHash(a+vec3(1,0,0)),f.x),
          mix(surfaceHash(a+vec3(0,1,0)),surfaceHash(a+vec3(1,1,0)),f.x),f.y),
          mix(mix(surfaceHash(a+vec3(0,0,1)),surfaceHash(a+vec3(1,0,1)),f.x),
          mix(surfaceHash(a+vec3(0,1,1)),surfaceHash(a+vec3(1,1,1)),f.x),f.y),f.z);
      }
      ${shader.fragmentShader}`
    if (clip) shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
      vec2 clipLonLat=surfaceLonLat();
      for(int i=0;i<4;i++) { if(i < surfaceClipCount && surfaceInside(clipLonLat,surfaceClips[i])) discard; }`)
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      vec3 detailP=vSurfaceDetailPosition+surfaceNoiseOrigin;
      float footprint=max(length(dFdx(detailP)),length(dFdy(detailP)));
      float detailFade=surfaceDetail*(1.0-smoothstep(0.25,2.0,footprint));
      if(detailFade>0.001) {
        float rock=smoothstep(0.025,0.20,vSurfaceSlope);
        if(surfaceHasClass>0.5) {
          vec2 ll=surfaceLonLat();
          if(surfaceInside(ll,surfaceClassBounds)) {
            vec2 uv=vec2((ll.x-surfaceClassBounds.x)/(surfaceClassBounds.z-surfaceClassBounds.x),
              (surfaceClassBounds.w-ll.y)/(surfaceClassBounds.w-surfaceClassBounds.y));
            float label=texture2D(surfaceClass,uv).r*255.0;
            // WorldCover vegetation vs bare/built surfaces. This controls fine
            // material response, never replaces observed regional color.
            if(abs(label-80.0)<0.5) { detailFade=0.0; roughnessFactor=0.18; }
            if(label>0.5) rock=(abs(label-60.0)<0.5 || abs(label-50.0)<0.5)?1.0:0.0;
          }
        }
        float coarse=surfaceNoise(detailP*0.6);
        float fine=surfaceNoise(detailP*2.5+vec3(17.0,31.0,11.0));
        float bump=mix(0.012,0.045,rock)*(coarse+0.3*fine)*detailFade;
        vec3 sx=dFdx(-vViewPosition*149597870700.0), sy=dFdy(-vViewPosition*149597870700.0);
        vec3 r1=cross(sy,normal), r2=cross(normal,sx);
        float det=dot(sx,r1);
        normal=normalize(abs(det)*normal-sign(det)*(dFdx(bump)*r1+dFdy(bump)*r2));
        diffuseColor.rgb *= 1.0 + (coarse-0.5)*0.055*detailFade;
        roughnessFactor=mix(roughnessFactor,mix(0.97,0.82,rock),detailFade);
      }`)
  }
  material.customProgramCacheKey = () => `${previousKey}/surface-pilot-v1/${clip ? 'fallback' : 'patch'}`
}

/** Skirts hide mixed-LOD cracks but are not physical cliffs or shadow casters. */
export function configureTerrainDepth(material: THREE.MeshDepthMaterial, state: SurfaceState, radiusMeters: number, clip: boolean, origin = new THREE.Vector3()) {
  configureSurfaceMaterial(material, state, radiusMeters, 1, clip, origin)
  const previous = material.onBeforeCompile, key = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    shader.vertexShader = 'attribute float terrainSkirt; varying float vTerrainSkirt;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainSkirt=terrainSkirt;')
    shader.fragmentShader = 'varying float vTerrainSkirt;\n' + shader.fragmentShader
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif(vTerrainSkirt>0.000001) discard;')
  }
  material.customProgramCacheKey = () => key + '/physical-surface-only'
}
