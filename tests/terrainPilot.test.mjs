import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { earthViewRoots, geoDirection, mercatorAddress, mercatorBounds, parseRegionalManifest, sampleTerrarium, terrainBounds, tileKey } from '../src/terrainPilot.ts'
import { earthMeshSize, heightGrid, REGIONAL_TRIANGLE_BUDGET } from '../src/terrainLod.ts'
import { terrainGeometry } from '../src/terrain.ts'
import { decodeTerrain } from '../src/terrainDecode.ts'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { RegionalTerrainLayer } from '../src/RegionalTerrainLayer.ts'
import { captureTerrainEdge, stitchTerrainEdges } from '../src/terrainEdges.ts'
import { surfaceState } from '../src/surfaceMaterial.ts'

const close = (a,b,e=1e-6) => assert.ok(Math.abs(a-b)<e, `${a} != ${b}`)
const flush = async () => { for(let i=0;i<10;i++) await new Promise(r=>setImmediate(r)) }

test('native Mercator addresses cover the pilot locations, respect latitude limits, and share boundaries', () => {
  for(const [lon,lat] of [[25.15,60.25],[8.02,46.57],[14.58,-21.12],[-180,85],[180,-90]]) {
    const a=mercatorAddress(lon,lat,9), b=mercatorBounds(a)
    assert.ok(lon>=b.west && lon<=b.east)
    const limited=Math.max(-85.0511287,Math.min(85.0511287,lat))
    assert.ok(limited>=b.south-1e-6 && limited<=b.north+1e-6)
    close(b.east,mercatorBounds({...a,x:a.x+1}).west)
  }
})

test('Terrarium decoding preserves numerical channel values and resamples Mercator to geographic rows', () => {
  const pixels=new Uint8ClampedArray(512*512*4)
  for(let y=0;y<512;y++) for(let x=0;x<512;x++) {
    const h=-300+y*.5, encoded=(h+32768)*256, i=(y*512+x)*4
    pixels[i]=Math.floor(encoded/65536); pixels[i+1]=Math.floor(encoded/256)%256; pixels[i+2]=encoded%256; pixels[i+3]=255
  }
  const a=mercatorAddress(25.15,60.25,9), bounds=mercatorBounds(a)
  const gradients=new Float32Array(2*65*65)
  const heights=sampleTerrarium(pixels,512,512,bounds,a,65,gradients)
  close(heights[0],-300)
  close(heights[64*65],-44.5)
  const lat=(bounds.north+bounds.south)/2*Math.PI/180
  const nativeY=((1-Math.asinh(Math.tan(lat))/Math.PI)/2*2**a.z-a.y)*512-.5
  close(heights[32*65+32],-300+nativeY*.5,1e-4)
  const meters=2*Math.PI*6371000*Math.cos(lat)/(512*2**a.z)
  for(const i of [0,32*65+32,65*65-1]) close(gradients[i],0)
  close(gradients[65*65+32*65+32],-.5/meters,1e-8)
  assert.throws(()=>sampleTerrarium(pixels,256,512,bounds,a))
})

function manifest() {
  const root={z:6,x:65,y:22}, tiles={}
  const info={min:-100,max:200,error:3000,bytes:1000,sha256:'a'.repeat(64)}
  tiles[tileKey(root)]={...info}
  for(let x=130;x<132;x++) for(let y=44;y<46;y++) tiles[`7/${x}/${y}`]={...info}
  return {schema:1,id:'hadley',body:'moon',root,maxZoom:7,sampleSize:65,referenceRadiusMeters:1737400,
    scaleMeters:.5,offsetMeters:0,noData:-32768,minHeightMeters:-100,maxHeightMeters:200,sourceResolutionMeters:118,
    credit:'source',sourceUrl:'https://example.com',license:'source terms',frame:'MEAN EARTH/POLAR AXIS OF DE421',verticalDatum:'sphere',tiles}
}
test('bounded regional contracts reject holes, orphans, unrelated coverage, and unbounded manifests', () => {
  assert.equal(parseRegionalManifest(manifest()).id,'hadley')
  const hole=manifest(); delete hole.tiles['7/130/44']; assert.throws(()=>parseRegionalManifest(hole))
  const outside=manifest(); outside.tiles['7/0/0']={...outside.tiles['7/130/44']}; assert.throws(()=>parseRegionalManifest(outside))
  assert.throws(()=>parseRegionalManifest({...manifest(),maxZoom:40}))
  assert.throws(()=>parseRegionalManifest({...manifest(),referenceRadiusMeters:6371000}))
})

