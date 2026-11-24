import * as THREE from 'three'
import { GiantPlanetRenderer } from './GiantPlanetRenderer.ts'
import { SolarRenderer } from './SolarRenderer.ts'
import type { GiantBody } from './giantPlanetProfiles.ts'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { applySkyVisibility, AtmosphereRenderer, type AtmosphereFrame } from './AtmosphereRenderer.ts'
import { marsAtmosphere, titanAtmosphere, venusAtmosphere, type AtmosphereBody } from './atmosphereProfiles.ts'

const TARGET_BUDGET = 80 * 1024 * 1024

/** Linear scene color and sampleable depth, with clear air integrated before
 * the single display transform. Transparent objects retain scene ordering;
 * joint cloud/transparent-medium integration remains a later stage. */
export class AtmosphereRenderPipeline {
  readonly giants = new Map<GiantBody, GiantPlanetRenderer>()
  solar?: SolarRenderer
  private appearanceSun?: THREE.Mesh
  readonly atmosphere = new AtmosphereRenderer()
  readonly atmospheres = { earth: this.atmosphere, mars: new AtmosphereRenderer(marsAtmosphere), venus: new AtmosphereRenderer(venusAtmosphere), titan: new AtmosphereRenderer(titanAtmosphere) }
  private readonly compositionOrder = { value: new THREE.Vector4(0, 1, 2, 3) }
  private readonly renderer: THREE.WebGLRenderer
  private readonly output = new OutputPass()
  private readonly size = new THREE.Vector2()
  private readonly viewport = new THREE.Vector2()
  private target: THREE.WebGLRenderTarget | null = null
  private fallbackReason: string | null = null
  private disposed = false
  private frames = 0
  private readonly maxSamples: number

