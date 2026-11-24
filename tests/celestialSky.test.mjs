import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { BRIGHT_STARS } from '../src/brightStars.ts'
import {
  CelestialSky,
  J2000_OBLIQUITY_DEG,
  bvToLinearRgb,
  equatorialToScene,
  galacticBasisInScene,
  galacticToScene,
} from '../src/celestialSky.ts'
import { applySkyVisibility } from '../src/AtmosphereRenderer.ts'

const RAD_TO_DEG = 180 / Math.PI

test('J2000 equatorial coordinates align with the Solar System ecliptic frame and Earth pole', () => {
  const vernal = equatorialToScene(0, 0)
  assert.ok(vernal.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-12)

  const solstice = equatorialToScene(90, J2000_OBLIQUITY_DEG)
  assert.ok(solstice.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-12)

  const nep = equatorialToScene(270, 90 - J2000_OBLIQUITY_DEG)
  assert.ok(nep.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-12)

  // Polaris must sit within 0.8 degrees of Earth's North Celestial Pole.
  const ncp = equatorialToScene(0, 90)
  const polarisRecord = BRIGHT_STARS.find(([name]) => name === 'Polaris')
  assert.ok(polarisRecord)
  const polaris = equatorialToScene(polarisRecord[1], polarisRecord[2])
  const separationDeg = ncp.angleTo(polaris) * RAD_TO_DEG
  assert.ok(separationDeg > 0.5 && separationDeg < 0.85, `unexpected Polaris offset: ${separationDeg}°`)
})

test('IAU J2000 Galactic frame is orthonormal, tilted ~60.2 deg to the ecliptic, and points to Sagittarius A*', () => {
  const basis = galacticBasisInScene()
  assert.ok(Math.abs(basis.center.length() - 1) < 1e-12)
  assert.ok(Math.abs(basis.east.length() - 1) < 1e-12)
  assert.ok(Math.abs(basis.pole.length() - 1) < 1e-12)
  assert.ok(Math.abs(basis.center.dot(basis.east)) < 1e-12)
  assert.ok(Math.abs(basis.center.dot(basis.pole)) < 1e-12)
  assert.ok(Math.abs(basis.east.dot(basis.pole)) < 1e-12)
  assert.ok(Math.abs(basis.sceneToGalactic.determinant() - 1) < 1e-12)

  // Tilt between Galactic plane and Ecliptic plane is ~60.19 degrees.
  const planeTiltDeg = Math.acos(Math.abs(basis.pole.y)) * RAD_TO_DEG
  assert.ok(Math.abs(planeTiltDeg - 60.19) < 0.05, `unexpected Galactic inclination: ${planeTiltDeg}°`)

  // Galactic Center (l=0, b=0) aligns with Sagittarius A* (RA 266.4051 deg, Dec -28.936175 deg).
  const sgrA = equatorialToScene(266.4051, -28.936175)
  const gcErrorDeg = basis.center.angleTo(sgrA) * RAD_TO_DEG
  assert.ok(gcErrorDeg < 0.05, `Galactic Center offset ${gcErrorDeg}°`)

  // Deneb lies near Galactic longitude ~84 deg, low Galactic latitude; Acrux lies near l ~300 deg, b ~0 deg.
  const deneb = BRIGHT_STARS.find(([name]) => name === 'Deneb')
  const acrux = BRIGHT_STARS.find(([name]) => name === 'Acrux')
  assert.ok(deneb && acrux)
  const denebGal = equatorialToScene(deneb[1], deneb[2]).applyMatrix3(basis.sceneToGalactic)
  const acruxGal = equatorialToScene(acrux[1], acrux[2]).applyMatrix3(basis.sceneToGalactic)
  assert.ok(Math.abs(Math.asin(denebGal.z) * RAD_TO_DEG) < 4)
  assert.ok(Math.abs(Math.atan2(denebGal.y, denebGal.x) * RAD_TO_DEG - 84.3) < 1.5)
  assert.ok(Math.abs(Math.asin(acruxGal.z) * RAD_TO_DEG) < 2)
  assert.ok(Math.abs(((Math.atan2(acruxGal.y, acruxGal.x) * RAD_TO_DEG + 360) % 360) - 300.1) < 1.5)

  // Round-trip galacticToScene through sceneToGalactic.
  const lmc = galacticToScene(280.47, -32.89, basis)
  const back = lmc.clone().applyMatrix3(basis.sceneToGalactic)
  assert.ok(Math.abs(Math.asin(back.z) * RAD_TO_DEG - (-32.89)) < 1e-6)
})

