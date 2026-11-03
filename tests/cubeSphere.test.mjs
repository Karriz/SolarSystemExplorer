import assert from 'node:assert/strict'
import {test} from 'node:test'
import * as THREE from 'three'
import {cubeAddress,cubeDirection,cubeFaceUv,cubeGrid,cubeKey,cubeRoots,cubeSphereGeometry,cubeTerrainGeometry,sampleCubeSurface} from '../src/cubeSphere.ts'
import {captureTerrainEdge} from '../src/terrainEdges.ts'
import {stitchCubeEdges} from '../src/cubeTerrainEdges.ts'
import {sphereSurfaceSampler} from '../src/terrainSurface.ts'
import {heightAddress,heightKey,PlanetHeightSource} from '../src/PlanetHeightSource.ts'
import {CubeTerrainLayer} from '../src/CubeTerrainLayer.ts'
import {surfaceState} from '../src/surfaceMaterial.ts'
const close=(a,b,epsilon=1e-7)=>assert.ok(Math.abs(a-b)<epsilon,`${a} != ${b}`)

test('six cube faces round-trip without polar singularities or reversed triangles',()=>{
  for(const a of cubeRoots()){
    const g=cubeTerrainGeometry(a,9,()=>({height:0}),1737400,1,false),p=g.getAttribute('position'),index=g.index
    for(const [u,v]of [[0,0],[-1,-1],[1,1],[-.36,.87]]){
      const d=cubeDirection(a.face,u,v),uv=cubeFaceUv(a.face,d)
      close(d.length(),1);close(uv.u,u);close(uv.v,v)
    }
    for(let i=0;i<index.count;i+=3){
      const x=new THREE.Vector3().fromBufferAttribute(p,index.getX(i)),y=new THREE.Vector3().fromBufferAttribute(p,index.getX(i+1)),z=new THREE.Vector3().fromBufferAttribute(p,index.getX(i+2))
      assert.ok(y.sub(x).cross(z.sub(x)).dot(x)>1e-6,'Degenerate or inward cube triangle')
    }
    g.dispose()
  }
  assert.equal(cubeAddress(new THREE.Vector3(0,1,0),8).face,2)
  assert.equal(cubeAddress(new THREE.Vector3(0,-1,0),8).face,3)
})

test('all cube face borders share the same physical vertices',()=>{
  const groups=new Map(),size=9
  for(const a of cubeRoots()){
    const dirs=cubeGrid(a,size)
    for(let r=0;r<size;r++)for(let c=0;c<size;c++)if(!r||!c||r===size-1||c===size-1){
      const v=Array.from(dirs.slice((r*size+c)*3,(r*size+c)*3+3)),key=v.map(x=>x.toFixed(12)).join('/')
      const all=groups.get(key)??[];all.push(v);groups.set(key,all)
    }
  }
  for(const all of groups.values())assert.ok(all.length>=2,'Unmatched face-border vertex')
})

test('cube picking matches rendered geometry including poles and face corners',()=>{
  const radius=.000011,geometry=cubeSphereGeometry(radius,17),sample=sphereSurfaceSampler(geometry),p=new THREE.Vector3(),n=new THREE.Vector3()
  const mesh=new THREE.Mesh(geometry,new THREE.MeshBasicMaterial());mesh.updateMatrixWorld()
  for(const [lat,lon]of [[90,0],[-90,135],[0,180],[0,45],[35.2643897,45],[26.13,3.63]]){
    assert.ok(sample(lat,lon,p,n))
    const d=new THREE.Vector3(Math.cos(lat*Math.PI/180)*Math.cos(lon*Math.PI/180),Math.sin(lat*Math.PI/180),-Math.cos(lat*Math.PI/180)*Math.sin(lon*Math.PI/180))
    const hit=new THREE.Raycaster(d.clone().multiplyScalar(radius*2),d.clone().negate()).intersectObject(mesh,false)[0]
    assert.ok(hit);close(p.length()*radius,hit.point.length(),1e-12);assert.ok(n.dot(d)>.98)
  }
  geometry.dispose()
})

