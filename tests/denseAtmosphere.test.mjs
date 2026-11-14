import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Vector3 } from 'three'
import { solveDenseColumn } from '../src/denseAtmosphere.ts'
import { marsAtmosphere as mars, venusAtmosphere as venus } from '../src/atmosphereProfiles.ts'
import { buildAtmosphereTables, integrateAtmosphere, mediumAt, sampleTable, transmissionToSpace, multiUv } from '../src/atmosphereOptics.ts'

test('dense columns recover pure absorption and conserve a conservative reflecting slab', () => {
  const absorption=solveDenseColumn(Array.from({length:96},()=>({tau:4/96,albedo:0})),.5,0)
  assert.ok(Math.abs(absorption.transmitted/.5-Math.exp(-8))<1e-12)
  assert.equal(absorption.reflected,0);assert.ok(absorption.energyError<1e-12)
  const conservative=solveDenseColumn(Array.from({length:96},()=>({tau:4/96,albedo:1})),.5,1)
  assert.ok(Math.abs(conservative.reflected/.5-1)<2e-6)
  assert.equal(conservative.transmitted,0);assert.equal(conservative.absorbed,0)
})

test('discrete ordinates match an independent Monte Carlo photon random walk', () => {
  let seed=4721
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (seed+.5)/4294967296}
  const photons=60000, tau=4, omega=.95, ground=.1, mu=.5, result=[0,0,0]
  for(let photon=0;photon<photons;photon++){
    let z=0,direction=mu
    for(;;){
      const step=-Math.log(random()),boundary=direction>0?(tau-z)/direction:-z/direction
      if(step>=boundary){
        if(direction<0){result[0]++;break}
        if(random()>=ground){result[1]++;break}
        z=tau;direction=-Math.sqrt(random());continue
      }
      z+=step*direction
      if(random()>=omega){result[2]++;break}
      direction=random()*2-1
    }
  }
  const column=solveDenseColumn(Array.from({length:96},()=>({tau:tau/96,albedo:omega})),mu,ground)
  for(const [i,flux] of [column.reflected,column.transmitted,column.absorbed].entries()){
    assert.ok(Math.abs(flux/mu-result[i]/photons)<.012,`${flux/mu} != ${result[i]/photons}`)
  }
  assert.ok(column.energyError<1e-6)
})

test('Mars dust yields warm daylight and a blue forward-scattered sunset halo', () => {
  const p=new Vector3(0,mars.radiusKm+.1,0)
  const day=integrateAtmosphere(mars,p,new Vector3(0,1,0),new Vector3(1,1,0).normalize(),Infinity,256)
  const sunset=integrateAtmosphere(mars,p,new Vector3(1,.005,0).normalize(),new Vector3(1,0,0),Infinity,256)
  assert.ok(day.radiance[0]>day.radiance[2]*2)
  assert.ok(sunset.radiance[2]>sunset.radiance[0]*2)
})

test('Venus cloud density is finite, continuous, thick and not an infinitely thin shell', () => {
  assert.equal(mediumAt(venus,47).cloudDensity,0);assert.equal(mediumAt(venus,71).cloudDensity,0)
  assert.equal(mediumAt(venus,55).cloudDensity,1)
  assert.ok(mediumAt(venus,49).cloudDensity>0 && mediumAt(venus,49).cloudDensity<1)
  const transmission=transmissionToSpace(venus,venus.radiusKm,1,2048)
  assert.ok(transmission.every(v=>v<.0002),'ground must not show through the orbital cloud column')
})

test('Venus diffuse field converges, conserves flux and produces diffuse warm ground light', () => {
  const t=buildAtmosphereTables(venus)
  assert.equal(t.validation.accepted,true)
  assert.ok(t.validation.maxEnergyError<.00001)
  assert.ok(t.validation.maxResidual<2e-6)
  for(const data of [t.multiple,t.irradiance]) assert.ok(data.every(v=>Number.isFinite(v)&&v>=0))
  const irradiance=sampleTable(t.irradiance,t.multiWidth,t.multiHeight,...multiUv(venus,venus.radiusKm,.7))
  const direct=transmissionToSpace(venus,venus.radiusKm,.7,2048)
  assert.ok(irradiance[0]>direct[0]*100,'surface illumination should be overwhelmingly diffuse')
  assert.ok(irradiance[0]>irradiance[2],'lower atmosphere should preferentially transmit warm light')
})