function setup(t,load,bodyId='moon') {
  const state=surfaceState(), body=new THREE.Mesh(new THREE.SphereGeometry(1),new THREE.MeshStandardMaterial())
  const layer=new RegionalTerrainLayer(body,bodyId,state), m=manifest()
  layer.addSource({id:'test',body:bodyId,root:m.root,maxZoom:7,minHeight:-100,maxHeight:200,resolution:118,
    credit:'test',url:'https://example.com',bounds:terrainBounds, info:a=>m.tiles[tileKey(a)],
    load:load??(async()=>({heights:new Float32Array(65*65).fill(100),transferBytes:1000,decodeMs:1}))})
  const bounds=terrainBounds(m.root), camera=new THREE.PerspectiveCamera(48,1,.0001,100)
  camera.position.copy(geoDirection((bounds.north+bounds.south)/2,(bounds.west+bounds.east)/2)).multiplyScalar(1.02)
  camera.lookAt(0,0,0)
  t.after(()=>layer.dispose())
  return {layer,state,body,camera}
}

test('regional roots clip fallback only after loading, children replace parents without overlap, and disable clears clips', async t => {
  const {layer,state,camera}=setup(t)
  layer.update(camera,900,performance.now(),true)
  assert.equal(state.clipCount.value,0)
  await flush()
  layer.update(camera,900,performance.now()+200,true)
  assert.equal(state.clipCount.value,1)
  await flush()
  layer.update(camera,900,performance.now()+400,true)
  assert.equal(layer.metrics().visible,4)
  assert.ok(layer.metrics().memoryBytes<=layer.budget)
  const ray=new THREE.Ray(camera.position.clone(),camera.position.clone().negate().normalize())
  assert.ok(layer.hitGround(ray))
  layer.setEnabled(false)
  assert.equal(state.clipCount.value,0)
  assert.equal(layer.hitGround(ray),null)
})

test('regional failure retains fallback and backs off; selection cancellation cannot attach stale geometry', async t => {
  let calls=0
  const {layer,state,camera}=setup(t,async()=>{calls++;throw Error('offline')})
  layer.update(camera,900,performance.now(),true); await flush()
  layer.update(camera,900,performance.now()+200,true); await flush()
  assert.equal(calls,1)
  assert.equal(state.clipCount.value,0)
  assert.equal(layer.metrics().failed,1)
  assert.equal(layer.metrics().memoryBytes,0)
  layer.dispose()
  let finish,signal
  const other=setup(t,(_address,s)=>{signal=s;return new Promise(r=>finish=r)})
  other.layer.update(other.camera,900,performance.now(),true)
  other.layer.update(other.camera,900,performance.now()+1,false)
  assert.ok(signal.aborted)
  finish({heights:new Float32Array(65*65),transferBytes:100,decodeMs:1})
  await flush()
  assert.equal(other.layer.metrics().cached,0)
  assert.equal(other.layer.metrics().memoryBytes,0)
  assert.equal(other.state.clipCount.value,0)
})

