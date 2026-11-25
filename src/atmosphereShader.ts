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
    uniform mat3 atmViewToBody;
    uniform vec2 atmDepthCoefficients;
    uniform float atmMultipleStrength;
    uniform float atmCloudPhase;
    uniform float atmCloudVariation;
    ${profile.id === 'earth' ? `
    uniform sampler2D atmEarthClouds;
    uniform float atmEarthCloudsReady;
    uniform float atmEarthCloudStrength;
    ` : ''}
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
    ${profile.id === 'earth' ? `
    float atmCloudHash3(vec3 p) {
      p = fract(p * 0.1031);
      p += dot(p, p.yzx + 33.33);
      return fract((p.x + p.y) * p.z);
    }
    float atmCloudNoise3(vec3 p) {
      vec3 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(
        mix(mix(atmCloudHash3(i), atmCloudHash3(i + vec3(1.0, 0.0, 0.0)), f.x),
            mix(atmCloudHash3(i + vec3(0.0, 1.0, 0.0)), atmCloudHash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
        mix(mix(atmCloudHash3(i + vec3(0.0, 0.0, 1.0)), atmCloudHash3(i + vec3(1.0, 0.0, 1.0)), f.x),
            mix(atmCloudHash3(i + vec3(0.0, 1.0, 1.0)), atmCloudHash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
        f.z);
    }
    float atmEarthCloudDensity(vec3 pCloud, float camDistKm) {
      if (atmEarthCloudsReady < 0.5 || atmEarthCloudStrength <= 0.0) return 0.0;
      vec3 u = normalize(pCloud);
      float lon = (u.x < 0.0 && abs(u.z) < abs(u.x) * 1.0e-7)
        ? (u.z >= 0.0 ? -ATM_PI : ATM_PI)
        : atan(-u.z, u.x);
      vec2 uv = vec2(lon / (2.0 * ATM_PI) + 0.5, asin(clamp(u.y, -1.0, 1.0)) / ATM_PI + 0.5);
      float base = texture2D(atmEarthClouds, uv).r;
      // Add subtle 3D procedural wisp breakup only at close range so 4K texels stay organic.
      float detailWeight = 1.0 - smoothstep(120.0, 900.0, camDistKm);
      if (detailWeight > 0.001 && base > 0.02) {
        float wisp = 0.65 * atmCloudNoise3(pCloud * 0.14) + 0.35 * atmCloudNoise3(pCloud * 0.42 + vec3(7.3, -4.1, 2.9));
        base = clamp(base + (wisp - 0.5) * 0.28 * detailWeight * smoothstep(0.02, 0.35, base) * (1.0 - 0.4 * base), 0.0, 1.0);
      }
      return base * atmEarthCloudStrength;
    }
    vec3 atmEarthCloudRadiance(vec3 pCloud, vec3 viewDir, float density) {
      vec3 u = normalize(pCloud);
      float muSun = dot(u, atmSunDirection);
      // Soft multiple-scattered cloud illumination + gentle forward-scatter silver lining.
      float wrapDiffuse = pow(max(0.0, muSun), 0.72) * 0.78 + 0.22 * smoothstep(-0.08, 0.28, muSun);
      float cosTheta = dot(viewDir, atmSunDirection);
      float g = 0.62;
      float hg = (1.0 - g * g) / (4.0 * ATM_PI * pow(max(0.05, 1.0 + g * g - 2.0 * g * cosTheta), 1.5));
      float forwardBoost = 1.0 + min(0.85, hg * 0.45) * (1.0 - 0.65 * density);
      vec3 direct = atmSunTransmission(pCloud) * atmSolar * (wrapDiffuse * forwardBoost);
      vec3 skyFill = atmSkyIrradiance(pCloud) * (0.45 + 0.25 * (1.0 - density));
      return vec3(0.95, 0.96, 0.98) * (direct / ATM_PI + skyFill / ATM_PI);
    }
    float atmEarthCloudShadow(vec3 pKm) {
      if (atmEarthCloudsReady < 0.5 || atmEarthCloudStrength <= 0.0) return 1.0;
      vec3 u = normalize(pKm);
      float muSun = dot(u, atmSunDirection);
      float sunFade = smoothstep(0.02, 0.16, muSun);
      if (sunFade <= 0.001) return 1.0;
      const float CLOUD_R = ATM_RADIUS + 8.0;
      float r2 = dot(pKm, pKm);
      if (r2 >= CLOUD_R * CLOUD_R) return 1.0;
      float b = dot(pKm, atmSunDirection);
      float t = min(140.0, -b + sqrt(max(0.0, b * b - r2 + CLOUD_R * CLOUD_R)));
      float density = atmEarthCloudDensity(pKm + atmSunDirection * t, 1000.0);
      float shadow = smoothstep(0.08, 0.88, density) * 0.66 * sunFade;
      return 1.0 - shadow;
    }
    ` : ''}
    vec3 atmSkyReflection(vec3 pointKm, vec3 reflDir) {
      vec2 hit = atmSphere(pointKm, reflDir, ATM_TOP);
      float end = hit.y;
      if (end <= 0.0) return vec3(0.0);
      float cosine = dot(reflDir, atmSunDirection);
      float rayPhase = 3.0 * (1.0 + cosine * cosine) / (16.0 * ATM_PI);
      const vec3 gRefl = ${rgb(phaseAsRgb(profile.aerosolG))};
      vec3 aerosolPhase = 3.0 * (vec3(1.0) - gRefl * gRefl) * (1.0 + cosine * cosine)
        / (8.0 * ATM_PI * (2.0 + gRefl * gRefl) * pow(vec3(1.0) + gRefl * gRefl - 2.0 * gRefl * cosine, vec3(1.5)));
      vec3 T = vec3(1.0), L = vec3(0.0);
      ${profile.id === 'earth' ? `
      vec2 cloudHit = atmSphere(pointKm, reflDir, ATM_RADIUS + 8.0);
      float tCloud = (atmEarthCloudsReady > 0.5 && atmEarthCloudStrength > 0.0 && cloudHit.y > 0.0 && cloudHit.y < end) ? cloudHit.y : -1.0;
      bool cloudDone = tCloud <= 0.0;
      ` : ''}
      const int RSTEPS = 6;
      for (int i = 0; i < RSTEPS; i++) {
        float u0 = float(i) / float(RSTEPS), u1 = float(i + 1) / float(RSTEPS);
        float t0 = end * u0 * u0, t1 = end * u1 * u1;
        ${profile.id === 'earth' ? `
        if (!cloudDone && t1 >= tCloud) {
          float cd = atmEarthCloudDensity(pointKm + reflDir * tCloud, tCloud);
          float ca = smoothstep(0.05, 0.90, cd) * 0.92;
          if (ca > 0.001) {
            L += T * ca * atmEarthCloudRadiance(pointKm + reflDir * tCloud, reflDir, cd);
            T *= (1.0 - ca);
          }
          cloudDone = true;
        }
        ` : ''}
        vec3 p = pointKm + reflDir * ((t0 + t1) * 0.5);
        float r = length(p), molecular, aerosol; vec3 scattering, extinction;
        atmMedium(r - ATM_RADIUS, scattering, extinction, molecular, aerosol);
        vec3 source = ${profile.model ? 'scattering / (4.0 * ATM_PI)' : '(ATM_RAYLEIGH * molecular * rayPhase + ATM_AEROSOL * aerosol * aerosolPhase)'} * atmSunTransmission(p);
        source += scattering * texture2D(atmMultiple, atmMultiUv(r, dot(p, atmSunDirection) / r)).rgb * atmMultipleStrength;
        vec3 stepT = exp(-extinction * (t1 - t0));
        L += T * (vec3(1.0) - stepT) / max(vec3(1e-10), extinction) * source * atmSolar;
        T *= stepT;
      }
      return L;
    }
  `
}

export function atmosphereViewShader(profile: AtmosphereProfile) {
  return /* glsl */`
    ${atmosphereCommon(profile)}
    uniform sampler2D atmSceneDepth;
    uniform mat4 atmInverseProjection;
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
      ${profile.id === 'earth' ? `
        // Split Earth's air ray at the observed cloud layer (~8 km) when loaded
        // so upper air scatters over clouds and lower air sits between clouds and ground.
        float cloudT0 = -1.0, cloudT1 = -1.0;
        if (atmEarthCloudsReady > 0.5 && atmEarthCloudStrength > 0.0) {
          vec2 cloudSpan = atmSphere(origin, direction, ATM_RADIUS + 8.0);
          if (cloudSpan.y >= cloudSpan.x) {
            if (cloudSpan.x > start && cloudSpan.x < end) cloudT0 = cloudSpan.x;
            if (cloudSpan.y > start && cloudSpan.y < end) {
              if (cloudT0 < 0.0) cloudT0 = cloudSpan.y;
              else cloudT1 = cloudSpan.y;
            }
          }
        }
        int segCount = cloudT0 < 0.0 ? 1 : (cloudT1 < 0.0 ? 2 : 3);
        for (int segment = 0; segment < 3; segment++) {
          if (segment >= segCount) break;
          float segmentStart = segment == 0 ? start : (segment == 1 ? cloudT0 : cloudT1);
          float segmentEnd = segment == 0 ? (cloudT0 >= 0.0 ? cloudT0 : end) : (segment == 1 ? (cloudT1 >= 0.0 ? cloudT1 : end) : end);
          int steps = segCount == 1 ? 48 : (segCount == 2 ? 24 : 16);
          if (segmentEnd > segmentStart) {
            for (int i = 0; i < 48; i++) {
              if (i >= steps) break;
              float t0 = mix(segmentStart, segmentEnd, 0.5 - 0.5 * cos(ATM_PI * float(i) / float(steps)));
              float t1 = mix(segmentStart, segmentEnd, 0.5 - 0.5 * cos(ATM_PI * float(i + 1) / float(steps)));
              vec3 p = origin + direction * ((t0 + t1) * 0.5);
              float r = length(p), molecular, aerosol; vec3 scattering, extinction;
              atmMedium(r - ATM_RADIUS, scattering, extinction, molecular, aerosol);
              vec3 source = (ATM_RAYLEIGH * molecular * rayPhase + ATM_AEROSOL * aerosol * aerosolPhase) * atmSunTransmission(p);
              source += scattering * texture2D(atmMultiple, atmMultiUv(r, dot(p, atmSunDirection) / r)).rgb * atmMultipleStrength;
              vec3 stepT = exp(-extinction * (t1 - t0));
              radiance += transmission * (vec3(1.0) - stepT) / max(vec3(1e-10), extinction) * source;
              transmission *= stepT;
            }
          }
          float crossing = segment == 0 ? cloudT0 : (segment == 1 ? cloudT1 : -1.0);
          if (crossing > start && crossing < end) {
            vec3 pCloud = origin + direction * crossing;
            float density = atmEarthCloudDensity(pCloud, crossing);
            float alpha = smoothstep(0.04, 0.90, density) * 0.93;
            if (alpha > 0.001) {
              // Convert cloud radiance into unit-solar space to match outer atmSolar multiply.
              vec3 cloudRad = atmEarthCloudRadiance(pCloud, direction, density) / max(atmSolar, vec3(1e-6));
              radiance += transmission * alpha * cloudRad;
              transmission *= (1.0 - alpha);
            }
          }
        }
        radiance *= atmSolar;
      ` : `
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
      `}
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