test('cross-face mixed LOD stitching follows the coarser physical edge and its skirt',()=>{
  const addresses=[{face:0,z:0,x:0,y:0},{face:5,z:1,x:0,y:0},{face:5,z:1,x:0,y:1}],size=9
  const patches=addresses.map(address=>{
    const directions=cubeGrid(address,size),geometry=cubeTerrainGeometry(address,size,()=>({height:address.z?700:0}),1737400)
    return {key:cubeKey(address),address,directions,geometry,edge:captureTerrainEdge(geometry,size)}
  })
  stitchCubeEdges(patches)
  const coarse=patches[0],cp=coarse.geometry.getAttribute('position'),point=new THREE.Vector3(),normal=new THREE.Vector3()
  for(const patch of patches.slice(1)){
    const p=patch.geometry.getAttribute('position')
    // Face -Z's left edge is face +X's right edge.
    for(let row=0;row<size;row++){
      const id=row*size,d=new THREE.Vector3().fromBufferAttribute(p,id).normalize()
      assert.ok(sampleCubeSurface(coarse.geometry,coarse.address,size,d,point,normal))
      assert.ok(new THREE.Vector3().fromBufferAttribute(p,id).distanceTo(point)<2e-5)
      const at=patch.edge.indices.indexOf(id),bottom=patch.edge.skirtIndices[at]
      assert.ok(new THREE.Vector3().fromBufferAttribute(p,bottom).length()<new THREE.Vector3().fromBufferAttribute(p,id).length())
    }
  }
  assert.ok(cp.count>size*size)
  patches.forEach(p=>p.geometry.dispose())
})

const contracts={moon:{radius:1737400,scale:.5,frame:'MEAN EARTH/POLAR AXIS OF DE421'},mars:{radius:3389500,scale:1,frame:'IAU2000'},venus:{radius:6051000,scale:1,frame:'Magellan body-fixed'},mercury:{radius:2439400,scale:.5,frame:'MESSENGER MDIS body-fixed'}}
const fixture=(body='moon',maxZoom=1,sampleSize=65)=>{
  const tiles={};for(let z=0;z<=maxZoom;z++)for(let x=0;x<2**(z+1);x++)for(let y=0;y<2**z;y++)tiles[`${z}/${x}/${y}`]={min:100,max:200,error:500,bytes:2,sha256:'a'.repeat(64)}
  return {schema:body==='moon'?1:2,body,version:'cube-test',grid:'geographic-2x1',sampleSize,maxZoom,encoding:'gzip-int16-le',
    scaleMeters:contracts[body].scale,offsetMeters:0,referenceRadiusMeters:contracts[body].radius,frame:contracts[body].frame,longitude:'east-positive-minus180-to180',rowOrder:'north-to-south',
    minHeightMeters:100,maxHeightMeters:200,credit:body==='moon'?'LOLA':'MOLA',sourceUrl:'https://example.test',tileUrl:'tiles/{z}/{x}/{y}.bin',tiles,
    noData:-32768,indexPages:{rootZoom:3,pages:{}},sourceResolutionMeters:500,verticalDatum:'reference sphere'}
}
const installFetch=(t,body='moon',maxZoom=1,sampleSize=65)=>{
  const original=globalThis.fetch
  globalThis.fetch=async url=>({ok:true,json:async()=>String(url).endsWith('catalog.json')?{schema:1,bodies:{[body]:'manifest.json'}}:fixture(body,maxZoom,sampleSize),arrayBuffer:async()=>new ArrayBuffer(2)})
  t.after(()=>{globalThis.fetch=original})
}
const decoder=()=>({decode:async()=>new Float32Array(65*65).fill(150),dispose(){}})
const flush=()=>new Promise(resolve=>setImmediate(resolve))

test('numeric height source wraps longitude, interpolates meters, and clears its cache',async t=>{
  installFetch(t)
  const source=new PlanetHeightSource('https://example.test/',()=>{},decoder);t.after(()=>source.dispose())
  await flush()
  const a=heightAddress(30,0,1),wanted=new Map([[heightKey(a),a]])
  source.update(wanted,0);await flush();await flush()
  assert.ok(source.ready(wanted));close(source.sample(30,0,1),150)
  assert.deepEqual(heightAddress(0,180,8),heightAddress(0,-180,8))
  assert.deepEqual(heightAddress(90,170,8),heightAddress(90,-40,8))
  assert.ok(source.metrics().memoryBytes<=source.budget)
  source.clear();assert.equal(source.metrics().memoryBytes,0)
})

test('dense height cache makes room for geometry and metadata without losing wanted samples',async t=>{
  installFetch(t,'mars',3,129)
  const source=new PlanetHeightSource('https://example.test/',()=>{},()=>({
    decode:async(_buffer,size)=>new Float32Array(size*size).fill(150),dispose(){}
  }),'mars')
  t.after(()=>source.dispose());await flush()
  const wanted=new Map(Object.keys(source.manifest.tiles).map(key=>{
    const [z,x,y]=key.split('/').map(Number);return[key,{z,x,y}]
  }))
  source.update(wanted,0);await flush();await flush()
  assert.ok(source.ready(wanted));assert.ok(source.metrics().memoryBytes>8*1048576)
  const address=heightAddress(30,0,0),keep=new Map([[heightKey(address),address]])
  source.update(keep,1000,8*1048576)
  assert.equal(source.budget,8*1048576)
  assert.ok(source.metrics().memoryBytes<=source.budget)
  assert.ok(source.ready(keep));close(source.sample(30,0,0),150)
  assert.ok(source.metrics().cached<wanted.size)
})

