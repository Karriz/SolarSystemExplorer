import assert from 'node:assert/strict'
import { test } from 'node:test'
import { earthColorUvs, earthColorTransform } from '../src/earthProjection.ts'
import { mercatorBounds, mercatorAddress } from '../src/terrainPilot.ts'
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`)

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
