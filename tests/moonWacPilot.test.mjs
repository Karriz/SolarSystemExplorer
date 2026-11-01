import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as THREE from 'three'
import { MoonWacPilot } from '../src/MoonWacPilot.ts'

test('WAC pilot loads only when enabled, reuses maps, and releases them on disposal', async t => {
  const maps = [], urls = []
  t.mock.method(THREE.TextureLoader.prototype, 'loadAsync', async url => { urls.push(url); const map = new THREE.Texture(); maps.push(map); return map })
  const pilot = new MoonWacPilot(), material = new THREE.MeshStandardMaterial()
  pilot.configure(material)
  const shader = { uniforms: {}, fragmentShader: '#include <map_fragment>', vertexShader: '' }
  material.onBeforeCompile(shader, {})
  assert.equal(urls.length, 0)
  assert.equal(shader.uniforms.wacPilotEnabled.value, 0)
  await pilot.setEnabled(true)
  assert.equal(urls.length, 2)
  assert.equal(shader.uniforms.wacPilotEnabled.value, 1)
  assert.equal(shader.uniforms.wacHadley.value, maps[0])
  await pilot.setEnabled(false); await pilot.setEnabled(true)
  assert.equal(urls.length, 2)
  let disposed = 0
  maps.forEach(map => map.addEventListener('dispose', () => disposed++))
  pilot.dispose()
  assert.equal(disposed, 2)
  assert.equal(shader.uniforms.wacPilotEnabled.value, 0)
})

test('failed or late WAC loads never enable the pilot and dispose completed maps', async t => {
  let release, disposed = 0
  const map = new THREE.Texture(); map.addEventListener('dispose', () => disposed++)
  let index = 0
  t.mock.method(THREE.TextureLoader.prototype, 'loadAsync', () => ++index === 1 ? new Promise(resolve => { release = resolve }) : Promise.reject(Error('unavailable')))
  const pilot = new MoonWacPilot(), material = new THREE.MeshStandardMaterial()
  pilot.configure(material)
  const shader = { uniforms: {}, fragmentShader: '#include <map_fragment>', vertexShader: '' }
  material.onBeforeCompile(shader, {})
  const pending = pilot.setEnabled(true)
  pilot.dispose(); release(map)
  await assert.rejects(pending, /Could not load/)
  assert.equal(disposed, 1)
  assert.equal(shader.uniforms.wacPilotEnabled.value, 0)
})
