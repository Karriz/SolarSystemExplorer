import { atmosphereGeometryShader } from './atmosphereGeometryShader.ts'
import { phaseAsRgb, type AtmosphereProfile, type OpticalRgb } from './atmosphereProfiles.ts'

const scalar = (n: number) => n.toExponential(10)
const rgb = (v: OpticalRgb) => `vec3(${v.map(scalar).join(',')})`

/** Shared optical equations for view integration and surface illumination.
 * LUTs store radiance/irradiance per unit solar irradiance, in linear RGB. */
export function atmosphereCommon(profile: AtmosphereProfile) {
  return /* glsl */`
    uniform float atmEnabled;
    uniform sampler2D atmTransmittance;
    uniform sampler2D atmMultiple;
    uniform sampler2D atmIrradiance;
    uniform vec4 atmTableSize;
    uniform vec3 atmSunDirection;
    uniform vec3 atmSolar;
    uniform vec3 atmCameraKm;
    uniform vec3 atmViewForward;
    uniform vec2 atmDepthCoefficients;
    uniform float atmMultipleStrength;
    uniform float atmCloudPhase;
    uniform float atmCloudVariation;
    const float ATM_PI = 3.141592653589793;
    const float ATM_RADIUS = ${scalar(profile.radiusKm)};
    const float ATM_HEIGHT = ${scalar(profile.heightKm)};
    const float ATM_TOP = ATM_RADIUS + ATM_HEIGHT;
    const vec3 ATM_RAYLEIGH = ${rgb(profile.rayleigh)};
    const vec3 ATM_AEROSOL = ${rgb(profile.aerosolScattering)};
    const vec3 ATM_AEROSOL_ABSORPTION = ${rgb(profile.aerosolAbsorption)};
    const vec3 ATM_OZONE = ${rgb(profile.ozoneAbsorption)};
    ${atmosphereGeometryShader}
    vec2 atmSphere(vec3 p, vec3 d, float r) { return atmGeometrySphere(p,d,r); }
    vec2 atmTexelUv(vec2 uv, vec2 size) { return (clamp(uv,0.0,1.0)*(size-1.0)+0.5)/size; }
    vec2 atmTransUv(float radius, float mu) {
      float r=clamp(radius,ATM_RADIUS,ATM_TOP);
      float H=sqrt((ATM_TOP-ATM_RADIUS)*(ATM_TOP+ATM_RADIUS));
      float rho=sqrt(max(0.0,(r-ATM_RADIUS)*(r+ATM_RADIUS)));
      float d=max(0.0,-r*mu+sqrt(max(0.0,r*r*(mu*mu-1.0)+ATM_TOP*ATM_TOP)));
      return atmTexelUv(vec2((d-(ATM_TOP-r))/max(1e-6,rho+H-(ATM_TOP-r)),rho/H),atmTableSize.xy);
    }
    vec2 atmMultiUv(float radius, float mu) {
      return atmTexelUv(vec2(0.5+0.5*sign(mu)*sqrt(abs(mu)),sqrt(max(0.0,(radius-ATM_RADIUS)/ATM_HEIGHT))),atmTableSize.zw);
    }
    vec3 atmSunTransmission(vec3 p) {
      float len=length(p), r=max(ATM_RADIUS+0.001,len), mu=dot(p,atmSunDirection)/len;
      float horizon=-sqrt(max(0.0,1.0-(ATM_RADIUS/r)*(ATM_RADIUS/r)));
      float visible=smoothstep(horizon-${scalar(profile.sunAngularRadius)},horizon+${scalar(profile.sunAngularRadius)},mu);
      return visible*texture2D(atmTransmittance,atmTransUv(r,max(horizon+1e-6,mu))).rgb;
    }
    void atmMedium(float altitude, out vec3 scattering, out vec3 extinction, out float molecular, out float aerosol) {
      float h=max(0.0,altitude);
      molecular=exp(-h/${scalar(profile.rayleighScaleKm)});
      aerosol=exp(-h/${scalar(profile.aerosolScaleKm)});
      float ozone=max(0.0,1.0-abs(h-${scalar(profile.ozoneCenterKm)})/${scalar(profile.ozoneWidthKm)});
      scattering=ATM_RAYLEIGH*molecular+ATM_AEROSOL*aerosol;
      ${profile.model ? `scattering=ATM_RAYLEIGH*molecular+ATM_AEROSOL*aerosol*(vec3(1.0)-${rgb(phaseAsRgb(profile.aerosolG))});` : ''}
      extinction=scattering+ATM_AEROSOL_ABSORPTION*aerosol+ATM_OZONE*ozone;
      ${profile.clouds ? `
        float cloud=smoothstep(${scalar(profile.clouds.baseKm)},${scalar(profile.clouds.baseKm+profile.clouds.edgeKm)},h)
          *(1.0-smoothstep(${scalar(profile.clouds.topKm-profile.clouds.edgeKm)},${scalar(profile.clouds.topKm)},h));
        vec3 cloudScattering=${scalar(profile.clouds.extinction*(1-profile.clouds.g))}*${rgb(profile.clouds.albedo)}*cloud;
        scattering+=cloudScattering;
        extinction+=cloudScattering+${scalar(profile.clouds.extinction)}*(vec3(1.0)-${rgb(profile.clouds.albedo)})*cloud;
      ` : ''}
    }
    vec3 atmSkyIrradiance(vec3 p) {
      float r=length(p);
      return texture2D(atmIrradiance,atmMultiUv(r,dot(p,atmSunDirection)/r)).rgb*atmSolar;
    }
  `
}

