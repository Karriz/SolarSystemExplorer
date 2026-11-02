import * as THREE from 'three'
import type { CubeAddress } from './cubeSphere.ts'
import type { TerrainEdge } from './terrainEdges.ts'

type Patch={key:string;address:CubeAddress;geometry:THREE.BufferGeometry;edge:TerrainEdge;directions:Float64Array}
type Edge={patch:Patch;rank:number;ids:number[];coordinates:number[];low:number;high:number;key:string}

/** Edges are lines on the unnormalized cube: two coordinates are fixed and
 * one varies. That identity is shared across all six face orientations. */
export function stitchCubeEdges(patches:Patch[]){
  const ordered=[...patches].sort((a,b)=>a.address.z-b.address.z||a.key.localeCompare(b.key)),lines=new Map<string,Edge[]>()
  const d=new THREE.Vector3(),point=new THREE.Vector3(),normal=new THREE.Vector3()
  ordered.forEach((patch,rank)=>{
    const p=patch.geometry.getAttribute('position'),n=patch.geometry.getAttribute('normal'),size=patch.edge.size
    patch.edge.indices.forEach((index,i)=>{p.setXYZ(index,patch.edge.positions[i*3],patch.edge.positions[i*3+1],patch.edge.positions[i*3+2]);n.setXYZ(index,patch.edge.normals[i*3],patch.edge.normals[i*3+1],patch.edge.normals[i*3+2])})
    const sides=[Array.from({length:size},(_,i)=>i),Array.from({length:size},(_,i)=>i*size+size-1),
      Array.from({length:size},(_,i)=>(size-1)*size+i),Array.from({length:size},(_,i)=>i*size)]
    sides.forEach(ids=>{
      const cubes=ids.map(i=>{d.fromArray(patch.directions,i*3);return d.clone().divideScalar(Math.max(Math.abs(d.x),Math.abs(d.y),Math.abs(d.z)))})
      let axis=0
      for(let k=1;k<3;k++)if(Math.abs(cubes[0].getComponent(k)-cubes[size-1].getComponent(k))>Math.abs(cubes[0].getComponent(axis)-cubes[size-1].getComponent(axis)))axis=k
      const key=`${axis}/`+[0,1,2].filter(k=>k!==axis).map(k=>cubes[0].getComponent(k).toFixed(12)).join('/')
      let coordinates=cubes.map(v=>v.getComponent(axis))
      if(coordinates[0]>coordinates[size-1]){ids=ids.reverse();coordinates=coordinates.reverse()}
      const edge={patch,rank,ids,coordinates,low:coordinates[0],high:coordinates[size-1],key}
      const list=lines.get(key)??[];list.push(edge);lines.set(key,list)
    })
  })
  ordered.forEach((patch,rank)=>{
    const p=patch.geometry.getAttribute('position'),n=patch.geometry.getAttribute('normal')
    for(const edges of lines.values())for(const edge of edges)if(edge.patch===patch){
      edge.ids.forEach((id,i)=>{
        const value=edge.coordinates[i],owner=edges.find(other=>other.rank<rank&&value>=other.low-1e-10&&value<=other.high+1e-10)
        if(!owner)return
        let lo=0,hi=owner.coordinates.length-1
        while(hi-lo>1){const mid=(lo+hi)>>1;if(owner.coordinates[mid]<=value)lo=mid;else hi=mid}
        const f=THREE.MathUtils.clamp((value-owner.coordinates[lo])/(owner.coordinates[hi]-owner.coordinates[lo]),0,1)
        const a=owner.patch.geometry.getAttribute('position'),an=owner.patch.geometry.getAttribute('normal'),first=owner.ids[lo],second=owner.ids[hi]
        point.fromBufferAttribute(a,first).lerp(d.fromBufferAttribute(a,second),f)
        normal.fromBufferAttribute(an,first).lerp(d.fromBufferAttribute(an,second),f).normalize()
        p.setXYZ(id,point.x,point.y,point.z);n.setXYZ(id,normal.x,normal.y,normal.z)
      })
    }
    patch.edge.indices.forEach((id,i)=>{
      const bottom=patch.edge.skirtIndices[i]
      point.fromBufferAttribute(p,id);point.setLength(point.length()-patch.edge.skirtDepths[i])
      p.setXYZ(bottom,point.x,point.y,point.z);n.setXYZ(bottom,n.getX(id),n.getY(id),n.getZ(id))
    })
    p.needsUpdate=true;n.needsUpdate=true;patch.geometry.computeBoundingSphere();patch.geometry.computeBoundingBox()
  })
}
