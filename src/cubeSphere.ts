import * as THREE from 'three'

export type CubeAddress = { face: number; z: number; x: number; y: number }
const bases = [
  [[1,0,0],[0,0,-1],[0,-1,0]], [[-1,0,0],[0,0,1],[0,-1,0]],
  [[0,1,0],[1,0,0],[0,0,1]], [[0,-1,0],[1,0,0],[0,0,-1]],
  [[0,0,1],[1,0,0],[0,-1,0]], [[0,0,-1],[-1,0,0],[0,-1,0]],
].map(face => face.map(v => new THREE.Vector3(...v)))

export const cubeKey = (a: CubeAddress) => `${a.face}/${a.z}/${a.x}/${a.y}`
export const cubeRoots = (): CubeAddress[] => Array.from({length:6},(_,face)=>({face,z:0,x:0,y:0}))
export const cubeChildren = (a: CubeAddress): CubeAddress[] => [0,1,2,3].map(i=>({face:a.face,z:a.z+1,x:a.x*2+i%2,y:a.y*2+Math.floor(i/2)}))
const tangent = (v: number) => v === 1 || v === -1 ? v : Math.tan(v * Math.PI / 4)

/** Equiangular cube: every face has a regular, nonsingular parameter grid. */
export function cubeDirection(face: number, u: number, v: number, target = new THREE.Vector3()) {
  const [n,a,b]=bases[face]
  return target.copy(n).addScaledVector(a,tangent(u)).addScaledVector(b,tangent(v)).normalize()
}

export function cubeFaceUv(face: number, direction: THREE.Vector3) {
  const [n,a,b]=bases[face], d=direction.dot(n)
  if (d<=0) return null
  return {u:Math.atan(direction.dot(a)/d)*4/Math.PI,v:Math.atan(direction.dot(b)/d)*4/Math.PI}
}

export function cubeAddress(direction: THREE.Vector3, z: number): CubeAddress {
  let face=0, distance=-Infinity
  bases.forEach(([n],i)=>{const d=direction.dot(n);if(d>distance){distance=d;face=i}})
  const uv=cubeFaceUv(face,direction)!, count=2**z
  return {face,z,x:Math.min(count-1,Math.max(0,Math.floor((uv.u+1)*.5*count))),
    y:Math.min(count-1,Math.max(0,Math.floor((uv.v+1)*.5*count)))}
}

export function cubeUvBounds(a: CubeAddress) {
  const span=2/2**a.z
  return {left:-1+a.x*span,right:-1+(a.x+1)*span,top:-1+a.y*span,bottom:-1+(a.y+1)*span}
}

export function cubeGrid(a: CubeAddress, size: number) {
  const b=cubeUvBounds(a), directions=new Float64Array(size*size*3), point=new THREE.Vector3()
  for(let r=0;r<size;r++)for(let c=0;c<size;c++){
    cubeDirection(a.face,b.left+(b.right-b.left)*c/(size-1),b.top+(b.bottom-b.top)*r/(size-1),point)
    directions.set(point.toArray(),(r*size+c)*3)
  }
  return directions
}

export type CubeHeightSample = { height: number; normal?: THREE.Vector3 }
export function cubeTerrainGeometry(a: CubeAddress, size: number, sample: (direction: THREE.Vector3)=>CubeHeightSample,
  radiusMeters: number, exaggeration=1, skirts=true, directions:Float64Array=cubeGrid(a,size)) {
  const positions:number[]=[],normals:number[]=[],uvs:number[]=[],coverage:number[]=[],indices:number[]=[]
  const d=new THREE.Vector3(),center=cubeDirection(a.face,(cubeUvBounds(a).left+cubeUvBounds(a).right)/2,(cubeUvBounds(a).top+cubeUvBounds(a).bottom)/2)
  const centerU=(Math.atan2(-center.z,center.x)+Math.PI)/(2*Math.PI)
  for(let i=0;i<size*size;i++){
    d.fromArray(directions,i*3)
    const s=sample(d),h=Number.isFinite(s.height)?s.height:0,p=d.clone().multiplyScalar(1+h*exaggeration/radiusMeters)
    positions.push(...p.toArray());normals.push(...(s.normal??d).toArray());coverage.push(Number.isFinite(s.height)?1:0)
    let u=(Math.atan2(-d.z,d.x)+Math.PI)/(2*Math.PI)
    u+=Math.round(centerU-u)
    uvs.push(u,(Math.asin(THREE.MathUtils.clamp(d.y,-1,1))+Math.PI/2)/Math.PI)
    const r=Math.floor(i/size),c=i%size
    if(r<size-1&&c<size-1)indices.push(i,i+size,i+1,i+1,i+size,i+size+1)
  }
  const edge=[...Array.from({length:size},(_,c)=>c),...Array.from({length:size-1},(_,r)=>(r+1)*size+size-1),
    ...Array.from({length:size-1},(_,c)=>size*size-2-c),...Array.from({length:size-2},(_,r)=>(size-2-r)*size)]
  if(skirts){
    const depth=Math.max(1500,radiusMeters*(1-Math.cos(Math.PI/2/2**a.z/(size-1))))*exaggeration/radiusMeters
    edge.forEach(i=>{
      d.fromArray(positions,i*3).setLength(d.fromArray(positions,i*3).length()-depth)
      positions.push(...d.toArray());normals.push(...normals.slice(i*3,i*3+3));uvs.push(...uvs.slice(i*2,i*2+2));coverage.push(coverage[i])
    })
    edge.forEach((a,i)=>{const j=(i+1)%edge.length,b=edge[j],c=size*size+i,d=size*size+j;indices.push(a,b,c,b,d,c)})
  }
  const geometry=new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3))
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3))
  geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2))
  geometry.setAttribute('terrainCoverage',new THREE.Float32BufferAttribute(coverage,1))
  const skirt=new Float32Array(positions.length/3);if(skirts)skirt.fill(1,size*size)
  geometry.setAttribute('terrainSkirt',new THREE.BufferAttribute(skirt,1));geometry.setIndex(indices)
  geometry.computeBoundingSphere();geometry.computeBoundingBox()
  geometry.userData.cube={address:a,size}
  return geometry
}

