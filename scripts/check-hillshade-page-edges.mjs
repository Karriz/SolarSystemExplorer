import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {chromium} from 'playwright'
const url=process.env.VECTOR_PREVIEW_URL||'http://127.0.0.1:5175'
const browser=await chromium.launch({headless:true,args:['--no-sandbox']})
try{
 const page=await browser.newPage();const errors=[]
 page.on('console',m=>{if(m.type()==='error')errors.push(m.text())})
 await page.route('**/surface-edge-fixture',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Hillshade boundary fixture</title>'}))
 await page.goto(url+'/surface-edge-fixture')
 const samples=await page.evaluate(async()=>{
  const THREE=await import('/node_modules/.vite/deps/three.js')
  const {globalHillshadeDeclarations}=await import('/src/GlobalHillshadeLayer.ts')
  const renderer=new THREE.WebGLRenderer({antialias:false});renderer.setSize(512,16)
  const base=new THREE.DataTexture(new Uint8Array([100,100,100,100]),2,2,THREE.RedFormat);base.minFilter=base.magFilter=THREE.LinearFilter;base.needsUpdate=true
  const pages=new THREE.DataArrayTexture(new Uint8Array(260*260).fill(200),260,260,1);pages.format=THREE.RedFormat;pages.minFilter=pages.magFilter=THREE.LinearFilter;pages.needsUpdate=true
  const data=new Uint8Array(2*6*4);data[(5*2)*4]=1;data[(5*2)*4+1]=255
  const table=new THREE.DataTexture(data,2,6);table.needsUpdate=true
  const material=new THREE.ShaderMaterial({glslVersion:THREE.GLSL3,uniforms:{hsGlobalBase:{value:base},hsGlobalPages:{value:pages},hsGlobalTable:{value:table},hsGlobalPoolReady:{value:1},hsGlobalLevels:{value:Array.from({length:6},(_,z)=>new THREE.Vector4(512,256,z,0))}},vertexShader:'out vec2 edgeUv; void main(){edgeUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}',fragmentShader:'in vec2 edgeUv; out vec4 edgeColor;\n'+globalHillshadeDeclarations+'\nvoid main(){edgeColor=vec4(vec3(hsGlobalSample(edgeUv,5)),1.0);}'})
  const geometry=new THREE.PlaneGeometry(2,2),mesh=new THREE.Mesh(geometry,material),scene=new THREE.Scene();scene.add(mesh)
  renderer.render(scene,new THREE.OrthographicCamera(-1,1,1,-1,0,1))
  const pixels=new Uint8Array(512*4);const gl=renderer.getContext();gl.readPixels(0,8,512,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels)
  const result=Object.fromEntries([0,1,128,252,254,255,256,257,384,510,511].map(x=>[x,pixels[x*4]]))
  const cornerData=new Uint8Array(2*12*4)
  for(const [x,y]of [[0,10],[1,10],[0,11]]){cornerData[(y*2+x)*4]=1;cornerData[(y*2+x)*4+1]=255}
  const cornerTable=new THREE.DataTexture(cornerData,2,12);cornerTable.needsUpdate=true
  material.uniforms.hsGlobalTable.value=cornerTable
  material.uniforms.hsGlobalLevels.value.forEach((v,z)=>v.set(512,512,z*2,0))
  renderer.setSize(512,512);renderer.render(scene,new THREE.OrthographicCamera(-1,1,1,-1,0,1))
  const cornerPixels=new Uint8Array(4*4*4);gl.readPixels(254,254,4,4,gl.RGBA,gl.UNSIGNED_BYTE,cornerPixels)
  const corners=[cornerPixels[(1*4+1)*4],cornerPixels[(1*4+2)*4],cornerPixels[(2*4+1)*4],cornerPixels[(2*4+2)*4]]
  geometry.dispose();material.dispose();base.dispose();pages.dispose();table.dispose();cornerTable.dispose();renderer.dispose()
  return {edge:result,corners}
 })
 console.log(JSON.stringify(samples))
 await mkdir('.terrain-cache/global-surfaces-browser',{recursive:true})
 await writeFile('.terrain-cache/global-surfaces-browser/edge-fixture.json',JSON.stringify({samples,errors},null,2))
 assert.deepEqual(errors,[]);assert.ok(Math.abs(samples.edge[128]-200)<=1);assert.ok(Math.abs(samples.edge[384]-100)<=1)
 assert.ok(Math.abs(samples.edge[255]-samples.edge[256])<=8,'A missing neighbor must not create a hard tile boundary')
 assert.ok(Math.abs(samples.edge[0]-samples.edge[511])<=8,'Partial-residency longitude wrap must be continuous')
 assert.ok(Math.max(...samples.corners)-Math.min(...samples.corners)<=8,'A missing diagonal neighbor must not create a corner discontinuity')
}finally{await browser.close()}
