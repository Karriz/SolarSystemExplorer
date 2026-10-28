import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createCameraOrbit } from '../src/cameraOrbit.ts'

class Canvas extends EventTarget {
  style = { cursor: '', touchAction: '' }
  clientHeight = 600
  pointers = new Set()
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 } }
  setPointerCapture(id) { this.pointers.add(id) }
  hasPointerCapture(id) { return this.pointers.has(id) }
  releasePointerCapture(id) { this.pointers.delete(id) }
}
function setup(radius = 1, distance = 5) {
  const camera = new THREE.PerspectiveCamera(48, 4 / 3, radius * .001, 200)
  camera.position.set(0, .4, 1.1).normalize().multiplyScalar(radius * distance)
  camera.lookAt(0, 0, 0)
  const element = new Canvas(), target = new THREE.Vector3()
  let starts = 0
  const controls = createCameraOrbit(camera, element, target, radius * 1.05, () => starts++)
  const body = { id: 'earth', center: new THREE.Vector3(), rotation: new THREE.Quaternion(), radius }
  controls.setBody(body)
  return { camera, element, target, controls, body, starts: () => starts }
}
function pointer(element, type, button, x, y, id = 1, pointerType = 'mouse') {
  const event = new Event(type, { cancelable: true })
  Object.assign(event, { pointerType, pointerId: id, button, clientX: x, clientY: y })
  element.dispatchEvent(event)
}
function wheel(element, deltaY) {
  const event = new Event('wheel', { cancelable: true })
  Object.assign(event, { deltaY, deltaMode: 0, clientX: 750, clientY: 20 })
  element.dispatchEvent(event)
}
const close = (a, b, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`)
function drag(element, button, from, to) {
  pointer(element, 'pointerdown', button, ...from)
  pointer(element, 'pointermove', button, ...to)
  pointer(element, 'pointerup', button, ...to)
}

test('left drag orbits in both directions around the selected body', () => {
  const { controls, camera, element, target, starts } = setup()
  const position = camera.position.clone(), polar = controls.getPolarAngle(), azimuth = controls.getAzimuthalAngle()
  drag(element, 0, [400, 300], [480, 350])
  assert.ok(Math.abs(controls.getPolarAngle() - polar) > .1)
  assert.ok(Math.abs(controls.getAzimuthalAngle() - azimuth) > .1)
  close(camera.position.length(), position.length())
  close(target.length(), 0)
  close(camera.getWorldDirection(new THREE.Vector3()).dot(camera.position.clone().negate().normalize()), 1)
  assert.equal(starts(), 1)
  controls.dispose()
})

test('right drag tilts the view toward the horizon without moving the camera', () => {
  for (const distance of [1.05, 1.2, 5]) {
    const { controls, camera, element, target } = setup(4.26e-5, distance)
    const position = camera.position.clone(), orientation = camera.quaternion.clone()
    drag(element, 2, [400, 300], [500, 150])
    close(camera.position.distanceTo(position), 0)
    close(camera.quaternion.angleTo(orientation), .6)
    close(target.length(), 0)
    const q = camera.quaternion.clone()
    drag(element, 2, [400, 300], [550, 300])
    assert.ok(camera.quaternion.angleTo(q) < 1e-7)
    controls.dispose()
  }
})

test('close left dragging holds the pointed surface exactly under the cursor', () => {
  for (const radius of [1, 4.26e-5, 1.16e-5]) {
    const { controls, camera, element, target } = setup(radius, 1.2)
    const grabbed = controls.hit(new THREE.Vector2(400, 300))
    const range = camera.position.length()
    drag(element, 0, [400, 300], [500, 330])
    const p = grabbed.clone().project(camera)
    close(p.x, .25)
    close(p.y, -.1)
    close(camera.position.length(), range)
    close(target.length(), 0)
    controls.dispose()
  }
})

test('surface grip remains exact after looking toward the horizon', () => {
  const { controls, camera, element } = setup(1, 1.05)
  drag(element, 2, [400, 500], [400, 250])
  const grabbed = controls.hit(new THREE.Vector2(400, 300))
  assert.ok(grabbed)
  const distance = camera.position.length()
  drag(element, 0, [400, 300], [420, 315])
  const p = grabbed.clone().project(camera)
  close(p.x, .05)
  close(p.y, -.05)
  close(camera.position.length(), distance)
  controls.dispose()
})

test('zoom preserves orientation across close and wide views and respects the surface floor', () => {
  for (const radius of [1, 4.26e-5, 1.16e-5]) {
    const { controls, camera, element, body, target } = setup(radius)
    drag(element, 2, [400, 300], [400, 150])
    const orientation = camera.quaternion.clone()
    for (let i = 0; i < 10; i++) { wheel(element, -3000); controls.setBody(body); controls.update() }
    close(camera.position.length() / radius, 1.05)
    assert.ok(controls.close)
    for (let i = 0; i < 15; i++) { wheel(element, 1000); controls.setBody(body); controls.update() }
    assert.ok(!controls.close)
    const position = camera.position.clone()
    for (let i = 0; i < 120; i++) controls.update()
    assert.ok(camera.quaternion.angleTo(orientation) < 1e-7)
    close(camera.position.distanceTo(position), 0)
    close(target.length(), 0)
    controls.dispose()
  }
})

test('tilt is bounded and first input preserves roll without a position jump', () => {
  const { controls, camera, element } = setup(1, 1.05)
  camera.up.applyAxisAngle(camera.getWorldDirection(new THREE.Vector3()), 1.2)
  camera.lookAt(0, 0, 0)
  const orientation = camera.quaternion.clone(), position = camera.position.clone()
  drag(element, 2, [400, 300], [400, 299])
  close(camera.quaternion.angleTo(orientation), .004)
  close(camera.position.distanceTo(position), 0)
  drag(element, 2, [400, 300], [400, -10000])
  close(Math.acos(camera.getWorldDirection(new THREE.Vector3()).dot(position.clone().negate().normalize())), 85 * Math.PI / 180)
  close(camera.position.distanceTo(position), 0)
  controls.dispose()
})

test('close views follow body rotation, while entering and exiting never reorient automatically', () => {
  const { controls, camera, body } = setup(1, 1.2)
  const p = camera.position.clone(), q = camera.quaternion.clone()
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .6)
  controls.setBody({ ...body, rotation })
  close(camera.position.distanceTo(p.clone().applyQuaternion(rotation)), 0)
  assert.ok(camera.quaternion.angleTo(q.clone().premultiply(rotation)) < 1e-7)
  camera.position.setLength(2)
  controls.setBody({ ...body, rotation })
  assert.ok(!controls.close)
  const orientation = camera.quaternion.clone()
  camera.position.setLength(1.4)
  controls.setBody({ ...body, rotation: new THREE.Quaternion() })
  assert.ok(controls.close)
  assert.ok(camera.quaternion.angleTo(orientation) < 1e-7)
  controls.dispose()
})

test('sky grabs stay still, cancellation releases capture, and disposal removes input handlers', () => {
  const { controls, camera, element, starts } = setup(1, 1.05)
  drag(element, 2, [400, 500], [400, 100])
  const position = camera.position.clone(), orientation = camera.quaternion.clone()
  assert.equal(controls.hit(new THREE.Vector2(400, 20)), null)
  drag(element, 0, [400, 20], [450, 550])
  close(camera.position.distanceTo(position), 0)
  assert.ok(camera.quaternion.angleTo(orientation) < 1e-7)
  pointer(element, 'pointerdown', 0, 400, 500)
  pointer(element, 'pointercancel', 0, 400, 500)
  assert.equal(element.pointers.size, 0)
  controls.dispose()
  const count = starts()
  pointer(element, 'pointerdown', 0, 400, 300)
  pointer(element, 'pointermove', 0, 500, 400)
  assert.equal(starts(), count)
  assert.equal(element.style.touchAction, '')
})

test('touch dragging and pinch zoom retain the selected body as navigation reference', () => {
  const { controls, camera, element, target } = setup(1, 1.2)
  pointer(element, 'pointerdown', 0, 380, 300, 1, 'touch')
  pointer(element, 'pointerdown', 0, 420, 300, 2, 'touch')
  const distance = camera.position.length()
  pointer(element, 'pointermove', 0, 460, 300, 2, 'touch')
  assert.ok(camera.position.length() < distance)
  close(target.length(), 0)
  pointer(element, 'pointerup', 0, 380, 300, 1, 'touch')
  pointer(element, 'pointerup', 0, 460, 300, 2, 'touch')
  assert.equal(element.pointers.size, 0)
  controls.dispose()
})
