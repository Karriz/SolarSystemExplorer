import * as THREE from 'three'
import type { SolidSurfaceBody } from './planetRenderProfiles.ts'

const CORE=256,PAGE=260,SLOTS=128
type Manifest={schema:number;body:string;version:string;tileSize:number;gutter:number;range:number[];levels:{width:number;height:number}[];tiles:Record<string,{bytes:number;sha256:string}>;baseSha256:string}
type Node={key:string;z:number;x:number;y:number;box:THREE.Box3;sphere:THREE.Sphere}
type Resident={slot:number;at:number;used:number}

export class GlobalHillshadeLayer {
  readonly enabled={value:1}
  readonly ready={value:0}
  readonly poolReady={value:0}
  readonly base={value:null as THREE.DataTexture|null}
  readonly pages={value:null as THREE.DataArrayTexture|null}
  readonly table={value:null as THREE.DataTexture|null}
  readonly levels={value:Array.from({length:6},()=>new THREE.Vector4())}
  readonly range={value:new THREE.Vector2(.55,1.30)}
  private coarseOnly=false
  private nextMetadata=0
  private manifest?:Manifest
  private nodes:Node[]=[]
  private url=''
  private metadata?:AbortController
  private pending=new Map<string,AbortController>()
  private residents=new Map<string,Resident>()
  private retries=new Map<string,number>()
  private wanted=new Set<string>()
  private queue:Node[]=[]
  private active=false
  private disposed=false
  private lastPlan=-Infinity
  private tableWidth=0
  private tableData?:Uint8Array
  private pageData?:Uint8Array
  private failures=0
  readonly bodyId:SolidSurfaceBody
  constructor(bodyId:SolidSurfaceBody){this.bodyId=bodyId}
  private async read(url:string,signal:AbortSignal,length:number,sha:string){
    const r=await fetch(url,{signal});if(!r.ok||!r.body)throw Error('Hillshade data unavailable')
    const decoded=r.headers.get('Content-Encoding')?.split(',').some(v=>v.trim().toLowerCase()==='gzip')
    const reader=(decoded?r.body:r.body.pipeThrough(new DecompressionStream('gzip'))).getReader()
    const bytes=new Uint8Array(length);let offset=0
    try{for(;;){const {done,value}=await reader.read();if(done)break;if(offset+value.length>length)throw Error('Invalid hillshade length');bytes.set(value,offset);offset+=value.length}}finally{await reader.cancel()}
    if(offset!==length)throw Error('Incomplete hillshade page')
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('')
    if(hash!==sha)throw Error('Hillshade checksum mismatch')
    return bytes
  }
  private async load(){
    if(this.metadata||this.manifest&&!this.coarseOnly||this.disposed)return
    const request=this.metadata=new AbortController(),timeout=setTimeout(()=>request.abort('timeout'),30000)
    try{
      const root=new URL(import.meta.env.VITE_HILLSHADE_BASE_URL||`${import.meta.env.BASE_URL}hillshade/`,location.href).href
      let url='',m:Manifest,bundled=false
      try {
        const catalogResponse=await fetch(root+'catalog.json',{signal:request.signal});if(!catalogResponse.ok)throw Error('Missing hillshade catalog')
        const catalog=await catalogResponse.json();if(catalog.schema!==1||typeof catalog.bodies?.[this.bodyId]!=='string')throw Error('Invalid hillshade catalog')
        url=new URL(catalog.bodies[this.bodyId],root).href;if(!url.startsWith(root))throw Error('Invalid hillshade release')
        const response=await fetch(url,{signal:request.signal});if(!response.ok)throw Error('Missing hillshade manifest')
        m=await response.json()
      } catch(error) {
        if(request.signal.aborted)throw error
        if(this.ready.value){this.nextMetadata=performance.now()+30000;return}
        url=new URL(`${import.meta.env.BASE_URL}textures/${this.bodyId}-hillshade-base.json`,location.href).href
        const response=await fetch(url,{signal:request.signal});if(!response.ok)throw error
        m=await response.json();bundled=true
      }
      if(m.schema!==1||m.body!==this.bodyId||m.tileSize!==CORE||m.gutter!==2||m.levels?.length!==6||m.range?.[0]!==.55||m.range[1]!==1.3)throw Error('Invalid hillshade manifest')
      let rows=0,columns=0
      for(let z=0;z<6;z++){
        const l=m.levels[z];if(!Number.isInteger(l.width)||!Number.isInteger(l.height)||l.width!==l.height*2||l.width>32768||l.width<1||z>0&&l.width!==m.levels[z-1].width*2)throw Error('Invalid hillshade dimensions')
        this.levels.value[z].set(l.width,l.height,rows,0);rows+=Math.ceil(l.height/CORE);columns=Math.max(columns,Math.ceil(l.width/CORE))
      }
      const data=await this.read(new URL(bundled?`${this.bodyId}-hillshade-base.bin.gz`:'base.bin.gz',url).href,request.signal,m.levels[0].width*m.levels[0].height,m.baseSha256)
      if(this.disposed||request.signal.aborted||this.metadata!==request)return
      const base=new THREE.DataTexture(data,m.levels[0].width,m.levels[0].height,THREE.RedFormat)
      base.wrapS=THREE.RepeatWrapping;base.generateMipmaps=true;base.minFilter=THREE.LinearMipmapLinearFilter;base.magFilter=THREE.LinearFilter;base.needsUpdate=true
      const nodes:Node[]=[]
      for(let z=1;!bundled&&z<6;z++){
        const l=m.levels[z]
        for(let y=0;y<Math.ceil(l.height/CORE);y++)for(let x=0;x<Math.ceil(l.width/CORE);x++){
          const key=`${z}/${x}/${y}`;if(!m.tiles[key]||!/^[a-f0-9]{64}$/.test(m.tiles[key].sha256))throw Error('Incomplete hillshade metadata')
          const box=new THREE.Box3()
          for(let r=0;r<5;r++)for(let c=0;c<5;c++){
            const lat=((y*CORE+Math.min(CORE,l.height-y*CORE)*r/4)/l.height-.5)*Math.PI
            const lon=((x*CORE+Math.min(CORE,l.width-x*CORE)*c/4)/l.width-.5)*Math.PI*2
            const d=new THREE.Vector3(Math.cos(lat)*Math.cos(lon),Math.sin(lat),-Math.cos(lat)*Math.sin(lon))
            box.expandByPoint(d.clone().multiplyScalar(.985));box.expandByPoint(d.multiplyScalar(1.015))
          }
          box.expandByScalar(1e-5);nodes.push({key,z,x,y,box,sphere:box.getBoundingSphere(new THREE.Sphere())})
        }
      }
      this.base.value?.dispose();this.base.value=base;this.tableWidth=columns;this.tableData=new Uint8Array(columns*rows*4)
      this.url=url;this.manifest=m;this.coarseOnly=bundled;this.nextMetadata=performance.now()+30000;this.nodes=nodes;this.ready.value=1;this.lastPlan=-Infinity
    }catch{if(!this.disposed){this.failures++;this.nextMetadata=performance.now()+30000}}
    finally{clearTimeout(timeout);if(this.metadata===request)this.metadata=undefined}
  }
  private allocate(){
    if(this.pages.value||!this.manifest||!this.tableData)return
    this.pageData=new Uint8Array(PAGE*PAGE*SLOTS)
    const pages=new THREE.DataArrayTexture(this.pageData,PAGE,PAGE,SLOTS);pages.format=THREE.RedFormat
    pages.minFilter=pages.magFilter=THREE.LinearFilter;pages.generateMipmaps=false;pages.needsUpdate=true;this.pages.value=pages
    const table=new THREE.DataTexture(this.tableData,this.tableWidth,this.tableData.length/(this.tableWidth*4))
    table.minFilter=table.magFilter=THREE.NearestFilter;table.needsUpdate=true;this.table.value=table;this.poolReady.value=1
  }
  update(camera:THREE.PerspectiveCamera,body:THREE.Mesh,viewportHeight:number,now:number,selected:boolean){
    const active=selected&&this.enabled.value>0
    if(!active){if(this.active)this.releaseFine();this.active=false;return}
    this.active=true
    if(!this.manifest||this.coarseOnly){if(now>=this.nextMetadata)void this.load();return}
    this.allocate()
    if(now-this.lastPlan>=180){
      camera.updateMatrixWorld()
      body.updateWorldMatrix(true,false)
      const radius=(body.geometry as THREE.SphereGeometry).parameters.radius
      const local=body.worldToLocal(camera.position.clone()).divideScalar(radius)
      const matrix=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).multiply(body.matrixWorld).multiply(new THREE.Matrix4().makeScale(radius,radius,radius))
      const frustum=new THREE.Frustum().setFromProjectionMatrix(matrix),focal=viewportHeight/(2*Math.tan(camera.fov*Math.PI/360))
      const candidates:{node:Node;priority:number}[]=[]
      for(const node of this.nodes){
        if(!frustum.intersectsBox(node.box)||local.dot(node.sphere.center)+local.length()*node.sphere.radius<.97)continue
        const score=focal*Math.PI/this.manifest.levels[node.z].height/Math.max(.00003,node.box.distanceToPoint(local))
        if(score<.55||score>3.5&&node.z!==5)continue
        candidates.push({node,priority:Math.abs(Math.log2(score))})
      }
      candidates.sort((a,b)=>a.priority-b.priority||a.node.key.localeCompare(b.node.key))
      this.queue=candidates.slice(0,96).map(c=>c.node);this.wanted=new Set(this.queue.map(n=>n.key))
      for(const [key,controller]of this.pending)if(!this.wanted.has(key))controller.abort()
      for(const key of this.wanted){const r=this.residents.get(key);if(r)r.used=now}
      this.lastPlan=now
    }
    let changed=false
    for(const node of this.nodes){const r=this.residents.get(node.key);if(!r)continue
      const offset=((this.levels.value[node.z].z+node.y)*this.tableWidth+node.x)*4
      const fade=Math.min(255,Math.round((now-r.at)/300*255))
      if(this.tableData![offset+1]!==fade){this.tableData![offset+1]=fade;changed=true}
    }
    if(changed)this.table.value!.needsUpdate=true
    this.pump(now)
  }
  private pump(now:number){
    if(!this.active||this.disposed||!this.manifest)return
    for(const node of this.queue){
      if(this.pending.size>=4)break
      if(this.residents.has(node.key)||this.pending.has(node.key)||(this.retries.get(node.key)??0)>now)continue
      const controller=new AbortController();this.pending.set(node.key,controller)
      const timeout=setTimeout(()=>controller.abort('timeout'),20000)
      void this.read(new URL(`${node.key}.bin.gz`,this.url).href,controller.signal,PAGE*PAGE,this.manifest.tiles[node.key].sha256).then(data=>{
        if(this.disposed||controller.signal.aborted||!this.active||!this.wanted.has(node.key))return
        const used=new Set([...this.residents.values()].map(r=>r.slot));let slot=0
        while(used.has(slot)&&slot<SLOTS)slot++
        if(slot===SLOTS){
          const victim=[...this.residents].filter(([key])=>!this.wanted.has(key)).sort((a,b)=>a[1].used-b[1].used)[0]
          if(!victim)return
          slot=victim[1].slot;this.residents.delete(victim[0])
          const old=this.nodes.find(n=>n.key===victim[0])!;this.tableData![((this.levels.value[old.z].z+old.y)*this.tableWidth+old.x)*4]=0
        }
        this.pageData!.set(data,slot*PAGE*PAGE);this.pages.value!.addLayerUpdate(slot);this.pages.value!.needsUpdate=true
        this.residents.set(node.key,{slot,at:performance.now(),used:performance.now()})
        const offset=((this.levels.value[node.z].z+node.y)*this.tableWidth+node.x)*4
        this.tableData![offset]=slot+1;this.tableData![offset+1]=0;this.table.value!.needsUpdate=true
      }).catch(()=>{if(!controller.signal.aborted||controller.signal.reason==='timeout'){this.failures++;this.retries.set(node.key,performance.now()+30000)}}).finally(()=>{
        clearTimeout(timeout);if(this.pending.get(node.key)===controller)this.pending.delete(node.key)
      })
    }
  }
  private releaseFine(){
    for(const c of this.pending.values())c.abort();this.pending.clear();this.residents.clear();this.wanted.clear();this.queue=[]
    this.pages.value?.dispose();this.table.value?.dispose();this.pages.value=null;this.table.value=null;this.pageData=undefined;this.tableData?.fill(0);this.poolReady.value=0;this.lastPlan=-Infinity
  }
  selectionSignature(){return [...this.wanted].sort().join('|')}
  metrics(){return {ready:!!this.ready.value,coarseOnly:this.coarseOnly,active:this.active,cached:this.residents.size,wanted:this.wanted.size,missingWanted:[...this.wanted].filter(k=>!this.residents.has(k)).length,requests:this.pending.size,failed:this.failures,gpuPageBytes:this.pageData?.length??0,cpuPageBytes:this.pageData?.length??0,maxPages:SLOTS,version:this.manifest?.version}}
  dispose(){this.disposed=true;this.metadata?.abort();this.releaseFine();this.base.value?.dispose();this.base.value=null;this.ready.value=0}
}

