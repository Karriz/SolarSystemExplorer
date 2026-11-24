import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import * as THREE from 'three'
import { bodyOrder, enceladusOffset, titanOffset, ioOffset, europaOffset, ganymedeOffset, callistoOffset, parentOf, planetOrder, positionAt, satelliteOrder, satellitePeriods } from '../src/ephemeris.ts'
import { orientationAt } from '../src/orientation.ts'
import { configurePlanetSurfaceMaterial, TITAN_DETAIL_PROFILE } from '../src/planetSurfaceMaterial.ts'
import { surfaceState } from '../src/surfaceMaterial.ts'
import { configureLiquidSurfaceMaterial, liquidMaterialState } from '../src/liquidSurfaceMaterial.ts'
import { planetRenderProfiles } from '../src/planetRenderProfiles.ts'

test('satellite registry separates moons from heliocentric planets and preserves parents', () => {
  assert.ok(bodyOrder.includes('enceladus'))
  assert.deepEqual(satelliteOrder, ['moon', 'io', 'europa', 'ganymede', 'callisto', 'enceladus', 'titan'])
  assert.equal(parentOf('enceladus'), 'saturn')
  assert.equal(parentOf('titan'), 'saturn')
  assert.equal(parentOf('io'), 'jupiter')
  assert.equal(parentOf('europa'), 'jupiter')
  assert.equal(parentOf('ganymede'), 'jupiter')
  assert.equal(parentOf('callisto'), 'jupiter')
  assert.ok(!planetOrder.includes('europa'))
  assert.ok(!planetOrder.includes('ganymede'))
  assert.ok(!planetOrder.includes('callisto'))
  assert.ok(!planetOrder.includes('titan'))
  assert.equal(parentOf('moon'), 'earth')
  assert.equal(parentOf('saturn'), 'sun')
  assert.ok(!planetOrder.includes('enceladus') && !planetOrder.includes('moon'))
  assert.ok(!planetOrder.includes('io'))
})

test('Io follows Jupiter and stays within its documented approximate JPL orbit envelope', () => {
  const reference = JSON.parse(readFileSync(new URL('./fixtures/io/orbit-reference.json', import.meta.url)))
  for (const sample of reference.samples) {
    const date = new Date(sample.date), p = ioOffset(date), tilt = 23.43928 * Math.PI / 180
    const parent = positionAt('jupiter', date), moon = positionAt('io', date)
    assert.ok(Math.abs(Math.hypot(moon.x-parent.x, moon.y-parent.y, moon.z-parent.z)*149597870.7-421700) < .001)
    const equatorial = [p.x, -Math.sin(tilt)*p.y-Math.cos(tilt)*p.z, Math.cos(tilt)*p.y-Math.sin(tilt)*p.z].map(v => v*149597870.7)
    assert.ok(Math.hypot(...equatorial.map((v, i) => v-sample.positionJ2000EquatorialKm[i])) < 3500)
    const orientation = orientationAt('io', date)
    assert.ok([orientation.ra, orientation.dec, orientation.w].every(Number.isFinite))
  }
})

test('Europa follows Jupiter and stays within its documented approximate JPL orbit envelope', () => {
  const reference = JSON.parse(readFileSync(new URL('./fixtures/europa/orbit-reference.json', import.meta.url)))
  for (const sample of reference.samples) {
    const date = new Date(sample.date), p = europaOffset(date), tilt = 23.43928 * Math.PI / 180
    const parent = positionAt('jupiter', date), moon = positionAt('europa', date)
    assert.ok(Math.abs(Math.hypot(moon.x-parent.x, moon.y-parent.y, moon.z-parent.z)*149597870.7-671100) < .001)
    const equatorial = [p.x, -Math.sin(tilt)*p.y-Math.cos(tilt)*p.z, Math.cos(tilt)*p.y-Math.sin(tilt)*p.z].map(v => v*149597870.7)
    assert.ok(Math.hypot(...equatorial.map((v, i) => v-sample.positionJ2000EquatorialKm[i])) < 11000)
    const orientation = orientationAt('europa', date)
    assert.ok([orientation.ra, orientation.dec, orientation.w].every(Number.isFinite))
  }
})

test('Ganymede follows Jupiter and stays within its documented approximate JPL orbit envelope', () => {
  const reference = JSON.parse(readFileSync(new URL('./fixtures/ganymede/orbit-reference.json', import.meta.url)))
  for (const sample of reference.samples) {
    const date = new Date(sample.date), p = ganymedeOffset(date), tilt = 23.43928 * Math.PI / 180
    const parent = positionAt('jupiter', date), moon = positionAt('ganymede', date)
    assert.ok(Math.abs(Math.hypot(moon.x-parent.x, moon.y-parent.y, moon.z-parent.z)*149597870.7-1070400) < .001)
    const equatorial = [p.x, -Math.sin(tilt)*p.y-Math.cos(tilt)*p.z, Math.cos(tilt)*p.y-Math.sin(tilt)*p.z].map(v => v*149597870.7)
    assert.ok(Math.hypot(...equatorial.map((v, i) => v-sample.positionJ2000EquatorialKm[i])) < 6500)
    const orientation = orientationAt('ganymede', date)
    assert.ok([orientation.ra, orientation.dec, orientation.w].every(Number.isFinite))
  }
})

