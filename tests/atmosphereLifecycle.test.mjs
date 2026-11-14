import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { AtmosphereRenderer } from '../src/AtmosphereRenderer.ts'
import { venusAtmosphere } from '../src/atmosphereProfiles.ts'

test('atmosphere lazily fades in, preserves idle/failure fallback and releases late worker results', () => {
  const previousWorker=globalThis.Worker, previousPerformance=globalThis.performance
  const workers=[];let now=100
  globalThis.performance={now:()=>now}
  globalThis.Worker=class {
    constructor(){workers.push(this);this.terminated=false}
    postMessage(profile){this.profile=profile}
    terminate(){this.terminated=true}
  }
  try {
    const camera=new THREE.PerspectiveCamera(48,1,1e-8,200)
    camera.position.set(0,0,7000/149597870.7);camera.lookAt(0,0,0);camera.updateMatrixWorld()
    const body=new THREE.Object3D(),depth=new THREE.DepthTexture(1,1)
    const frame={body,sun:new THREE.Vector3(1,0,0),solarColor:new THREE.Color('white')}
    const tables={transWidth:1,transHeight:1,multiWidth:1,multiHeight:1,
      transmittance:new Float32Array([.9,.8,.7,1]),multiple:new Float32Array([.01,.02,.03,1]),irradiance:new Float32Array([.1,.2,.3,1])}
    const air=new AtmosphereRenderer()
    air.update(camera,null,frame);assert.equal(workers.length,0)
    air.update(camera,depth);assert.equal(workers.length,0)
    air.update(camera,depth,frame);assert.equal(workers.length,1);assert.equal(air.metrics().state,'loading')
    assert.equal(air.lighting.atmEnabled.value,0)
    now=200;workers[0].onmessage({data:tables})
    assert.equal(workers[0].terminated,true)
    air.update(camera,depth,frame);assert.equal(air.lighting.atmEnabled.value,0)
    now=700;air.update(camera,depth,frame);assert.equal(air.lighting.atmEnabled.value,.5)
    now=1200;air.update(camera,depth,frame);assert.equal(air.lighting.atmEnabled.value,1)
    const textures=[air.lighting.atmTransmittance.value,air.lighting.atmMultiple.value,air.lighting.atmIrradiance.value]
    // Duplicate delivery must not replace textures and leak the first set.
    workers[0].onmessage({data:tables});assert.equal(air.lighting.atmTransmittance.value,textures[0])
    let releases=0;textures.forEach(texture=>texture.addEventListener('dispose',()=>releases++))
    air.dispose();air.dispose();assert.equal(releases,3)
    workers[0].onmessage({data:tables});assert.equal(air.metrics().state,'disposed');assert.equal(air.lighting.atmTransmittance.value,null)
    const late=new AtmosphereRenderer();late.update(camera,depth,frame);const pending=workers[1]
    late.dispose();assert.equal(pending.terminated,true)
    pending.onmessage({data:tables});assert.equal(late.metrics().state,'disposed');assert.equal(late.lighting.atmTransmittance.value,null)
    const failed=new AtmosphereRenderer();failed.update(camera,depth,frame)
    workers[2].onerror({preventDefault(){}});assert.equal(failed.metrics().state,'failed');assert.equal(workers[2].terminated,true)
    workers[2].onmessage({data:tables});assert.equal(failed.metrics().state,'failed');assert.equal(failed.lighting.atmTransmittance.value,null)
    failed.dispose()
    const dense=new AtmosphereRenderer(venusAtmosphere);dense.update(camera,depth,frame)
    workers[3].onmessage({data:{...tables,validation:{accepted:false,maxEnergyError:.1}}})
    assert.equal(dense.metrics().state,'failed');assert.equal(dense.lighting.atmTransmittance.value,null)
    assert.equal(dense.metrics().cloudPlaceholder,true,'rejected dense tables must retain opaque loading clouds')
    dense.dispose()
    const moving=new AtmosphereRenderer(venusAtmosphere);moving.update(camera,depth,frame)
    workers[4].onmessage({data:{...tables,validation:{accepted:true}}})
    moving.update(camera,depth,{...frame,date:new Date(86400000)})
    assert.ok(Math.abs(moving.lighting.atmCloudPhase.value+venusAtmosphere.clouds.radiansPerDay)<1e-12,'westward advection must use inverse texture coordinates')
    moving.dispose();depth.dispose()
  } finally {globalThis.Worker=previousWorker;globalThis.performance=previousPerformance}
})
