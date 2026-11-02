import * as THREE from 'three'
import { bodyInfo } from './ephemeris.ts'
import type { TerrainBody } from './terrain.ts'
import { cubeChildren,cubeDirection,cubeFaceUv,cubeGrid,cubeKey,cubeRoots,cubeTerrainGeometry,cubeUvBounds,sampleCubeSurface,type CubeAddress } from './cubeSphere.ts'
import { PlanetHeightSource,heightAddress,heightKey } from './PlanetHeightSource.ts'
import { captureTerrainEdge,type TerrainEdge } from './terrainEdges.ts'
import { firstTerrainSurfaceHit,sphereSurfaceSampler,type TerrainSurfaceSampler } from './terrainSurface.ts'
import { configureMoonSurfaceMaterial,configureMoonTerrainDepth,MARS_DETAIL_PROFILE,MOON_DETAIL_PROFILE,type MoonShade } from './moonSurfaceMaterial.ts'
import type { SurfaceState } from './surfaceMaterial.ts'
import type { TerrainStatus } from './GlobeTerrainLayer.ts'
import type { TileAddress } from './surfaceTiles.ts'
import { stitchCubeEdges } from './cubeTerrainEdges.ts'
import { configureTerrainHillshade, type HillshadeState } from './terrainHillshade.ts'
import { configureCubeColorMaterial } from './cubeColorMaterial.ts'

// Leaf cap stays under the 400k triangle budget (2304 tris per 33x33 leaf,
// so ~173 leaves max); the byte cap is a budget ceiling, not an allocation,
// and the release path enforces it. The height-tile cache gets whatever is
// left after geometry and metadata, so raising the cap also reduces refetch
// pop-in while zooming.
const SIZE=33,MAX_LEVEL=10,MAX_LEAVES=160,MAX_NODES=240,MAX_BYTES=256*1048576
/** Plan LOD as if the camera were this much closer than it is, so the terrain
 * resolution that used to appear at altitude x/2 is already wanted at x and
 * its tiles stream in before the cells reach their target screen size. */
const RESOLUTION_AHEAD=2
type Node={key:string;address:CubeAddress;box:THREE.Box3;sphere:THREE.Sphere;lastUsed:number;dataZ:number;
  directions?:Float64Array;coordinates?:Float64Array;keys?:Map<string,TileAddress>;mesh?:THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>;edge?:TerrainEdge}

/** Rendering and LOD use six equiangular cube trees. The measured release
 * remains geographic: a bounded numeric adapter resamples it on demand. */