test('regional sampled gradients preserve shared-edge normals across adjacent patches and exaggeration', async t => {
  const gradients=new Float32Array(2*65*65)
  gradients.fill(.2,0,4225);gradients.fill(-.1,4225)
  const {layer,camera}=setup(t,async()=>({heights:new Float32Array(65*65).fill(100),gradients,transferBytes:100,decodeMs:1}))
  for(let i=0;i<4;i++){layer.update(camera,900,performance.now()+i*200,true);await flush()}
  const nodes=[...layer.nodes.values()].filter(n=>n.address.z===7 && n.mesh)
  const left=nodes.find(n=>n.address.x===130 && n.address.y===44), right=nodes.find(n=>n.address.x===131 && n.address.y===44)
  assert.ok(left && right)
  for(const ex of [1,4]) {
    layer.setExaggeration(ex)
    const a=left.mesh.geometry.attributes.normal,b=right.mesh.geometry.attributes.normal
    for(let row=0;row<65;row++)for(let axis=0;axis<3;axis++)close(a.array[(row*65+64)*3+axis],b.array[row*65*3+axis],1e-7)
  }
})

test('tile-local positions preserve sub-millimeter placement at close Earth scale', () => {
  const address=mercatorAddress(25.15,60.25,17), bounds=mercatorBounds(address)
  const origin=geoDirection((bounds.north+bounds.south)/2,(bounds.west+bounds.east)/2)
  const radius=6371000, heights=new Float32Array(65*65).fill(123.5)
  const geometry=terrainGeometry(bounds,heights,65,radius,radius,1,origin)
  for(const [r,c] of [[0,0],[32,32],[64,64],[1,63]]) {
    const actual=new THREE.Vector3().fromBufferAttribute(geometry.attributes.position,r*65+c).add(origin).multiplyScalar(radius)
    const expected=geoDirection(bounds.north+(bounds.south-bounds.north)*r/64,bounds.west+(bounds.east-bounds.west)*c/64).multiplyScalar(radius+123.5)
    assert.ok(actual.distanceTo(expected)<.001)
  }
  assert.equal(geometry.attributes.terrainSkirt.getX(0),0)
  assert.equal(geometry.attributes.terrainSkirt.getX(65*65),1)
  geometry.dispose()
})

test('worker decoding supports checksummed height-plus-gradient planes without changing legacy length checks', async () => {
  const raw=new Int16Array([100,-200,2000,-4000,6000,-8000,10000,-12000,14000,-16000,18000,-20000])
  const payload=gzipSync(raw), buffer=payload.buffer.slice(payload.byteOffset,payload.byteOffset+payload.byteLength)
  const hash=createHash('sha256').update(payload).digest('hex')
  const decoded=await decodeTerrain(buffer,2,hash,.5,-32768,3)
  assert.equal(decoded.length,12)
  assert.equal(decoded[0],50)
  assert.equal(decoded[4],3000)
  await assert.rejects(decodeTerrain(buffer,2,hash,.5,-32768))
})


function edgePatch(key, address, height, size=65) {
  const bounds=terrainBounds(address), origin=geoDirection((bounds.north+bounds.south)/2,(bounds.west+bounds.east)/2)
  const heights=Float32Array.from({length:size*size},(_,i)=>height+Math.floor(i/size)*640/(size-1))
  const geometry=terrainGeometry(bounds,heights,size,1737400,1737400,1,origin)
  return {key,level:address.z,bounds,origin,geometry,edge:captureTerrainEdge(geometry,size)}
}

test('fine borders follow the actual coarse 3D edge, eliminating protruding skirt wedges without smoothing interiors', () => {
  const coarse=edgePatch('coarse',{z:7,x:130,y:44},300), fine=edgePatch('fine',{z:8,x:262,y:88},3500)
  const original=Array.from(fine.geometry.attributes.position.array.slice(3*(32*65+32),3*(32*65+32)+3))
  stitchTerrainEdges([fine,coarse])
  const p=coarse.geometry.attributes.position, q=fine.geometry.attributes.position
  for(let r=0;r<65;r++) {
    const t=r/2, a=Math.floor(t)*65+64,b=Math.ceil(t)*65+64
    const expected=new THREE.Vector3().fromBufferAttribute(p,a).lerp(new THREE.Vector3().fromBufferAttribute(p,b),t%1).add(coarse.origin)
    const actual=new THREE.Vector3().fromBufferAttribute(q,r*65).add(fine.origin)
    assert.ok(actual.distanceTo(expected)*1737400<.005, `unwelded row ${r}`)
    const normal=new THREE.Vector3().fromBufferAttribute(fine.geometry.attributes.normal,r*65)
    close(normal.length(),1,1e-6)
  }
  assert.deepEqual(Array.from(q.array.slice(3*(32*65+32),3*(32*65+32)+3)),original)
  for(let i=0;i<fine.edge.indices.length;i++) {
    const top=new THREE.Vector3().fromBufferAttribute(q,fine.edge.indices[i]).add(fine.origin)
    const bottom=new THREE.Vector3().fromBufferAttribute(q,fine.edge.skirtIndices[i]).add(fine.origin)
    close((top.length()-bottom.length())*1737400,1500,.01)
  }
  stitchTerrainEdges([fine])
  for(let i=0;i<fine.edge.indices.length;i++)for(let axis=0;axis<3;axis++)assert.equal(q.array[fine.edge.indices[i]*3+axis],fine.edge.positions[i*3+axis])
  coarse.geometry.dispose();fine.geometry.dispose()
})