test('starfield concentrates along the Milky Way, tints stars by B-V, and keeps depth/pipeline invariants', () => {
  const sky = new CelestialSky()
  const pos = sky.stars.geometry.getAttribute('position')
  assert.ok(pos.count > BRIGHT_STARS.length + 4000)

  let lowLat = 0
  let highLat = 0
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize().applyMatrix3(sky.basis.sceneToGalactic)
    const absLatDeg = Math.abs(Math.asin(THREE.MathUtils.clamp(v.z, -1, 1)) * RAD_TO_DEG)
    if (absLatDeg < 15) lowLat++
    else if (absLatDeg > 55) highLat++
  }
  const lowSteradian = Math.sin(15 * Math.PI / 180)
  const highSteradian = 1 - Math.sin(55 * Math.PI / 180)
  const lowDensity = lowLat / lowSteradian
  const highDensity = highLat / highSteradian
  assert.ok(lowDensity > highDensity * 2.5, `expected strong Galactic concentration (${lowDensity} vs ${highDensity})`)

  const hot = bvToLinearRgb(-0.22)
  const cool = bvToLinearRgb(1.85)
  assert.ok(hot[2] > hot[0], 'hot B-type star should be blue-white')
  assert.ok(cool[0] > cool[2], 'cool M-type star should be warm amber-red')

  // Verify unit sky directions and clip-space Milky Way camera projection.
  const firstStar = new THREE.Vector3().fromBufferAttribute(pos, 0)
  assert.ok(Math.abs(firstStar.length() - 1) < 1e-6, 'star directions should be unit vectors')

  const camera = new THREE.PerspectiveCamera(48, 16 / 9, 1e-8, 200)
  camera.position.set(1.2, 0.3, -0.7)
  camera.up.copy(sky.basis.pole)
  camera.lookAt(camera.position.clone().add(sky.basis.center))
  camera.updateMatrixWorld()
  sky.syncCamera(camera)
  const centerRayGalactic = new THREE.Vector3(0, 0, -1).applyMatrix3(sky.milkyWay.material.uniforms.uViewToGalactic.value)
  assert.ok(centerRayGalactic.distanceTo(new THREE.Vector3(1, 0, 0)) < 1e-6, 'center ray should hit Galactic Center')
  const tanHalfFov = sky.milkyWay.material.uniforms.uTanHalfFov.value
  assert.ok(Math.abs(tanHalfFov.y - Math.tan(24 * Math.PI / 180)) < 1e-6)
  assert.ok(Math.abs(tanHalfFov.x / tanHalfFov.y - 16 / 9) < 1e-6)

  // Pipeline & render ordering invariants.
  assert.equal(sky.milkyWay.material.depthWrite, false)
  assert.equal(sky.milkyWay.material.depthTest, false)
  assert.equal(sky.milkyWay.material.transparent, false)
  assert.equal(sky.stars.material.depthWrite, false)
  assert.equal(sky.stars.material.depthTest, true)
  assert.ok(sky.milkyWay.renderOrder < sky.stars.renderOrder && sky.stars.renderOrder < 0)
  assert.match(sky.milkyWay.material.vertexShader, /gl_Position\s*=\s*vec4\(position\.xy,\s*0\.0,\s*1\.0\)/)
  for (const material of [sky.milkyWay.material, sky.stars.material]) {
    assert.match(material.fragmentShader, /#include <tonemapping_fragment>/)
    assert.match(material.fragmentShader, /#include <colorspace_fragment>/)
    for (const src of [material.vertexShader, material.fragmentShader]) {
      for (const [, a, b] of src.matchAll(/smoothstep\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,/g)) {
        assert.ok(Number(a) < Number(b), `reversed GLSL smoothstep(${a}, ${b}, ...)`)
      }
    }
  }

  // Visibility updates and idempotent disposal.
  applySkyVisibility(sky, 0.25)
  assert.equal(sky.visibility, 0.25)
  applySkyVisibility(sky, -1)
  assert.equal(sky.visibility, 0)
  applySkyVisibility(sky, 2)
  assert.equal(sky.visibility, 1)

  let releases = 0
  for (const resource of [sky.milkyWay.geometry, sky.milkyWay.material, sky.stars.geometry, sky.stars.material]) {
    resource.addEventListener('dispose', () => releases++)
  }
  const parent = new THREE.Scene()
  parent.add(sky.group)
  sky.dispose()
  sky.dispose()
  assert.equal(releases, 4)
  assert.equal(sky.group.parent, null)
})
