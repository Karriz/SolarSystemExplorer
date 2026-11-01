import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { surfaceState } from '../src/surfaceMaterial.ts'
import { configureMoonSurfaceMaterial, configureMoonTerrainDepth } from '../src/moonSurfaceMaterial.ts'

const chunks = () => ({
  uniforms: {},
  vertexShader: 'void main() {\n#include <begin_vertex>\n}\n',
  fragmentShader: 'void main() {\n#include <clipping_planes_fragment>\n#include <map_fragment>\n#include <normal_fragment_maps>\n}\n',
})

test('moon material samples shared normal and roughness detail without procedural noise or displacement', () => {
  const material = new THREE.MeshStandardMaterial()
  const state = surfaceState()
  const shade = configureMoonSurfaceMaterial(material, state, 1_737_400, true)
  const shader = chunks()
  material.onBeforeCompile(shader, {})
  assert.equal(shader.uniforms.moonDetail, state.detail)
  assert.equal(shader.uniforms.moonCamera, shade.camera)
  assert.equal(shader.uniforms.moonMetersPerUnit.value, 1_737_400)
  const program = shader.vertexShader + shader.fragmentShader
  assert.doesNotMatch(program, /dFdx|dFdy|149597870700/)
  assert.doesNotMatch(program, /flat varying/)
  assert.match(shader.vertexShader, /varying float vMoonFade/)
  assert.match(shader.vertexShader, /moonMeters > 0\.0 && moonMeters < 1\.0e8/)
  assert.match(shader.vertexShader, /smoothstep\(300\.0, 3000\.0, moonMeters\)/)
  assert.match(shader.vertexShader, /smoothstep\(2500\.0, 18000\.0, moonMeters\)/)
  assert.equal(shader.uniforms.moonDetailMap,state.detailMap)
  assert.equal(shader.uniforms.moonDetailReady,state.detailMapReady)
  assert.equal(shader.uniforms.moonMediumMap,state.mediumDetailMap)
  assert.equal(shader.uniforms.moonMediumReady,state.mediumDetailReady)
  assert.doesNotMatch(program,/moonNoise|moonHash|transformed\s*[+*=]/)
  assert.equal((shader.fragmentShader.match(/texture2D\(detailTexture/g)??[]).length,3)
  assert.match(shader.fragmentShader,/moonSurfaceSample\(moonDetailMap/)
  assert.match(shader.fragmentShader,/moonSurfaceSample\(moonMediumMap/)
  assert.match(shader.fragmentShader,/vMoonFade > 0.001 && moonDetailReady > 0.5/)
  assert.match(shader.fragmentShader,/vMoonMediumFade > 0.001 && moonMediumReady > 0.5/)
  assert.match(shader.fragmentShader,/roughnessFactor = mix/)
  assert.match(shader.fragmentShader, /surfaceLonLat/)
  assert.match(shader.fragmentShader, /uniform int surfaceClipCount/)
  state.detail.value = 0
  assert.equal(shader.uniforms.moonDetail.value, 0)
})

test('moon depth keeps skirt discard without a derivative normal', () => {
  const material = new THREE.MeshDepthMaterial()
  configureMoonTerrainDepth(material, surfaceState(), 1_737_400, true)
  const shader = chunks()
  shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>','')
  material.onBeforeCompile(shader, {})
  const program = shader.vertexShader + shader.fragmentShader
  assert.doesNotMatch(program, /dFdx|dFdy/)
  assert.match(shader.vertexShader, /vTerrainSkirt = terrainSkirt/)
  assert.match(shader.fragmentShader, /vTerrainSkirt > 0\.000001\) discard/)
  assert.doesNotMatch(program,/texture2D|moonDetailMap|moonMediumMap|moonNoise/)
  assert.equal(shader.uniforms.moonDetailMap,undefined)
})

for(const file of ['moon-detail.png','moon-medium-detail.png'])test(`${file} contains valid unit normals and roughness data at fixed size`, () => {
  const png=readFileSync(new URL(`../public/textures/${file}`,import.meta.url))
  assert.equal(png.readUInt32BE(16),512);assert.equal(png.readUInt32BE(20),512)
  assert.equal(png[24],8);assert.equal(png[25],6)
  const parts=[]
  for(let offset=8;offset<png.length;){const size=png.readUInt32BE(offset);if(png.toString('ascii',offset+4,offset+8)==='IDAT')parts.push(png.subarray(offset+8,offset+8+size));offset+=size+12}
  const raw=inflateSync(Buffer.concat(parts)),stride=512*4+1
  assert.equal(raw.length,stride*512)
  let variation=0
  for(let y=0;y<512;y++){
    assert.equal(raw[y*stride],0)
    for(let x=0;x<512;x++){
      const i=y*stride+1+x*4,n=[raw[i],raw[i+1],raw[i+2]].map(v=>v/255*2-1)
      assert.ok(Math.abs(Math.hypot(...n)-1)<.015)
      assert.ok(n[2]>.75, 'angular rock faces remain outward-facing and bounded')
      assert.ok(raw[i+3]>=226&&raw[i+3]<=253)
      if(Math.abs(n[0])>.02||Math.abs(n[1])>.02)variation++
    }
  }
  assert.ok(variation>10000,'normal texture contains actual relief variation')
})