test('equal-level borders have deterministic positions and normals regardless of traversal order', () => {
  const a=edgePatch('a',{z:7,x:130,y:44},300), b=edgePatch('b',{z:7,x:131,y:44},1000)
  stitchTerrainEdges([b,a])
  const first=Array.from(b.geometry.attributes.position.array)
  stitchTerrainEdges([a,b])
  assert.deepEqual(Array.from(b.geometry.attributes.position.array),first)
  for(let r=0;r<65;r++) {
    const p=new THREE.Vector3().fromBufferAttribute(a.geometry.attributes.position,r*65+64).add(a.origin)
    const q=new THREE.Vector3().fromBufferAttribute(b.geometry.attributes.position,r*65).add(b.origin)
    assert.ok(p.distanceTo(q)*1737400<.005)
    for(let axis=0;axis<3;axis++)close(a.geometry.attributes.normal.array[(r*65+64)*3+axis],b.geometry.attributes.normal.array[r*65*3+axis],1e-7)
  }
  a.geometry.dispose();b.geometry.dispose()
})


test('Earth imagery and shadows preserve geometry-derived normals and measured heights', async t => {
  const {layer,state,camera}=setup(t,async()=>({heights:new Float32Array(65*65).fill(100),gradients:new Float32Array(2*65*65).fill(20),transferBytes:1000,decodeMs:1}),'earth')
  layer.update(camera,900,performance.now(),true);await flush()
  layer.update(camera,900,performance.now()+200,true)
  const mesh=[...layer.nodes.values()].find(n=>n.mesh?.visible).mesh
  assert.equal(mesh.castShadow,false);assert.equal(mesh.receiveShadow,true)
  assert.ok(mesh.customDepthMaterial)
  const normal=new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.normal,32*65+32)
  const radial=new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position,32*65+32).add(mesh.position).normalize()
  assert.ok(normal.dot(radial)>.999)
  camera.position.normalize().multiplyScalar(1.1)
  layer.update(camera,900,performance.now()+400,true)
  assert.equal(layer.metrics().ready,false);assert.equal(state.clipCount.value,0)
})


test('adaptive grids preserve additional close-range samples and cross-density borders stay welded',()=>{
  const dense=new Float32Array(129*129);dense[63*129+63]=20
  assert.equal(heightGrid(dense,129,129)[63*129+63],20)
  assert.equal(Math.max(...heightGrid(dense,129,65)),0)
  assert.equal(earthMeshSize(8),33);assert.equal(earthMeshSize(12),65);assert.equal(earthMeshSize(15),129)
  const a=edgePatch('a',{z:7,x:130,y:44},300,33),b=edgePatch('b',{z:8,x:262,y:88},1000,129)
  stitchTerrainEdges([b,a])
  for(let r=0;r<129;r++){
    const t=r/8,p=a.geometry.attributes.position,q=b.geometry.attributes.position
    const expected=new THREE.Vector3().fromBufferAttribute(p,Math.floor(t)*33+32).lerp(new THREE.Vector3().fromBufferAttribute(p,Math.ceil(t)*33+32),t%1).add(a.origin)
    const actual=new THREE.Vector3().fromBufferAttribute(q,r*129).add(b.origin)
    assert.ok(expected.distanceTo(actual)*1737400<.005)
  }
  a.geometry.dispose();b.geometry.dispose()
})