export const globalHillshadeDeclarations=`
uniform sampler2D hsGlobalBase; uniform highp sampler2DArray hsGlobalPages; uniform sampler2D hsGlobalTable;
uniform vec4 hsGlobalLevels[6]; uniform float hsGlobalReady; uniform float hsGlobalEnabled; uniform float hsGlobalPoolReady;
float hsPageFade(ivec2 cell,int level){
  ivec2 count=ivec2(ceil(hsGlobalLevels[level].xy/256.0));
  if(cell.y<0||cell.y>=count.y)return 1.0;
  cell.x=(cell.x%count.x+count.x)%count.x;
  vec4 p=texelFetch(hsGlobalTable,ivec2(cell.x,cell.y+int(hsGlobalLevels[level].z)),0);
  return p.r>0.0?p.g:0.0;
}
float hsGlobalSample(vec2 uv, int requested) {
  vec2 baseDx=dFdx(uv),baseDy=dFdy(uv);baseDx.x-=round(baseDx.x);baseDy.x-=round(baseDy.x);
  float total=0.0, remaining=1.0;
  if(hsGlobalPoolReady>0.5) for(int i=5;i>=1;i--){
    if(i>requested)continue;
    vec2 size=hsGlobalLevels[i].xy;
    vec2 pixel=uv*size; ivec2 cell=ivec2(min(floor(pixel/256.0),ceil(size/256.0)-1.0));
    vec4 page=texelFetch(hsGlobalTable,ivec2(cell.x,cell.y+int(hsGlobalLevels[i].z)),0);
    int slot=int(round(page.r*255.0))-1;
    if(slot>=0){
      vec2 within=pixel-vec2(cell)*256.0;
      vec2 extent=min(vec2(256.0),size-vec2(cell)*256.0);
      vec2 edge=min(within,extent-within);
      ivec2 side=ivec2(within.x<extent.x*0.5?-1:1,within.y<extent.y*0.5?-1:1);
      float alpha=page.g;
      if(edge.x<4.0)alpha=min(alpha,mix(hsPageFade(cell+ivec2(side.x,0),i),1.0,smoothstep(0.0,4.0,edge.x)));
      if(edge.y<4.0)alpha=min(alpha,mix(hsPageFade(cell+ivec2(0,side.y),i),1.0,smoothstep(0.0,4.0,edge.y)));
      if(edge.x<4.0&&edge.y<4.0)alpha=min(alpha,mix(hsPageFade(cell+side,i),1.0,smoothstep(0.0,4.0,max(edge.x,edge.y))));
      vec2 local=(within+2.0)/260.0;
      float value=texture(hsGlobalPages,vec3(local,float(slot))).r;
      total+=remaining*alpha*value;remaining*=1.0-alpha;
      if(remaining<0.001)break;
    }
  }
  return total+remaining*textureGrad(hsGlobalBase,uv,baseDx,baseDy).r;
}
`
