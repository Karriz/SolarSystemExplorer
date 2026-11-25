import * as THREE from 'three'
import { AU_KM, giantPlanetProfiles, isGiantBody } from './giantPlanetProfiles.ts'
import { bodyInfo, parentOf, satelliteOrder, satelliteParents, type BodyId } from './ephemeris.ts'

export const MAX_ECLIPSE_OCCLUDERS = 4
const SUN_RADIUS_KM = bodyInfo.sun.radiusKm

/** Mean Bond albedo and linear sRGB tint for planetshine reflection. */
const REFLECTOR_PROFILES: Partial<Record<BodyId, { bondAlbedo: number; color: readonly [number, number, number] }>> = {
  earth: { bondAlbedo: 0.306, color: [0.46, 0.66, 0.96] },
  jupiter: { bondAlbedo: 0.503, color: [0.92, 0.80, 0.64] },
  saturn: { bondAlbedo: 0.342, color: [0.95, 0.86, 0.65] },
  uranus: { bondAlbedo: 0.300, color: [0.68, 0.88, 0.90] },
  neptune: { bondAlbedo: 0.290, color: [0.56, 0.78, 0.92] },
}

export type PlanetaryLightingState = ReturnType<typeof planetaryLightingState>

export function planetaryLightingState() {
  return {
    plSunDir: { value: new THREE.Vector3(1, 0, 0) },
    plSunRadiusRad: { value: 0.00465 },
    plOccluderCount: { value: 0 },
    /** Body-local km center (xyz) and equatorial radius km (w). */
    plOccluders: { value: Array.from({ length: MAX_ECLIPSE_OCCLUDERS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    /** Slot-0 oblateness: body-local unit polar axis (xyz) and polar/equatorial ratio (w). */
    plOblateAxis: { value: new THREE.Vector4(0, 1, 0, 1) },
    /** Slot-0 refracted red atmospheric umbra strength (Earth eclipsing Moon). */
    plUmbraTint: { value: new THREE.Vector3(0, 0, 0) },
    /** Optional Saturn ring plane for Saturn's moons (axis xyz, enabled w). */
    plRingAxis: { value: new THREE.Vector4(0, 1, 0, 0) },
    /** Planetshine direction in body-local space (unit vector toward parent). */
    plShineDir: { value: new THREE.Vector3(0, 1, 0) },
    /** Planetshine linear irradiance RGB (0 when absent or parent is in new phase). */
    plShineColor: { value: new THREE.Vector3(0, 0, 0) },
    /** Cosine-wrap allowance from parent planet's angular radius on the sky. */
    plShineWrap: { value: 0 },
  }
}

/** Exact fraction of a solar disc (angular radius rSun) left unoccluded by a
 * circular occluder (angular radius rOcc) at angular separation sep (radians). */
export function discOverlapVisibility(rSun: number, rOcc: number, sep: number): number {
  if (!(rSun > 0) || !(rOcc > 0)) return 1
  const d = Math.max(0, sep)
  if (d >= rSun + rOcc) return 1
  if (d <= Math.abs(rSun - rOcc)) {
    if (rOcc >= rSun) return 0
    return Math.max(0, 1 - (rOcc / rSun) ** 2)
  }
  const c1 = THREE.MathUtils.clamp((d * d + rSun * rSun - rOcc * rOcc) / (2 * d * rSun), -1, 1)
  const c2 = THREE.MathUtils.clamp((d * d + rOcc * rOcc - rSun * rSun) / (2 * d * rOcc), -1, 1)
  const term = Math.max(0, (-d + rSun + rOcc) * (d + rSun - rOcc) * (d - rSun + rOcc) * (d + rSun + rOcc))
  const overlap = rSun * rSun * Math.acos(c1) + rOcc * rOcc * Math.acos(c2) - 0.5 * Math.sqrt(term)
  return THREE.MathUtils.clamp(1 - overlap / (Math.PI * rSun * rSun), 0, 1)
}

/** Lambertian sphere phase function Phi(alpha) in [0, 1], alpha in [0, pi]. */
export function lambertPhase(phaseAngleRad: number): number {
  const a = THREE.MathUtils.clamp(phaseAngleRad, 0, Math.PI)
  return (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI
}

/** Saturn's simplified radial ring optical depth profile (matches GiantPlanetRenderer). */
export function saturnRingOpticalDepthKm(radiusKm: number): number {
  if (radiusKm < 74658 || radiusKm > 136780) return 0
  if (radiusKm < 91975) return 0.14
  if (radiusKm < 117507) return 1.5
  if (radiusKm < 122340) return 0
  return 0.65
}

/** CPU reference evaluation matching the GLSL plEclipseFactor() shader function. */
export function eclipseFactorAt(pointKm: THREE.Vector3, state: PlanetaryLightingState): [number, number, number] {
  const sunDir = state.plSunDir.value
  const rSun = state.plSunRadiusRad.value
  const count = state.plOccluderCount.value
  let vis = 1
  let tintR = 0, tintG = 0, tintB = 0
  for (let i = 0; i < count; i++) {
    const occ = state.plOccluders.value[i]
    if (occ.w <= 0) continue
    const vx = occ.x - pointKm.x, vy = occ.y - pointKm.y, vz = occ.z - pointKm.z
    const t = vx * sunDir.x + vy * sunDir.y + vz * sunDir.z
    if (t <= 0) continue
    let wx = vx - t * sunDir.x, wy = vy - t * sunDir.y, wz = vz - t * sunDir.z
    if (i === 0 && state.plOblateAxis.value.w < 0.9999) {
      const a = state.plOblateAxis.value
      const proj = wx * a.x + wy * a.y + wz * a.z
      const stretch = 1 / Math.max(0.5, a.w) - 1
      wx += a.x * proj * stretch
      wy += a.y * proj * stretch
      wz += a.z * proj * stretch
    }
    const h = Math.hypot(wx, wy, wz)
    const dist = Math.hypot(t, h)
    if (dist <= occ.w) {
      vis = 0
      if (i === 0) {
        tintR = Math.max(tintR, state.plUmbraTint.value.x)
        tintG = Math.max(tintG, state.plUmbraTint.value.y)
        tintB = Math.max(tintB, state.plUmbraTint.value.z)
      }
      continue
    }
    const sep = Math.asin(Math.min(1, h / dist))
    const rOcc = Math.asin(Math.min(1, occ.w / dist))
    const v = discOverlapVisibility(rSun, rOcc, sep)
    if (i === 0 && state.plUmbraTint.value.x > 0 && v < 1) {
      // Deep umbra refraction glow for Earth eclipsing the Moon.
      const umbra = THREE.MathUtils.smoothstep(rOcc - sep, -rSun * 0.5, rSun * 1.2)
      tintR = Math.max(tintR, state.plUmbraTint.value.x * umbra * (1 - v))
      tintG = Math.max(tintG, state.plUmbraTint.value.y * umbra * (1 - v))
      tintB = Math.max(tintB, state.plUmbraTint.value.z * umbra * (1 - v))
    }
    vis *= v
  }
  if (state.plRingAxis.value.w > 0.5 && count > 0) {
    const occ0 = state.plOccluders.value[0]
    const ax = state.plRingAxis.value
    const denom = sunDir.x * ax.x + sunDir.y * ax.y + sunDir.z * ax.z
    if (Math.abs(denom) > 1e-5) {
      const t = ((occ0.x - pointKm.x) * ax.x + (occ0.y - pointKm.y) * ax.y + (occ0.z - pointKm.z) * ax.z) / denom
      if (t > 0) {
        const rx = pointKm.x + sunDir.x * t - occ0.x
        const ry = pointKm.y + sunDir.y * t - occ0.y
        const rz = pointKm.z + sunDir.z * t - occ0.z
        const tau = saturnRingOpticalDepthKm(Math.hypot(rx, ry, rz))
        if (tau > 0) vis *= Math.exp(-tau / Math.max(0.05, Math.abs(denom)))
      }
    }
  }
  return [Math.min(1, vis + tintR), Math.min(1, vis + tintG), Math.min(1, vis + tintB)]
}

/** Compute planetshine irradiance for a satellite from its parent planet. */
export function computePlanetshine(parentId: BodyId, parentOffsetKm: THREE.Vector3, sunDirBody: THREE.Vector3): {
  direction: THREE.Vector3
  irradiance: THREE.Vector3
  wrap: number
  physicalRatio: number
} {
  const distKm = parentOffsetKm.length()
  const profile = REFLECTOR_PROFILES[parentId]
  const direction = distKm > 0 ? parentOffsetKm.clone().divideScalar(distKm) : new THREE.Vector3(0, 1, 0)
  if (!profile || distKm <= 0) {
    return { direction, irradiance: new THREE.Vector3(), wrap: 0, physicalRatio: 0 }
  }
  const parentRadiusKm = isGiantBody(parentId) ? giantPlanetProfiles[parentId].equatorialKm : bodyInfo[parentId].radiusKm
  // Phase angle of parent as seen from moon: alpha = 0 when moon sits between parent and Sun.
  const cosPhase = THREE.MathUtils.clamp(-direction.dot(sunDirBody), -1, 1)
  const phase = lambertPhase(Math.acos(cosPhase))
  const ratio = (2 / 3) * profile.bondAlbedo * (parentRadiusKm / distKm) ** 2 * phase
  // Perceptually compressed display irradiance (strictly monotonic in physical flux,
  // zero at zero phase) so Jupitershine/Saturnshine/Earthshine read clearly at fixed exposure.
  const displayGain = ratio > 1e-8 ? Math.min(0.42, 0.95 * Math.pow(ratio, 0.44)) : 0
  const irradiance = new THREE.Vector3(profile.color[0], profile.color[1], profile.color[2]).multiplyScalar(displayGain)
  const wrap = Math.min(0.35, parentRadiusKm / distKm)
  return { direction, irradiance, wrap, physicalRatio: ratio }
}

const _inv = new THREE.Quaternion()
const _occQuat = new THREE.Quaternion()
const _pos = new THREE.Vector3()
const _sun = new THREE.Vector3()
const _other = new THREE.Vector3()
const _axis = new THREE.Vector3()

/** Update a body's eclipse occluders and planetshine uniforms from live scene meshes. */
export function updatePlanetaryLighting(
  id: BodyId,
  state: PlanetaryLightingState,
  bodies: Map<BodyId, THREE.Mesh>,
) {
  const body = bodies.get(id)
  const sunMesh = bodies.get('sun')
  if (!body || !sunMesh) return
  body.updateWorldMatrix(true, false)
  body.getWorldPosition(_pos)
  body.getWorldQuaternion(_inv).invert()
  sunMesh.getWorldPosition(_sun)
  const sunVec = _sun.sub(_pos)
  const sunDistKm = Math.max(SUN_RADIUS_KM * 1.1, sunVec.length() * AU_KM)
  state.plSunRadiusRad.value = Math.asin(Math.min(1, SUN_RADIUS_KM / sunDistKm))
  state.plSunDir.value.copy(sunVec).normalize().applyQuaternion(_inv)

  // Candidate occluders: parent + sibling moons for satellites; own moons for planets.
  const candidates: BodyId[] = []
  const parent = satelliteParents[id]
  if (parent) {
    candidates.push(parent)
    for (const sat of satelliteOrder) {
      if (sat !== id && parentOf(sat) === parent) candidates.push(sat)
    }
  } else {
    for (const sat of satelliteOrder) {
      if (parentOf(sat) === id) candidates.push(sat)
    }
  }

  let count = 0
  state.plOblateAxis.value.set(0, 1, 0, 1)
  state.plUmbraTint.value.set(0, 0, 0)
  state.plRingAxis.value.set(0, 1, 0, 0)

  for (const occId of candidates) {
    if (count >= MAX_ECLIPSE_OCCLUDERS) break
    const occMesh = bodies.get(occId)
    if (!occMesh) continue
    occMesh.getWorldPosition(_other)
    const relKm = _other.sub(_pos).multiplyScalar(AU_KM).applyQuaternion(_inv)
    const radiusKm = isGiantBody(occId) ? giantPlanetProfiles[occId].equatorialKm : bodyInfo[occId].radiusKm
    state.plOccluders.value[count].set(relKm.x, relKm.y, relKm.z, radiusKm)
    if (count === 0) {
      if (isGiantBody(occId)) {
        const gp = giantPlanetProfiles[occId]
        occMesh.getWorldQuaternion(_occQuat)
        _axis.set(0, 1, 0).applyQuaternion(_occQuat).applyQuaternion(_inv).normalize()
        state.plOblateAxis.value.set(_axis.x, _axis.y, _axis.z, gp.polarKm / gp.equatorialKm)
        if (occId === 'saturn') {
          state.plRingAxis.value.set(_axis.x, _axis.y, _axis.z, 1)
        }
      } else if (occId === 'earth') {
        // Refracted crimson/copper sunlight through Earth's atmosphere during total lunar eclipses.
        state.plUmbraTint.value.set(0.065, 0.013, 0.003)
      }
    }
    count++
  }
  state.plOccluderCount.value = count

  // Planetshine on satellites from their parent planet.
  if (parent && count > 0) {
    const occ0 = state.plOccluders.value[0]
    const shine = computePlanetshine(parent, new THREE.Vector3(occ0.x, occ0.y, occ0.z), state.plSunDir.value)
    state.plShineDir.value.copy(shine.direction)
    state.plShineColor.value.copy(shine.irradiance)
    state.plShineWrap.value = shine.wrap
  } else {
    state.plShineColor.value.set(0, 0, 0)
    state.plShineWrap.value = 0
  }
}

export const planetaryLightingGlsl = /* glsl */`
uniform vec3 plSunDir;
uniform float plSunRadiusRad;
uniform int plOccluderCount;
uniform vec4 plOccluders[${MAX_ECLIPSE_OCCLUDERS}];
uniform vec4 plOblateAxis;
uniform vec3 plUmbraTint;
uniform vec4 plRingAxis;
uniform vec3 plShineColor;
uniform float plShineWrap;

float plDiscOverlapVisibility(float rSun, float rOcc, float d) {
  if (rSun <= 0.0 || rOcc <= 0.0) return 1.0;
  if (d >= rSun + rOcc) return 1.0;
  if (d <= abs(rSun - rOcc)) {
    return rOcc >= rSun ? 0.0 : max(0.0, 1.0 - (rOcc / rSun) * (rOcc / rSun));
  }
  float c1 = clamp((d * d + rSun * rSun - rOcc * rOcc) / (2.0 * d * rSun), -1.0, 1.0);
  float c2 = clamp((d * d + rOcc * rOcc - rSun * rSun) / (2.0 * d * rOcc), -1.0, 1.0);
  float term = max(0.0, (-d + rSun + rOcc) * (d + rSun - rOcc) * (d - rSun + rOcc) * (d + rSun + rOcc));
  float overlap = rSun * rSun * acos(c1) + rOcc * rOcc * acos(c2) - 0.5 * sqrt(term);
  return clamp(1.0 - overlap / (3.14159265359 * rSun * rSun), 0.0, 1.0);
}

vec3 plEclipseFactor(vec3 pointKm) {
  float vis = 1.0;
  vec3 tint = vec3(0.0);
  for (int i = 0; i < ${MAX_ECLIPSE_OCCLUDERS}; i++) {
    if (i >= plOccluderCount) break;
    vec4 occ = plOccluders[i];
    if (occ.w <= 0.0) continue;
    vec3 v = occ.xyz - pointKm;
    float t = dot(v, plSunDir);
    if (t <= 0.0) continue;
    vec3 w = v - t * plSunDir;
    if (i == 0 && plOblateAxis.w < 0.9999) {
      float proj = dot(w, plOblateAxis.xyz);
      w += plOblateAxis.xyz * proj * (1.0 / max(0.5, plOblateAxis.w) - 1.0);
    }
    float h = length(w);
    float dist = sqrt(t * t + h * h);
    if (dist <= occ.w) {
      vis = 0.0;
      if (i == 0) tint = max(tint, plUmbraTint);
      continue;
    }
    float sep = asin(min(1.0, h / dist));
    float rOcc = asin(min(1.0, occ.w / dist));
    float occVis = plDiscOverlapVisibility(plSunRadiusRad, rOcc, sep);
    if (i == 0 && plUmbraTint.r > 0.0 && occVis < 1.0) {
      float umbra = smoothstep(-plSunRadiusRad * 0.5, plSunRadiusRad * 1.2, rOcc - sep);
      tint = max(tint, plUmbraTint * umbra * (1.0 - occVis));
    }
    vis *= occVis;
  }
  if (plRingAxis.w > 0.5 && plOccluderCount > 0) {
    float denom = dot(plSunDir, plRingAxis.xyz);
    if (abs(denom) > 1e-5) {
      float t = dot(plOccluders[0].xyz - pointKm, plRingAxis.xyz) / denom;
      if (t > 0.0) {
        float rKm = length((pointKm + plSunDir * t) - plOccluders[0].xyz);
        float tau = 0.0;
        if (rKm >= 74658.0 && rKm <= 136780.0) {
          if (rKm < 91975.0) tau = 0.14;
          else if (rKm < 117507.0) tau = 1.5;
          else if (rKm >= 122340.0) tau = 0.65;
        }
        if (tau > 0.0) vis *= exp(-tau / max(0.05, abs(denom)));
      }
    }
  }
  return min(vec3(1.0), vec3(vis) + tint);
}

vec3 plPlanetshineIrradiance(vec3 normalView, vec3 shineDirView) {
  if (dot(plShineColor, plShineColor) <= 1e-10) return vec3(0.0);
  float ndotl = (dot(normalView, normalize(shineDirView)) + plShineWrap) / (1.0 + plShineWrap);
  return plShineColor * max(0.0, ndotl);
}
`

/** Compose after surface and optional atmospheric lighting hooks. Attenuates
 * direct sunlight during analytic eclipses and adds parent planetshine. */
export function configurePlanetaryLighting(material: THREE.Material, state: PlanetaryLightingState, bodyId: string) {
  const previous = material.onBeforeCompile
  const key = material.customProgramCacheKey()
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer)
    const hasLightsChunk = shader.fragmentShader.includes('#include <lights_fragment_begin>')
    const hasExpandedDirect = shader.fragmentShader.includes('RE_Direct( directLight,')
    if (!hasLightsChunk && !hasExpandedDirect) return
    Object.assign(shader.uniforms, state)
    const hasMoonOrigin = shader.vertexShader.includes('moonOrigin')
    shader.vertexShader = `uniform vec3 plShineDir; varying vec3 vPlanetaryPointKm; varying vec3 vPlanetaryShineView;\n${shader.vertexShader}`
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vPlanetaryPointKm = ${hasMoonOrigin ? '(position + moonOrigin) * moonMetersPerUnit * 0.001' : 'position * 149597870.7'};
      vPlanetaryShineView = normalize(normalMatrix * plShineDir);`)
    shader.fragmentShader = `varying vec3 vPlanetaryPointKm; varying vec3 vPlanetaryShineView;\n${planetaryLightingGlsl}\n${shader.fragmentShader}`
    if (hasLightsChunk) {
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin)
    }
    shader.fragmentShader = shader.fragmentShader.replaceAll(
      'RE_Direct( directLight,',
      'directLight.color *= plEclipseFactor(vPlanetaryPointKm);\nRE_Direct( directLight,',
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      'irradiance += plPlanetshineIrradiance(geometryNormal, vPlanetaryShineView);\n#include <lights_fragment_end>',
    )
  }
  material.customProgramCacheKey = () => `${key}/planetary-lighting-v1/${bodyId}`
  material.needsUpdate = true
}