test('coarse grids own equal-level seams even when the dense tile sorts first by key', () => {
  const coarse = edgePatch('z-coarse', { z: 8, x: 260, y: 88 }, 300, 33)
  const fine = edgePatch('a-fine', { z: 8, x: 261, y: 88 }, 1000, 129)
  stitchTerrainEdges([fine, coarse])
  for (let r = 0; r < 129; r++) {
    const t = r / 4, p = coarse.geometry.attributes.position, q = fine.geometry.attributes.position
    const expected = new THREE.Vector3().fromBufferAttribute(p, Math.floor(t) * 33 + 32)
      .lerp(new THREE.Vector3().fromBufferAttribute(p, Math.ceil(t) * 33 + 32), t % 1).add(coarse.origin)
    const actual = new THREE.Vector3().fromBufferAttribute(q, r * 129).add(fine.origin)
    assert.ok(expected.distanceTo(actual) * 1737400 < .005, `unwelded mixed-grid row ${r}`)
  }
  coarse.geometry.dispose(); fine.geometry.dispose()
})

test('view-centered native roots wrap the date line and retain polar fallback',()=>{
  for(const [lon,lat]of [[25,60.38],[8.02,46.57],[179.99,0],[-179.99,0],[0,-80]]){
    const roots=earthViewRoots(lon,lat)
    assert.equal(roots.length,4);assert.equal(new Set(roots.map(tileKey)).size,4)
    assert.ok(roots.every(a=>a.x>=0&&a.x<256&&a.y>=0&&a.y<256&&a.z===8))
    assert.ok(roots.some(a=>{const b=mercatorBounds(a);return lon>=b.west&&lon<=b.east&&lat>=b.south&&lat<=b.north}))
  }
  assert.deepEqual(earthViewRoots(0,89),[])
})

test('dense Earth refinement remains within visible triangle and allocation budgets',async t=>{
  const body=new THREE.Mesh(new THREE.SphereGeometry(1),new THREE.MeshStandardMaterial()),state=surfaceState(),layer=new RegionalTerrainLayer(body,'earth',state)
  layer.imagery.dispose();layer.imagery=undefined // isolate terrain selection from remote color requests
  const root=mercatorAddress(25,60.38,13)
  layer.addSource({id:'dense',body:'earth',sampleSize:129,root,maxZoom:15,minHeight:0,maxHeight:200,resolution:2,credit:'test',url:'test',bounds:mercatorBounds,
    load:async()=>({heights:new Float32Array(129*129).fill(100),sampleSize:129,decodeMs:0,transferBytes:100})})
  t.after(()=>layer.dispose())
  const camera=new THREE.PerspectiveCamera(48,1,.000001,10);camera.position.copy(geoDirection(60.38,25)).multiplyScalar(1.00004);camera.lookAt(0,0,0)
  for(let i=0;i<18;i++){layer.update(camera,900,performance.now()+i*200,true);await flush()}
  const m=layer.metrics();assert.ok(m.ready);assert.ok(m.grids['129']>0);assert.ok(m.maxLevel>=14)
  assert.ok(m.triangles<=REGIONAL_TRIANGLE_BUDGET);assert.ok(m.memoryBytes<=layer.budget)
})

