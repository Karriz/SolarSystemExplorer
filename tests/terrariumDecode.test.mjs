import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import decodeWebp, { init } from '@jsquash/webp/decode.js'
import { decodeTerrariumTile } from '../src/terrariumDecode.ts'
import { mercatorBounds, sampleTerrarium } from '../src/terrainPilot.ts'

const root=new URL('./fixtures/mapterhorn/',import.meta.url)
const reference=JSON.parse(await readFile(new URL('reference.json',root),'utf8'))
const wasm=await readFile(new URL('../node_modules/@jsquash/webp/codec/dec/webp_dec.wasm',import.meta.url))
await init({wasmBinary:wasm})
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const buffer=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)

test('real Finnish and Alpine WebP bytes match independent GDAL pixels without canvas or bitmap APIs',async()=>{
  const previousCanvas=globalThis.OffscreenCanvas,previousBitmap=globalThis.createImageBitmap
  globalThis.OffscreenCanvas=class {constructor(){throw Error('Terrain must not use canvas')}}
  globalThis.createImageBitmap=()=>{throw Error('Terrain must not use bitmap readback')}
  try {
    for(const f of reference){
      const bytes=await readFile(new URL(f.file,root));assert.equal(sha(bytes),f.sha256)
      const image=await decodeWebp(buffer(bytes))
      assert.equal(image.width,512);assert.equal(image.height,512)
      assert.equal(sha(image.data),f.rgbaSha256)
      const heights=await decodeTerrariumTile(buffer(bytes),f.address)
      assert.equal(heights.length,65*65)
      assert.ok(heights.every(h=>Number.isFinite(h)&&h>=f.min&&h<=f.max))
      assert.deepEqual(heights,await decodeTerrariumTile(buffer(bytes),f.address))
    }
  }finally{globalThis.OffscreenCanvas=previousCanvas;globalThis.createImageBitmap=previousBitmap}
})

test('one-bit canvas noise reproduces an isolated large height spike in a real Finnish tile',async()=>{
  const f=reference.find(f=>f.name==='finland'),bytes=await readFile(new URL(f.file,root))
  const image=await decodeWebp(buffer(bytes)),noisy=new Uint8ClampedArray(image.data)
  const b=mercatorBounds(f.address),lat=(b.north+b.south)/2*Math.PI/180
  const y=Math.floor(((1-Math.asinh(Math.tan(lat))/Math.PI)/2*2**f.address.z-f.address.y)*512-.5)
  const i=(y*512+255)*4
  noisy[i]^=1 // The red-channel LSB encodes 256 meters, not a subtle color change.
  const original=await decodeTerrariumTile(buffer(bytes),f.address)
  const perturbed=sampleTerrarium(noisy,512,512,b,f.address)
  const deltas=perturbed.map((h,i)=>Math.abs(h-original[i]))
  assert.ok(Math.max(...deltas)>32)
  assert.equal(deltas.filter(d=>d>0).length,1)
  assert.deepEqual(await decodeTerrariumTile(buffer(bytes),f.address),original)
})