export function atmosphereViewShader(profile: AtmosphereProfile) {
  return /* glsl */`
    ${atmosphereCommon(profile)}
    uniform sampler2D atmSceneDepth;
    uniform mat4 atmInverseProjection;
    uniform mat3 atmViewToBody;
    uniform float atmUnitsKm;
    void atmIntegrate(vec3 origin, vec3 direction, float endpoint, out vec3 transmission, out vec3 radiance) {
      transmission=vec3(1.0); radiance=vec3(0.0);
      vec2 interval=atmSphere(origin,direction,ATM_TOP);
      float start=max(0.0,interval.x), end=min(endpoint,interval.y);
      ${profile.model ? `
        // A solid core well below all measured relief prevents background/MSAA
        // rays from integrating air through the planet's interior.
        vec2 core=atmSphere(origin,direction,ATM_RADIUS-30.0);
        if(core.x>0.0 && core.y>=core.x) end=min(end,core.x);
      ` : ''}
      if(end<=start) return;
      float cosine=dot(direction,atmSunDirection);
      float rayPhase=3.0*(1.0+cosine*cosine)/(16.0*ATM_PI);
      const vec3 g=${rgb(phaseAsRgb(profile.aerosolG))};
      vec3 aerosolPhase=3.0*(vec3(1.0)-g*g)*(1.0+cosine*cosine)/(8.0*ATM_PI*(2.0+g*g)*pow(vec3(1.0)+g*g-2.0*g*cosine,vec3(1.5)));
      ${profile.clouds ? `
        // Align quadrature with the cloud top. Without this split a grazing
        // ray can skip the thin entry gradient and form a dotted orbital rim.
        vec2 cloudRange=atmSphere(origin,direction,ATM_RADIUS+${scalar(profile.clouds.topKm)});
        float entry=cloudRange.y>=cloudRange.x?clamp(cloudRange.x,start,end):end;
        float exit=cloudRange.y>=cloudRange.x?clamp(cloudRange.y,start,end):end;
        for(int segment=0;segment<3;segment++) {
          float segmentStart=segment==0?start:segment==1?entry:exit;
          float segmentEnd=segment==0?entry:segment==1?exit:end;
          if(segmentEnd<=segmentStart) continue;
      ` : 'float segmentStart=start,segmentEnd=end;'}
      const int STEPS=48;
      for(int i=0;i<STEPS;i++) {
        float t0=mix(segmentStart,segmentEnd,0.5-0.5*cos(ATM_PI*float(i)/float(STEPS)));
        float t1=mix(segmentStart,segmentEnd,0.5-0.5*cos(ATM_PI*float(i+1)/float(STEPS)));
        vec3 p=origin+direction*((t0+t1)*0.5);
        float r=length(p), molecular, aerosol; vec3 scattering, extinction;
        float altitude=r-ATM_RADIUS;
        ${profile.clouds ? `
          // Generated body-fixed structure. Longitude terms use Cartesian x/z
          // and vanish at poles, avoiding a seam or a singular polar whirl.
          vec3 unit=p/r;
          vec2 spun=mat2(cos(atmCloudPhase),-sin(atmCloudPhase),sin(atmCloudPhase),cos(atmCloudPhase))*unit.xz;
          float wave=sin(unit.y*19.0+spun.x*8.0)*sin(spun.y*13.0-unit.y*7.0)*dot(unit.xz,unit.xz);
          altitude-=wave*${scalar(profile.clouds.variation*5)}*atmCloudVariation
            *smoothstep(${scalar(profile.clouds.baseKm-5)},${scalar(profile.clouds.baseKm)},altitude)
            *(1.0-smoothstep(${scalar(profile.clouds.topKm)},${scalar(profile.clouds.topKm+5)},altitude));
        ` : ''}
        atmMedium(altitude,scattering,extinction,molecular,aerosol);
        vec3 source=${profile.model ? 'scattering/(4.0*ATM_PI)' : '(ATM_RAYLEIGH*molecular*rayPhase+ATM_AEROSOL*aerosol*aerosolPhase)'}*atmSunTransmission(p);
        source+=scattering*texture2D(atmMultiple,atmMultiUv(r,dot(p,atmSunDirection)/r)).rgb*atmMultipleStrength;
        vec3 stepT=exp(-extinction*(t1-t0));
        radiance+=transmission*(vec3(1.0)-stepT)/max(vec3(1e-10),extinction)*source;
        transmission*=stepT;
      }
      ${profile.clouds ? '}' : ''}
      radiance*=atmSolar;
    }
    vec4 atmComposite(vec2 uv, vec4 sceneColor) {
      if(atmEnabled<=0.0) return sceneColor;
      vec4 farPoint=atmInverseProjection*vec4(uv*2.0-1.0,1.0,1.0);
      vec3 direction=normalize(atmViewToBody*normalize(farPoint.xyz));
      float depth=texture2D(atmSceneDepth,uv).x;
      float endpoint=1e20;
      if(depth<1.0) {
        vec4 hit=atmInverseProjection*vec4(uv*2.0-1.0,depth*2.0-1.0,1.0);
        endpoint=length(hit.xyz)/max(abs(hit.w),1e-30)*atmUnitsKm;
      }
      vec3 transmission, radiance;
      atmIntegrate(atmCameraKm,direction,endpoint,transmission,radiance);
      // CSS supplies the overview backdrop. Dense sky uses a black-space matte;
      // extremely thin air fades out smoothly instead of exposing a shell edge.
      float skyMatte=1.0-exp(-80.0*(1.0-min(transmission.r,min(transmission.g,transmission.b))));
      return vec4(sceneColor.rgb*mix(vec3(1.0),transmission,atmEnabled)+radiance*atmEnabled,
        mix(sceneColor.a,sceneColor.a+(1.0-sceneColor.a)*skyMatte,atmEnabled));
    }
  `
}
