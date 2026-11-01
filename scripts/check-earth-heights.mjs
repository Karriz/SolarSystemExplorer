import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import decodeWebp, { init } from '@jsquash/webp/decode.js'
import { mercatorAddress, tileKey } from '../src/terrainPilot.ts'

await init({ wasmBinary: await readFile(new URL('../node_modules/@jsquash/webp/codec/dec/webp_dec.wasm', import.meta.url)) })
const records=[]
for(const [name,lat,lon] of [['Helsinki coast',60.15,24.98],['Gulf of Finland',59.9,24.98],['Schermer polder',52.58,4.82]]) {
  const address=mercatorAddress(lon,lat,14),url=`https://tiles.mapterhorn.com/${tileKey(address)}.webp`
  const response=await fetch(url,{signal:AbortSignal.timeout(30000)})
  if(!response.ok)throw Error(`${url}: ${response.status}`)
  const bytes=await response.arrayBuffer(),image=await decodeWebp(bytes)
  const n=2**address.z,u=(lon+180)/360*n-address.x,v=(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*n-address.y
  const x=Math.min(511,Math.max(0,Math.floor(u*512))),y=Math.min(511,Math.max(0,Math.floor(v*512)))
  let min=Infinity,max=-Infinity,valid=0,zero=0
  const height=i=>image.data[i]*256+image.data[i+1]+image.data[i+2]/256-32768
  for(let i=0;i<image.data.length;i+=4)if(image.data[i+3]){const h=height(i);min=Math.min(min,h);max=Math.max(max,h);valid++;if(h===0)zero++}
  const record={name,lat,lon,url,sha256:createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),bytes:bytes.byteLength,
    pointHeightMeters:image.data[(y*512+x)*4+3]?height((y*512+x)*4):null,min,max,valid,zero}
  records.push(record);console.log(JSON.stringify(record))
}
await mkdir('.terrain-cache/pilot/continuity',{recursive:true})
await writeFile('.terrain-cache/pilot/continuity/source-heights.json',JSON.stringify({generatedAt:new Date().toISOString(),records},null,2)+'\n')