test('hidden parent geometry is rebuilt from cached heights without redownloading under pressure',async t=>{
  const body=new THREE.Mesh(new THREE.SphereGeometry(1),new THREE.MeshStandardMaterial()),layer=new RegionalTerrainLayer(body,'earth',surfaceState()),counts=new Map()
  layer.imagery.dispose();layer.imagery=undefined;layer.budget=20*1024*1024
  const root=mercatorAddress(25,60.38,13)
  layer.addSource({id:'pressure',body:'earth',sampleSize:129,root,maxZoom:15,minHeight:0,maxHeight:200,resolution:2,credit:'test',url:'test',bounds:mercatorBounds,
    load:async a=>{const k=tileKey(a);counts.set(k,(counts.get(k)??0)+1);return{heights:new Float32Array(129*129).fill(100),sampleSize:129,decodeMs:0,transferBytes:100}}})
  t.after(()=>layer.dispose())
  const camera=new THREE.PerspectiveCamera(48,1,.000001,10),dir=geoDirection(60.38,25)
  camera.position.copy(dir).multiplyScalar(1.00004);camera.lookAt(0,0,0)
  for(let i=0;i<30;i++){layer.update(camera,900,performance.now()+i*200,true);await flush()}
  assert.equal(layer.metrics().maxLevel,15);assert.ok(layer.metrics().cached>layer.metrics().residentMeshes)
  const wire=layer.metrics().transferBytes
  camera.position.copy(dir).multiplyScalar(1.02)
  layer.update(camera,10,performance.now()+7000,true);await flush()
  assert.ok(layer.metrics().ready);assert.ok(layer.metrics().memoryBytes<=layer.budget)
  assert.equal(layer.metrics().transferBytes,wire)
  assert.ok([...counts.values()].every(n=>n===1))
})

test('fallback clipping follows visible leaves when parent GPU geometry is evicted',async t=>{
  const {layer,state,camera}=setup(t)
  for(let i=0;i<4;i++){layer.update(camera,900,performance.now()+i*200,true);await flush()}
  const root=[...layer.nodes.values()].find(n=>n.address.z===6)
  assert.ok(root.mesh && !root.mesh.visible)
  // Reproduce pressure eviction while retaining parent metadata/heights.
  root.mesh.geometry.dispose();root.mesh.geometry=new THREE.BufferGeometry();root.edge=undefined
  const missing=[...layer.nodes.values()].find(n=>n.mesh?.visible)
  missing.mesh.geometry.dispose();missing.mesh.geometry=new THREE.BufferGeometry();missing.edge=undefined
  layer.ensureGeometry=()=>{} // simulate a deferred rebuild; this footprint needs fallback
  layer.update(camera,900,performance.now()+1000,true)
  const visible=[...layer.nodes.values()].filter(n=>n.mesh?.visible)
  assert.equal(visible.length,3)
  assert.equal(state.clipCount.value,visible.length)
  for(const n of visible){
    const b=n.source.bounds(n.address)
    assert.ok(state.clips.value.slice(0,state.clipCount.value).some(c=>c.x===b.west&&c.y===b.south&&c.z===b.east&&c.w===b.north))
  }
})

test('negative measured land elevations are retained rather than flattened as ocean',async t=>{
  const {layer,camera}=setup(t,async()=>({heights:new Float32Array(65*65).fill(-75),transferBytes:100,decodeMs:0}),'earth')
  layer.imagery.dispose();layer.imagery=undefined
  for(let i=0;i<3;i++){layer.update(camera,900,performance.now()+i*200,true);await flush()}
  const point=layer.hitGround(new THREE.Ray(camera.position.clone(),camera.position.clone().negate().normalize()))
  assert.ok(point)
  assert.ok(point.length()<1)
  close((point.length()-1)*6371000,-75,2)
})

test('camera clearance uses the displayed parent while a finer sibling set is incomplete',async t=>{
  const {layer,camera}=setup(t,async a=>{
    if(a.z===7 && a.x===131 && a.y===45)throw Error('missing child')
    return {heights:new Float32Array(65*65).fill(a.z===6?100:180),transferBytes:100,decodeMs:0}
  })
  for(let i=0;i<4;i++){layer.update(camera,900,performance.now()+i*200,true);await flush()}
  assert.equal(layer.metrics().visible,1)
  const b=terrainBounds({z:7,x:130,y:44})
  camera.position.copy(geoDirection((b.north+b.south)/2,(b.west+b.east)/2)).multiplyScalar(1.02)
  const displayed=layer.hitGround(new THREE.Ray(camera.position.clone(),camera.position.clone().negate().normalize()))
  const clearanceRadius=layer.cameraSurfaceRadius(camera.position)
  assert.ok(displayed);close(clearanceRadius,displayed.length(),1e-10)
})

