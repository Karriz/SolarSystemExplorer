import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import * as THREE from 'three'
import { earthColorUvs, earthColorTransform, configureEarthColor } from '../src/earthImagery.ts'
import { mercatorAddress, mercatorBounds } from '../src/terrainPilot.ts'

// Exercise the actual material's UV assignment on WebGL, without network tiles
// or a costly globe scene. CPU-only projection tests missed GPU math error.
const option = name => { const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1] }
const browser = await chromium.launch({ headless:true, executablePath:option('--executable'), args:['--no-sandbox'] })
try {
  const page=await browser.newPage()
  for(const [lon,lat] of [[24.6,60.38],[8.02,46.57],[14.58,-21.12],[179.99,85],[-179.99,-85]]) for(const z of [8,14,15]) {
    const a=mercatorAddress(lon,lat,z),local=earthColorUvs(mercatorBounds(a),9,a)
    for(const parentLevels of [0,2]){
      const p={z:z-parentLevels,x:Math.floor(a.x/2**parentLevels),y:Math.floor(a.y/2**parentLevels)},texture=new THREE.Texture(),material=new THREE.MeshStandardMaterial()
      texture.repeat.set(2**p.z,2**p.z);texture.offset.set(-p.x,-(2**p.z-p.y-1))
      const transform=earthColorTransform(a,texture)
      configureEarthColor(material,{value:1},{value:null},{value:transform})
      const shader={uniforms:{},vertexShader:`in vec2 uv; out vec2 vMapUv; uniform mat3 mapTransform;
void main(){
#include <uv_vertex>
gl_Position=vec4(0,0,0,1);
}`,fragmentShader:'#include <map_fragment>'}
      material.onBeforeCompile(shader,null)
      const vertex='#version 300 es\nprecision highp float;\n#define USE_MAP\n'+shader.vertexShader.replaceAll('attribute ','in ').replaceAll('varying ','out ').replace('#include <uv_vertex>','')
      const output=await page.evaluate(({vertex,local,transform})=>{
        const gl=document.createElement('canvas').getContext('webgl2')
        if(!gl)throw Error('WebGL2 unavailable')
        const program=gl.createProgram()
        for(const [type,source]of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(1);}']]){
          const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader)
          if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader))
          gl.attachShader(program,shader)
        }
        gl.transformFeedbackVaryings(program,['vMapUv'],gl.INTERLEAVED_ATTRIBS);gl.linkProgram(program)
        if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program))
        gl.useProgram(program);gl.uniform1f(gl.getUniformLocation(program,'earthColorActive'),1)
        gl.uniform4fv(gl.getUniformLocation(program,'earthColorTransform'),transform)
        const input=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,input);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(local),gl.STATIC_DRAW)
        const loc=gl.getAttribLocation(program,'earthColorUv');gl.enableVertexAttribArray(loc);gl.vertexAttribPointer(loc,2,gl.FLOAT,false,0,0)
        const buffer=gl.createBuffer();gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER,0,buffer);gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER,local.length*4,gl.DYNAMIC_READ)
        gl.enable(gl.RASTERIZER_DISCARD);gl.beginTransformFeedback(gl.POINTS);gl.drawArrays(gl.POINTS,0,local.length/2);gl.endTransformFeedback()
        const output=new Float32Array(local.length);gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER,0,output)
        const ext=gl.getExtension('WEBGL_debug_renderer_info'),renderer=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)
        gl.getExtension('WEBGL_lose_context')?.loseContext()
        return {values:Array.from(output),renderer}
      },{vertex,local:Array.from(local.array),transform:transform.toArray()})
      let maxError=0
      for(let i=0;i<output.values.length;i++){
        const expected=local.array[i]*(i%2?transform.y:transform.x)+(i%2?transform.w:transform.z)
        maxError=Math.max(maxError,Math.abs(output.values[i]-expected))
      }
      assert.ok(maxError<1/256/256,`Projection error exceeds 1/256 of a texel: ${maxError}`)
      console.log(JSON.stringify({lat,z,parentLevels,maxTexelError:maxError*256,renderer:output.renderer}))
      material.dispose();texture.dispose()
    }
  }
}finally{await browser.close()}
