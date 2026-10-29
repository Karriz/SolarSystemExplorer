import * as THREE from 'three'
import { SURFACE_CLEARANCE } from './cameraSafety.ts'

export type CameraBody = { id: string; center: THREE.Vector3; rotation: THREE.Quaternion; radius: number }

/** Body-centered orbital navigation blending into ground-anchored controls. */
export class BodyCameraControls {
  readonly target: THREE.Vector3
  minDistance: number
  maxDistance = 85
  enabled = true
  close = false
  private camera: THREE.PerspectiveCamera
  private element: HTMLElement
  private onStart: () => void
  private hitGround?: (ray: THREE.Ray) => THREE.Vector3 | null
  private body: CameraBody
  private surfaceWeight = 0
  private attachAllowed = true
  private pointers = new Map<number, THREE.Vector2>()
  private drag: { id: number; button: number; point: THREE.Vector2; grab: THREE.Vector3 | null } | null = null
  private gesture: { point: THREE.Vector2; distance: number } | null = null
  private previousTouchAction: string
  private previousCursor: string

  constructor(camera: THREE.PerspectiveCamera, element: HTMLElement, target: THREE.Vector3, minDistance: number, onStart: () => void, hitGround?: (ray: THREE.Ray) => THREE.Vector3 | null) {
    this.camera = camera
    this.element = element
    this.target = target
    this.minDistance = minDistance
    this.onStart = onStart
    this.hitGround = hitGround
    this.body = { id: '', center: target.clone(), rotation: new THREE.Quaternion(), radius: Math.max(Number.EPSILON, minDistance - SURFACE_CLEARANCE) }
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
    if (sameBody && this.surfaceWeight > 0) {
      const rotation = new THREE.Quaternion().slerp(body.rotation.clone().multiply(this.body.rotation.clone().invert()), this.surfaceWeight)
      this.transform(rotation, this.body.center, body.center)
    }
    this.body = { ...body, center: body.center.clone(), rotation: body.rotation.clone() }
    this.refreshNavigation()
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
    this.refreshNavigation()
    this.camera.updateMatrixWorld()
  }

