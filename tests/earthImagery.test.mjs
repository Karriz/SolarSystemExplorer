import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EarthImagery, earthColorAddress, earthColorUrl } from '../src/earthImagery.ts'
import { mercatorBounds } from '../src/terrainPilot.ts'
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
