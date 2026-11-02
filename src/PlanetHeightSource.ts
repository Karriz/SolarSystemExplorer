import { TerrainDecoder } from './TerrainDecoder.ts'
import { parseTerrainManifest, parseTerrainPage, type TerrainManifest, type TerrainTileInfo, type TerrainBody } from './terrain.ts'
import type { TileAddress } from './surfaceTiles.ts'

type Decoder=Pick<TerrainDecoder,'decode'|'dispose'>
type Tile={address:TileAddress; heights?:Float32Array; request?:AbortController; retryAt:number; lastUsed:number}
type Page={keys:string[]; request?:AbortController; retryAt:number; bytes:number; lastUsed:number}
export const heightKey=(a:TileAddress)=>`${a.z}/${a.x}/${a.y}`
export function heightAddress(lat:number,lon:number,z:number):TileAddress{
  const n=2**z,longitude=Math.abs(lat)===90?0:((lon+180)%360+360)%360-180
  return {z,x:Math.min(2*n-1,Math.max(0,Math.floor((longitude+180)/180*n))),
    y:Math.min(n-1,Math.max(0,Math.floor((90-lat)/180*n)))}
}

/** Numeric geographic tiles, independent of the rendering projection. Cube
 * meshes keep their heights after data eviction; caches never select LOD. */
