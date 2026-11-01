import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EarthImagery, earthColorAddress, earthColorUrl, earthColorUvs, earthColorTransform } from '../src/earthImagery.ts'
import { mercatorBounds, mercatorAddress } from '../src/terrainPilot.ts'
const flush=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setImmediate(r))}
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`)

test('hosted RGB uses the verified WMTS row/column contract and caps imagery independently of elevation',()=>{
  const a=earthColorAddress({z:15,x:18659,y:9446})
  assert.deepEqual(a,{z:14,x:9329,y:4723})
  const url=new URL(earthColorUrl(a))
  assert.equal(url.protocol,'https:');assert.equal(url.searchParams.get('SERVICE'),'WMTS')
  assert.equal(url.searchParams.get('TILECOL'),'9329');assert.equal(url.searchParams.get('TILEROW'),'4723')
  assert.equal(url.searchParams.get('TILEMATRIXSET'),'EPSG:3857')
  assert.equal(url.searchParams.get('LAYER'),'esa-worldcover-s2rgbnir-10m-2021-v2_tcc')
})

test('terrain color maps Mercator edges correctly, retains a parent, and releases bitmap/GPU allocations',async t=>{
  const oldFetch=globalThis.fetch,oldBitmap=globalThis.createImageBitmap;let closed=0
  globalThis.fetch=async()=>({ok:true,blob:async()=>new Blob([new Uint8Array(20)])})
  globalThis.createImageBitmap=async()=>({width:256,height:256,close(){closed++}})
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.createImageBitmap=oldBitmap})
  const layer=new EarthImagery(),a={z:14,x:9329,y:4723};t.after(()=>layer.dispose())
  layer.update([a],performance.now());await flush()
  assert.ok(layer.metrics().ready);assert.ok(layer.metrics().memoryBytes<=layer.budget)
  const texture=layer.texture(a),b=mercatorBounds(a)
  const v=lat=>.5+Math.asinh(Math.tan(lat*Math.PI/180))/(2*Math.PI)
  close((b.west+180)/360*texture.repeat.x+texture.offset.x,0)
  close((b.east+180)/360*texture.repeat.x+texture.offset.x,1)
  close(v(b.north)*texture.repeat.y+texture.offset.y,1)
  close(v(b.south)*texture.repeat.y+texture.offset.y,0)
  assert.equal(layer.texture({z:15,x:18658,y:9446}),texture)
  layer.clear();assert.equal(layer.metrics().memoryBytes,0);assert.equal(layer.metrics().cached,0);assert.ok(closed>=2)
})

test('RGB failure backs off and late decoding after cancellation cannot attach a texture',async t=>{
  const oldFetch=globalThis.fetch,oldBitmap=globalThis.createImageBitmap;let calls=0,complete,closed=0
  t.after(()=>{globalThis.fetch=oldFetch;globalThis.createImageBitmap=oldBitmap})
  globalThis.fetch=async()=>{calls++;throw Error('source unavailable')}
  const layer=new EarthImagery(),a={z:8,x:145,y:73};layer.update([a],performance.now());await flush()
  assert.equal(layer.texture(a),undefined);assert.ok(layer.metrics().failed>0)
  layer.update([a],performance.now()+100);await flush();assert.equal(calls,1);layer.dispose()
  globalThis.fetch=async()=>({ok:true,blob:async()=>new Blob([])})
  globalThis.createImageBitmap=()=>new Promise(resolve=>{complete=resolve})
  const late=new EarthImagery();late.update([a],performance.now());await flush();late.dispose()
  complete({width:256,height:256,close(){closed++}});await flush()
  assert.equal(late.metrics().cached,0);assert.equal(late.metrics().memoryBytes,0);assert.equal(closed,1)
})

test('local image UVs preserve fine tile boundaries, interior projection, and parent fallback',async()=>{
  const THREE=await import('three')
  for(const [lon,lat] of [[24.6,60.38],[8.02,46.57],[14.58,-21.12],[179.99,85],[-179.99,-85]])for(const z of [8,14,15]){
    const a=mercatorAddress(lon,lat,z),bounds=mercatorBounds(a),size=65,uv=earthColorUvs(bounds,size,a)
    assert.equal(uv.count,size*size+4*size-4)
    for(let i=0;i<size;i++){
      close(uv.getX(i*size),0);close(uv.getX(i*size+size-1),1)
      close(uv.getY(i),1);close(uv.getY((size-1)*size+i),0)
    }
    // A parent image must show the proper subrectangle, including reversed Y.
    const p={z:z-2,x:Math.floor(a.x/4),y:Math.floor(a.y/4)},texture=new THREE.Texture()
    texture.repeat.set(2**p.z,2**p.z);texture.offset.set(-p.x,-(2**p.z-p.y-1))
    const transform=earthColorTransform(a,texture)
    close(transform.x,.25);close(transform.y,.25)
    close(transform.z,(a.x%4)/4);close(transform.w,(3-a.y%4)/4)
    for(let i=0;i<size*size;i++){
      const r=Math.floor(i/size),c=i%size,lat=bounds.north+(bounds.south-bounds.north)*r/(size-1)
      const lon=bounds.west+(bounds.east-bounds.west)*c/(size-1)
      close(uv.getX(i)*transform.x+transform.z,(lon+180)/360*2**p.z-p.x)
      close(uv.getY(i)*transform.y+transform.w,(.5+Math.asinh(Math.tan(lat*Math.PI/180))/(2*Math.PI))*2**p.z-(2**p.z-p.y-1))
    }
    texture.dispose()
  }
})
