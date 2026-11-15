import { radiusAu } from './ephemeris.ts'
import * as THREE from 'three'
import { appearanceNoise } from './appearanceNoise.ts'
import { atmosphereGeometryShader } from './atmosphereGeometryShader.ts'

/** Visible-light photosphere and optically thin modeled corona. Shares scene
 * depth and the atmosphere pipeline's linear HDR output, not planetary LUTs. */
export class SolarRenderer {
  private readonly body: THREE.Mesh
  private disposed = false
  private readonly inverse = new THREE.Quaternion()
  private readonly center = new THREE.Vector3()
  private readonly uniforms = {
    solarEnabled: { value: 0 }, solarGlareStrength: { value: 0 },
    solarScreen: { value: new THREE.Vector4() }, solarViewport: { value: new THREE.Vector2(1, 1) },
    solarEye: { value: new THREE.Vector3() },
    solarViewToBody: { value: new THREE.Matrix3() }, solarInverseProjection: { value: new THREE.Matrix4() },
    solarDepth: { value: null as THREE.DepthTexture | null }, solarDepthCoefficients: { value: new THREE.Vector2() },
  }
  constructor(body: THREE.Mesh) {
    this.body = body
    const old = body.material
    if (Array.isArray(old)) old.forEach(m => m.dispose());else old.dispose()
    body.material = new THREE.ShaderMaterial({
      vertexShader: `varying vec3 solarPoint;varying vec3 solarNormal;varying vec3 solarView;
        void main(){solarPoint=normalize(position);solarNormal=normalize(normalMatrix*normal);
        vec4 mv=modelViewMatrix*vec4(position,1.0);solarView=-mv.xyz;gl_Position=projectionMatrix*mv;}`,
      fragmentShader: /* glsl */`
        varying vec3 solarPoint;varying vec3 solarNormal;varying vec3 solarView;
        ${appearanceNoise}
        // A 3D cellular field gives bright granules separated by darker lanes.
        // At orbital distances the entire field converges to its mean.
        float granulation(vec3 p) {
          float footprint=max(length(dFdx(p)),length(dFdy(p)));
          if(footprint>=1.0) return 0.0;
          vec3 cell=floor(p),fraction=fract(p);
          float nearest=10.0,second=10.0;
          for(int z=-1;z<=1;z++) for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) {
            vec3 offset=vec3(float(x),float(y),float(z)),seed=cell+offset;
            vec3 point=offset+0.2+0.6*vec3(hash31(seed),hash31(seed+13.7),hash31(seed+37.3));
            float distance=length(point-fraction);
            if(distance<nearest){second=nearest;nearest=distance;}else second=min(second,distance);
          }
          float grain=smoothstep(0.015,0.15,second-nearest)-0.55;
          return grain*(1.0-smoothstep(0.25,1.0,footprint));
        }
        float spot(vec3 p,vec3 center,float size) {
          float r=length(p-normalize(center))/size;
          r*=1.0+0.12*filteredFbm(p*280.0);
          float penumbra=1.0-smoothstep(0.60,1.0,r);
          float umbra=1.0-smoothstep(0.28,0.55,r);
          return penumbra*0.35+umbra*0.50;
        }
        void main() {
          vec3 p=normalize(solarPoint);
          float mu=clamp(dot(normalize(solarNormal),normalize(solarView)),0.0,1.0);
          float limb=0.40+0.60*mu;
          float granules=granulation(p*650.0);
          float smallGranules=filteredFbm(p*1900.0);
          float dark=spot(p,vec3(0.5,0.18,0.85),0.048)
            +spot(p,vec3(0.55,0.21,0.82),0.022)
            +spot(p,vec3(-0.5,-0.27,0.82),0.033)
            +spot(p,vec3(-0.52,-0.24,0.81),0.018)
            +spot(p,vec3(0.7,-0.21,-0.68),0.04)
            +spot(p,vec3(-0.25,0.3,-0.92),0.025);
          float brightness=limb*(1.0+0.50*granules+0.20*smallGranules)*(1.0-clamp(dark,0.0,0.90));
          gl_FragColor=vec4(vec3(0.88,0.83,0.75)*brightness,1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    })
  }

  configureOutput(material: THREE.RawShaderMaterial) {
    Object.assign(material.uniforms, this.uniforms)
    // Namespaced copy, since the existing air integrators also share this code.
    const geometry = atmosphereGeometryShader.replace(/atmGeometry/g, 'solarGeometry')
    material.fragmentShader = material.fragmentShader.replace('void main() {', /* glsl */`
      uniform float solarEnabled;
      uniform float solarGlareStrength;
      uniform vec4 solarScreen;
      uniform vec2 solarViewport;
      uniform vec3 solarEye;
      uniform mat3 solarViewToBody;
      uniform mat4 solarInverseProjection;
      uniform sampler2D solarDepth;
      uniform vec2 solarDepthCoefficients;
      ${geometry}
      vec4 solarCorona(vec2 uv,vec4 color) {
        if(solarEnabled<0.5) return color;
        vec4 projected=solarInverseProjection*vec4(uv*2.0-1.0,0.0,1.0);
        vec3 viewRay=normalize(projected.xyz);
        vec3 d=normalize(solarViewToBody*viewRay);
        vec2 interval=solarGeometrySphere(solarEye,d,2.8);
        float begin=max(0.0,interval.x),end=interval.y;
        float depth=texture2D(solarDepth,uv).x;
        if(depth<1.0) {
          float viewDistance=solarDepthCoefficients.y/(depth-solarDepthCoefficients.x);
          end=min(end,viewDistance/max(1e-6,-viewRay.z));
        }
        if(end<=begin) return color;
        vec3 L=vec3(0.0);float stepSize=(end-begin)/16.0;
        for(int i=0;i<16;i++) {
          vec3 p=solarEye+d*(begin+(float(i)+0.5)*stepSize);
          float r=length(p);
          if(r<1.0) continue;
          float latitude=p.y/r;
          float streamer=0.75+0.25*pow(1.0-latitude*latitude,2.0);
          float density=exp(-(r-1.0)*5.5)/(r*r);
          L+=vec3(0.90,0.93,1.0)*density*streamer*stepSize*0.045;
        }
        // Deliberate visibility gain, not calibrated solar radiometry.
        color.rgb+=L;
        color.a+=(1.0-color.a)*clamp(max(L.r,max(L.g,L.b)),0.0,1.0);
        return color;
      }
      // Screen-space photographic glare: deliberately retains a visible size
      // when the real solar disc becomes subpixel at outer-planet distances.
      vec4 solarGlare(vec2 uv,vec4 color) {
        if(solarGlareStrength<=0.0) return color;
        vec2 offset=(uv-solarScreen.xy)*solarViewport;
        float radius=length(offset);
        if(radius>150.0) return color;
        // Test the solar source, not the halo edge: an occulted Sun must never
        // leave a floating flare above terrain. Nine taps soften partial cover.
        float visibility=0.0;
        vec2 sampleRadius=vec2(max(0.65,solarScreen.w*0.60))/solarViewport;
        for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++) {
          vec2 sampleUv=solarScreen.xy+vec2(float(x),float(y))*sampleRadius;
          float depth=texture2D(solarDepth,clamp(sampleUv,0.0,1.0)).x;
          visibility+=depth+1.2e-7>=solarScreen.z?1.0/9.0:0.0;
        }
        if(visibility<=0.0) return color;
        float depth=texture2D(solarDepth,uv).x;
        if(depth+1.2e-7<solarScreen.z) return color;
        float coreWidth=max(2.0,solarScreen.w*0.8);
        float core=2.4*exp(-radius*radius/(coreWidth*coreWidth));
        float halo=0.15*exp(-radius/16.0)+0.035*exp(-radius/40.0);
        // Four restrained diffraction streaks; a soft core avoids angular NaNs.
        vec2 direction=offset/max(0.01,radius);
        float crossShape=pow(abs(direction.x*direction.x-direction.y*direction.y),32.0);
        float rays=0.18*crossShape*exp(-radius/32.0)*(1.0-exp(-radius/4.0));
        float intensity=(core+halo+rays)*visibility*solarGlareStrength
          *(1.0-smoothstep(110.0,150.0,radius));
        vec3 light=vec3(1.0,0.92,0.77)*intensity;
        color.rgb+=light;
        color.a+=(1.0-color.a)*clamp(intensity,0.0,1.0);
        return color;
      }
      void main() {`)
    // Solar emission must enter before foreground planetary transmission.
    material.fragmentShader = material.fragmentShader.replace(
      'composeAtmospheres(vUv,texture2D(tDiffuse,vUv))',
      'composeAtmospheres(vUv,solarGlare(vUv,solarCorona(vUv,texture2D(tDiffuse,vUv))))')
  }

  update(camera: THREE.Camera, depth: THREE.DepthTexture | null, viewport?: THREE.Vector2) {
    this.uniforms.solarEnabled.value = 0
    this.uniforms.solarGlareStrength.value = 0
    if (this.disposed || !depth) return
    this.body.updateWorldMatrix(true, false);camera.updateMatrixWorld()
    this.body.getWorldPosition(this.center);this.body.getWorldQuaternion(this.inverse).invert()
    const radius = radiusAu('sun')
    this.uniforms.solarEye.value.copy(camera.position).sub(this.center).applyQuaternion(this.inverse).divideScalar(radius)
    const viewRotation = camera.getWorldQuaternion(new THREE.Quaternion()).premultiply(this.inverse)
    this.uniforms.solarViewToBody.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(viewRotation))
    this.uniforms.solarInverseProjection.value.copy(camera.projectionMatrixInverse)
    const e = camera.projectionMatrix.elements
    this.uniforms.solarDepthCoefficients.value.set(.5 * (1 - e[10]), .5 * e[14] / radius)
    this.uniforms.solarDepth.value = depth
    if (viewport) {
      this.uniforms.solarViewport.value.copy(viewport)
      const viewCenter = this.center.clone().applyMatrix4(camera.matrixWorldInverse)
      const projected = this.center.clone().project(camera)
      const discPixels = radius / Math.max(radius, -viewCenter.z) * Math.abs(e[5]) * viewport.y * .5
      const u = .5 + .5 * projected.x, v = .5 + .5 * projected.y
      // Compare in depth-buffer space with two depth24 units of tolerance;
      // reconstructing AU distances amplifies quantization on the Sun itself.
      const frontDistance = Math.max(radius * .001, -viewCenter.z - radius)
      const sourceDepth = THREE.MathUtils.clamp(.5 * (1 - e[10] + e[14] / frontDistance), 0, 1)
      this.uniforms.solarScreen.value.set(u, v, sourceDepth, discPixels)
      const edge = THREE.MathUtils.smoothstep(u, 0, .035) * (1 - THREE.MathUtils.smoothstep(u, .965, 1))
        * THREE.MathUtils.smoothstep(v, 0, .035) * (1 - THREE.MathUtils.smoothstep(v, .965, 1))
      this.uniforms.solarGlareStrength.value = viewCenter.z < -radius
        ? edge * (1 - THREE.MathUtils.smoothstep(discPixels, 10, 32)) : 0
    }
    const bounds = new THREE.Sphere(this.center, radius * 2.8)
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
    this.uniforms.solarEnabled.value = frustum.intersectsSphere(bounds) && radius / camera.position.distanceTo(this.center) * Math.abs(e[5]) > .0005 ? 1 : 0
  }
  metrics() { return { active: this.uniforms.solarEnabled.value > 0, disposed: this.disposed,
    glareStrength: this.uniforms.solarGlareStrength.value,
    appearance: 'Modeled photosphere and sunspots; corona and photographic glare use presentation gains', coronaSteps: 16 } }
  dispose() {
    if (this.disposed) return
    this.disposed = true;this.uniforms.solarEnabled.value = 0;this.uniforms.solarGlareStrength.value = 0;this.uniforms.solarDepth.value = null
    // The body owns its photosphere material and releases it during traversal.
  }
}