export class PlanetHeightSource {
  manifest?:TerrainManifest
  failedManifest=false
  private byteBudget=64*1024*1024
  get budget(){return this.byteBudget}
  private manifestUrl=''
  private controller=new AbortController()
  private disposed=false
  private tiles=new Map<string,Tile>()
  private pages=new Map<string,Page>()
  private wanted=new Map<string,TileAddress>()
  private requests=0
  private pageRequests=0
  private bytes=0
  private decoder?:Decoder
  private baseUrl:string
  private changed:()=>void
  private createDecoder:()=>Decoder
  private bodyId:TerrainBody
  constructor(baseUrl:string,changed:()=>void=()=>{},createDecoder:()=>Decoder=()=>new TerrainDecoder(),bodyId:TerrainBody='moon'){
    this.bodyId=bodyId;this.baseUrl=baseUrl;this.changed=changed;this.createDecoder=createDecoder
    void this.loadManifest()
  }
  private async loadManifest(){
    const timeout=setTimeout(()=>this.controller.abort(),15000)
    try{
      const catalog=await fetch(new URL('catalog.json',this.baseUrl),{signal:this.controller.signal})
      if(!catalog.ok)throw Error('Terrain catalog unavailable')
      const index=await catalog.json()
      if(index.schema!==1||typeof index.bodies?.[this.bodyId]!=='string')throw Error('Invalid terrain catalog')
      this.manifestUrl=new URL(index.bodies[this.bodyId],this.baseUrl).href
      if(!this.manifestUrl.startsWith(this.baseUrl))throw Error('Terrain outside release root')
      const response=await fetch(this.manifestUrl,{signal:this.controller.signal})
      if(!response.ok)throw Error('Terrain manifest unavailable')
      const manifest=parseTerrainManifest(await response.json())
      if(manifest.body!==this.bodyId)throw Error('Wrong body')
      if(!this.disposed)this.manifest=manifest
    }catch{if(!this.disposed)this.failedManifest=true}
    finally{clearTimeout(timeout);if(!this.disposed)this.changed()}
  }
  ready(keys:Map<string,TileAddress>){return [...keys.keys()].every(key=>!!this.tiles.get(key)?.heights)}
  sample(lat:number,lon:number,z:number):number{
    const a=heightAddress(lat,lon,z),heights=this.tiles.get(heightKey(a))?.heights,m=this.manifest
    if(!heights||!m)return NaN
    const n=2**z,span=180/n,west=-180+a.x*span,north=90-a.y*span
    let longitude=Math.abs(lat)===90?0:((lon+180)%360+360)%360-180
    if(longitude<west)longitude+=360
    const x=Math.max(0,Math.min(m.sampleSize-1,(longitude-west)/span*(m.sampleSize-1)))
    const y=Math.max(0,Math.min(m.sampleSize-1,(north-lat)/span*(m.sampleSize-1)))
    const c=Math.min(m.sampleSize-2,Math.floor(x)),r=Math.min(m.sampleSize-2,Math.floor(y)),u=x-c,v=y-r
    const values=[heights[r*m.sampleSize+c],heights[r*m.sampleSize+c+1],heights[(r+1)*m.sampleSize+c],heights[(r+1)*m.sampleSize+c+1]]
    if(values.some(h=>!Number.isFinite(h)))return NaN
    return values[0]*(1-u)*(1-v)+values[1]*u*(1-v)+values[2]*(1-u)*v+values[3]*u*v
  }
  update(wanted:Map<string,TileAddress>,now:number,budget=this.budget){
    if(this.disposed)return
    this.byteBudget=Math.max(8*1048576,Math.min(64*1048576,Math.floor(budget)))
    this.wanted=wanted
    for(const [key,tile] of this.tiles)if(!wanted.has(key))tile.request?.abort()
    for(const [key,address] of wanted){
      let tile=this.tiles.get(key)
      if(!tile){tile={address,retryAt:0,lastUsed:now};this.tiles.set(key,tile)}
      tile.lastUsed=now
      if(!tile.heights&&!this.manifest?.tiles[key])this.ensurePage(address,now)
    }
    const usedPages=new Set([...wanted.values()].filter(a=>a.z>3).map(a=>`${Math.floor(a.x/2**(a.z-3))}/${Math.floor(a.y/2**(a.z-3))}`))
    for(const [key,page]of this.pages)if(usedPages.has(key))page.lastUsed=now
    const unused=[...this.pages].filter(([key,p])=>!usedPages.has(key)&&!p.request).sort((a,b)=>a[1].lastUsed-b[1].lastUsed)
    while(this.pages.size>24&&unused.length){const [key,p]=unused.shift()!;p.keys.forEach(k=>delete this.manifest!.tiles[k]);this.pages.delete(key)}
    for(const[key,tile]of this.tiles)if(!wanted.has(key)&&!tile.heights&&!tile.request&&now-tile.lastUsed>30000)this.tiles.delete(key)
    this.evict(0)
    this.pump(now)
  }
  private evict(reserve:number){
    if(this.bytes+reserve<=this.budget)return true
    const unused=[...this.tiles].filter(([key,t])=>!this.wanted.has(key)&&t.heights&&!t.request).sort((a,b)=>a[1].lastUsed-b[1].lastUsed)
    while(this.bytes+reserve>this.budget&&unused.length){const[key,t]=unused.shift()!;this.bytes-=t.heights!.byteLength;this.tiles.delete(key)}
    return this.bytes+reserve<=this.budget
  }
  private pump(now:number){
    if(this.disposed||!this.manifest)return
    const reserve=this.manifest.sampleSize**2*4
    const pending=[...this.wanted.keys()].map(key=>this.tiles.get(key)!).filter(t=>t&&!t.heights&&!t.request&&t.retryAt<=now)
      .sort((a,b)=>a.address.z-b.address.z)
    for(const tile of pending){
      if(this.requests>=6)break
      const info=this.manifest.tiles[heightKey(tile.address)]
      if(!info)continue
      if(!this.evict(reserve))break
      tile.request=new AbortController();this.requests++;this.bytes+=reserve
      void this.load(tile,info,tile.request,reserve)
    }
  }
  private async load(tile:Tile,info:TerrainTileInfo,request:AbortController,reserve:number){
    const timeout=setTimeout(()=>{tile.retryAt=performance.now()+30000;request.abort()},15000)
    try{
      const a=tile.address,m=this.manifest!,url=new URL(m.tileUrl.replace('{z}',String(a.z)).replace('{x}',String(a.x)).replace('{y}',String(a.y)),this.manifestUrl)
      const response=await fetch(url,{signal:request.signal})
      if(!response.ok)throw Error('Height tile unavailable')
      const buffer=await response.arrayBuffer()
      if(buffer.byteLength!==info.bytes)throw Error('Height size mismatch')
      if(request.signal.aborted||this.disposed)return
      const decoder=this.decoder??=this.createDecoder()
      const heights=await decoder.decode(buffer,m.sampleSize,info.sha256,m.scaleMeters,m.noData)
      if(request.signal.aborted||this.disposed)return
      tile.heights=heights;tile.retryAt=0
    }catch{if(!request.signal.aborted)tile.retryAt=performance.now()+30000}
    finally{
      clearTimeout(timeout);if(!tile.heights)this.bytes-=reserve
      tile.request=undefined;this.requests--
      if(!this.disposed){this.changed();this.pump(performance.now())}
    }
  }
  private ensurePage(a:TileAddress,now:number){
    if(!this.manifest||a.z<=3||this.pageRequests>=2)return
    const factor=2**(a.z-3),key=`${Math.floor(a.x/factor)}/${Math.floor(a.y/factor)}`,info=this.manifest.indexPages?.pages[key]
    if(!info)return
    let page=this.pages.get(key)
    if(!page){page={keys:[],retryAt:0,bytes:0,lastUsed:now};this.pages.set(key,page)}
    if(page.keys.length||page.request||page.retryAt>now)return
    const entry=page,request=entry.request=new AbortController();this.pageRequests++
    void(async()=>{
      const timeout=setTimeout(()=>{entry.retryAt=performance.now()+30000;request.abort()},15000)
      try{
        const response=await fetch(new URL(info.url,this.manifestUrl),{signal:request.signal})
        if(!response.ok)throw Error('Height index unavailable')
        const buffer=await response.arrayBuffer()
        if(buffer.byteLength!==info.bytes)throw Error('Height index size mismatch')
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),b=>b.toString(16).padStart(2,'0')).join('')
        if(digest!==info.sha256)throw Error('Height index checksum mismatch')
        const tiles=parseTerrainPage(JSON.parse(new TextDecoder().decode(buffer)),this.manifest!,key)
        if(request.signal.aborted||this.disposed)return
        Object.assign(this.manifest!.tiles,tiles);entry.keys=Object.keys(tiles);entry.bytes=buffer.byteLength*2;entry.retryAt=0
      }catch{if(!request.signal.aborted)entry.retryAt=performance.now()+30000}
      finally{clearTimeout(timeout);entry.request=undefined;this.pageRequests--;if(!this.disposed){this.changed();this.pump(performance.now())}}
    })()
  }
  clear(){
    this.wanted.clear()
    for(const tile of this.tiles.values())tile.request?.abort()
    for(const page of this.pages.values()){page.request?.abort();page.keys.forEach(key=>delete this.manifest?.tiles[key])}
    this.tiles.clear();this.pages.clear()
    // In-flight reservations are removed in their own finally blocks.
    this.bytes=this.requests*(this.manifest?.sampleSize??129)**2*4
    this.decoder?.dispose();this.decoder=undefined
  }
  metrics(){const metadataBytes=[...this.pages.values()].reduce((sum,p)=>sum+p.bytes,0)
    return {requests:this.requests+this.pageRequests,memoryBytes:this.bytes+metadataBytes,metadataBytes,
    failed:Number(this.failedManifest)+[...this.tiles.values(),...this.pages.values()].filter(t=>t.retryAt>0).length,cached:[...this.tiles.values()].filter(t=>t.heights).length}}
  dispose(){this.disposed=true;this.controller.abort();this.clear()}
}
