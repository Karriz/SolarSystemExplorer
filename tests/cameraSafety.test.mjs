import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Vector3 } from 'three'
import { constrainCamera } from '../src/cameraSafety.ts'

const globe = [{ center: new Vector3(), radius: 1 }]
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)

test('stops zooming at surface clearance and preserves viewing direction', () => {
  const position = new Vector3(0, 0, .8)
  const target = new Vector3()
  const direction = target.clone().sub(position)
  constrainCamera(position, target, new Vector3(0, 0, 3), globe)
  close(position.z, 1.05)
  close(target.clone().sub(position).distanceTo(direction), 0)
})

test('prevents a large pan from tunneling through a body', () => {
  const position = new Vector3(3, .2, 0)
  constrainCamera(position, new Vector3(), new Vector3(-3, .2, 0), globe)
  assert.ok(position.x < 0)
  close(position.length(), 1.05)
})

test('permits orbiting along the clearance boundary', () => {
  const position = new Vector3(Math.sin(.1), 0, Math.cos(.1)).multiplyScalar(1.05)
  const expected = position.clone()
  constrainCamera(position, new Vector3(), new Vector3(0, 0, 1.05), globe)
  close(position.distanceTo(expected), 0)
})

test('recovers from a focus change placing the camera at a body center', () => {
  const position = new Vector3()
  constrainCamera(position, new Vector3(), null, globe)
  close(position.length(), 1.05)
})

test('checks other bodies independently of the selected orbit target', () => {
  const position = new Vector3(4, 0, 0)
  const surfaces = [...globe, { center: new Vector3(4, 0, 0), radius: .1 }]
  constrainCamera(position, new Vector3(), null, surfaces)
  close(position.distanceTo(surfaces[1].center), .105)
})

test('near clipping adapts to small bodies in AU and stays capped in overview', () => {
  for (const radius of [1.16e-5, 4.26e-5, .00465]) {
    const surfaces = [{ center: new Vector3(), radius }]
    const position = new Vector3(0, 0, radius * 1.05)
    const near = constrainCamera(position, new Vector3(), null, surfaces)
    assert.ok(near > 0 && near < position.length() - radius)
  }
  close(constrainCamera(new Vector3(0, 0, 20), new Vector3(), null, globe), 1)
})
