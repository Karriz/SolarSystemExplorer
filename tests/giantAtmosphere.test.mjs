import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { giantPlanetProfiles, giantBoundaryRadius, AU_KM } from '../src/giantPlanetProfiles.ts'
import { rayEllipsoidInterval } from '../src/atmosphereMath.ts'
import { GiantPlanetRenderer } from '../src/GiantPlanetRenderer.ts'
import { SolarRenderer } from '../src/SolarRenderer.ts'
import { orientationAt } from '../src/orientation.ts'

test('giant boundary and ray picking agree at poles, equator and intermediate latitudes', () => {
  for (const p of Object.values(giantPlanetProfiles)) {
    const axes = new THREE.Vector3(p.equatorialKm,p.polarKm,p.equatorialKm).divideScalar(AU_KM)
    for (let lat=-90;lat<=90;lat+=5) {
      const direction = new THREE.Vector3(Math.cos(lat*Math.PI/180),Math.sin(lat*Math.PI/180),0)
      const boundary=giantBoundaryRadius(p,direction,0)
      const radius=giantBoundaryRadius(p,direction)
      assert.ok(radius>boundary && (radius-boundary)*AU_KM<21)
      const origin=direction.clone().multiplyScalar(.01)
      const interval=rayEllipsoidInterval(origin,direction.clone().negate(),axes)
      assert.ok(interval && Math.abs(.01-interval[0]-boundary)<1e-14)
      const point=origin.clone().addScaledVector(direction,-interval[0]).divide(axes)
      assert.ok(Math.abs(point.length()-1)<1e-10)
    }
    const tangent=rayEllipsoidInterval(new THREE.Vector3(axes.x,0,axes.z*2),new THREE.Vector3(0,0,-1),axes)
    assert.ok(tangent && Math.abs(tangent[0]-axes.z*2)<axes.z*2e-8)
    assert.equal(rayEllipsoidInterval(new THREE.Vector3(axes.x*1.001,0,axes.z*2),new THREE.Vector3(0,0,-1),axes),null)
  }
})

test('giant atmosphere resources are bounded, cull when offscreen and dispose once', () => {
  for (const id of Object.keys(giantPlanetProfiles)) {
    const body = new THREE.Mesh(new THREE.SphereGeometry(1),new THREE.MeshBasicMaterial())
    let oldReleases=0;body.geometry.addEventListener('dispose',()=>oldReleases++);body.material.addEventListener('dispose',()=>oldReleases++)
    const giant=new GiantPlanetRenderer(id,body),r=giantPlanetProfiles[id].equatorialKm/AU_KM
    assert.equal(oldReleases,2)
    let releases=0;giant.proxy.geometry.addEventListener('dispose',()=>releases++);giant.proxy.material.addEventListener('dispose',()=>releases++)
    const camera=new THREE.PerspectiveCamera(48,1,r*.001,100)
    camera.position.set(0,0,r*4);camera.lookAt(0,0,0)
    giant.update(camera,new Date('2026-11-15'),new THREE.Vector3(1,1,1))
    assert.equal(giant.metrics().active,true);assert.equal(giant.metrics().textureBytes,0)
    camera.lookAt(0,0,10);giant.update(camera,new Date(),new THREE.Vector3(1,1,1));assert.equal(giant.metrics().active,false)
    giant.dispose();giant.dispose();assert.equal(releases,2);assert.equal(giant.proxy.parent,null)
    giant.update(camera,new Date(),new THREE.Vector3(1,1,1));assert.equal(giant.metrics().active,false)
    body.geometry.dispose();body.material.dispose()
  }
})

test('solar rotation and depth fallback preserve a separately owned photosphere', () => {
  const date=new Date('2000-01-01T12:00:00Z'),first=orientationAt('sun',date),next=orientationAt('sun',new Date(date.getTime()+86400000))
  assert.ok(Math.abs(next.w-first.w-14.1844)<1e-8)
  const body=new THREE.Mesh(new THREE.SphereGeometry(.00465),new THREE.MeshBasicMaterial())
  const solar=new SolarRenderer(body),camera=new THREE.PerspectiveCamera(48,1,1e-8,200)
  camera.position.set(0,0,.02);camera.lookAt(0,0,0)
  solar.update(camera,null);assert.equal(solar.metrics().active,false)
  const depth=new THREE.DepthTexture(1,1)
  solar.update(camera,depth);assert.equal(solar.metrics().active,true)
  const viewport=new THREE.Vector2(1000,750)
  solar.update(camera,depth,viewport);assert.equal(solar.metrics().glareStrength,0,'close-up photosphere should have no screen glare')
  camera.position.set(0,0,1);camera.lookAt(0,0,0)
  solar.update(camera,depth,viewport);assert.ok(solar.metrics().glareStrength>.9,'planet-distance Sun should retain glare')
  camera.lookAt(0,0,2);solar.update(camera,depth,viewport);assert.equal(solar.metrics().glareStrength,0,'Sun behind the camera must not flare')
  camera.lookAt(1,0,0);solar.update(camera,depth,viewport);assert.equal(solar.metrics().glareStrength,0,'offscreen Sun must not flare')
  solar.update(camera,null,viewport);assert.equal(solar.metrics().glareStrength,0)
  let releases=0;body.material.addEventListener('dispose',()=>releases++)
  solar.dispose();solar.dispose();assert.equal(solar.metrics().disposed,true);assert.equal(releases,0)
  body.material.dispose();body.geometry.dispose();depth.dispose();assert.equal(releases,1)
})
