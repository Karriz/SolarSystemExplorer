import * as THREE from 'three'
import type { AtmosphericLighting } from './AtmosphereRenderer.ts'
import { atmosphereCommon } from './atmosphereShader.ts'
import { earthAtmosphere, type AtmosphereProfile } from './atmosphereProfiles.ts'

/** Compose after the surface's position/detail hooks. A patch's local origin
 * and unit conversion preserve km precision independently of mesh residency. */
export function configureAtmosphericLighting(material: THREE.Material, state: AtmosphericLighting, fallbackSphere = false, profile: AtmosphereProfile = earthAtmosphere) {
  const previous = material.onBeforeCompile, key = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    if (!shader.fragmentShader.includes('#include <lights_fragment_begin>')) return
    Object.assign(shader.uniforms, state)
    shader.vertexShader = 'varying vec3 vAtmospherePointKm;\n' + shader.vertexShader
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vAtmospherePointKm=(position+moonOrigin)*moonMetersPerUnit*0.001;`)
    shader.fragmentShader = `varying vec3 vAtmospherePointKm;\n${atmosphereCommon(profile)}\n${shader.fragmentShader}`
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', `
      vec3 atmSurfacePoint=vAtmospherePointKm;
      ${fallbackSphere ? `
        // Only the unmeasured fallback globe gets analytic spherical depth.
        // Otherwise flat triangles look like kilometer-deep air-filled bowls.
        gl_FragDepth=gl_FragCoord.z;
        if(atmEnabled>0.0) {
          vec3 direction=normalize(vAtmospherePointKm-atmCameraKm);
          vec2 hit=atmSphere(atmCameraKm,direction,ATM_RADIUS);
          if(hit.x>0.0 && hit.y>=hit.x) {
            vec3 point=atmCameraKm+direction*hit.x;
            float distanceZ=dot(point-atmCameraKm,atmViewForward);
            gl_FragDepth=mix(gl_FragCoord.z,atmDepthCoefficients.x+atmDepthCoefficients.y/max(1e-6,distanceZ),atmEnabled);
            atmSurfacePoint=mix(atmSurfacePoint,point,atmEnabled);
          }
        }` : ''}
      #include <lights_physical_fragment>`)
    // Expand this one chunk so both point and shadowed directional sunlight
    // receive the SAME transmission before their BRDF/specular evaluation.
    let lights: string = THREE.ShaderChunk.lights_fragment_begin
    lights = lights.replaceAll('RE_Direct( directLight,', 'directLight.color *= mix(vec3(1.0),atmSunTransmission(atmSurfacePoint),atmEnabled);\nRE_Direct( directLight,')
    lights = lights.replace('vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );',
      'vec3 irradiance = mix(getAmbientLightIrradiance(ambientLightColor),atmSkyIrradiance(atmSurfacePoint),atmEnabled);')
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', lights)
  }
  material.customProgramCacheKey = () => key + `/${profile.id}-atmospheric-illumination-v3/${fallbackSphere ? 'sphere' : 'terrain'}`
}