  constructor(renderer: THREE.WebGLRenderer, options: { forceDirect?: boolean } = {}) {
    this.renderer = renderer
    const gl = renderer.getContext() as WebGL2RenderingContext
    this.maxSamples = 0
    if (options.forceDirect) this.fallbackReason = 'Direct rendering requested'
    else if (!renderer.extensions.has('EXT_color_buffer_float')) this.fallbackReason = 'HDR color attachments unavailable'
    else {
      // Intersect supported color/depth sample counts rather than assuming the
      // renderer-wide MAX_SAMPLES applies to RGBA16F. Some drivers support only
      // 4 samples, so allow that count when it fits the attachment budget.
      const color = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.RGBA16F, gl.SAMPLES) as Int32Array
      const depth = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, gl.SAMPLES) as Int32Array
      this.maxSamples = Math.max(0, ...Array.from(color).filter(n => n <= 4 && depth.includes(n)))
    }
    this.output.renderToScreen = true
    // The canvas is transparent and expects premultiplied display RGB. Undo
    // scene alpha before the nonlinear display transform, then premultiply in
    // display space. This avoids dark fringes on stars, rings and the Sun glow.
    this.output.material.fragmentShader = this.output.material.fragmentShader
      .replace('gl_FragColor = texture2D( tDiffuse, vUv );', `
        gl_FragColor = texture2D( tDiffuse, vUv );
        gl_FragColor.a = clamp(gl_FragColor.a, 0.0, 1.0);
        gl_FragColor.rgb /= max(gl_FragColor.a, 1e-6);
      `)
      .replace(/}\s*$/, 'gl_FragColor.rgb *= gl_FragColor.a;\n}')
    const compose = [this.atmosphere.configureOutput(this.output.material),
      this.atmospheres.mars.configureOutput(this.output.material, 'mars_'),
      this.atmospheres.venus.configureOutput(this.output.material, 'venus_'),
      this.atmospheres.titan.configureOutput(this.output.material, 'titan_')]
    this.output.material.uniforms.atmosphereOrder = this.compositionOrder
    this.output.material.fragmentShader = this.output.material.fragmentShader
      .replace('void main() {', `uniform vec4 atmosphereOrder;
        vec4 composeAtmospheres(vec2 uv, vec4 color) {
          for(int i=0;i<4;i++) {
            float body=atmosphereOrder[i];
            if(body<0.5) color=${compose[0]}(uv,color);
            else if(body<1.5) color=${compose[1]}(uv,color);
            else if(body<2.5) color=${compose[2]}(uv,color);
            else color=${compose[3]}(uv,color);
          }
          return color;
        }
        void main() {`)
      .replace('gl_FragColor = texture2D( tDiffuse, vUv );', 'gl_FragColor = composeAtmospheres(vUv,texture2D(tDiffuse,vUv));')
  }

  attachGiant(id: GiantBody, body: THREE.Mesh) {
    this.giants.get(id)?.dispose()
    this.giants.set(id, new GiantPlanetRenderer(id, body))
  }
  attachSun(body: THREE.Mesh) {
    this.appearanceSun = body
    this.solar = new SolarRenderer(body)
    this.solar.configureOutput(this.output.material)
    this.output.material.needsUpdate = true
  }

  /** Drawing-buffer pixels, not CSS pixels. Resizing releases old attachments. */
  resize() {
    if (this.disposed || this.fallbackReason) return
    this.renderer.getDrawingBufferSize(this.size)
    const scale = Math.min(1, Math.sqrt(TARGET_BUDGET / (12 * Math.max(1, this.size.x * this.size.y))))
    const width = Math.max(1, Math.floor(this.size.x * scale)), height = Math.max(1, Math.floor(this.size.y * scale))
    const samples = width * height * 12 * (1 + this.maxSamples) <= TARGET_BUDGET ? this.maxSamples : 0
    if (this.target?.width === width && this.target.height === height && this.target.samples === samples) return
    this.target?.dispose()
    this.target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      colorSpace: THREE.LinearSRGBColorSpace, generateMipmaps: false,
      depthBuffer: true, stencilBuffer: false, samples,
      depthTexture: new THREE.DepthTexture(width, height, THREE.UnsignedIntType),
    })
    this.target.texture.name = 'Atmosphere scene linear HDR'
    this.target.depthTexture!.name = 'Atmosphere scene depth'
    const previous = this.renderer.getRenderTarget()
    try {
      this.renderer.setRenderTarget(this.target)
      const gl = this.renderer.getContext()
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        this.target.dispose()
        this.target = null
        this.fallbackReason = 'HDR framebuffer incomplete'
      }
    } finally {
      this.renderer.setRenderTarget(previous)
    }
  }

  render(scene: THREE.Scene, camera: THREE.Camera, atmosphereFrame?: AtmosphereFrame | AtmosphereFrame[], date = new Date()) {
    if (this.disposed) return
    this.resize()
    const frames = Array.isArray(atmosphereFrame) ? atmosphereFrame : atmosphereFrame ? [atmosphereFrame] : []
    if (this.appearanceSun) {
      this.giants.forEach(giant => giant.update(camera, date, this.appearanceSun!.position))
      this.solar?.update(camera, this.target?.depthTexture ?? null, this.renderer.getSize(this.viewport))
    }
    const ids: AtmosphereBody[] = ['earth', 'mars', 'venus', 'titan']
    for (const id of ids) {
      const frame = frames.find(frame => (frame.id ?? 'earth') === id)
      this.atmospheres[id].update(camera, this.target?.depthTexture ?? null, frame ? { ...frame, stars: undefined } : undefined)
    }
    const order = ids.map((id, index) => ({ index, distance: frames.find(frame => (frame.id ?? 'earth') === id)?.body.position.distanceToSquared(camera.position) ?? 0 }))
      .sort((a, b) => b.distance - a.distance)
    this.compositionOrder.value.set(order[0].index, order[1].index, order[2].index, order[3].index)
    const stars = frames.find(frame => frame.stars)?.stars
    applySkyVisibility(stars, Math.min(...ids.map(id => this.atmospheres[id].metrics().starVisibility)))
    const renderer = this.renderer, previous = renderer.getRenderTarget()
    const autoReset = renderer.info.autoReset
    try {
      if (autoReset) renderer.info.reset()
      renderer.info.autoReset = false
      if (this.target) {
        // Three.js disables material tone mapping and display conversion for
        // this linear render target. OutputPass applies both once on the canvas.
        renderer.setRenderTarget(this.target)
        renderer.render(scene, camera)
        this.output.render(renderer, this.target, this.target, 0, false)
      } else {
        renderer.setRenderTarget(null)
        renderer.render(scene, camera)
      }
      this.frames++
    } finally {
      renderer.info.autoReset = autoReset
      renderer.setRenderTarget(previous)
    }
  }

  metrics() {
    const target = this.target
    return {
      mode: target ? 'linear-hdr' : 'direct', fallbackReason: this.fallbackReason,
      width: target?.width ?? 0, height: target?.height ?? 0,
      samples: target?.samples ?? 0, frames: this.frames,
      // RGBA16F + depth24 (conservatively 4 bytes), resolved + MSAA.
      estimatedAttachmentBytes: target ? target.width * target.height * 12 * (1 + target.samples) : 0,
      atmosphereEnabled: Object.values(this.atmospheres).some(air => air.lighting.atmEnabled.value > 0)
        || [...this.giants.values()].some(giant => giant.metrics().active),
      giants: Object.fromEntries([...this.giants].map(([id, giant]) => [id, giant.metrics()])), solar: this.solar?.metrics(),
      atmosphere: this.atmosphere.metrics(),
      atmospheres: Object.fromEntries(Object.entries(this.atmospheres).map(([id, air]) => [id, air.metrics()])),
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.target?.dispose()
    this.target = null
    Object.values(this.atmospheres).forEach(air => air.dispose())
    this.giants.forEach(giant => giant.dispose())
    this.solar?.dispose()
    this.output.dispose()
  }
}