for(const bodyId of ['moon','mars','mercury','venus'])test(`${bodyId} cube terrain loads six complete roots, remains stationary, and releases on departure`,async t=>{
  installFetch(t,bodyId)
  const body=new THREE.Mesh(cubeSphereGeometry(1),new THREE.MeshStandardMaterial()),statuses=[]
  const layer=new CubeTerrainLayer(body,s=>statuses.push(s),'https://example.test/',bodyId==='moon'?surfaceState():undefined,{value:1},bodyId)
  layer.source.dispose();layer.source=new PlanetHeightSource('https://example.test/',()=>{},decoder,bodyId)
  t.after(()=>layer.dispose());await flush()
  const camera=new THREE.PerspectiveCamera(48,1,.001,20);camera.position.set(3,0,0);camera.up.set(0,1,0);camera.lookAt(0,0,0);camera.updateMatrixWorld()
  for(let i=0;i<40;i++){layer.update(camera,600,i*150,true);await flush()}
  assert.ok(layer.active);assert.equal(layer.metrics().projection,'cube-sphere');assert.ok(layer.metrics().visible>=6)
  assert.ok(layer.metrics().triangles<=400000);assert.ok(layer.metrics().memoryBytes<=256*1048576)
  const wanted=[...layer.wanted].sort(),signature=layer.surfaceSignature()
  for(let i=40;i<55;i++){layer.update(camera,600,i*150,true);await flush();assert.deepEqual([...layer.wanted].sort(),wanted);assert.equal(layer.surfaceSignature(),signature)}
  const p=new THREE.Vector3(),n=new THREE.Vector3();assert.ok(layer.sampleSurface(0,0,p,n));close(p.length()*(bodyId==='mercury'?2439700:bodyId==='venus'?6051800:contracts[bodyId].radius)-contracts[bodyId].radius,150,1)
  assert.equal(statuses.at(-1).body,bodyId)
  assert.equal(layer.group.name,`${bodyId}-cube-terrain`)
  const node=[...layer.nodes.values()].find(n=>n.mesh)
  const shader={uniforms:{},vertexShader:THREE.ShaderLib.standard.vertexShader,fragmentShader:THREE.ShaderLib.standard.fragmentShader}
  node.mesh.material.onBeforeCompile(shader,{})
  assert.ok(shader.uniforms.terrainHillshadeEnabled)
  assert.equal(!!shader.uniforms.moonDetail,bodyId==='moon')
  if(bodyId==='mercury'||bodyId==='venus'){
    layer.setExaggeration(4)
    for(let i=0;i<40;i++){layer.update(camera,600,10000+i*150,true);await flush()}
    assert.ok(layer.sampleSurface(0,0,p,n))
    close(p.length()*(bodyId==='venus'?6051800:2439700)-contracts[bodyId].radius,600,1,'Datum offset must not be exaggerated')
  }
  layer.update(camera,600,20000,false);await flush()
  assert.equal(layer.active,false);assert.equal(layer.metrics().memoryBytes,0);assert.equal(body.material.visible,true)
})

test('cube terrain plans as if the camera were half the altitude away',async t=>{
  installFetch(t,'moon',8)
  const camera=new THREE.PerspectiveCamera(48,1,.001,100)
  camera.up.set(0,1,0)
  const maxWantedZ=layer=>[...layer.wanted].reduce((m,key)=>Math.max(m,Number(key.split('/')[1])),0)
  const planAt=async d=>{
    const body=new THREE.Mesh(cubeSphereGeometry(1),new THREE.MeshStandardMaterial())
    const layer=new CubeTerrainLayer(body,()=>{},'https://example.test/',surfaceState(),{value:1},'moon')
    layer.source.dispose();layer.source=new PlanetHeightSource('https://example.test/',()=>{},decoder,'moon')
    t.after(()=>layer.dispose());await flush();await flush();await flush()
    camera.position.set(d,0,0);camera.lookAt(0,0,0);camera.updateMatrixWorld()
    layer.update(camera,600,150,true);await flush()
    return maxWantedZ(layer)
  }
  // With the resolution-ahead lead, 10 radii already wants level 2 — the level
  // the plain distance only reaches near 5.5 radii — while 19 radii still
  // only wants level 1.
  assert.equal(await planAt(10),2)
  assert.equal(await planAt(19),1)
})