  private refreshNavigation() {
    // Altitude in body radii keeps the same feel on planets and tiny moons.
    // Full surface control below 20%; orbital control above 80%.
    const altitude = this.camera.position.distanceTo(this.target) / this.body.radius - 1
    const weight = this.attachAllowed ? 1 - THREE.MathUtils.smootherstep(altitude, .2, .8) : 0
    if (weight < this.surfaceWeight) {
      const restore = 1 - weight / this.surfaceWeight
      const north = new THREE.Vector3(0, 1, 0).applyQuaternion(this.body.rotation)
      const orbital = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(this.camera.position, this.target, north))
      this.camera.quaternion.slerp(orbital, restore).normalize()
      this.camera.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion)
    }
    if (weight !== this.surfaceWeight && this.drag?.button === 0) this.drag.grab = this.hit(this.drag.point)
    this.surfaceWeight = weight
  }

  getPolarAngle() { return new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.target)).phi }
  getAzimuthalAngle() { return new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.target)).theta }

  hit(point: THREE.Vector2): THREE.Vector3 | null {
    const rect = this.element.getBoundingClientRect()
    const ndc = new THREE.Vector2((point.x - rect.left) / rect.width * 2 - 1, 1 - (point.y - rect.top) / rect.height * 2)
    this.camera.updateMatrixWorld()
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    return this.hitGround?.(ray.ray) ?? ray.ray.intersectSphere(new THREE.Sphere(this.target, this.body.radius), new THREE.Vector3())
  }

  private viewCenter() {
    const rect = this.element.getBoundingClientRect()
    return new THREE.Vector2(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }

  private transform(rotation: THREE.Quaternion, oldCenter = this.target, newCenter = this.target) {
    const oldOrigin = oldCenter.clone(), newOrigin = newCenter.clone()
    this.camera.position.sub(oldOrigin).applyQuaternion(rotation).add(newOrigin)
    this.camera.quaternion.premultiply(rotation).normalize()
    this.camera.up.applyQuaternion(rotation).normalize()
    this.drag?.grab?.sub(oldOrigin).applyQuaternion(rotation).add(newOrigin)
    this.camera.updateMatrixWorld()
  }

  private orbitRotation(dx: number, dy: number) {
    const scale = 2 * Math.PI / Math.max(1, this.element.clientHeight)
    const north = new THREE.Vector3(0, 1, 0).applyQuaternion(this.body.rotation)
    const yaw = new THREE.Quaternion().setFromAxisAngle(north, -dx * scale)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).applyQuaternion(yaw)
    const pitch = new THREE.Quaternion().setFromAxisAngle(right, -dy * scale)
    return pitch.multiply(yaw)
  }

  private look(dx: number, dy: number, anchor: THREE.Vector3) {
    const vertical = anchor.clone().sub(this.target).normalize()
    const offset = this.camera.position.clone().sub(anchor)
    const angle = Math.acos(THREE.MathUtils.clamp(offset.clone().normalize().dot(vertical), -1, 1))
    const next = THREE.MathUtils.clamp(angle - dy * .004 * this.surfaceWeight, 0, 85 * Math.PI / 180)
    const yaw = new THREE.Quaternion().setFromAxisAngle(vertical, -dx * .004 * this.surfaceWeight)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).applyQuaternion(yaw)
    const pitch = new THREE.Quaternion().setFromAxisAngle(right, next - angle)
    const distance = this.camera.position.distanceTo(this.target)
    this.transform(pitch.multiply(yaw), anchor, anchor)
    // Keep altitude while tilting around the ground anchor. Lengthening the
    // sightline prevents a low camera from dipping through the safety floor.
    const direction = this.camera.position.clone().sub(anchor).normalize()
    this.camera.position.copy(anchor).addScaledVector(direction, this.groundRange(anchor, direction, distance))
    this.camera.updateMatrixWorld()
  }

  private groundRange(anchor: THREE.Vector3, direction: THREE.Vector3, distance: number) {
    const radial = anchor.clone().sub(this.target)
    const b = radial.dot(direction)
    const c = Math.max(0, distance * distance - radial.lengthSq())
    const root = Math.sqrt(b * b + c)
    return b >= 0 ? c / Math.max(root + b, Number.MIN_VALUE) : root - b
  }

  private zoom(factor: number, point?: THREE.Vector2) {
    const offset = this.camera.position.clone().sub(this.target)
    const radius = this.body.radius
    const oldDistance = offset.length()
    const surfaceRadius = this.minDistance - SURFACE_CLEARANCE
    const distance = THREE.MathUtils.clamp(surfaceRadius + (oldDistance - surfaceRadius) * factor, this.minDistance, this.maxDistance)
    // Blend in as the globe grows to fill the vertical field of view.
    const angularRadius = Math.asin(Math.min(1, radius / oldDistance))
    const weight = this.attachAllowed ? THREE.MathUtils.smootherstep(angularRadius / THREE.MathUtils.degToRad(this.camera.fov / 2), .75, 1) : 0
    const anchor = point && weight > 0 ? this.hit(point) : null
    const radialPosition = this.target.clone().add(offset.setLength(distance))
    if (anchor) {
      const direction = this.camera.position.clone().sub(anchor).normalize()
      const cursorPosition = anchor.clone().addScaledVector(direction, this.groundRange(anchor, direction, distance))
      this.camera.position.copy(radialPosition).lerp(cursorPosition, weight)
      this.camera.position.sub(this.target).setLength(distance).add(this.target)
    } else this.camera.position.copy(radialPosition)
    this.refreshClose(radius)
    this.refreshNavigation()
    this.camera.updateMatrixWorld()
    // Orientation restoration in the orbital blend must also retain the
    // pointed location. Rotating the whole frame preserves radial clearance.
    const after = anchor && point ? this.hit(point) : null
    if (anchor && after) {
      const correction = new THREE.Quaternion().setFromUnitVectors(after.sub(this.target).normalize(), anchor.clone().sub(this.target).normalize())
      this.transform(new THREE.Quaternion().slerp(correction, weight))
    }
    if (this.drag) this.drag.grab = this.hit(this.drag.button === 0 ? this.drag.point : this.viewCenter())
  }

  private leftDrag(from: THREE.Vector2, to: THREE.Vector2, grab: THREE.Vector3 | null) {
    const rotation = this.orbitRotation(to.x - from.x, to.y - from.y)
    if (this.surfaceWeight > 0) {
      const hit = this.hit(to)
      // In the blend band use incremental hits so the unused part of a grab
      // does not accumulate and cause a jump on the next pointer movement.
      const anchor = this.surfaceWeight === 1 ? grab : this.hit(from)
      const surface = anchor && hit
        ? new THREE.Quaternion().setFromUnitVectors(hit.sub(this.target).normalize(), anchor.clone().sub(this.target).normalize())
        : new THREE.Quaternion()
      rotation.slerp(surface, this.surfaceWeight)
    }
    const saved = this.drag?.grab?.clone()
    this.transform(rotation)
    if (saved) this.drag!.grab!.copy(saved)
    if (this.drag && this.surfaceWeight < 1) this.drag.grab = this.hit(to)
  }

  private rightDrag(dx: number, dy: number) {
    const anchor = this.drag?.grab
    const weight = anchor ? this.surfaceWeight : 0
    this.transform(new THREE.Quaternion().slerp(this.orbitRotation(dx, dy), 1 - weight))
    if (anchor && weight > 0) this.look(dx, dy, anchor)
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
    this.drag = { id: event.pointerId, button: event.button, point, grab: this.hit(event.button === 0 ? point : this.viewCenter()) }
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
      if (gesture.distance > 0) this.zoom(this.gesture.distance / gesture.distance, gesture.point)
      this.gesture = gesture
    } else if (this.drag?.id === event.pointerId) {
      if (this.drag.button === 0) this.leftDrag(this.drag.point, point, this.drag.grab)
      else this.rightDrag(point.x - this.drag.point.x, point.y - this.drag.point.y)
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
    this.zoom(Math.exp(THREE.MathUtils.clamp(pixels * .00064, -.7, .7)), new THREE.Vector2(event.clientX, event.clientY))
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

export function createCameraOrbit(camera: THREE.PerspectiveCamera, element: HTMLElement, target: THREE.Vector3, minDistance: number, onStart: () => void, hitGround?: (ray: THREE.Ray) => THREE.Vector3 | null) {
  return new BodyCameraControls(camera, element, target, minDistance, onStart, hitGround)
}
