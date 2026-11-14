import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PerspectiveCamera, Vector3 } from 'three'
import { atmosphereRaySegment, planetOccludesSun, raySphereInterval, reconstructViewPosition } from '../src/atmosphereMath.ts'

const earth = 6371, top = 6471
const near = (a, b, tolerance = 1e-7) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`)

test('body-relative ray intersections retain thin ground clearance and grazing limbs', () => {
  const down = new Vector3(0, -1, 0)
  const above = new Vector3(0, earth + .0001, 0)
  const hit = raySphereInterval(above, down, earth)
  near(hit[0], .0001, 1e-9)
  near(hit[1], 2 * earth + .0001)
  // An exact tangent, an almost tangent hit, and a miss from distant space.
  assert.deepEqual(raySphereInterval(new Vector3(-1e6, earth, 0), new Vector3(1, 0, 0), earth), [1e6, 1e6])
  assert.ok(raySphereInterval(new Vector3(-1e6, earth - .001, 0), new Vector3(1, 0, 0), earth))
  assert.equal(raySphereInterval(new Vector3(-1e6, earth + .001, 0), new Vector3(1, 0, 0), earth), null)
  assert.deepEqual(raySphereInterval(new Vector3(), down, earth), [-earth, earth])
  assert.deepEqual(raySphereInterval(new Vector3(earth, 0, 0), down, earth), [0, 0])
})

test('air segments clip to actual terrain depth above and below the reference sphere', () => {
  const origin = new Vector3(0, earth + 10, 0), down = new Vector3(0, -1, 0)
  assert.deepEqual(atmosphereRaySegment(origin, down, top, 6), [0, 6])
  assert.deepEqual(atmosphereRaySegment(origin, down, top, 12), [0, 12])
  assert.equal(atmosphereRaySegment(origin, down, top, 0), null)
  assert.equal(atmosphereRaySegment(new Vector3(0, top + 10, 0), down, top, 5), null)
  const segment = atmosphereRaySegment(new Vector3(0, top + 10, 0), down, top, 110)
  near(segment[0], 10); near(segment[1], 110)
  assert.equal(atmosphereRaySegment(new Vector3(0, top + 10, 0), new Vector3(0, 1, 0), top), null)
})

test('planet shadow distinguishes daylight, night and the visible Sun over the limb', () => {
  const point = new Vector3(0, earth + 1, 0)
  assert.equal(planetOccludesSun(point, new Vector3(0, 1, 0), earth), false)
  assert.equal(planetOccludesSun(point, new Vector3(0, -1, 0), earth), true)
  assert.equal(planetOccludesSun(point, new Vector3(1, 0, 0), earth), false)
  assert.equal(planetOccludesSun(new Vector3(0, earth, 0), new Vector3(0, 1, 0), earth), false)
})

test('depth reconstruction follows adaptive clipping, off-axis rays and AU-scale units', () => {
  for (const [nearPlane, far] of [[1e-11, 1e-5], [1e-6, 200], [.1, 1e4]]) {
    for (const aspect of [16 / 9, 390 / 844]) {
      const camera = new PerspectiveCamera(48, aspect, nearPlane, far)
      for (const distance of [nearPlane * 2, Math.sqrt(nearPlane * far), far / 2]) {
        const point = new Vector3(distance * .1, -distance * .2, -distance)
        const projected = point.clone().applyMatrix4(camera.projectionMatrix)
        const reconstructed = reconstructViewPosition((projected.x + 1) / 2, (projected.y + 1) / 2,
          (projected.z + 1) / 2, camera.projectionMatrixInverse)
        assert.ok(reconstructed.distanceTo(point) / point.length() < 1e-7,
          'depth reconstruction exceeded precision of an extreme far/near ratio')
      }
    }
  }
})
