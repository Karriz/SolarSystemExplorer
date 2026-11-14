import * as THREE from 'three'
import { earthAtmosphere, type AtmosphereBody, type AtmosphereProfile } from './atmosphereProfiles.ts'
import type { DenseValidation } from './denseAtmosphere.ts'
import { atmosphereViewShader } from './atmosphereShader.ts'
import type { AtmosphereTables } from './atmosphereOptics.ts'
import { VenusCloudPlaceholder } from './VenusCloudPlaceholder.ts'

const AU_KM = 149_597_870.7
export type AtmosphericLighting = ReturnType<typeof atmosphereLightingState>
function atmosphereLightingState() {
  return {
    atmEnabled: { value: 0 }, atmSunDirection: { value: new THREE.Vector3(0, 1, 0) },
    atmSolar: { value: new THREE.Vector3(3, 3, 3) }, atmTableSize: { value: new THREE.Vector4(256, 64, 48, 24) },
    atmCameraKm: { value: new THREE.Vector3() }, atmViewForward: { value: new THREE.Vector3(0, 0, -1) },
    atmDepthCoefficients: { value: new THREE.Vector2(1, -.1) },
    atmTransmittance: { value: null as THREE.DataTexture | null },
    atmMultiple: { value: null as THREE.DataTexture | null }, atmIrradiance: { value: null as THREE.DataTexture | null },
    atmMultipleStrength: { value: 1 }, atmCloudPhase: { value: 0 }, atmCloudVariation: { value: 1 },
  }
}
export type AtmosphereFrame = { id?: AtmosphereBody; date?: Date; body: THREE.Object3D; sun: THREE.Vector3; solarColor: THREE.Color;
  stars?: { material: THREE.PointsMaterial; opacity: number } }

/** Body-specific optical owner. Tables are lazy, immutable and generated off-thread.
 * Dense tables must pass flux/convergence gates before they can be activated. */
export class AtmosphereRenderer {
  readonly lighting = atmosphereLightingState()
  enabled = true
  private worker?: Worker
  private state: 'idle' | 'loading' | 'ready' | 'failed' | 'disposed' = 'idle'
  private readyAt = 0
  private generationMs = 0
  private starVisibility = 1
  private startedAt = 0
  private readonly cameraKm = this.lighting.atmCameraKm
  private readonly viewToBody = { value: new THREE.Matrix3() }
  private readonly inverseProjection = { value: new THREE.Matrix4() }
  private readonly sceneDepth = { value: null as THREE.DepthTexture | null }
  private readonly bodyInverse = new THREE.Quaternion()
  private readonly viewRotation = new THREE.Quaternion()
  private readonly relative = new THREE.Vector3()
  private readonly frustum = new THREE.Frustum()
  private readonly projection = new THREE.Matrix4()
  private readonly sphere = new THREE.Sphere()

  private validation?: DenseValidation
  private cloudPlaceholder?: VenusCloudPlaceholder

  readonly profile: AtmosphereProfile
  constructor(profile: AtmosphereProfile = earthAtmosphere) { this.profile = profile }

  configureOutput(material: THREE.RawShaderMaterial, prefix = '') {
    const uniforms = { ...this.lighting,
      atmCameraKm: this.cameraKm, atmViewToBody: this.viewToBody, atmInverseProjection: this.inverseProjection,
      atmSceneDepth: this.sceneDepth, atmUnitsKm: { value: AU_KM },
    }
    const rename = (source: string) => source.replace(/\batm[A-Z]\w*|\bATM_[A-Z_]+\b/g, name => prefix + name)
    for (const [name, value] of Object.entries(uniforms)) material.uniforms[prefix + name] = value
    material.fragmentShader = material.fragmentShader.replace('void main() {', `${rename(atmosphereViewShader(this.profile))}\nvoid main() {`)
    return prefix + 'atmComposite'
  }