test('Callisto follows Jupiter and stays within its documented approximate JPL orbit envelope', () => {
  const reference = JSON.parse(readFileSync(new URL('./fixtures/callisto/orbit-reference.json', import.meta.url)))
  for (const sample of reference.samples) {
    const date = new Date(sample.date), p = callistoOffset(date), tilt = 23.43928 * Math.PI / 180
    const parent = positionAt('jupiter', date), moon = positionAt('callisto', date)
    assert.ok(Math.abs(Math.hypot(moon.x-parent.x, moon.y-parent.y, moon.z-parent.z)*149597870.7-1882700) < .001)
    const equatorial = [p.x, -Math.sin(tilt)*p.y-Math.cos(tilt)*p.z, Math.cos(tilt)*p.y-Math.sin(tilt)*p.z].map(v => v*149597870.7)
    assert.ok(Math.hypot(...equatorial.map((v, i) => v-sample.positionJ2000EquatorialKm[i])) < 45000)
    const orientation = orientationAt('callisto', date)
    assert.ok([orientation.ra, orientation.dec, orientation.w].every(Number.isFinite))
  }
})

test('Enceladus follows Saturn across the supported date range with a continuous mean orbit', () => {
  for (const iso of ['1900-01-01T12:00:00Z', '2000-01-01T12:00:00Z', '2026-11-15T12:00:00Z', '2049-12-31T12:00:00Z']) {
    const date = new Date(iso), parent = positionAt('saturn', date), moon = positionAt('enceladus', date)
    assert.ok(Math.abs(Math.hypot(moon.x-parent.x, moon.y-parent.y, moon.z-parent.z) * 149597870.7 - 238037) < .001)
    const offset = enceladusOffset(date), angle = orientationAt('enceladus', date)
    assert.ok([angle.ra, angle.dec, angle.w].every(Number.isFinite))
    const next = enceladusOffset(new Date(+date + satellitePeriods.enceladus * 86400000))
    assert.ok(Math.hypot(offset.x-next.x, offset.y-next.y, offset.z-next.z) * 149597870.7 < .1)
    const opposite = enceladusOffset(new Date(+date + satellitePeriods.enceladus * 86400000 / 2))
    assert.ok(Math.hypot(offset.x+opposite.x, offset.y+opposite.y, offset.z+opposite.z) * 149597870.7 < .1)
  }
})

test('approximate Enceladus orbit remains within its documented JPL reference envelope', () => {
  const reference = JSON.parse(readFileSync(new URL('./fixtures/enceladus/orbit-reference.json', import.meta.url)))
  for (const sample of reference.samples) {
    const p = enceladusOffset(new Date(sample.date)), tilt = 23.43928 * Math.PI / 180
    const equatorial = [p.x, -Math.sin(tilt) * p.y - Math.cos(tilt) * p.z,
      Math.cos(tilt) * p.y - Math.sin(tilt) * p.z].map(x => x * 149597870.7)
    const error = Math.hypot(...equatorial.map((x, i) => x - sample.positionJ2000EquatorialKm[i]))
    assert.ok(error < 5500, `${sample.date}: visual orbit error ${error} km`)
  }
})

test('Titan follows Saturn and stays within its documented approximate JPL orbit envelope', () => {
  const reference = JSON.parse(readFileSync(new URL('./fixtures/titan/orbit-reference.json', import.meta.url)))
  for (const sample of reference.samples) {
    const date = new Date(sample.date), p = titanOffset(date), tilt = 23.43928 * Math.PI / 180
    const parent = positionAt('saturn', date), moon = positionAt('titan', date)
    assert.ok(Math.abs(Math.hypot(moon.x-parent.x, moon.y-parent.y, moon.z-parent.z)*149597870.7-1221870) < .001)
    const equatorial = [p.x, -Math.sin(tilt)*p.y-Math.cos(tilt)*p.z, Math.cos(tilt)*p.y-Math.sin(tilt)*p.z].map(v => v*149597870.7)
    assert.ok(Math.hypot(...equatorial.map((v, i) => v-sample.positionJ2000EquatorialKm[i])) < 90000)
    const orientation = orientationAt('titan', date)
    assert.ok([orientation.ra, orientation.dec, orientation.w].every(Number.isFinite))
  }
})

test('Titan liquid hydrocarbon sea shader binds mask, ripples and low specular roughness', () => {
  const material = new THREE.MeshStandardMaterial()
  const surface = surfaceState()
  const liquid = liquidMaterialState()
  configurePlanetSurfaceMaterial(material, surface, 2575000, true, undefined, undefined, TITAN_DETAIL_PROFILE)
  configureLiquidSurfaceMaterial(material, liquid, planetRenderProfiles.titan.liquid)
  const shader = {
    uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
  }
  material.onBeforeCompile(shader, {})
  assert.equal(shader.uniforms.liquidMask, liquid.mask)
  assert.equal(shader.uniforms.liquidReady, liquid.ready)
  assert.equal(shader.uniforms.liquidTime, liquid.time)
  assert.ok(shader.vertexShader.includes('vLiquidDistance'))
  assert.ok(shader.fragmentShader.includes('textureGrad(liquidMask, liqUv, liqDx, liqDy)'))
  assert.ok(shader.fragmentShader.includes('roughnessFactor = mix(roughnessFactor, 0.14, liq)'))
  assert.ok(material.customProgramCacheKey().includes('/liquid-sea-v1/0.14/0.014'))
})