test('an evicted child keeps its drawable parent until the complete replacement subtree is ready',async t=>{
  const {layer,camera,state}=setup(t)
  for(let i=0;i<4;i++){layer.update(camera,900,performance.now()+i*200,true);await flush()}
  const root=[...layer.nodes.values()].find(n=>n.address.z===6),child=[...layer.nodes.values()].find(n=>n.mesh?.visible)
  assert.ok(root.edge && child.edge)
  child.mesh.geometry.dispose();child.mesh.geometry=new THREE.BufferGeometry();child.edge=undefined
  layer.ensureGeometry=()=>{} // hold the missing child unavailable for one frame
  layer.update(camera,900,performance.now()+1000,true)
  assert.equal(layer.metrics().visible,1);assert.equal(root.mesh.visible,true);assert.equal(state.clipCount.value,1)
})

test('exposed regional borders match fallback geometry without moving measured interiors or internal joins',async()=>{
  const {referenceSphereSurface}=await import('../src/terrainSurface.ts')
  const bounds={west:0,east:2,north:2,south:0,span:2},rightBounds={...bounds,west:2,east:4}
  const radius=1737400,size=65,make=(key,b)=>{
    const origin=geoDirection((b.north+b.south)/2,(b.west+b.east)/2)
    const geometry=terrainGeometry(b,new Float32Array(size*size).fill(200),size,radius,radius,1,origin)
    return {key,level:6,bounds:b,origin,geometry,edge:captureTerrainEdge(geometry,size)}
  }
  const left=make('left',bounds),right=make('right',rightBounds)
  const interior=Array.from(left.geometry.getAttribute('position').array.slice((32*65+32)*3,(32*65+32)*3+3))
  stitchTerrainEdges([left,right],referenceSphereSurface)
  const p=new THREE.Vector3()
  for(const patch of [left,right])for(let r=1;r<64;r++){
    const outer=r*65+(patch===left?0:64),inner=r*65+(patch===left?64:0)
    p.fromBufferAttribute(patch.geometry.getAttribute('position'),outer).add(patch.origin)
    close(p.length(),1,1e-8)
    p.fromBufferAttribute(patch.geometry.getAttribute('position'),inner).add(patch.origin)
    close((p.length()-1)*radius,200,.01)
  }
  // The common top/bottom corners also border fallback; leaving those at the
  // measured height creates isolated corner spikes despite welded edge middles.
  for (const patch of [left,right]) for (const i of [0,64,64*65,65*65-1]) {
    p.fromBufferAttribute(patch.geometry.getAttribute('position'),i).add(patch.origin)
    close(p.length(),1,1e-8)
  }
  assert.deepEqual(Array.from(left.geometry.getAttribute('position').array.slice((32*65+32)*3,(32*65+32)*3+3)),interior)
  for(const patch of [left,right])patch.geometry.dispose()
})

test('fallback refinement refreshes regional borders even when the regional tile selection is unchanged',async t=>{
  const {referenceSphereSurface}=await import('../src/terrainSurface.ts')
  const {layer,camera}=setup(t)
  let height=10,version=0
  layer.setFallbackSurface((lat,lon,p,n)=>{referenceSphereSurface(lat,lon,p,n);p.multiplyScalar(1+height/1737400);return true},()=>String(version))
  for(let i=0;i<4;i++){layer.update(camera,900,performance.now()+i*200,true);await flush()}
  const node=[...layer.nodes.values()].find(n=>n.mesh?.visible&&n.address.x===130&&n.address.y===44)
  const point=new THREE.Vector3(),index=32*65
  const radius=()=>point.fromBufferAttribute(node.mesh.geometry.getAttribute('position'),index).add(node.origin).length()
  close((radius()-1)*1737400,10,.01)
  height=50;version++
  layer.update(camera,900,performance.now()+1200,true)
  close((radius()-1)*1737400,50,.01)
})