export function cubeSphereGeometry(radius: number, size=33) {
  const positions:number[]=[],normals:number[]=[],uvs:number[]=[],indices:number[]=[]
  for(const a of cubeRoots()){
    const g=cubeTerrainGeometry(a,size,()=>({height:0}),1,1,false),offset=positions.length/3
    positions.push(...g.getAttribute('position').array);normals.push(...g.getAttribute('normal').array);uvs.push(...g.getAttribute('uv').array)
    indices.push(...Array.from(g.index!.array,i=>i+offset));g.dispose()
  }
  const geometry=new THREE.BufferGeometry()
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions.map(v=>v*radius),3))
  geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));geometry.setIndex(indices)
  geometry.computeBoundingSphere();geometry.userData.cubeSphereSize=size
  const result=geometry as THREE.BufferGeometry & {parameters:{radius:number}}
  result.parameters={radius};return result
}

/** Fast physical picking: intersect the cells near the cube projection, never
 * skirts. Face-edge rounding uses adjacent cells just like the geographic path. */
export function sampleCubeSurface(geometry:THREE.BufferGeometry,a:CubeAddress,size:number,direction:THREE.Vector3,
  point:THREE.Vector3,normal:THREE.Vector3,offset=0,unitScale=1){
  const uv=cubeFaceUv(a.face,direction),b=cubeUvBounds(a)
  if(!uv||uv.u<b.left-1e-9||uv.u>b.right+1e-9||uv.v<b.top-1e-9||uv.v>b.bottom+1e-9)return false
  const row=Math.floor((uv.v-b.top)/(b.bottom-b.top)*(size-1)),col=Math.floor((uv.u-b.left)/(b.right-b.left)*(size-1))
  const ray=new THREE.Ray(direction.clone().multiplyScalar(2),direction.clone().negate()),p=geometry.getAttribute('position'),n=geometry.getAttribute('normal')
  const va=new THREE.Vector3(),vb=new THREE.Vector3(),vc=new THREE.Vector3(),bary=new THREE.Vector3(),triangle=new THREE.Triangle()
  for(let r=Math.max(0,row-1);r<=Math.min(size-2,row+1);r++)for(let c=Math.max(0,col-1);c<=Math.min(size-2,col+1);c++)for(let half=0;half<2;half++){
    const base=offset+r*size+c,ia=base+half,ib=base+size,ic=base+1+half*size
    va.fromBufferAttribute(p,ia).multiplyScalar(unitScale);vb.fromBufferAttribute(p,ib).multiplyScalar(unitScale);vc.fromBufferAttribute(p,ic).multiplyScalar(unitScale)
    triangle.set(va,vb,vc)
    // A ray exactly on a shared face edge can round a few ulps outside a
    // triangle. Intersect the plane, then accept only tiny barycentric error.
    triangle.getNormal(bary)
    const denominator=bary.dot(ray.direction)
    if(Math.abs(denominator)<1e-14)continue
    const distance=bary.dot(va.clone().sub(ray.origin))/denominator
    if(distance<0)continue
    ray.at(distance,point);triangle.getBarycoord(point,bary)
    if(bary.x< -1e-7||bary.y< -1e-7||bary.z< -1e-7)continue
    bary.max(new THREE.Vector3()).divideScalar(Math.max(1e-20,Math.max(0,bary.x)+Math.max(0,bary.y)+Math.max(0,bary.z)))
    point.copy(va).multiplyScalar(bary.x).addScaledVector(vb,bary.y).addScaledVector(vc,bary.z)
    normal.fromBufferAttribute(n,ia).multiplyScalar(bary.x).addScaledVector(vb.fromBufferAttribute(n,ib),bary.y).addScaledVector(vc.fromBufferAttribute(n,ic),bary.z).normalize()
    return true
  }
  return false
}
