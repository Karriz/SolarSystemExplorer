import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { fitTerrainShadow, configureTerrainShadowFade } from '../src/terrainShadows.ts'

const AU = 149_597_870_700
function view(altitude, tilt, aspect = 16 / 9) {
  const ground = new THREE.Vector3(0, 1737400 / AU, 0)
  const camera = new THREE.PerspectiveCamera(48, aspect, 10 / AU, 200)
  camera.position.copy(ground).add(new THREE.Vector3(0, altitude / AU, 0))
  camera.up.set(0, 0, -1)
  const angle = THREE.MathUtils.degToRad(tilt)
  camera.lookAt(camera.position.clone().add(new THREE.Vector3(0, -Math.cos(angle), Math.sin(angle))))
  const light = new THREE.DirectionalLight()
  light.shadow.mapSize.set(2048, 2048)
  const sunlight = new THREE.Vector3(1, .15, .3).normalize()
  const result = fitTerrainShadow(light, camera, ground, sunlight, altitude)
  light.updateMatrixWorld(); light.target.updateMatrixWorld(); light.shadow.updateMatrices(light)
  return { ground, camera, light, sunlight, ...result }
}

test('close shadow coverage includes wide and phone views through horizon tilt', () => {
  for (const altitude of [100, 1000, 12000, 45000]) for (const tilt of [0, 45, 75, 89.9, 90.1, 100]) for (const aspect of [16 / 9, 390 / 844]) {
    const { points, light } = view(altitude, tilt, aspect)
    for (const p of points) {
      const projected = p.clone().project(light.shadow.camera)
      assert.ok(Math.abs(projected.x) < .8 && Math.abs(projected.y) < .8, `${altitude} m, ${tilt} degrees: receiver outside padded coverage`)
      assert.ok(projected.z > -1 && projected.z < 1, 'receiver outside shadow depth range')
    }
  }
})

test('zooming to the clearance floor retains elevated and exaggerated shadow casters', () => {
  for (const altitude of [100, 1000, 12000]) {
    const { ground, light, sunlight } = view(altitude, 75)
    for (const height of [-40000, 40000]) {
      const caster = ground.clone().addScaledVector(sunlight, height / AU).project(light.shadow.camera)
      assert.ok(caster.z > -1 && caster.z < 1, 'terrain caster clipped when shadow footprint shrinks')
    }
    assert.ok(Math.abs(light.shadow.bias * (light.shadow.camera.far - light.shadow.camera.near) * AU + .25) < 1e-8)
  }
})

test('shadow target remains continuous when the view center crosses from ground to sky', () => {
  const before = view(100, 89.9), after = view(100, 90.1)
  assert.ok(before.light.target.position.distanceTo(after.light.target.position) * AU < 10)
  assert.ok(Math.abs(before.light.shadow.camera.right - after.light.shadow.camera.right) * AU < 10)
})

test('pitching up preserves coverage and sampling of shadows already visible on crater terrain', () => {
  const before = view(100, 45)
  // Receivers several km away were dropped by the old 1.5 km view fitting.
  const receivers = [new THREE.Vector3(8000, 0, 12000), new THREE.Vector3(-18000, -3000, 22000)]
    .map(p => p.divideScalar(AU).add(before.ground))
  for (const tilt of [60, 75, 85, 89.9, 90.1, 100]) {
    const after = view(100, tilt)
    assert.deepEqual(after.light.shadow.matrix.elements, before.light.shadow.matrix.elements,
      'rotation alone changed the shadow map')
    for (const point of receivers) {
      const uv = point.clone().applyMatrix4(after.light.shadow.matrix)
      assert.ok(uv.x > .08 && uv.x < .92 && uv.y > .08 && uv.y < .92 && uv.z > 0 && uv.z < 1,
        'previously visible crater shadow lost coverage')
    }
  }
})

test('grazing sunlight includes upstream casters beyond the former fixed depth margin', () => {
  const { ground, camera, light } = view(100, 85)
  const sunlight = new THREE.Vector3(1, .01, 0).normalize()
  fitTerrainShadow(light, camera, ground, sunlight, 100)
  light.updateMatrixWorld(); light.target.updateMatrixWorld(); light.shadow.updateMatrices(light)
  // This point remains inside the Moon's 4x relief envelope and projects onto
  // the receiver, but was clipped by the old 51.5 km light offset.
  const caster = ground.clone().addScaledVector(sunlight, 200000 / AU)
  assert.ok(caster.length() * AU < 1737400 + 40000)
  const uv = caster.applyMatrix4(light.shadow.matrix)
  assert.ok(uv.z > 0 && uv.z < 1, 'sunward crater rim clipped from shadow pass')
})

test('local shadow edge fade composes with material shaders and leaves point shadows intact', () => {
  const material = new THREE.MeshStandardMaterial()
  material.onBeforeCompile = shader => { shader.uniforms.existing = { value: 1 } }
  configureTerrainShadowFade(material)
  const shader = { uniforms: {}, vertexShader: '', fragmentShader: '#include <shadowmap_pars_fragment>' }
  material.onBeforeCompile(shader, {})
  assert.equal(shader.uniforms.existing.value, 1)
  assert.equal((shader.fragmentShader.match(/float terrainShadowFade/g) ?? []).length, 3)
  assert.doesNotMatch(shader.fragmentShader.slice(shader.fragmentShader.indexOf('float getPointShadow')), /terrainShadowFade/)
})