export class CubeTerrainLayer {
  readonly group=new THREE.Group()
  active=false
  private source:PlanetHeightSource
  private nodes=new Map<string,Node>()
  private wanted=new Set<string>()
  private refined=new Set<string>()
  private enabled=true
  private disposed=false
  private exaggeration=1
  private lastPlan=-Infinity
  private stitched=''
  private reported=''
  private material:THREE.MeshStandardMaterial
  private base:THREE.MeshStandardMaterial
  private shade?:MoonShade
  private fallback:TerrainSurfaceSampler
  private body:THREE.Mesh
  private onStatus:(status:TerrainStatus)=>void
  private surface?:SurfaceState
  private radiusMeters:number
  private bodyId:TerrainBody
  constructor(body:THREE.Mesh,onStatus:(status:TerrainStatus)=>void,baseUrl:string,surface?:SurfaceState,hillshade?:HillshadeState,bodyId:TerrainBody='moon'){
    this.body=body;this.onStatus=onStatus;this.surface=surface;this.bodyId=bodyId
    this.radiusMeters=bodyInfo[bodyId].radiusKm*1000
    this.base=body.material as THREE.MeshStandardMaterial
    this.material=this.base.clone()
    this.material.onBeforeCompile=shader=>{
      shader.vertexShader='attribute float terrainCoverage; varying float vTerrainCoverage;\n'+shader.vertexShader
      shader.vertexShader=shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvTerrainCoverage=terrainCoverage;')
      shader.fragmentShader='varying float vTerrainCoverage;\n'+shader.fragmentShader
      shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>\ndiffuseColor.rgb=mix(vec3(0.22),diffuseColor.rgb,step(0.999,vTerrainCoverage));')
    }
    this.material.customProgramCacheKey=()=> 'cube-terrain-coverage-v1'
    const detailProfile=bodyId==='mars'?MARS_DETAIL_PROFILE:MOON_DETAIL_PROFILE
    if((bodyId==='moon'||bodyId==='mars')&&surface)this.shade=configureMoonSurfaceMaterial(this.material,surface,this.radiusMeters,true,undefined,undefined,detailProfile)
    if(bodyId==='mars')configureCubeColorMaterial(this.material)
    if(hillshade)configureTerrainHillshade(this.material,hillshade)
    this.group.name=`${bodyId}-cube-terrain`;this.group.scale.setScalar((body.geometry as THREE.SphereGeometry).parameters.radius)
    body.add(this.group)
    this.fallback=sphereSurfaceSampler(body.geometry as THREE.SphereGeometry)
    this.source=new PlanetHeightSource(baseUrl,()=>this.report(),undefined,bodyId)
    this.setActive(false)
  }
  private setActive(active:boolean){this.active=active;this.group.visible=active;this.base.visible=!active}
  updateShadeCamera(camera:THREE.Camera){if(!this.shade)return;this.body.updateWorldMatrix(true,true);this.shade.camera.value.copy(this.body.worldToLocal(camera.position.clone())).divideScalar(this.group.scale.x)}
  setEnabled(enabled:boolean){this.enabled=enabled;this.lastPlan=-Infinity;if(!enabled){this.setActive(false);this.source.clear()}this.report()}
  setExaggeration(value:number){
    if((value!==1&&value!==4)||value===this.exaggeration)return
    this.exaggeration=value
    for(const node of this.nodes.values())this.releaseMesh(node)
    this.stitched='';this.lastPlan=-Infinity;this.setActive(false)
  }
  private node(address:CubeAddress,now:number){
    const key=cubeKey(address);let node=this.nodes.get(key)
    if(node)return node
    const box=new THREE.Box3(),b=cubeUvBounds(address)
    for(let r=0;r<5;r++)for(let c=0;c<5;c++){
      const d=cubeDirection(address.face,b.left+(b.right-b.left)*c/4,b.top+(b.bottom-b.top)*r/4)
      for(const h of [this.source.manifest!.minHeightMeters,this.source.manifest!.maxHeightMeters])box.expandByPoint(d.clone().multiplyScalar(1+h*4/this.radiusMeters))
    }
    box.expandByScalar(1e-7)
    const dataZ=Math.min(this.source.manifest!.maxZoom,Math.max(0,address.z+1-Math.log2((this.source.manifest!.sampleSize-1)/(SIZE-1))))
    node={key,address,box,sphere:box.getBoundingSphere(new THREE.Sphere()),dataZ,lastUsed:now}
    this.nodes.set(key,node);return node
  }
  private prepare(node:Node){
    node.directions=cubeGrid(node.address,SIZE)
    const coordinates=new Float64Array(SIZE*SIZE*5*2),keys=new Map<string,TileAddress>()
    const d=new THREE.Vector3(),axis=new THREE.Vector3(),a=new THREE.Vector3(),b=new THREE.Vector3(),p=new THREE.Vector3()
    const step=Math.PI/(2**node.dataZ*(this.source.manifest!.sampleSize-1))
    for(let i=0;i<SIZE*SIZE;i++){
      d.fromArray(node.directions,i*3);axis.set(Math.abs(d.y)<.9?0:1,Math.abs(d.y)<.9?1:0,0)
      a.crossVectors(d,axis).normalize();b.crossVectors(d,a).normalize()
      for(let j=0;j<5;j++){
        p.copy(d);if(j)p.addScaledVector(j<=2?a:b,j%2?step:-step).normalize()
        const lat=Math.asin(THREE.MathUtils.clamp(p.y,-1,1))*180/Math.PI,lon=Math.atan2(-p.z,p.x)*180/Math.PI
        coordinates[(i*5+j)*2]=lat;coordinates[(i*5+j)*2+1]=lon
        const address=heightAddress(lat,lon,node.dataZ);keys.set(heightKey(address),address)
      }
    }
    node.coordinates=coordinates;node.keys=keys
  }
  private build(node:Node){
    const d=new THREE.Vector3(),axis=new THREE.Vector3(),a=new THREE.Vector3(),b=new THREE.Vector3()
    const pa=new THREE.Vector3(),ma=new THREE.Vector3(),pb=new THREE.Vector3(),mb=new THREE.Vector3(),normal=new THREE.Vector3()
    const step=Math.PI/(2**node.dataZ*(this.source.manifest!.sampleSize-1)),coordinates=node.coordinates!
    let index=0
    const geometry=cubeTerrainGeometry(node.address,SIZE,dir=>{
      d.copy(dir);const values:number[]=[]
      for(let j=0;j<5;j++)values.push(this.source.sample(coordinates[(index*5+j)*2],coordinates[(index*5+j)*2+1],node.dataZ))
      index++
      const height=values[0],center=Number.isFinite(height)?height:0
      axis.set(Math.abs(d.y)<.9?0:1,Math.abs(d.y)<.9?1:0,0);a.crossVectors(d,axis).normalize();b.crossVectors(d,a).normalize()
      const placed=(out:THREE.Vector3,t:THREE.Vector3,sign:number,h:number)=>out.copy(d).addScaledVector(t,sign*step).normalize().multiplyScalar(1+(Number.isFinite(h)?h:center)*this.exaggeration/this.radiusMeters)
      placed(pa,a,1,values[1]);placed(ma,a,-1,values[2]);placed(pb,b,1,values[3]);placed(mb,b,-1,values[4])
      normal.crossVectors(pa.sub(ma),pb.sub(mb)).normalize()
      return {height,normal}
    },this.radiusMeters,this.exaggeration,true,node.directions)
    const material=this.material.clone();material.onBeforeCompile=this.material.onBeforeCompile;material.customProgramCacheKey=this.material.customProgramCacheKey
    const mesh=new THREE.Mesh(geometry,material);mesh.name=`${this.bodyId}-cube/${node.key}`;mesh.frustumCulled=false;mesh.visible=false;mesh.receiveShadow=true
    if((this.bodyId==='moon'||this.bodyId==='mars')&&this.surface){
      const depth=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking})
      configureMoonTerrainDepth(depth,this.surface,this.radiusMeters,true,undefined,undefined,this.bodyId==='mars'?MARS_DETAIL_PROFILE:MOON_DETAIL_PROFILE);mesh.customDepthMaterial=depth
    }
    node.mesh=mesh;node.edge=captureTerrainEdge(geometry,SIZE);this.group.add(mesh)
  }
  update(camera:THREE.PerspectiveCamera,viewportHeight:number,now:number,selected:boolean){
    if(this.disposed)return
    this.material.map=this.base.map;this.material.emissiveMap=this.base.emissiveMap;this.material.emissive.copy(this.base.emissive);this.material.emissiveIntensity=this.base.emissiveIntensity
    if(!this.enabled||!selected||!this.source.manifest){
      this.setActive(false)
      if(!selected&&this.nodes.size){this.nodes.forEach(n=>this.releaseMesh(n));this.nodes.clear();this.wanted.clear();this.refined.clear();this.source.clear();this.stitched='';this.lastPlan=-Infinity}
      this.report();return
    }
    camera.updateMatrixWorld();this.group.updateWorldMatrix(true,true)
    const local=this.body.worldToLocal(camera.position.clone()).divideScalar(this.group.scale.x)
    const focal=viewportHeight/(2*Math.tan(camera.fov*Math.PI/360))
    if(focal*2/Math.max(1,local.length()-1)<32){this.setActive(false);this.report();return}
    if(now-this.lastPlan>=120){
      const frustum=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).multiply(this.group.matrixWorld))
      const score=(n:Node)=>{
        if(!frustum.intersectsBox(n.box)||local.dot(n.sphere.center)+local.length()*n.sphere.radius<.96)return 0
        const uv=cubeFaceUv(n.address.face,local),bounds=cubeUvBounds(n.address)
        const closest=uv?cubeDirection(n.address.face,THREE.MathUtils.clamp(uv.u,bounds.left,bounds.right),THREE.MathUtils.clamp(uv.v,bounds.top,bounds.bottom)):n.sphere.center.clone().normalize()
        const height=THREE.MathUtils.clamp((local.length()-1)*this.radiusMeters/this.exaggeration,this.source.manifest!.minHeightMeters,this.source.manifest!.maxHeightMeters)
        closest.multiplyScalar(1+height*this.exaggeration/this.radiusMeters)
        const nearest=Math.max(100/this.radiusMeters,local.distanceTo(closest)/RESOLUTION_AHEAD)
        return focal*(Math.PI/2/2**n.address.z)/(SIZE-1)/nearest
      }
      const leaves=cubeRoots().map(a=>{const n=this.node(a,now);return {node:n,score:score(n)}}),wanted=new Set(leaves.map(n=>n.node.key)),refined=new Set<string>()
      while(leaves.length+3<=MAX_LEAVES){
        leaves.sort((a,b)=>b.score-a.score||a.node.key.localeCompare(b.node.key))
        const maxLevel=Math.min(MAX_LEVEL,this.source.manifest!.maxZoom+Math.log2((this.source.manifest!.sampleSize-1)/(SIZE-1))-1)
        const next=leaves.find(n=>n.node.address.z<maxLevel&&n.score>(this.refined.has(n.node.key)?1.5:2.5))
        if(!next)break
        const children=cubeChildren(next.node.address).map(a=>{const n=this.node(a,now);wanted.add(n.key);return {node:n,score:score(n)}})
        refined.add(next.node.key);leaves.splice(leaves.indexOf(next),1,...children)
      }
      this.wanted=wanted;this.refined=refined;this.lastPlan=now
      for(const key of wanted)this.nodes.get(key)!.lastUsed=now
    }
    let prepared=0
    const ordered=[...this.wanted].map(key=>this.nodes.get(key)!).sort((a,b)=>a.address.z-b.address.z||a.key.localeCompare(b.key))
    for(const node of ordered)if(!node.coordinates&&prepared++<8)this.prepare(node)
    const needed=new Map<string,TileAddress>()
    for(const node of ordered)if(!node.mesh&&node.keys)for(const [key,a]of node.keys)needed.set(key,a)
    // Dense level-9 metadata shares the allocation budget with geometry and
    // decoded heights. Leave room for the next two pages and mesh builds.
    const sourceStats=this.source.metrics()
    this.source.update(needed,now,MAX_BYTES-this.geometryBytes()-sourceStats.metadataBytes-4*1048576)
    const start=performance.now();let built=0
    for(const node of ordered)if(!node.mesh&&node.keys&&this.source.ready(node.keys)){
      this.build(node);if(++built>=4||performance.now()-start>8)break
    }
    for(const node of this.nodes.values())if(node.mesh){
      node.mesh.visible=false
      const m=node.mesh.material
      if(m.map!==this.base.map){m.map=this.base.map;m.emissiveMap=this.base.map;m.needsUpdate=true}
      m.emissive.copy(this.base.emissive);m.emissiveIntensity=this.base.emissiveIntensity
    }
    const show=(node:Node)=>{
      const children=this.refined.has(node.key)?cubeChildren(node.address).map(a=>this.nodes.get(cubeKey(a))!):[]
      if(children.length&&children.every(n=>n.mesh))children.forEach(show)
      else if(node.mesh)node.mesh.visible=true
    }
    const roots=cubeRoots().map(a=>this.nodes.get(cubeKey(a))!);roots.forEach(show)
    this.setActive(roots.every(n=>!!n.mesh))
    const visible=[...this.nodes.values()].filter(n=>n.mesh?.visible),signature=visible.map(n=>`${n.key}:${n.mesh!.geometry.id}`).sort().join('|')
    if(signature!==this.stitched){stitchCubeEdges(visible.map(n=>({key:n.key,address:n.address,geometry:n.mesh!.geometry,edge:n.edge!,directions:n.directions!})));this.stitched=signature}
    const unused=[...this.nodes.values()].filter(n=>!this.wanted.has(n.key)&&!n.mesh?.visible).sort((a,b)=>a.lastUsed-b.lastUsed)
    while((this.nodes.size>MAX_NODES||this.metrics().memoryBytes>MAX_BYTES)&&unused.length){const node=unused.shift()!;this.releaseMesh(node);this.nodes.delete(node.key)}
    this.report()
  }
  private releaseMesh(node:Node){node.mesh?.removeFromParent();node.mesh?.geometry.dispose();node.mesh?.material.dispose();node.mesh?.customDepthMaterial?.dispose();node.mesh=undefined;node.edge=undefined}
  nodeSize(_node?:Node){return SIZE}
  sampleSurface:TerrainSurfaceSampler=(lat,lon,point,normal)=>{
    if(!this.active)return this.fallback(lat,lon,point,normal)
    const d=new THREE.Vector3(Math.cos(lat*Math.PI/180)*Math.cos(lon*Math.PI/180),Math.sin(lat*Math.PI/180),-Math.cos(lat*Math.PI/180)*Math.sin(lon*Math.PI/180))
    for(const node of [...this.nodes.values()].filter(n=>n.mesh).sort((a,b)=>Number(!!b.mesh?.visible)-Number(!!a.mesh?.visible)||b.address.z-a.address.z))
      if(sampleCubeSurface(node.mesh!.geometry,node.address,SIZE,d,point,normal))return true
    return false
  }
  hitGround(ray:THREE.Ray){
    this.body.updateWorldMatrix(true,true)
    const picker=new THREE.Raycaster();picker.ray.copy(ray)
    const meshes=this.active?[...this.nodes.values()].filter(n=>n.mesh?.visible).map(n=>n.mesh!):[this.body]
    return firstTerrainSurfaceHit(picker,meshes)?.point??null
  }
  cameraSurfaceRadius(position:THREE.Vector3){
    const center=this.body.getWorldPosition(new THREE.Vector3()),r=this.group.scale.x,d=position.clone().sub(center)
    if(d.length()<r*1.15){
      d.applyQuaternion(this.body.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize()
      const lat=Math.asin(THREE.MathUtils.clamp(d.y,-1,1))*180/Math.PI,lon=Math.atan2(-d.z,d.x)*180/Math.PI,p=new THREE.Vector3(),n=new THREE.Vector3()
      if(this.sampleSurface(lat,lon,p,n))return p.length()*r
      const world=position.clone().sub(center).normalize(),ground=this.hitGround(new THREE.Ray(center.clone().addScaledVector(world,r*2),world.negate()))
      if(ground)return ground.distanceTo(center)
    }
    return r*(1+(this.enabled?Math.max(0,this.source.manifest?.maxHeightMeters??0)*this.exaggeration/this.radiusMeters:0))
  }
  surfaceSignature(){return !this.active?'cube-fallback':`${this.exaggeration}/`+[...this.nodes.values()].filter(n=>n.mesh?.visible).map(n=>n.key).sort().join('|')}
  private geometryBytes(){return [...this.nodes.values()].reduce((sum,n)=>sum+(n.directions?.byteLength??0)+(n.coordinates?.byteLength??0)+(n.keys?.size??0)*64+
      (n.mesh?(Object.values(n.mesh.geometry.attributes).reduce((s,a)=>s+a.array.byteLength,0)+(n.mesh.geometry.index?.array.byteLength??0))*2:0),0)
  }
  metrics(){
    const visible=[...this.nodes.values()].filter(n=>n.mesh?.visible&&this.active),source=this.source.metrics(),bytes=this.geometryBytes()
    return {projection:'cube-sphere',ready:this.active,visible:visible.length,cached:[...this.nodes.values()].filter(n=>n.mesh).length,
      requests:source.requests,memoryBytes:bytes+source.memoryBytes,sampleSize:this.source.manifest?.sampleSize??0,
      grids:{33:visible.length,65:0,129:0},maxLevel:visible.reduce((z,n)=>Math.max(z,n.address.z),0),dataMaxLevel:visible.reduce((z,n)=>Math.max(z,n.dataZ),0),
      failed:source.failed,triangles:visible.reduce((sum,n)=>sum+(n.mesh!.geometry.index!.count/3),0),triangleBudget:400000,
      imagery:{memoryBytes:0,requests:0,cached:0,failed:0,budget:32*1048576}}
  }
  private report(){
    if(this.disposed)return
    const m=this.source?.manifest,metrics=this.source?.metrics()
    const status:TerrainStatus={body:this.bodyId,state:!this.enabled?'off':this.source?.failedManifest?'unavailable':this.active?'ready':'loading',
      loadedTiles:[...this.nodes.values()].filter(n=>n.mesh).length,failedTiles:metrics?.failed??0,
      source:m?{resolution:m.sourceResolutionMeters,credit:m.credit,url:m.sourceUrl,gaps:!!m.missingPixels,approximate:!!m.referenceSurfaceApproximation,licenseUrl:m.licenseUrl}:undefined}
    const key=JSON.stringify(status);if(key!==this.reported){this.reported=key;this.onStatus(status)}
  }
  dispose(){this.disposed=true;this.setActive(false);this.nodes.forEach(n=>this.releaseMesh(n));this.nodes.clear();this.wanted.clear();this.source.dispose();this.material.dispose();this.group.removeFromParent()}
}
