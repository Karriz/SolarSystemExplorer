import * as THREE from 'three'
import { SURFACE_CLEARANCE } from './cameraSafety.ts'

export type CameraBody = { id: string; center: THREE.Vector3; rotation: THREE.Quaternion; radius: number }

/** Selected-body navigation with an independent viewing direction. Orbiting
 * moves the whole camera frame; tilting only changes where the camera looks. */
export class BodyCameraControls {
  readonly target: THREE.Vector3
  minDistance: number
  maxDistance = 85
  enabled = true
  close = false
  private camera: THREE.PerspectiveCamera
  private element: HTMLElement
  private onStart: () => void
  private body: CameraBody
  private tiltAngle = 0
  private attachAllowed = true
  private pointers = new Map<number, THREE.Vector2>()
  private drag: { id: number; button: number; point: THREE.Vector2; grab: THREE.Vector3 | null } | null = null
  private gesture: { point: THREE.Vector2; distance: number } | null = null
  private previousTouchAction: string
  private previousCursor: string

  constructor(camera: THREE.PerspectiveCamera, element: HTMLElement, target: THREE.Vector3, minDistance: number, onStart: () => void) {
    this.camera = camera
    this.element = element
    this.target = target
    this.minDistance = minDistance
    this.onStart = onStart
    this.body = { id: '', center: target.clone(), rotation: new THREE.Quaternion(), radius: minDistance / (1 + SURFACE_CLEARANCE) }
    this.previousTouchAction = element.style.touchAction
    this.previousCursor = element.style.cursor
    element.style.touchAction = 'none'
    element.addEventListener('pointerdown', this.pointerDown)
    element.addEventListener('pointermove', this.pointerMove)
    element.addEventListener('pointerup', this.pointerUp)
    element.addEventListener('pointercancel', this.pointerUp)
    element.addEventListener('lostpointercapture', this.pointerUp)
    element.addEventListener('wheel', this.wheel, { passive: false })
    element.addEventListener('contextmenu', this.contextMenu)
    this.update()
  }

  setBody(body: CameraBody, allowAttachment = true) {
    const sameBody = this.body.id === body.id
    const wasClose = this.close
    this.attachAllowed = allowAttachment && body.id !== 'sun'
    this.target.copy(body.center)
    this.refreshClose(body.radius)
    if (sameBody && wasClose && this.close) {
      const rotation = body.rotation.clone().multiply(this.body.rotation.clone().invert())
      this.transform(rotation, this.body.center, body.center)
    }
    this.body = { ...body, center: body.center.clone(), rotation: body.rotation.clone() }
    if (!sameBody) this.cancelDrag()
    if (wasClose !== this.close && this.drag?.button === 0) this.drag.grab = this.hit(this.drag.point)
    if (!this.drag) this.element.style.cursor = this.close ? 'grab' : this.previousCursor
  }

  private refreshClose(radius: number) {
    const altitude = this.camera.position.distanceTo(this.target) / radius - 1
    if (!this.attachAllowed) this.close = false
    else if (!this.close && altitude <= .5) this.close = true
    else if (this.close && altitude >= .8) this.close = false
  }

  update() {
    const offset = this.camera.position.clone().sub(this.target)
    const distance = offset.length()
    if (distance === 0) offset.set(0, 0, 1)
    this.camera.position.copy(this.target).add(offset.setLength(THREE.MathUtils.clamp(distance, this.minDistance, this.maxDistance)))
    this.refreshClose(this.body.radius)
    this.camera.updateMatrixWorld()
  }

