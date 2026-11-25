import * as THREE from 'three'
import { AU_KM, giantPlanetProfiles, type GiantBody, type GiantPlanetProfile } from './giantPlanetProfiles.ts'
import { bodyInfo, parentOf, satelliteOrder, type BodyId } from './ephemeris.ts'
import { atmosphereGeometryShader } from './atmosphereGeometryShader.ts'
import { appearanceNoise } from './appearanceNoise.ts'

const rgb = (v: readonly number[]) => `vec3(${v.map(n => n.toExponential(8)).join(',')})`

/** A bounded atmosphere backend: opaque ellipsoidal clouds, upper haze and
 * Saturn's ring sheet are integrated along one body-relative ray. No LUTs or
 * full-screen passes per giant. All outputs are linear HDR radiance. */
export class GiantPlanetRenderer {
  readonly profile: GiantPlanetProfile
  readonly proxy: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>
  private readonly body: THREE.Mesh
  private readonly inverse = new THREE.Quaternion()
  private readonly center = new THREE.Vector3()
  private readonly sphere = new THREE.Sphere()
  private readonly frustum = new THREE.Frustum()
  private readonly matrix = new THREE.Matrix4()
  private disposed = false
  private active = false
  private readonly uniforms = {
    eye: { value: new THREE.Vector3() }, sunDirection: { value: new THREE.Vector3() },
    windPhase: { value: 0 },
    sunAngularRadius: { value: 0.0009 },
    moonOccluderCount: { value: 0 },
    moonOccluders: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, 0, 0)) },
  }
  private readonly moonPos = new THREE.Vector3()

  constructor(id: GiantBody, body: THREE.Mesh) {
    this.profile = giantPlanetProfiles[id]; this.body = body
    const p = this.profile, radius = p.equatorialKm / AU_KM
    // Keep a physical ellipsoid on the body for ray picking. The proxy only
    // bounds shader work; its surface is never used as the visible depth.
    body.geometry.dispose()
    body.geometry = new THREE.SphereGeometry(radius, 128, 96).scale(1, p.polarKm / p.equatorialKm, 1)
    const old = body.material
    if (Array.isArray(old)) old.forEach(m => m.dispose())
    else { if (old instanceof THREE.MeshStandardMaterial) old.map?.dispose(); old.dispose() }
    body.material = new THREE.MeshBasicMaterial({ visible: false })
    const bound = id === 'saturn' ? 2.32 : 1 + p.hazeHeightKm / p.polarKm + .002
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: true, side: THREE.BackSide,
      vertexShader: `varying vec3 bodyPoint;
        void main(){bodyPoint=position/${radius.toExponential(10)};gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: this.fragmentShader(),
    })
    this.proxy = new THREE.Mesh(new THREE.SphereGeometry(radius * bound, 80, 48), material)
    this.proxy.geometry.computeBoundingSphere()
    this.proxy.name = `${id} cloud/atmosphere ray boundary`
    this.proxy.raycast = () => {}
    body.add(this.proxy)
  }

  private fragmentShader() {
    const p = this.profile, saturn = p.id === 'saturn', jupiter = p.id === 'jupiter'
    const light = new THREE.Color(p.cloudLight), dark = new THREE.Color(p.cloudDark)
    return /* glsl */`
      varying vec3 bodyPoint;
      uniform mat4 projectionMatrix;
      uniform mat4 modelViewMatrix;
      uniform vec3 eye;
      uniform vec3 sunDirection;
      uniform float windPhase;
      uniform float sunAngularRadius;
      uniform int moonOccluderCount;
      uniform vec4 moonOccluders[4];
      const float R=${p.equatorialKm.toFixed(4)};
      const float POLAR=${(p.polarKm / p.equatorialKm).toFixed(10)};
      const float TOP=${(1 + p.hazeHeightKm / p.equatorialKm).toFixed(10)};
      const float SCALE=${p.hazeScaleKm.toFixed(5)};
      const vec3 TAU=${rgb(p.hazeOpticalDepth)};
      const vec3 ALBEDO=${rgb(p.hazeAlbedo)};
      const vec3 CLOUD_LIGHT=${rgb(light.toArray())};
      const vec3 CLOUD_DARK=${rgb(dark.toArray())};
      ${atmosphereGeometryShader}
      ${appearanceNoise}
      // Direction need not have unit length after the ellipsoid transform.
      vec2 ellipsoid(vec3 o,vec3 d,float scale) {
        vec3 axes=vec3(1.0,POLAR,1.0)*scale;
        vec3 localD=d/axes;float k=length(localD);
        return atmGeometrySphere(o/axes,localD/k,1.0)/k;
      }
      float ringTau(float r) {
        ${saturn ? `
        float km=r*R, base=0.0;
        float footprint=max(fwidth(km),1.0),aa=clamp(footprint,15.0,300.0);
        if(km<74300.0||km>137100.0) return 0.0;
        base+=0.14*smoothstep(74658.0-aa,74658.0+aa,km)*(1.0-smoothstep(91975.0-aa,91975.0+aa,km));
        base+=1.5*smoothstep(91975.0-aa,91975.0+aa,km)*(1.0-smoothstep(117507.0-aa,117507.0+aa,km));
        base+=0.65*smoothstep(122340.0-aa,122340.0+aa,km)*(1.0-smoothstep(136780.0-aa,136780.0+aa,km));
        float detail=0.82+0.12*sin(km*0.0021)+0.07*sin(km*0.0062);
        float fine=(0.06*sin(km*0.014)+0.025*sin(km*0.051))*(1.0-smoothstep(40.0,180.0,footprint));
        detail+=fine;
        float enckeWidth=max(1.0,160.0-aa);
        float encke=1.0-0.92*(1.0-smoothstep(enckeWidth,160.0+aa,abs(km-133590.0)));
        return base*detail*encke;` : 'return 0.0;'}
      }
      float ringSun(vec3 q) {
        ${saturn ? `
        if(abs(sunDirection.y)<0.00001) return 1.0;
        float t=-q.y/sunDirection.y;
        if(t<=0.00001) return 1.0;
        float tau=ringTau(length((q+t*sunDirection).xz));
        return exp(-tau/max(0.015,abs(sunDirection.y)));` : 'return 1.0;'}
      }
      float moonDiscVisibility(float rSun,float rOcc,float d) {
        if(rSun<=0.0||rOcc<=0.0) return 1.0;
        if(d>=rSun+rOcc) return 1.0;
        if(d<=abs(rSun-rOcc)) return rOcc>=rSun?0.0:max(0.0,1.0-(rOcc/rSun)*(rOcc/rSun));
        float c1=clamp((d*d+rSun*rSun-rOcc*rOcc)/(2.0*d*rSun),-1.0,1.0);
        float c2=clamp((d*d+rOcc*rOcc-rSun*rSun)/(2.0*d*rOcc),-1.0,1.0);
        float term=max(0.0,(-d+rSun+rOcc)*(d+rSun-rOcc)*(d-rSun+rOcc)*(d+rSun+rOcc));
        float overlap=rSun*rSun*acos(c1)+rOcc*rOcc*acos(c2)-0.5*sqrt(term);
        return clamp(1.0-overlap/(3.14159265359*rSun*rSun),0.0,1.0);
      }
      float moonEclipse(vec3 q) {
        float vis=1.0;
        for(int i=0;i<4;i++) {
          if(i>=moonOccluderCount) break;
          vec4 occ=moonOccluders[i];
          if(occ.w<=0.0) continue;
          vec3 v=occ.xyz-q;
          float t=dot(v,sunDirection);
          if(t<=0.0) continue;
          float h=length(v-t*sunDirection);
          float dist=sqrt(t*t+h*h);
          if(dist<=occ.w){vis=0.0;continue;}
          vis*=moonDiscVisibility(sunAngularRadius,asin(min(1.0,occ.w/dist)),asin(min(1.0,h/dist)));
        }
        return vis;
      }
      float solarVisibility(vec3 q) {
        vec2 block=ellipsoid(q,sunDirection,0.99999);
        return (block.y>max(0.00001,block.x)?0.0:1.0)*ringSun(q)*moonEclipse(q);
      }
      vec3 cloudColor(vec3 n) {
        float lat=asin(clamp(n.y,-1.0,1.0));
        // Bounded periodic shear is continuous at date/longitude wraps.
        float drift=0.10*sin(windPhase+lat*9.0);
        float c=cos(drift),s=sin(drift);
        vec3 flow=vec3(c*n.x-s*n.z,n.y,s*n.x+c*n.z);
        float turbulence=filteredFbm(flow*vec3(19.0,36.0,19.0));
        float fine=filteredFbm(flow*vec3(66.0,115.0,66.0));
        float closeDetail=0.24*filteredFbm(flow*vec3(650.0,1300.0,650.0))
          +0.15*filteredFbm(flow*vec3(2400.0,4800.0,2400.0));
        float warped=lat+0.035*turbulence+0.009*sin(18.0*flow.x+10.0*flow.z+lat*31.0);
        ${jupiter ? `
        float belt=0.68*exp(-pow((warped-0.27)/0.095,2.0))
          +0.88*exp(-pow((warped+0.27)/0.105,2.0))
          +0.50*exp(-pow((warped-0.54)/0.07,2.0))
          +0.46*exp(-pow((warped+0.56)/0.08,2.0));
        float polar=smoothstep(0.72,1.3,abs(lat));
        belt=clamp(belt+0.40*polar+0.15*turbulence+0.07*sin(warped*90.0),0.0,1.0);
        vec3 color=mix(CLOUD_LIGHT,CLOUD_DARK,belt);
        color*=1.0+0.20*turbulence+0.11*fine;
        // Localized elliptical vortex. Wrapped longitude is used only here;
        // its support vanishes long before reaching a pole or seam.
        float lon=atan(n.z,n.x)-1.15;
        vec2 v=vec2(atan(sin(lon),cos(lon))/0.19,(lat+0.385)/0.085);
        float vRadius=length(v),angle=atan(v.y,v.x)+3.2*exp(-vRadius);
        vec3 swirl=vec3(cos(angle),sin(angle),0.4)*vRadius*9.0;
        float storm=1.0-smoothstep(0.72,1.16,vRadius+0.13*turbulence);
        vec3 red=mix(vec3(0.43,0.19,0.10),vec3(0.68,0.39,0.24),
          0.5+0.13*sin(11.0*vRadius+angle*2.0+5.0*filteredFbm(swirl))+0.65*filteredFbm(swirl));
        color=mix(color,red,storm);
        return max(color*(1.0+closeDetail),vec3(0.0));` : `
        float bands=0.5+0.22*sin(warped*37.0)+0.12*sin(warped*79.0+2.0*turbulence)
          +${p.bandContrast.toFixed(4)}*turbulence;
        vec3 color=mix(CLOUD_LIGHT,CLOUD_DARK,clamp(bands,0.0,1.0));
        color*=1.0+${(p.bandContrast * .22).toFixed(4)}*(turbulence+fine);
        ${p.id === 'neptune' ? `
        float clouds=pow(max(0.0,turbulence+fine+0.12),4.0)*3.0;
        clouds*=exp(-pow((lat+0.5)/0.15,2.0));
        color=mix(color,vec3(0.72,0.80,0.81),clamp(clouds,0.0,0.6));` : ''}
        return color*(1.0+closeDetail);`}
      }
      // Exponential upper haze. Analytic cloud boundary clips this interval;
      // ring intersections split it so haze is never flattened across rings.
      void haze(vec3 o,vec3 d,float start,float end,inout vec3 L,inout vec3 T) {
        if(end<=start) return;
        float stepSize=(end-start)/12.0;
        float phase=atmGeometryRayleighPhase(dot(d,sunDirection));
        for(int i=0;i<12;i++) {
          vec3 q=o+d*(start+(float(i)+0.5)*stepSize);
          float altitude=max(0.0,(length(q/vec3(1.0,POLAR,1.0))-1.0)*R);
          vec3 extinction=TAU/SCALE*exp(-altitude/SCALE);
          vec3 segmentT=exp(-extinction*stepSize*R);
          float daylight=solarVisibility(q);
          vec3 source=ALBEDO*(phase*daylight*2.2+0.018*daylight);
          L+=T*(vec3(1.0)-segmentT)*source;
          T*=segmentT;
        }
      }
      void main() {
        vec3 d=normalize(bodyPoint-eye);
        vec2 air=ellipsoid(eye,d,TOP);
        vec2 cloud=ellipsoid(eye,d,1.0);
        float cloudT=cloud.x>=0.0&&cloud.y>=cloud.x?cloud.x:1e20;
        float ringT=1e20,tau=0.0;
        ${saturn ? `
        if(abs(d.y)>1e-7) {
          float t=-eye.y/d.y;
          if(t>0.0){tau=ringTau(length((eye+d*t).xz));if(tau>0.0)ringT=t;}
        }` : ''}
        bool hitCloud=cloudT<1e19,hitRing=ringT<cloudT;
        float start=max(0.0,air.x),end=min(air.y,cloudT);
        bool hitHaze=air.y>start&&end>start;
        if(!hitCloud&&!hitRing&&!hitHaze) discard;
        vec3 L=vec3(0.0),T=vec3(1.0);
        if(hitHaze) haze(eye,d,start,min(end,ringT),L,T);
        if(hitRing) {
          vec3 q=eye+d*ringT;
          float alpha=1.0-exp(-tau/max(0.003,abs(d.y)));
          vec2 shadow=ellipsoid(q,sunDirection,1.0);
          float lit=(shadow.y>max(0.0001,shadow.x)?0.0:1.0)*moonEclipse(q);
          bool sameFace=d.y*sunDirection.y<0.0;
          float illumination=lit*(sameFace?(0.30+0.65*sqrt(abs(sunDirection.y))):0.13)+0.008;
          vec3 ringColor=mix(vec3(0.46,0.40,0.29),vec3(0.72,0.66,0.51),clamp(tau,0.0,1.0));
          L+=T*alpha*ringColor*illumination;T*=1.0-alpha;
        }
        if(hitHaze&&ringT<end) haze(eye,d,max(start,ringT),end,L,T);
        if(hitCloud) {
          vec3 q=eye+d*cloudT;
          vec3 n=normalize(q/vec3(1.0,POLAR,1.0));
          vec3 normal=normalize(q/vec3(1.0,POLAR*POLAR,1.0));
          float mu=max(0.0,dot(normal,sunDirection)),view=max(0.025,dot(normal,-d));
          // A mild cloud multiple-scattering limb law preserves cloud contrast
          // without the plastic Lambert edge of a bare standard material.
          float diffuse=mu*(0.62+0.38/(mu+view+0.12));
          float eclipse=moonEclipse(q);
          ${saturn ? `
          float ringLitFace=smoothstep(0.0,0.28,abs(sunDirection.y))*step(0.0,n.y*sunDirection.y);
          float ringShine=ringLitFace*smoothstep(0.02,0.35,abs(n.y))*(1.0-smoothstep(0.55,0.92,abs(n.y)))*0.055;
          vec3 ringFill=vec3(0.95,0.87,0.68)*ringShine;
          ` : 'vec3 ringFill=vec3(0.0);'}
          vec3 color=cloudColor(n)*(diffuse*(0.92*ringSun(q)*eclipse+0.035*eclipse)+0.002+ringFill);
          L+=T*color;T=vec3(0.0);
        }
        float alpha=clamp(1.0-dot(T,vec3(1.0/3.0)),0.0,1.0);
        if(alpha<0.0005) discard;
        float depthT=min(cloudT,ringT);
        if(depthT>1e19) depthT=start;
        vec4 clip=projectionMatrix*modelViewMatrix*vec4((eye+d*depthT)*(R/${AU_KM.toFixed(1)}),1.0);
        gl_FragDepth=clamp(0.5*clip.z/clip.w+0.5,0.0,1.0);
        gl_FragColor=vec4(L/max(alpha,1e-6),alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `
  }

  update(camera: THREE.Camera, date: Date, sun: THREE.Vector3, bodies?: Map<BodyId, THREE.Mesh>) {
    if (this.disposed) return
    this.body.updateWorldMatrix(true, false);camera.updateMatrixWorld()
    this.body.getWorldPosition(this.center)
    this.body.getWorldQuaternion(this.inverse).invert()
    this.uniforms.eye.value.copy(camera.position).sub(this.center).applyQuaternion(this.inverse).multiplyScalar(AU_KM / this.profile.equatorialKm)
    const sunDelta = sun.clone().sub(this.center)
    const sunDistKm = Math.max(bodyInfo.sun.radiusKm * 1.1, sunDelta.length() * AU_KM)
    this.uniforms.sunAngularRadius.value = Math.asin(Math.min(1, bodyInfo.sun.radiusKm / sunDistKm))
    this.uniforms.sunDirection.value.copy(sunDelta).normalize().applyQuaternion(this.inverse)
    this.uniforms.windPhase.value = ((date.getTime() / 86400000 - 10957.5) * .035) % (Math.PI * 2)
    let moonCount = 0
    if (bodies) {
      for (const sat of satelliteOrder) {
        if (parentOf(sat) !== this.profile.id || moonCount >= 4) continue
        const mesh = bodies.get(sat)
        if (!mesh) continue
        mesh.getWorldPosition(this.moonPos)
        this.moonPos.sub(this.center).applyQuaternion(this.inverse).multiplyScalar(AU_KM / this.profile.equatorialKm)
        this.uniforms.moonOccluders.value[moonCount].set(
          this.moonPos.x, this.moonPos.y, this.moonPos.z, bodyInfo[sat].radiusKm / this.profile.equatorialKm,
        )
        moonCount++
      }
    }
    this.uniforms.moonOccluderCount.value = moonCount
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.matrix)
    this.sphere.copy(this.proxy.geometry.boundingSphere!)
    this.sphere.center.copy(this.center)
    const distance = camera.position.distanceTo(this.center)
    this.active = this.body.visible && this.frustum.intersectsSphere(this.sphere) && (distance < this.sphere.radius || this.sphere.radius / distance * Math.abs(camera.projectionMatrix.elements[5]) > .0001)
    this.proxy.visible = this.active
  }
  metrics() {
    return { active: this.active, disposed: this.disposed, profile: this.profile.id, backend: 'bounded ellipsoid cloud/haze transport',
      referencePressureBar: this.profile.referencePressureBar, equatorialKm: this.profile.equatorialKm, polarKm: this.profile.polarKm,
      geometryBytes: [this.body.geometry, this.proxy.geometry].reduce((sum, geometry) => sum
        + Object.values(geometry.attributes).reduce((bytes, attribute) => bytes + attribute.array.byteLength, 0)
        + (geometry.index?.array.byteLength ?? 0), 0),
      textureBytes: 0, hazeSteps: 12, appearance: 'Modeled clouds and haze; illustrative motion; no live weather' }
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true;this.active = false
    this.proxy.removeFromParent();this.proxy.geometry.dispose();this.proxy.material.dispose()
  }
}
