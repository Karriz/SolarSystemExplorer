import * as THREE from 'three'

const METERS_PER_AU = 149_597_870_700

/** Ground-anchored coverage must not change when the camera only rotates:
 * fitting a short view frustum clips previously visible shadows on pitch-up. */
export function fitTerrainShadow(light: THREE.DirectionalLight, camera: THREE.PerspectiveCamera,
  ground: THREE.Vector3, sunlight: THREE.Vector3, altitudeMeters: number,
  bodyCenter = new THREE.Vector3(), bodyRadius = ground.distanceTo(bodyCenter)) {
  const altitude = Math.max(0, altitudeMeters) / METERS_PER_AU
  // Include the local horizon even at the clearance floor, plus nearby crater
  // walls that rise above it. The 30 km floor keeps close crater views covered.
  const reach = Math.max(30000 / METERS_PER_AU, Math.sqrt(altitude * (2 * bodyRadius + altitude)))
  // The supported Earth/Moon terrain envelope includes 4x relief. Allow for
  // curvature below the tangent plane as coverage grows with altitude.
  const relief = 50000 / METERS_PER_AU
  const radial = ground.clone().sub(bodyCenter).normalize()
  const tangentX = new THREE.Vector3().crossVectors(radial, Math.abs(radial.y) > .95
    ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize()
  const tangentY = new THREE.Vector3().crossVectors(radial, tangentX)
  const points = [camera.position.clone(), ground.clone()]
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    points.push(ground.clone().addScaledVector(tangentX, sx * reach).addScaledVector(tangentY, sy * reach)
      .addScaledVector(radial, sz > 0 ? relief : -relief - reach * reach / bodyRadius))
  }
  const up = Math.abs(sunlight.y) > .95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
  const x = new THREE.Vector3().crossVectors(up, sunlight).normalize()
  const y = new THREE.Vector3().crossVectors(sunlight, x).normalize()
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
  // Include every possible upstream caster inside this light-space footprint.
  // A fixed 50 km depth can omit distant rims under a grazing Sun. Intersect
  // the footprint with the body's outer sphere to bound the sunward depth.
  const dx = Math.max(0, Math.abs(centerX - bodyCenter.dot(x)) - halfX)
  const dy = Math.max(0, Math.abs(centerY - bodyCenter.dot(y)) - halfY)
  const outerRadius = bodyRadius + relief
  const front = bodyCenter.dot(sunlight) + Math.sqrt(Math.max(0, outerRadius * outerRadius - dx * dx - dy * dy))
  const zs = points.map(p => p.dot(sunlight))
  const margin = 1000 / METERS_PER_AU
  const lightZ = Math.max(front, ...zs) + margin
  const depthReach = lightZ - target.dot(sunlight)
  light.target.position.copy(target)
  light.position.copy(target).addScaledVector(sunlight, depthReach)
  const shadow = light.shadow.camera
  shadow.up.copy(up)
  shadow.left = -halfX; shadow.right = halfX
  shadow.bottom = -halfY; shadow.top = halfY
  shadow.near = 1 / METERS_PER_AU; shadow.far = lightZ - Math.min(...zs) + margin
  shadow.updateProjectionMatrix()
  light.shadow.bias = -.25 / ((shadow.far - shadow.near) * METERS_PER_AU)
  light.shadow.normalBias = .5 / METERS_PER_AU
  return { points, reach }
}

/** Fade finite coverage and compensate PCF depth comparisons for the receiver
 * slope, so wider ground coverage doesn't introduce striped self-shadowing. */
export function configureTerrainShadowFade(material: THREE.Material) {
  const previous = material.onBeforeCompile, key = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    const chunk = THREE.ShaderChunk.shadowmap_pars_fragment
    const pointStart = chunk.indexOf('float getPointShadow')
    const directional = chunk.slice(0, pointStart)
      // Only PCF has this unconditional bias statement. Derivatives must be
      // evaluated before the frustum branch, using the actual triangle plane.
      .replace('shadowCoord.z += shadowBias;', `shadowCoord.z += shadowBias;
      vec3 terrainShadowDx = dFdx(shadowCoord.xyz);
      vec3 terrainShadowDy = dFdy(shadowCoord.xyz);
      float terrainShadowDet = terrainShadowDx.x * terrainShadowDy.y - terrainShadowDx.y * terrainShadowDy.x;
      vec2 terrainShadowSlope = vec2(0.0);
      if (abs(terrainShadowDet) > 1e-20) {
        terrainShadowSlope = vec2(terrainShadowDy.y * terrainShadowDx.z - terrainShadowDx.y * terrainShadowDy.z,
          terrainShadowDx.x * terrainShadowDy.z - terrainShadowDy.x * terrainShadowDx.z) / terrainShadowDet;
      }
      // Cover the disk taps and hardware PCF's half-texel footprint. Clamp at
      // degenerate/grazing triangles rather than allowing unbounded offsets.
      shadowCoord.z -= min(0.001, dot(abs(terrainShadowSlope), vec2(1.0) / shadowMapSize) * (shadowRadius + 0.5));`)
      .replaceAll('return mix( 1.0, shadow, shadowIntensity );', `
      float terrainShadowEdge = min(min(shadowCoord.x, 1.0 - shadowCoord.x), min(shadowCoord.y, 1.0 - shadowCoord.y));
      float terrainShadowFade = smoothstep(0.0, 0.08, terrainShadowEdge);
      return mix(1.0, shadow, shadowIntensity * terrainShadowFade);`)
    shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>', directional + chunk.slice(pointStart))
  }
  material.customProgramCacheKey = () => key + '/terrain-shadow-fade-v2'
}
