import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  computePlanetshine,
  configurePlanetaryLighting,
  discOverlapVisibility,
  eclipseFactorAt,
  lambertPhase,
  planetaryLightingState,
  saturnRingOpticalDepthKm,
} from '../src/planetaryLighting.ts'
import { configureAtmosphericLighting } from '../src/atmosphericLighting.ts'
import { AtmosphereRenderer } from '../src/AtmosphereRenderer.ts'

test('analytic disc overlap handles clear sky, partial penumbra, total and annular eclipses', () => {
  assert.equal(discOverlapVisibility(0.00465, 0.0048, 0.02), 1)
  assert.equal(discOverlapVisibility(0.00465, 0.0048, 0), 0)
  // Annular eclipse when occluder angular radius is smaller than Sun
  const annular = discOverlapVisibility(0.005, 0.003, 0)
  assert.ok(Math.abs(annular - (1 - (0.003 / 0.005) ** 2)) < 1e-12)
  // Partial eclipse decreases monotonically as separation shrinks
  const p1 = discOverlapVisibility(0.005, 0.005, 0.008)
  const p2 = discOverlapVisibility(0.005, 0.005, 0.005)
  const p3 = discOverlapVisibility(0.005, 0.005, 0.002)
  assert.ok(p1 > p2 && p2 > p3 && p3 > 0 && p1 < 1)
})

test('eclipse evaluation captures lunar coppery umbra, oblate Jupiter shadow and Saturn ring gaps', () => {
  // 1. Earth eclipsing Moon: coppery red atmospheric umbra refraction
  const moonState = planetaryLightingState()
  moonState.plSunDir.value.set(1, 0, 0)
  moonState.plSunRadiusRad.value = 0.00465
  moonState.plOccluderCount.value = 1
  moonState.plOccluders.value[0].set(384400, 0, 0, 6371)
  moonState.plUmbraTint.value.set(0.065, 0.013, 0.003)
  const [ur, ug, ub] = eclipseFactorAt(new THREE.Vector3(0, 0, 0), moonState)
  assert.ok(ur > ug && ug > ub && ub > 0 && ur < 0.1, `expected coppery umbra, got ${ur},${ug},${ub}`)
  // Outside Earth's shadow cone
  const [cr, cg, cb] = eclipseFactorAt(new THREE.Vector3(0, 12000, 0), moonState)
  assert.deepEqual([cr, cg, cb], [1, 1, 1])

  // 2. Oblate Jupiter shadow is narrower along polar axis than equatorial axis
  const ioState = planetaryLightingState()
  ioState.plSunDir.value.set(1, 0, 0)
  ioState.plSunRadiusRad.value = 0.0009
  ioState.plOccluderCount.value = 1
  ioState.plOccluders.value[0].set(421700, 0, 0, 71492)
  ioState.plOblateAxis.value.set(0, 1, 0, 66854 / 71492)
  // At 69,000 km offset: eclipsed along equatorial Z, sunlit along polar Y
  const [eqR] = eclipseFactorAt(new THREE.Vector3(0, 0, 69000), ioState)
  const [polR] = eclipseFactorAt(new THREE.Vector3(0, 69000, 0), ioState)
  assert.ok(eqR < 0.05 && polR > 0.95, `expected oblate shadow difference, eq=${eqR}, pol=${polR}`)

  // 3. Saturn ring shadow on Enceladus attenuates through B ring and opens in Cassini Division
  const encState = planetaryLightingState()
  encState.plSunDir.value.set(Math.cos(0.4), Math.sin(0.4), 0).normalize()
  encState.plSunRadiusRad.value = 0.00049
  encState.plOccluderCount.value = 1
  encState.plOccluders.value[0].set(238037, 0, 0, 60268)
  encState.plRingAxis.value.set(0, 1, 0, 1)
  // Ray from point hits Saturn's ring plane (y = 0) at r = 105,000 km (B ring) vs r = 120,000 km (Cassini)
  const bRingPoint = new THREE.Vector3(238037, 0, 105000).addScaledVector(encState.plSunDir.value, -80000)
  const cassiniPoint = new THREE.Vector3(238037, 0, 120000).addScaledVector(encState.plSunDir.value, -80000)
  assert.equal(saturnRingOpticalDepthKm(105000), 1.5)
  assert.equal(saturnRingOpticalDepthKm(120000), 0)
  assert.ok(eclipseFactorAt(bRingPoint, encState)[0] < 0.1)
  assert.equal(eclipseFactorAt(cassiniPoint, encState)[0], 1)
})

test('planetshine obeys parent phase and scales monotonically from Earthshine to Saturnshine/Jupitershine', () => {
  assert.ok(Math.abs(lambertPhase(0) - 1) < 1e-12)
  assert.ok(Math.abs(lambertPhase(Math.PI)) < 1e-12)
  assert.ok(lambertPhase(Math.PI / 2) > 0.3 && lambertPhase(Math.PI / 2) < 0.35)

  // Moon between Earth and Sun -> Full Earthshine
  const earthFull = computePlanetshine('earth', new THREE.Vector3(-384400, 0, 0), new THREE.Vector3(1, 0, 0))
  // Moon behind Earth -> New Earth -> zero Earthshine
  const earthNew = computePlanetshine('earth', new THREE.Vector3(384400, 0, 0), new THREE.Vector3(1, 0, 0))
  const ioFull = computePlanetshine('jupiter', new THREE.Vector3(-421700, 0, 0), new THREE.Vector3(1, 0, 0))
  const encFull = computePlanetshine('saturn', new THREE.Vector3(-238037, 0, 0), new THREE.Vector3(1, 0, 0))

  assert.equal(earthNew.irradiance.length(), 0)
  assert.ok(earthFull.irradiance.length() > 0)
  assert.ok(ioFull.physicalRatio > earthFull.physicalRatio * 50)
  assert.ok(encFull.physicalRatio > ioFull.physicalRatio)
  assert.ok(encFull.irradiance.length() > ioFull.irradiance.length())
  assert.ok(ioFull.irradiance.length() > earthFull.irradiance.length())
})

test('planetary lighting shader hook composes both standalone and after atmospheric lighting', () => {
  const makeShader = () => ({
    uniforms: {},
    vertexShader: '#include <begin_vertex>\n',
    fragmentShader: '#include <lights_physical_fragment>\n#include <lights_fragment_begin>\n#include <lights_fragment_end>\n',
  })
  const state = planetaryLightingState()

  // Standalone solid body
  const m1 = new THREE.MeshStandardMaterial()
  configurePlanetaryLighting(m1, state, 'moon')
  const s1 = makeShader()
  m1.onBeforeCompile(s1, {})
  assert.ok(s1.fragmentShader.includes('plEclipseFactor(vPlanetaryPointKm)'))
  assert.ok(s1.fragmentShader.includes('plPlanetshineIrradiance(geometryNormal, vPlanetaryShineView)'))

  // Composed after atmospheric lighting
  const m2 = new THREE.MeshStandardMaterial()
  const air = new AtmosphereRenderer()
  configureAtmosphericLighting(m2, air.lighting, true)
  configurePlanetaryLighting(m2, state, 'earth')
  const s2 = makeShader()
  m2.onBeforeCompile(s2, {})
  assert.ok(s2.fragmentShader.includes('atmSunTransmission(atmSurfacePoint)'))
  assert.ok(s2.fragmentShader.includes('plEclipseFactor(vPlanetaryPointKm)'))
  assert.ok(s2.fragmentShader.includes('plPlanetshineIrradiance(geometryNormal, vPlanetaryShineView)'))
  air.dispose()
  m1.dispose()
  m2.dispose()
})