  getPolarAngle() { return new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.target)).phi }
  getAzimuthalAngle() { return new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.target)).theta }

  hit(point: THREE.Vector2): THREE.Vector3 | null {
    const rect = this.element.getBoundingClientRect()
    const ndc = new THREE.Vector2((point.x - rect.left) / rect.width * 2 - 1, 1 - (point.y - rect.top) / rect.height * 2)
    this.camera.updateMatrixWorld()
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    return ray.ray.intersectSphere(new THREE.Sphere(this.target, this.body.radius * 1.0005), new THREE.Vector3())
  }

  private transform(rotation: THREE.Quaternion, oldCenter = this.target, newCenter = this.target) {
    this.camera.position.sub(oldCenter).applyQuaternion(rotation).add(newCenter)
    this.camera.quaternion.premultiply(rotation).normalize()
    this.camera.up.applyQuaternion(rotation).normalize()
    this.drag?.grab?.sub(oldCenter).applyQuaternion(rotation).add(newCenter)
    this.camera.updateMatrixWorld()
  }

  private orbit(dx: number, dy: number) {
    const scale = 2 * Math.PI / Math.max(1, this.element.clientHeight)
    const north = new THREE.Vector3(0, 1, 0).applyQuaternion(this.body.rotation)
    const yaw = new THREE.Quaternion().setFromAxisAngle(north, -dx * scale)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).applyQuaternion(yaw)
    const pitch = new THREE.Quaternion().setFromAxisAngle(right, -dy * scale)
    this.transform(pitch.multiply(yaw))
  }

  private pan(grab: THREE.Vector3, point: THREE.Vector2) {
    const hit = this.hit(point)
    if (!hit) return
    const rotation = new THREE.Quaternion().setFromUnitVectors(hit.sub(this.target).normalize(), grab.clone().sub(this.target).normalize())
    const saved = this.drag?.grab?.clone()
    this.transform(rotation)
    if (saved) this.drag!.grab!.copy(saved)
  }

  private tilt(dy: number) {
    const next = THREE.MathUtils.clamp(this.tiltAngle - dy * .004, 0, 85 * Math.PI / 180)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion)
    const rotation = new THREE.Quaternion().setFromAxisAngle(right, next - this.tiltAngle)
    this.camera.quaternion.premultiply(rotation).normalize()
    this.camera.up.applyQuaternion(rotation).normalize()
    this.tiltAngle = next
    this.camera.updateMatrixWorld()
  }

  private zoom(factor: number) {
    const offset = this.camera.position.clone().sub(this.target)
    const radius = this.body.radius
    const distance = THREE.MathUtils.clamp(radius + (offset.length() - radius) * factor, this.minDistance, this.maxDistance)
    this.camera.position.copy(this.target).add(offset.setLength(distance))
    this.camera.updateMatrixWorld()
    if (this.drag?.button === 0 && this.close) this.drag.grab = this.hit(this.drag.point)
  }

  private leftDrag(from: THREE.Vector2, to: THREE.Vector2, grab: THREE.Vector3 | null) {
    if (this.close) { if (grab) this.pan(grab, to) }
    else this.orbit(to.x - from.x, to.y - from.y)
  }

  private touchGesture() {
    if (this.pointers.size !== 2) return null
    const [a, b] = [...this.pointers.values()]
    return { point: a.clone().add(b).multiplyScalar(.5), distance: a.distanceTo(b) }
  }

  private pointerDown = (event: PointerEvent) => {
    if (!this.enabled || (event.button !== 0 && event.button !== 2)) return
    event.preventDefault()
    if (this.drag && event.pointerType !== 'touch') return
    if (this.pointers.size >= 2) return
    this.onStart()
    const point = new THREE.Vector2(event.clientX, event.clientY)
    this.pointers.set(event.pointerId, point)
    this.element.setPointerCapture(event.pointerId)
    this.drag = { id: event.pointerId, button: event.button, point, grab: event.button === 0 ? this.hit(point) : null }
    this.gesture = this.touchGesture()
    this.element.style.cursor = event.button === 0 ? 'grabbing' : 'move'
  }

  private pointerMove = (event: PointerEvent) => {
    if (!this.enabled || !this.pointers.has(event.pointerId)) return
    event.preventDefault()
    const point = new THREE.Vector2(event.clientX, event.clientY)
    this.pointers.set(event.pointerId, point)
    const gesture = this.touchGesture()
    if (gesture && this.gesture) {
      this.leftDrag(this.gesture.point, gesture.point, this.hit(this.gesture.point))
      if (gesture.distance > 0) this.zoom(this.gesture.distance / gesture.distance)
      this.gesture = gesture
    } else if (this.drag?.id === event.pointerId) {
      if (this.drag.button === 0) this.leftDrag(this.drag.point, point, this.drag.grab)
      else this.tilt(point.y - this.drag.point.y)
      this.drag.point = point
    }
  }

  private pointerUp = (event: PointerEvent) => {
    if (!this.pointers.has(event.pointerId)) return
    event.preventDefault()
    this.pointers.delete(event.pointerId)
    if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId)
    this.gesture = null
    const remaining = this.pointers.entries().next().value
    this.drag = remaining ? { id: remaining[0], button: 0, point: remaining[1], grab: this.hit(remaining[1]) } : null
    this.element.style.cursor = this.drag ? 'grabbing' : this.close ? 'grab' : this.previousCursor
  }

  private wheel = (event: WheelEvent) => {
    if (!this.enabled) return
    event.preventDefault()
    this.onStart()
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.element.clientHeight : 1)
    this.zoom(Math.exp(THREE.MathUtils.clamp(pixels * .00064, -.7, .7)))
  }
  private contextMenu = (event: Event) => event.preventDefault()

  private cancelDrag() {
    this.drag = null
    this.gesture = null
    const ids = [...this.pointers.keys()]
    this.pointers.clear()
    for (const id of ids) if (this.element.hasPointerCapture(id)) this.element.releasePointerCapture(id)
  }

  dispose() {
    this.cancelDrag()
    this.element.style.cursor = this.previousCursor
    this.element.style.touchAction = this.previousTouchAction
    this.element.removeEventListener('pointerdown', this.pointerDown)
    this.element.removeEventListener('pointermove', this.pointerMove)
    this.element.removeEventListener('pointerup', this.pointerUp)
    this.element.removeEventListener('pointercancel', this.pointerUp)
    this.element.removeEventListener('lostpointercapture', this.pointerUp)
    this.element.removeEventListener('wheel', this.wheel)
    this.element.removeEventListener('contextmenu', this.contextMenu)
  }
}

export function createCameraOrbit(camera: THREE.PerspectiveCamera, element: HTMLElement, target: THREE.Vector3, minDistance: number, onStart: () => void) {
  return new BodyCameraControls(camera, element, target, minDistance, onStart)
}
