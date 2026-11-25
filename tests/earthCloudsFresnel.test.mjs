import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { earthAtmosphere, marsAtmosphere, titanAtmosphere } from '../src/atmosphereProfiles.ts'
import { atmosphereViewShader } from '../src/atmosphereShader.ts'
import { AtmosphereRenderer } from '../src/AtmosphereRenderer.ts'
import { configureAtmosphericLighting } from '../src/atmosphericLighting.ts'
import { configureEarthSurfaceMaterial } from '../src/earthSurfaceMaterial.ts'
import { configureLiquidSurfaceMaterial, liquidMaterialState } from '../src/liquidSurfaceMaterial.ts'
import { surfaceState } from '../src/surfaceMaterial.ts'
import { configurePlanetSurfaceMaterial } from '../src/planetSurfaceMaterial.ts'
import { TITAN_DETAIL_PROFILE } from '../src/planetSurfaceMaterial.ts'

test('Earth atmosphere shader integrates observed cloud layer and keeps other bodies isolated', () => {
  const earthGlsl = atmosphereViewShader(earthAtmosphere)
  assert.ok(earthGlsl.includes('uniform sampler2D atmEarthClouds;'))
  assert.ok(earthGlsl.includes('atmEarthCloudDensity'))
  assert.ok(earthGlsl.includes('atmEarthCloudRadiance'))
  assert.ok(earthGlsl.includes('atmEarthCloudShadow'))
  assert.ok(earthGlsl.includes('atmSkyReflection'))
  // Ensure no duplicate atmViewToBody uniform declaration
  assert.equal((earthGlsl.match(/uniform mat3 atmViewToBody;/g) ?? []).length, 1)

  const marsGlsl = atmosphereViewShader(marsAtmosphere)
  assert.ok(!marsGlsl.includes('atmEarthClouds'))
  assert.ok(marsGlsl.includes('atmSkyReflection'))
  assert.equal((marsGlsl.match(/uniform mat3 atmViewToBody;/g) ?? []).length, 1)
})

test('Earth surface material binds cloud shadows and Fresnel sky reflections on water', () => {
  const material = new THREE.MeshStandardMaterial()
  const state = surfaceState()
  const earthState = { global: { value: new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat) }, globalReady: { value: 1 }, time: { value: 0 } }
  const air = new AtmosphereRenderer(earthAtmosphere)
  configureEarthSurfaceMaterial(material, state, earthState, 6371000, false)
  configureAtmosphericLighting(material, air.lighting, false, earthAtmosphere)

  const shader = {
    uniforms: {},
    vertexShader: '#include <begin_vertex>\n#include <uv_vertex>\n',
    fragmentShader: '#include <map_fragment>\n#include <normal_fragment_maps>\n#include <lights_physical_fragment>\n#include <lights_fragment_begin>\n#include <lights_fragment_end>\n',
  }
  material.onBeforeCompile(shader, {})
  assert.ok(shader.fragmentShader.includes('atmEarthCloudShadow(atmSurfacePoint)'))
  assert.ok(shader.fragmentShader.includes('float surfaceLiquidWeight=earthWater;'))
  assert.ok(shader.fragmentShader.includes('atmSkyReflection(atmSurfacePoint, atmReflBody)'))
  assert.ok(shader.fragmentShader.includes('reflectedLight.indirectSpecular += atmReflSky'))
  assert.ok('atmViewToBody' in shader.uniforms)
  assert.ok('atmEarthClouds' in shader.uniforms)
  air.dispose()
  material.dispose()
  earthState.global.value.dispose()
})

test('Titan hydrocarbon sea material binds Fresnel sky reflections via shared atmospheric lighting', () => {
  const material = new THREE.MeshStandardMaterial()
  const state = surfaceState()
  const liquid = liquidMaterialState()
  const air = new AtmosphereRenderer(titanAtmosphere)
  configurePlanetSurfaceMaterial(material, state, 2575000, false, undefined, undefined, TITAN_DETAIL_PROFILE)
  configureLiquidSurfaceMaterial(material, liquid, { color: [0.018, 0.023, 0.03], roughness: 0.14, waveStrength: 0.014 })
  configureAtmosphericLighting(material, air.lighting, false, titanAtmosphere)

  const shader = {
    uniforms: {},
    vertexShader: '#include <begin_vertex>\n',
    fragmentShader: '#include <map_fragment>\n#include <normal_fragment_maps>\n#include <lights_physical_fragment>\n#include <lights_fragment_begin>\n#include <lights_fragment_end>\n',
  }
  material.onBeforeCompile(shader, {})
  assert.ok(shader.fragmentShader.includes('float surfaceLiquidF0 = 0.017;'))
  assert.ok(shader.fragmentShader.includes('atmSkyReflection(atmSurfacePoint, atmReflBody)'))
  assert.ok(!shader.fragmentShader.includes('atmEarthCloudShadow'))
  air.dispose()
  material.dispose()
})
