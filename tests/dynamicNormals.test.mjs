import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { GlobalHillshadeLayer } from '../src/GlobalHillshadeLayer.ts'
import { configureTerrainHillshade } from '../src/terrainHillshade.ts'
import { configurePlanetSurfaceMaterial, MOON_DETAIL_PROFILE } from '../src/planetSurfaceMaterial.ts'
import { surfaceState } from '../src/surfaceMaterial.ts'

test('dynamic RG8 normal map shader injects before fine detail and cross-fades on cube terrain', () => {
  const layer = new GlobalHillshadeLayer('moon')
  const state = surfaceState()

  // Base globe (full authority for streamed normals)
  const globeMat = new THREE.MeshStandardMaterial()
  configurePlanetSurfaceMaterial(globeMat, state, 149_597_870_700, true, undefined, undefined, MOON_DETAIL_PROFILE)
  configureTerrainHillshade(globeMat, { value: 1 }, layer, { cubeMesh: false, radiusMeters: 1737400 })
  const globeShader = {
    uniforms: {},
    vertexShader: '#include <begin_vertex>\n',
    fragmentShader: '#include <map_fragment>\n#include <normal_fragment_begin>\n#include <normal_fragment_maps>\n#include <lights_physical_fragment>\n',
  }
  globeMat.onBeforeCompile(globeShader, {})
  assert.ok(globeShader.fragmentShader.includes('hsGlobalMode > 1.5'))
  assert.ok(globeShader.fragmentShader.includes('hsDynamicWeight = terrainHillshadeEnabled;'))
  assert.ok(globeShader.fragmentShader.includes('vec2 hsGlobalSample('))
  // Dynamic normal perturbation must occur before close-range detail in normal_fragment_maps
  assert.ok(globeShader.fragmentShader.indexOf('hsMapBodyNormal') < globeShader.fragmentShader.indexOf('moonFineOn'))
  assert.ok('hsGlobalMode' in globeShader.uniforms)

  // Cube terrain mesh (distance cross-fade prevents double-counting measured vertex normals)
  const cubeMat = new THREE.MeshStandardMaterial()
  configurePlanetSurfaceMaterial(cubeMat, state, 1737400, true, undefined, undefined, MOON_DETAIL_PROFILE)
  configureTerrainHillshade(cubeMat, { value: 1 }, layer, { cubeMesh: true, radiusMeters: 1737400 })
  const cubeShader = {
    uniforms: {},
    vertexShader: '#include <begin_vertex>\n',
    fragmentShader: '#include <map_fragment>\n#include <normal_fragment_begin>\n#include <normal_fragment_maps>\n#include <lights_physical_fragment>\n',
  }
  cubeMat.onBeforeCompile(cubeShader, {})
  assert.ok(cubeShader.fragmentShader.includes('hsTexelMeters * 35.0'))
  assert.ok(cubeShader.fragmentShader.includes('mix(hsMeshBodyNormal, hsMapBodyNormal, hsDynamicWeight)'))
  // Legacy schema 1 R8 fallback remains intact
  assert.ok(cubeShader.fragmentShader.includes('mix(0.55, 1.30, encoded)'))

  layer.dispose()
  globeMat.dispose()
  cubeMat.dispose()
})