  private load() {
    this.state = 'loading'; this.startedAt = performance.now()
    try {
      this.worker = new Worker(new URL('./atmosphere.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (event: MessageEvent<AtmosphereTables>) => {
        if (this.state !== 'loading') return
        const t = event.data
        this.validation = t.validation
        if (this.profile.model && !t.validation?.accepted) {
          this.state = 'failed'; this.worker?.terminate(); this.worker = undefined; return
        }
        const texture = (data: Float32Array, width: number, height: number, name: string) => {
          const half = Uint16Array.from(data, v => THREE.DataUtils.toHalfFloat(v))
          const result = new THREE.DataTexture(half, width, height, THREE.RGBAFormat, THREE.HalfFloatType)
          result.minFilter = THREE.LinearFilter; result.magFilter = THREE.LinearFilter
          result.name = name; result.needsUpdate = true
          return result
        }
        this.lighting.atmTransmittance.value = texture(t.transmittance, t.transWidth, t.transHeight, `${this.profile.id} transmittance`)
        this.lighting.atmMultiple.value = texture(t.multiple, t.multiWidth, t.multiHeight, `${this.profile.id} multiple scattering`)
        this.lighting.atmIrradiance.value = texture(t.irradiance, t.multiWidth, t.multiHeight, `${this.profile.id} diffuse sky irradiance`)
        this.lighting.atmTableSize.value.set(t.transWidth, t.transHeight, t.multiWidth, t.multiHeight)
        this.generationMs = performance.now() - this.startedAt
        this.readyAt = performance.now(); this.state = 'ready'
        this.worker?.terminate(); this.worker = undefined
      }
      this.worker.onerror = event => {
        event.preventDefault()
        if (this.state !== 'loading') return
        this.state = 'failed'; this.worker?.terminate(); this.worker = undefined
      }
      this.worker.postMessage(this.profile)
    } catch { this.state = 'failed'; this.worker?.terminate(); this.worker = undefined }
  }

  update(camera: THREE.Camera, depth: THREE.DepthTexture | null, frame?: AtmosphereFrame) {
    this.lighting.atmEnabled.value = 0
    this.starVisibility = 1
    this.cloudPlaceholder?.update(false)
    if (frame?.stars) frame.stars.material.opacity = frame.stars.opacity
    if (!this.enabled || !frame || this.state === 'disposed') return
    camera.updateMatrixWorld(); frame.body.updateWorldMatrix(true, false)
    const center = frame.body.getWorldPosition(this.relative)
    this.projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projection)
    this.sphere.set(center, (this.profile.radiusKm + this.profile.heightKm) / AU_KM)
    if (!this.frustum.intersectsSphere(this.sphere)) return
    // Avoid AU-scale GPU intersections when the entire atmosphere is subpixel.
    if (this.profile.clouds) {
      this.cloudPlaceholder ??= new VenusCloudPlaceholder(frame.body, this.profile)
      this.cloudPlaceholder.update(true)
    }
    const distance = camera.position.distanceTo(center)
    if (distance > this.sphere.radius && this.sphere.radius / distance * Math.abs(camera.projectionMatrix.elements[5]) < .0005) return
    if (!depth) return
    if (this.state === 'idle') this.load()
    if (this.state !== 'ready') return
    frame.body.getWorldQuaternion(this.bodyInverse).invert()
    this.cameraKm.value.copy(camera.position).sub(center).multiplyScalar(AU_KM).applyQuaternion(this.bodyInverse)
    this.lighting.atmSunDirection.value.copy(frame.sun).sub(center).normalize().applyQuaternion(this.bodyInverse)
    camera.getWorldQuaternion(this.viewRotation).premultiply(this.bodyInverse)
    this.lighting.atmViewForward.value.set(0, 0, -1).applyQuaternion(this.viewRotation)
    const projection = camera.projectionMatrix.elements
    this.lighting.atmDepthCoefficients.value.set(.5 * (1 - projection[10]), .5 * projection[14] * AU_KM)
    this.viewToBody.value.setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(this.viewRotation))
    this.inverseProjection.value.copy(camera.projectionMatrixInverse)
    this.sceneDepth.value = depth
    this.lighting.atmSolar.value.set(frame.solarColor.r, frame.solarColor.g, frame.solarColor.b).multiplyScalar(3)
    // Advect the density field with inverse coordinates so a negative (westward)
    // wind moves visible features westward, independently of solid-body spin.
    this.lighting.atmCloudPhase.value = this.profile.clouds ? (-((frame.date?.getTime() ?? 0) / 86400000) * this.profile.clouds.radiansPerDay) % (2 * Math.PI) : 0
    this.lighting.atmEnabled.value = THREE.MathUtils.smoothstep(performance.now() - this.readyAt, 0, 1000)
    this.cloudPlaceholder?.update(this.lighting.atmEnabled.value < 1)
    // The overview's decorative stars use arbitrary brightness. Suppress them
    // in bright local skies as a presentation exposure approximation; at night
    // and above the atmosphere retain their established brightness.
    const altitude = this.cameraKm.value.length() - this.profile.radiusKm
    const mu = this.cameraKm.value.clone().normalize().dot(this.lighting.atmSunDirection.value)
    const daylight = THREE.MathUtils.smoothstep(mu, -.12, .02)
    const localAir = 1 - THREE.MathUtils.smoothstep(altitude, 20, 100)
    this.starVisibility = 1 - this.lighting.atmEnabled.value * (1 - (1 - daylight * localAir) ** 2)
    if (frame.stars) frame.stars.material.opacity = frame.stars.opacity * this.starVisibility
  }

  metrics() {
    const size = this.lighting.atmTableSize.value
    return { body: this.profile.id, validation: this.validation, state: this.state, active: this.lighting.atmEnabled.value > 0,
      strength: this.lighting.atmEnabled.value, generationMs: this.generationMs,
      tableBytes: this.state === 'ready' ? (size.x * size.y + 2 * size.z * size.w) * 8 : 0,
      starVisibility: this.starVisibility,
      cloudPlaceholder: this.cloudPlaceholder?.mesh.visible ?? false,
      profile: this.profile.description, viewSteps: this.profile.model ? 144 : 48, multipleScattering: this.profile.model ? 'converged discrete-ordinate transport column' : 'isotropic higher-order approximation' }
  }
  dispose() {
    this.state = 'disposed'; this.worker?.terminate(); this.worker = undefined
    this.lighting.atmEnabled.value = 0
    this.cloudPlaceholder?.dispose(); this.cloudPlaceholder = undefined
    for (const uniform of [this.lighting.atmTransmittance, this.lighting.atmMultiple, this.lighting.atmIrradiance]) {
      uniform.value?.dispose(); uniform.value = null
    }
  }
}
