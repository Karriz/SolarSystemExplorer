import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { createCameraOrbit } from '../src/cameraOrbit.ts'
import { SURFACE_CLEARANCE } from '../src/cameraSafety.ts'

class Canvas extends EventTarget {
  style = { cursor: '', touchAction: '' }
  clientHeight = 600
  pointers = new Set()
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 } }
  setPointerCapture(id) { this.pointers.add(id) }
  hasPointerCapture(id) { return this.pointers.has(id) }
  releasePointerCapture(id) { this.pointers.delete(id) }
}
function setup(radius = 1, distance = 5, hitGround, groundRadius) {
  const camera = new THREE.PerspectiveCamera(48, 4 / 3, radius * .001, 200)
  camera.position.set(0, .4, 1.1).normalize().multiplyScalar(radius * distance)
  camera.lookAt(0, 0, 0)
  const element = new Canvas(), target = new THREE.Vector3()
  let starts = 0
  const controls = createCameraOrbit(camera, element, target, radius + SURFACE_CLEARANCE, () => starts++, hitGround, groundRadius)
  const body = { id: 'earth', center: new THREE.Vector3(), rotation: new THREE.Quaternion(), radius }
  controls.setBody(body)
  element.controls = controls
  return { camera, element, target, controls, body, starts: () => starts }
}
function pointer(element, type, button, x, y, id = 1, pointerType = 'mouse') {
  const event = new Event(type, { cancelable: true })
  Object.assign(event, { pointerType, pointerId: id, button, clientX: x, clientY: y })
  element.dispatchEvent(event)
}
function wheel(element, deltaY, x = 750, y = 20, settle = true) {
  const event = new Event('wheel', { cancelable: true })
  Object.assign(event, { deltaY, deltaMode: 0, clientX: x, clientY: y })
  element.dispatchEvent(event)
  if (settle) for (let i = 0; i < 120; i++) element.controls.update(1 / 60)
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

test('close right drag tilts and turns around a stable ground anchor at constant altitude', () => {
  for (const radius of [1, 4.26e-5, 1.16e-5]) {
    for (const distance of [1.01, 1.05, 1.2]) {
      const { controls, camera, element, target } = setup(radius, distance)
      const position = camera.position.clone(), orientation = camera.quaternion.clone()
      const anchor = controls.hit(new THREE.Vector2(400, 300))
      drag(element, 2, [400, 300], [400, 150])
      assert.ok(camera.position.distanceTo(position) / radius > .00001)
      close(camera.position.length() / radius, distance)
      close(camera.quaternion.angleTo(orientation), .6, 1e-7)
      const tiltedProjection = anchor.clone().project(camera)
      close(tiltedProjection.x, 0)
      close(tiltedProjection.y, 0)
      const q = camera.quaternion.clone(), tiltedPosition = camera.position.clone()
      drag(element, 2, [400, 300], [550, 300])
      close(camera.quaternion.angleTo(q), .6, 1e-7)
      close(camera.position.length() / radius, distance)
      assert.ok(camera.position.distanceTo(tiltedPosition) / radius > .00001)
      const projected = anchor.clone().project(camera)
      close(projected.x, 0)
      close(projected.y, 0)
      close(target.length(), 0)
      controls.dispose()
    }
  }
})

test('close left dragging holds the pointed surface exactly under the cursor', () => {
  for (const radius of [.00465, 4.26e-5, 1.16e-5]) {
    const { controls, camera, element, target } = setup(radius, 1 + SURFACE_CLEARANCE / radius)
    const grabbed = controls.hit(new THREE.Vector2(400, 300))
    const range = camera.position.length()
    drag(element, 0, [400, 300], [500, 330])
    const p = grabbed.clone().project(camera)
    close(p.x, .25, 1e-7)
    close(p.y, -.1, 1e-7)
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

test('zooming out progressively restores orbital aim and compass orientation', () => {
  for (const radius of [1, 4.26e-5, 1.16e-5]) {
    const { controls, camera, element, body, target } = setup(radius, 1.05)
    drag(element, 2, [400, 300], [550, 150])
    const surface = camera.quaternion.clone()
    camera.position.setLength(radius * 1.5)
    controls.update()
    const north = new THREE.Vector3(0, 1, 0).applyQuaternion(body.rotation)
    const orbital = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(camera.position, target, north))
    close(camera.quaternion.angleTo(orbital), surface.angleTo(orbital) * .5, 1e-7)
    camera.position.setLength(radius * 1.8)
    controls.update()
    assert.ok(camera.quaternion.angleTo(orbital) < 1e-7)
    for (let i = 0; i < 40; i++) wheel(element, -3000, 400, 300)
    close(camera.position.length() / radius, 1 + SURFACE_CLEARANCE / radius)
    assert.ok(controls.close)
    assert.ok(camera.quaternion.angleTo(orbital) < 1e-7)
    close(target.length(), 0)
    controls.dispose()
  }
})

test('wide right dragging behaves like orbital dragging with no independent tilt', () => {
  const left = setup(), right = setup()
  drag(left.element, 0, [400, 300], [470, 250])
  drag(right.element, 2, [400, 300], [470, 250])
  close(left.camera.position.distanceTo(right.camera.position), 0)
  assert.ok(left.camera.quaternion.angleTo(right.camera.quaternion) < 1e-7)
  close(right.camera.getWorldDirection(new THREE.Vector3()).dot(right.camera.position.clone().negate().normalize()), 1)
  left.controls.dispose()
  right.controls.dispose()
})

test('drag speeds stay continuous across the old mode thresholds and blend endpoints', () => {
  for (const boundary of [1.2, 1.5, 1.8]) {
    for (const button of [0, 2]) {
      const a = setup(1, boundary - .00001), b = setup(1, boundary + .00001)
      const beforeA = a.camera.position.clone().normalize(), beforeB = b.camera.position.clone().normalize()
      drag(a.element, button, [400, 300], [402, 301])
      drag(b.element, button, [400, 300], [402, 301])
      const motionA = beforeA.angleTo(a.camera.position.clone().normalize())
      const motionB = beforeB.angleTo(b.camera.position.clone().normalize())
      close(motionA, motionB, .00001)
      a.controls.dispose()
      b.controls.dispose()
    }
  }
})

test('a held ground drag stays anchored while zooming through the blend band', () => {
  const { camera, controls, element } = setup(1, 2)
  pointer(element, 'pointerdown', 0, 400, 300)
  for (const distance of [1.79, 1.55, 1.3, 1.19]) {
    camera.position.setLength(distance)
    controls.update()
    const before = camera.position.clone()
    pointer(element, 'pointermove', 0, 400, 300)
    close(camera.position.distanceTo(before), 0)
    pointer(element, 'pointermove', 0, 402, 301)
    pointer(element, 'pointermove', 0, 400, 300)
  }
  const grabbed = controls.hit(new THREE.Vector2(400, 300))
  pointer(element, 'pointermove', 0, 410, 305)
  const projected = grabbed.clone().project(camera)
  close(projected.x, .025)
  close(projected.y, -1 / 60)
  pointer(element, 'pointerup', 0, 410, 305)
  controls.dispose()
})

test('the Sun and focus animations keep right dragging in orbital mode', () => {
  for (const id of ['sun', 'earth']) {
    const { controls, camera, element, body } = setup(1, 1.05)
    controls.setBody({ ...body, id }, id === 'sun')
    const position = camera.position.clone()
    drag(element, 2, [400, 300], [430, 250])
    assert.ok(camera.position.distanceTo(position) > .01)
    close(camera.getWorldDirection(new THREE.Vector3()).dot(camera.position.clone().negate().normalize()), 1)
    controls.dispose()
  }
})

test('ground tilt is bounded, preserves initial roll, and keeps the ground anchor centered', () => {
  const { controls, camera, element } = setup(1, 1.05)
  camera.up.applyAxisAngle(camera.getWorldDirection(new THREE.Vector3()), 1.2)
  camera.lookAt(0, 0, 0)
  const orientation = camera.quaternion.clone(), position = camera.position.clone()
  const anchor = controls.hit(new THREE.Vector2(400, 300))
  drag(element, 2, [400, 300], [400, 299])
  close(camera.quaternion.angleTo(orientation), .004)
  close(camera.position.length(), position.length())
  drag(element, 2, [400, 300], [400, -10000])
  const normal = anchor.clone().normalize()
  close(camera.position.clone().sub(anchor).normalize().angleTo(normal), 85 * Math.PI / 180, 1e-7)
  close(camera.position.length(), position.length())
  const projected = anchor.clone().project(camera)
  close(projected.x, 0)
  close(projected.y, 0)
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

test('close cursor zoom keeps the pointed ground location fixed through zoom in and out', () => {
  for (const radius of [1, 4.26e-5, 1.16e-5]) {
    for (const tilted of [false, true]) {
      const { controls, camera, element, target } = setup(radius, 1.15)
      if (tilted) drag(element, 2, [400, 300], [470, 150])
      const point = new THREE.Vector2(520, 360)
      const anchor = controls.hit(point)
      assert.ok(anchor)
      const initialDistance = camera.position.length()
      for (const delta of [-300, -300, 300, 300]) {
        wheel(element, delta, point.x, point.y)
        controls.update()
        const projected = anchor.clone().project(camera)
        close(projected.x, .3, 1e-7)
        close(projected.y, -.2, 1e-7)
        close(target.length(), 0)
      }
      close(camera.position.length() / radius, initialDistance / radius, 1e-7)
      controls.dispose()
    }
  }
})

test('edge zoom preserves the camera frame relative to the surface on every frame', () => {
  for (const radius of [1, 4.26e-5, 1.16e-5]) {
    for (const tilted of [false, true]) {
      for (const [x, y] of [[40, 300], [760, 300], [400, 560], [80, 520]]) {
        const s = setup(radius, 1.05)
        if (tilted) drag(s.element, 2, [400, 300], [470, 180])
        const point = new THREE.Vector2(x, y), anchor = s.controls.hit(point)
        assert.ok(anchor)
        const localNormal = () => s.camera.position.clone().sub(s.target).normalize()
          .applyQuaternion(s.camera.quaternion.clone().invert())
        const before = localNormal()
        for (const delta of [-600, 600]) {
          wheel(s.element, delta, x, y, false)
          for (let frame = 0; frame < 120; frame++) {
            s.controls.update(1 / 60)
            close(localNormal().distanceTo(before), 0, 1e-8)
            const p = anchor.clone().project(s.camera)
            close(p.x, x / 400 - 1, 1e-7)
            close(p.y, 1 - y / 300, 1e-7)
          }
        }
        s.controls.dispose()
      }
    }
  }
})

test('an off-center approach from orbit stays downward-facing through the entire transition', () => {
  for (const radius of [1, 4.26e-5, 1.16e-5]) {
    for (const distance of [5, 2, 1.6]) {
      for (const x of [280, 520]) {
        const s = setup(radius, distance)
        assert.ok(s.controls.hit(new THREE.Vector2(x, 340)))
        for (let step = 0; step < 40; step++) {
          wheel(s.element, -1200, x, 340, false)
          for (let frame = 0; frame < 90; frame++) {
            s.controls.update(1 / 60)
            const normal = s.camera.position.clone().sub(s.target).normalize()
              .applyQuaternion(s.camera.quaternion.clone().invert())
            close(normal.x, 0, 1e-8)
            close(normal.y, 0, 1e-8)
            close(normal.z, 1, 1e-8)
          }
        }
        close(s.camera.position.length(), radius + SURFACE_CLEARANCE, 1e-9)
        s.controls.dispose()
      }
    }
  }
})

test('cursor zoom begins as the planet fills the view and ignores sky and overview pointing', () => {
  for (const distance of [2, 5]) {
    const { controls, camera, element } = setup(1, distance)
    const anchor = controls.hit(new THREE.Vector2(470, 330))
    const axis = camera.position.clone().normalize()
    wheel(element, -100, 470, 330)
    if (distance === 2) {
      const projected = anchor.clone().project(camera)
      close(projected.x, .175, 1e-7)
      close(projected.y, -.1, 1e-7)
      assert.ok(camera.position.clone().normalize().distanceTo(axis) > .0001)
    } else close(camera.position.clone().normalize().distanceTo(axis), 0)
    controls.dispose()
  }
  const { controls, camera, element } = setup(1, 1.7)
  const axis = camera.position.clone().normalize()
  assert.equal(controls.hit(new THREE.Vector2(0, 0)), null)
  wheel(element, -100, 0, 0)
  close(camera.position.clone().normalize().distanceTo(axis), 0)
  controls.dispose()
})

test('a held right drag retains its ground anchor through repeated moves and body rotation', () => {
  const { controls, camera, element, body } = setup(1, 1.05)
  const anchor = controls.hit(new THREE.Vector2(400, 300))
  pointer(element, 'pointerdown', 2, 400, 300)
  for (const [x, y] of [[400, 200], [470, 150], [550, 180], [500, 230]]) {
    pointer(element, 'pointermove', 2, x, y)
    const projection = anchor.clone().project(camera)
    close(projection.x, 0)
    close(projection.y, 0)
    close(camera.position.length(), 1.05)
  }
  const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .1)
  controls.setBody({ ...body, rotation })
  anchor.applyQuaternion(rotation)
  pointer(element, 'pointermove', 2, 520, 210)
  const projection = anchor.clone().project(camera)
  close(projection.x, 0)
  close(projection.y, 0)
  pointer(element, 'pointerup', 2, 520, 210)
  controls.dispose()
})

test('cursor zoom and right drag use supplied elevated ground intersections', () => {
  const sphere = new THREE.Sphere(new THREE.Vector3(), 1.003)
  const { controls, camera, element } = setup(1, 1.05, ray => ray.intersectSphere(sphere, new THREE.Vector3()))
  const anchor = controls.hit(new THREE.Vector2(510, 330))
  close(anchor.length(), 1.003)
  wheel(element, -150, 510, 330)
  const projection = anchor.clone().project(camera)
  close(projection.x, .275, 1e-7)
  close(projection.y, -.1, 1e-7)
  const pivot = controls.hit(new THREE.Vector2(400, 300))
  drag(element, 2, [400, 300], [470, 200])
  close(pivot.clone().project(camera).x, 0, 1e-7)
  close(pivot.clone().project(camera).y, 0, 1e-7)
  controls.dispose()
})

test('zoom reaches 100 meters and ground tilt remains usable at the floor', () => {
  const metersPerAu = 149_597_870_700
  for (const radius of [6371000 / metersPerAu, 1737400 / metersPerAu]) {
    const { controls, camera, element } = setup(radius, 1.01)
    for (let i = 0; i < 25; i++) wheel(element, -3000, 400, 300)
    close((camera.position.length() - radius) * metersPerAu, 100, 1e-5)
    const anchor = controls.hit(new THREE.Vector2(400, 300))
    drag(element, 2, [400, 300], [470, 150])
    close((camera.position.length() - radius) * metersPerAu, 100, 1e-5)
    close(anchor.clone().project(camera).x, 0, 1e-6)
    close(anchor.clone().project(camera).y, 0, 1e-6)
    controls.dispose()
  }
})

test('zoom can descend to 100 meters above terrain below the reference radius', () => {
  const metersPerAu = 149_597_870_700
  const radius = 1737400 / metersPerAu, groundRadius = radius - 2000 / metersPerAu
  const sphere = new THREE.Sphere(new THREE.Vector3(), groundRadius)
  const { controls, camera, element } = setup(radius, 1.01, ray => ray.intersectSphere(sphere, new THREE.Vector3()))
  controls.minDistance = groundRadius + SURFACE_CLEARANCE
  for (let i = 0; i < 25; i++) wheel(element, -3000, 400, 300)
  close((camera.position.length() - groundRadius) * metersPerAu, 100, 1e-5)
  wheel(element, 300, 400, 300)
  assert.ok(camera.position.length() > controls.minDistance)
  controls.dispose()
})

test('wheel zoom is gradual, monotonic, and independent of render frame rate', () => {
  const states = [30, 60, 144].map(fps => {
    const state = setup(1, 1.1)
    const before = state.camera.position.length()
    wheel(state.element, -300, 400, 300, false)
    close(state.camera.position.length(), before)
    let previous = before
    for (let i = 0; i < fps / 2; i++) {
      state.controls.update(1 / fps)
      const distance = state.camera.position.length()
      assert.ok(distance <= previous + 1e-12)
      assert.ok(distance > 1 + .1 * Math.exp(-300 * .00064) - 1e-12)
      previous = distance
    }
    return state
  })
  close(states[0].camera.position.length(), states[1].camera.position.length(), 1e-10)
  close(states[1].camera.position.length(), states[2].camera.position.length(), 1e-10)
  states.forEach(s => s.controls.dispose())
})

test('animated cursor zoom keeps its ground anchor on every intermediate frame', () => {
  const { controls, camera, element } = setup(1, 1.15)
  drag(element, 2, [400, 300], [470, 150])
  const point = new THREE.Vector2(510, 340), anchor = controls.hit(point)
  wheel(element, -600, point.x, point.y, false)
  for (let i = 0; i < 120; i++) {
    controls.update(1 / 60)
    const projection = anchor.clone().project(camera)
    close(projection.x, .275, 1e-7)
    close(projection.y, -2 / 15, 1e-7)
  }
  controls.dispose()
})

test('input interruption, disabling, and changing body cancel pending wheel motion', () => {
  for (const interrupt of [s => pointer(s.element, 'pointerdown', 0, 400, 300),
    s => { s.controls.enabled = false }, s => s.controls.setBody({ ...s.body, id: 'moon' })]) {
    const s = setup(1, 1.1)
    wheel(s.element, -500, 400, 300, false)
    s.controls.update(1 / 60)
    interrupt(s)
    const position = s.camera.position.clone()
    for (let i = 0; i < 30; i++) s.controls.update(1 / 60)
    close(position.distanceTo(s.camera.position), 0)
    s.controls.dispose()
  }
})

test('wheel direction changes retarget zoom immediately without stored overshoot at the floor', () => {
  const s = setup(1, 1.05)
  for (let i = 0; i < 30; i++) wheel(s.element, -3000, 400, 300, false)
  for (let i = 0; i < 120; i++) s.controls.update(1 / 60)
  close(s.camera.position.length(), 1 + SURFACE_CLEARANCE)
  wheel(s.element, 300, 400, 300, false)
  s.controls.update(1 / 60)
  assert.ok(s.camera.position.length() > 1 + SURFACE_CLEARANCE)
  s.controls.dispose()
})

// An ellipsoid supplies a continuous, analytically known terrain height and
// ray intersection, independent of mesh loading or the navigation algorithm.
function terrainSetup() {
  const scale = new THREE.Vector3(1.08, 1, 1), sphere = new THREE.Sphere(new THREE.Vector3(), 1)
  const hitGround = ray => {
    const transformed = new THREE.Ray(ray.origin.clone().divide(scale), ray.direction.clone().divide(scale).normalize())
    return transformed.intersectSphere(sphere, new THREE.Vector3())?.multiply(scale) ?? null
  }
  const groundRadius = position => 1 / position.clone().normalize().divide(scale).length()
  return { ...setup(1, 1.01, hitGround, groundRadius), groundRadius }
}

test('grazing edge zoom over sloped terrain retains its local orientation without jumps', () => {
  const s = terrainSetup()
  drag(s.element, 2, [400, 300], [464, -20])
  const point = new THREE.Vector2(736, 480), anchor = s.controls.hit(point)
  assert.ok(anchor)
  const localNormal = () => s.camera.position.clone().normalize().applyQuaternion(s.camera.quaternion.clone().invert())
  const normal = localNormal(), projected = anchor.clone().project(s.camera)
  for (const delta of [-600, 600]) {
    wheel(s.element, delta, point.x, point.y, false)
    for (let frame = 0; frame < 120; frame++) {
      const previous = s.camera.quaternion.clone()
      s.controls.update(1 / 60)
      close(localNormal().distanceTo(normal), 0, 1e-8)
      assert.ok(previous.angleTo(s.camera.quaternion) < .05)
      const p = anchor.clone().project(s.camera)
      close(p.x, projected.x, 1e-6)
      close(p.y, projected.y, 1e-6)
    }
  }
  s.controls.dispose()
})

test('left ground dragging maintains terrain height and the grabbed point across changing elevation', () => {
  const s = terrainSetup(), anchor = s.controls.hit(new THREE.Vector2(400, 300))
  const height = s.camera.position.length() - s.groundRadius(s.camera.position)
  pointer(s.element, 'pointerdown', 0, 400, 300)
  for (const x of [420, 440, 460, 480, 500]) {
    pointer(s.element, 'pointermove', 0, x, 310)
    close(s.camera.position.length() - s.groundRadius(s.camera.position), height, 1e-9)
    const p = anchor.clone().project(s.camera)
    close(p.x, (x - 400) / 400, 1e-6)
    close(p.y, -1 / 30, 1e-6)
  }
  s.controls.dispose()
})

test('right ground pivot stays centered at constant terrain height through tilt and compass rotation', () => {
  const s = terrainSetup(), anchor = s.controls.hit(new THREE.Vector2(400, 300))
  const height = s.camera.position.length() - s.groundRadius(s.camera.position)
  pointer(s.element, 'pointerdown', 2, 400, 300)
  for (const [x, y] of [[400, 200], [400, 100], [500, 100], [600, 120], [700, 140]]) {
    pointer(s.element, 'pointermove', 2, x, y)
    const p = anchor.clone().project(s.camera)
    close(p.x, 0, 1e-7)
    close(p.y, 0, 1e-7)
    close(s.camera.position.length() - s.groundRadius(s.camera.position), height, 1e-9)
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(s.camera.quaternion)
    close(right.dot(anchor.clone().normalize()), 0, 1e-7)
  }
  s.controls.dispose()
})

test('smooth wheel zoom during a held right drag retains the original ground pivot', () => {
  const s = terrainSetup(), anchor = s.controls.hit(new THREE.Vector2(400, 300))
  pointer(s.element, 'pointerdown', 2, 400, 300)
  pointer(s.element, 'pointermove', 2, 500, 150)
  wheel(s.element, -300, 500, 150, false)
  for (let i = 0; i < 90; i++) {
    s.controls.update(1 / 60)
    const p = anchor.clone().project(s.camera)
    close(p.x, 0, 1e-7)
    close(p.y, 0, 1e-7)
  }
  pointer(s.element, 'pointermove', 2, 520, 170)
  close(anchor.clone().project(s.camera).x, 0, 1e-7)
  close(anchor.clone().project(s.camera).y, 0, 1e-7)
  s.controls.dispose()
})

test('ground pivots and compass headings stay finite at both poles', () => {
  for (const sign of [-1, 1]) {
    const s = setup(1, 1.01)
    s.camera.position.set(0, sign * 1.01, 0)
    s.camera.up.set(0, 0, -sign)
    s.camera.lookAt(s.target)
    const anchor = s.controls.hit(new THREE.Vector2(400, 300))
    drag(s.element, 2, [400, 300], [500, 160])
    const p = anchor.clone().project(s.camera)
    close(p.x, 0, 1e-7)
    close(p.y, 0, 1e-7)
    close(s.camera.position.length(), 1.01)
    assert.ok(s.camera.quaternion.toArray().every(Number.isFinite))
    s.controls.dispose()
  }
})

test('reversing the wheel cancels unfinished travel in the old direction', () => {
  const s = setup(1, 1.1)
  wheel(s.element, -1000, 400, 300, false)
  s.controls.update(1 / 60)
  const distance = s.camera.position.length()
  wheel(s.element, 100, 400, 300, false)
  s.controls.update(1 / 60)
  assert.ok(s.camera.position.length() > distance)
  s.controls.dispose()
})

test('animated retreat from a tilted ground view restores orbit without orientation jumps', () => {
  const s = setup(1, 1.1)
  drag(s.element, 2, [400, 300], [550, 100])
  let previous = s.camera.quaternion.clone()
  for (let step = 0; step < 5; step++) {
    wheel(s.element, 3000, 400, 300, false)
    for (let frame = 0; frame < 120; frame++) {
      s.controls.update(1 / 60)
      assert.ok(previous.angleTo(s.camera.quaternion) < .12, 'Transition must distribute rotation over frames')
      previous.copy(s.camera.quaternion)
    }
  }
  close(s.camera.getWorldDirection(new THREE.Vector3()).dot(s.camera.position.clone().negate().normalize()), 1, 1e-7)
  assert.equal(s.controls.close, false)
  s.controls.dispose()
})

test('animated cursor zoom reconciles its anchor with changing terrain elevation', () => {
  const s = terrainSetup()
  drag(s.element, 2, [400, 300], [470, 180])
  const point = new THREE.Vector2(500, 340), anchor = s.controls.hit(point)
  assert.ok(anchor)
  const initialHeight = s.camera.position.length() - s.groundRadius(s.camera.position)
  wheel(s.element, -300, point.x, point.y, false)
  for (let i = 0; i < 120; i++) {
    s.controls.update(1 / 60)
    const p = anchor.clone().project(s.camera)
    close(p.x, .25, 1e-6)
    close(p.y, -2 / 15, 1e-6)
  }
  close(s.camera.position.length() - s.groundRadius(s.camera.position), initialHeight * Math.exp(-300 * .00064), 1e-8)
  s.controls.dispose()
})

test('oblate body picking rejects the spherical polar fringe and follows body rotation', () => {
  const s=setup(1,4)
  s.camera.position.set(0,0,4);s.camera.lookAt(0,0,0);s.camera.updateMatrixWorld()
  s.body.ellipsoid=new THREE.Vector3(1,.8,1);s.controls.setBody(s.body)
  const fringe=new THREE.Vector3(0,.9,0).project(s.camera)
  const screen=new THREE.Vector2((fringe.x*.5+.5)*800,(.5-fringe.y*.5)*600)
  assert.equal(s.controls.hit(screen),null)
  const center=s.controls.hit(new THREE.Vector2(400,300));assert.ok(center)
  close(center.z,1)
  s.body.rotation.setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/2)
  s.controls.setBody(s.body)
  assert.ok(s.controls.hit(screen),'the equatorial limb should be pickable after rotating the ellipsoid')
  s.controls.dispose()
})
