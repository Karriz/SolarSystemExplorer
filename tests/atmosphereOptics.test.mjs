import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Vector3 } from 'three'
import { earthAtmosphere as profile } from '../src/atmosphereProfiles.ts'
import { buildAtmosphereTables, transmissionToSpace, transmissionUv, transmissionParameters, sampleTable,
  sunTransmission, phaseRayleigh, phaseAerosol, integrateAtmosphere, multiUv } from '../src/atmosphereOptics.ts'

const tables = buildAtmosphereTables(profile)
const lookup = (r, mu) => sampleTable(tables.transmittance, tables.transWidth, tables.transHeight, ...transmissionUv(profile, r, mu))
const multiple = (r, mu) => sampleTable(tables.multiple, tables.multiWidth, tables.multiHeight, ...multiUv(profile, r, mu))

test('vertical transmission agrees with independently integrated exponential and triangular columns', () => {
  const actual = transmissionToSpace(profile, profile.radiusKm, 1, 2048)
  const r = profile.rayleighScaleKm * (1 - Math.exp(-profile.heightKm / profile.rayleighScaleKm))
  const m = profile.aerosolScaleKm * (1 - Math.exp(-profile.heightKm / profile.aerosolScaleKm))
  const expected = profile.rayleigh.map((v, c) => Math.exp(-v*r - (profile.aerosolScattering[c]+profile.aerosolAbsorption[c])*m - profile.ozoneAbsorption[c]*profile.ozoneWidthKm))
  actual.forEach((v, c) => assert.ok(Math.abs(v - expected[c]) < 2e-6))
})

test('molecular and aerosol phase functions conserve scattered energy', () => {
  for (const phase of [phaseRayleigh, mu => phaseAerosol(mu, profile.aerosolG)]) {
    let integral = 0
    const samples = 16384
    for (let i = 0; i < samples; i++) integral += phase(-1 + 2*(i+.5)/samples)*4*Math.PI/samples
    assert.ok(Math.abs(integral - 1) < 1e-5)
  }
})

test('limb-concentrated table coordinates round trip and preserve numerical transmission', () => {
  for (const altitude of [.001, 1, 10, 40, 80]) for (const mu of [0, .02, .2, 1]) {
    const r = profile.radiusKm + altitude, uv = transmissionUv(profile, r, mu)
    const [r2, mu2] = transmissionParameters(profile, ...uv)
    assert.ok(Math.abs(r-r2)<1e-8); assert.ok(Math.abs(mu-mu2)<1e-8)
    const expected = transmissionToSpace(profile, r, mu, 1024), actual = lookup(r, mu)
    actual.forEach((v,c) => assert.ok(Math.abs(v-expected[c]) < .006, `${altitude}km mu=${mu}: ${v} != ${expected[c]}`))
  }
})

test('finite Sun gives red grazing transmission, continuous horizon and a shadowed night side', () => {
  const p = new Vector3(0, profile.radiusKm + .1, 0)
  const sun = angle => new Vector3(Math.cos(angle), Math.sin(angle), 0)
  const low = sunTransmission(profile, p, sun(.005), lookup), noon = sunTransmission(profile, p, sun(Math.PI/2), lookup)
  assert.ok(low[0] > low[1] && low[1] > low[2]); assert.ok(noon[2] > low[2])
  assert.deepEqual(sunTransmission(profile, p, sun(-Math.PI/2), lookup), [0,0,0])
  let last = 0
  for (let i=0;i<=100;i++) {
    const value = sunTransmission(profile, p, sun(-.02+i*.0004), lookup)[0]
    assert.ok(value>=0 && value<=1 && Math.abs(value-last)<.03); last=value
  }
})

test('accelerated single scattering matches high-sample numerical reference from ground to space', () => {
  const sun = new Vector3(1,.1,0).normalize()
  for (const [h, direction, endpoint] of [
    [.1,new Vector3(0,1,0),Infinity], [1,new Vector3(1,.01,0).normalize(),Infinity],
    [10,new Vector3(0,-1,0),8], [1000,new Vector3(0,-1,0),999],
  ]) {
    const origin = new Vector3(0,profile.radiusKm+h,0)
    const expected = integrateAtmosphere(profile,origin,direction,sun,endpoint,384)
    const fast = integrateAtmosphere(profile,origin,direction,sun,endpoint,48,lookup)
    fast.radiance.forEach((v,c)=>assert.ok(Math.abs(v-expected.radiance[c]) < .00015+expected.radiance[c]*.06))
    fast.transmission.forEach((v,c)=>assert.ok(Math.abs(v-expected.transmission[c]) < .01))
  }
})

test('higher-order approximation is finite, increases sky radiance and preserves terrain endpoints', () => {
  for (const data of [tables.multiple,tables.irradiance]) assert.ok(data.every(v=>Number.isFinite(v)&&v>=0))
  const origin = new Vector3(0,profile.radiusKm+.1,0), direction = new Vector3(0,1,0), sun = new Vector3(1,.2,0).normalize()
  const single = integrateAtmosphere(profile,origin,direction,sun,Infinity,96,lookup)
  const total = integrateAtmosphere(profile,origin,direction,sun,Infinity,96,lookup,multiple)
  total.radiance.forEach((v,c)=>assert.ok(v>single.radiance[c]))
  assert.deepEqual(total.transmission,single.transmission)
  assert.deepEqual(integrateAtmosphere(profile,origin,direction,sun,0,48,lookup,multiple).radiance,[0,0,0])
})
