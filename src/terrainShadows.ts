import * as THREE from 'three'

const METERS_PER_AU = 149_597_870_700

/** Fit the local view rather than a center-ray hit, which jumps to the body
 * underneath the camera as soon as that ray crosses the horizon. */
export function fitTerrainShadow(light: THREE.DirectionalLight, camera: THREE.PerspectiveCamera,
  ground: THREE.Vector3, sunlight: THREE.Vector3, altitudeMeters: number) {
  const reach = THREE.MathUtils.clamp(altitudeMeters * 12, 1500, 60000) / METERS_PER_AU
  const up = Math.abs(sunlight.y) > .95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
  const x = new THREE.Vector3().crossVectors(up, sunlight).normalize()
  const y = new THREE.Vector3().crossVectors(sunlight, x).normalize()
  const forward = camera.getWorldDirection(new THREE.Vector3())
  const points = [camera.position.clone(), ground.clone()]
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const ray = new THREE.Vector3(sx, sy, .5).unproject(camera).sub(camera.position).normalize()
    points.push(camera.position.clone().addScaledVector(ray, reach / ray.dot(forward)))
  }
  const xs = points.map(p => p.dot(x)), ys = points.map(p => p.dot(y))
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  // Padding keeps the focused view inside the fully shadowed region, leaving
  // the map's outer band available for a gradual transition to distant light.
  const halfX = Math.max(500 / METERS_PER_AU, (maxX - minX) * .65)
  const halfY = Math.max(500 / METERS_PER_AU, (maxY - minY) * .65)
  const texelX = halfX * 2 / light.shadow.mapSize.x, texelY = halfY * 2 / light.shadow.mapSize.y
  const centerX = Math.round((minX + maxX) * .5 / texelX) * texelX
  const centerY = Math.round((minY + maxY) * .5 / texelY) * texelY
  const target = x.clone().multiplyScalar(centerX).addScaledVector(y, centerY).addScaledVector(sunlight, ground.dot(sunlight))
  // Keep caster depth independent of close zoom. This includes relief up to
  // 4x exaggeration instead of slicing it off with a 1.5 km light offset.
  const depthReach = reach + 50000 / METERS_PER_AU
  light.target.position.copy(target)
  light.position.copy(target).addScaledVector(sunlight, depthReach)
  const shadow = light.shadow.camera
  shadow.up.copy(up)
  shadow.left = -halfX; shadow.right = halfX
  shadow.bottom = -halfY; shadow.top = halfY
  shadow.near = 1 / METERS_PER_AU; shadow.far = depthReach * 2
  shadow.updateProjectionMatrix()
  light.shadow.bias = -.25 / ((shadow.far - shadow.near) * METERS_PER_AU)
  light.shadow.normalBias = .5 / METERS_PER_AU
  return { points, reach }
}

/** A local shadow map has finite coverage. Blend its perimeter back to the
 * ordinary solar lighting instead of exposing a moving rectangular cut. */
export function configureTerrainShadowFade(material: THREE.Material) {
  const previous = material.onBeforeCompile, key = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    const chunk = THREE.ShaderChunk.shadowmap_pars_fragment
    const pointStart = chunk.indexOf('float getPointShadow')
    const directional = chunk.slice(0, pointStart).replaceAll('return mix( 1.0, shadow, shadowIntensity );', `
      float terrainShadowEdge = min(min(shadowCoord.x, 1.0 - shadowCoord.x), min(shadowCoord.y, 1.0 - shadowCoord.y));
      float terrainShadowFade = smoothstep(0.0, 0.08, terrainShadowEdge);
      return mix(1.0, shadow, shadowIntensity * terrainShadowFade);`)
    shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', directional + chunk.slice(pointStart))
  }
  material.customProgramCacheKey = () => key + '/terrain-shadow-fade-v1'
}
