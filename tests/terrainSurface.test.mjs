import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as THREE from 'three'
import {terrainSurfaceSampler} from '../src/terrainSurface.ts'
import {terrainGeometry} from '../src/terrain.ts'
import {geoDirection} from '../src/terrainPilot.ts'

test('bounded fallback sampling matches rendered triangle intersections rather than bilinear heights',()=>{
  const bounds={west:2,east:5,north:29,south:25,span:4},heights=Float32Array.from({length:65*65},(_,i)=>500*Math.sin(i/13))
  const geometry=terrainGeometry(bounds,heights,65,1737400,1737400,1)
  const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial()),sample=terrainSurfaceSampler(),point=new THREE.Vector3(),normal=new THREE.Vector3()
  for(const [lat,lon] of [[26.1,3.14],[28.125,4.999],[25.0001,2.0001]]){
    const direction=geoDirection(lat,lon),ray=new THREE.Raycaster(direction.clone().multiplyScalar(2),direction.clone().negate())
    const hit=ray.intersectObject(mesh,false).find(h=>h.face.a<65*65&&h.face.b<65*65&&h.face.c<65*65)
    assert.ok(hit);assert.ok(sample(geometry,bounds,65,lat,lon,point,normal))
    assert.ok(point.distanceTo(hit.point)<1e-10);assert.ok(Math.abs(normal.length()-1)<1e-10)
  }
  assert.equal(sample(geometry,bounds,65,0,100,point,normal),false)
  geometry.dispose();mesh.material.dispose()
})

test('picking ignores artificial coverage-edge skirt walls and retains physical surface hits',async()=>{
  const {firstTerrainSurfaceHit}=await import('../src/terrainSurface.ts')
  const radius=1737400,bounds={west:0,east:.1,north:.1,south:0,span:.1}
  const geometry=terrainGeometry(bounds,new Float32Array(65*65).fill(200),65,radius,radius,1)
  const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({side:THREE.DoubleSide}))
  const origin=geoDirection(.05,-.05).multiplyScalar(1+100/radius)
  const throughSkirt=new THREE.Raycaster(origin,new THREE.Vector3(0,0,-1))
  assert.ok(throughSkirt.intersectObject(mesh).length>0)
  assert.equal(firstTerrainSurfaceHit(throughSkirt,[mesh]),undefined)
  const normal=geoDirection(.05,.05),down=new THREE.Raycaster(normal.clone().multiplyScalar(2),normal.clone().negate())
  assert.ok(firstTerrainSurfaceHit(down,[mesh]))
  geometry.dispose();mesh.material.dispose()
})

test('unavailable global terrain uses the actual faceted fallback globe in normalized units',async()=>{
  const {sphereSurfaceSampler}=await import('../src/terrainSurface.ts')
  const geometry=new THREE.SphereGeometry(.003,128,96),sample=sphereSurfaceSampler(geometry),point=new THREE.Vector3(),normal=new THREE.Vector3()
  const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial())
  for(const [lat,lon] of [[25.576171875,2.8125],[60.38,25],[-84.99,-179.99]]){
    const direction=geoDirection(lat,lon),hit=new THREE.Raycaster(direction.clone().multiplyScalar(.006),direction.clone().negate()).intersectObject(mesh)[0]
    assert.ok(hit);assert.ok(sample(lat,lon,point,normal))
    assert.ok(point.distanceTo(hit.point.clone().divideScalar(.003))<1e-10)
  }
  geometry.dispose();mesh.material.dispose()
})
