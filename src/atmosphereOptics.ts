import { Vector3 } from 'three'
import { phaseAsRgb, type AtmosphereProfile, type OpticalRgb } from './atmosphereProfiles.ts'
import { buildDenseScattering, type DenseValidation } from './denseAtmosphere.ts'
import { atmosphereRaySegment, raySphereInterval } from './atmosphereMath.ts'

export type Spectrum = [number, number, number]
export type AtmosphereTables = {
  transmittance: Float32Array; transWidth: number; transHeight: number
  multiple: Float32Array; irradiance: Float32Array; multiWidth: number; multiHeight: number
  validation?: DenseValidation
}
const PI = Math.PI
export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
export function mediumAt(profile: AtmosphereProfile, altitudeKm: number) {
  const h = Math.max(0, altitudeKm)
  const molecular = Math.exp(-h / profile.rayleighScaleKm), aerosol = Math.exp(-h / profile.aerosolScaleKm)
  const ozone = Math.max(0, 1 - Math.abs(h - profile.ozoneCenterKm) / profile.ozoneWidthKm)
  const cloud = profile.clouds
  const cloudDensity = cloud ? smoothstep(cloud.baseKm, cloud.baseKm + cloud.edgeKm, h) * (1 - smoothstep(cloud.topKm - cloud.edgeKm, cloud.topKm, h)) : 0
  const g = phaseAsRgb(profile.aerosolG)
  const transport = profile.model === 'dense-transport'
  const scattering = profile.rayleigh.map((v, c) => v * molecular + profile.aerosolScattering[c] * aerosol * (transport ? 1 - g[c] : 1)
    + (cloud ? cloud.extinction * cloud.albedo[c] * (transport ? 1 - cloud.g : 1) * cloudDensity : 0)) as Spectrum
  const extinction = scattering.map((v, c) => v + profile.aerosolAbsorption[c] * aerosol + profile.ozoneAbsorption[c] * ozone
    + (cloud ? cloud.extinction * (1 - cloud.albedo[c]) * cloudDensity : 0)) as Spectrum
  return { molecular, aerosol, scattering, extinction, cloudDensity }
}
export function phaseRayleigh(cosine: number) { return 3 * (1 + cosine * cosine) / (16 * PI) }
/** Cornette-Shanks, with a positive forward cosine (view ray toward Sun). */
export function phaseAerosol(cosine: number, g: number) {
  return 3 * (1 - g * g) * (1 + cosine * cosine) / (8 * PI * (2 + g * g) * Math.pow(1 + g * g - 2 * g * cosine, 1.5))
}

/** High-sample numerical optical-depth reference, independent of LUT sampling. */
export function transmissionToSpace(profile: AtmosphereProfile, radius: number, cosine: number, samples = 192): Spectrum {
  const origin = new Vector3(0, radius, 0), direction = new Vector3(Math.sqrt(Math.max(0, 1 - cosine * cosine)), cosine, 0)
  const interval = raySphereInterval(origin, direction, profile.radiusKm + profile.heightKm)
  if (!interval || interval[1] <= 0) return [1, 1, 1]
  const optical: Spectrum = [0, 0, 0], distance = interval[1], p = new Vector3()
  for (let i = 0; i < samples; i++) {
    const extinction = mediumAt(profile, p.copy(origin).addScaledVector(direction, distance * (i + .5) / samples).length() - profile.radiusKm).extinction
    for (let c = 0; c < 3; c++) optical[c] += extinction[c] * distance / samples
  }
  return optical.map(v => Math.exp(-v)) as Spectrum
}

/** Bruneton transmittance parameterization concentrates resolution at the limb. */
export function transmissionUv(profile: AtmosphereProfile, radius: number, cosine: number): [number, number] {
  const bottom = profile.radiusKm, top = bottom + profile.heightKm
  const r = Math.max(bottom, Math.min(top, radius)), h = Math.sqrt((top - bottom) * (top + bottom))
  const rho = Math.sqrt(Math.max(0, (r - bottom) * (r + bottom)))
  const d = Math.max(0, -r * cosine + Math.sqrt(Math.max(0, r * r * (cosine * cosine - 1) + top * top)))
  return [(d - (top - r)) / Math.max(1e-9, rho + h - (top - r)), rho / h]
}
export function transmissionParameters(profile: AtmosphereProfile, u: number, v: number): [number, number] {
  const bottom = profile.radiusKm, top = bottom + profile.heightKm
  const h = Math.sqrt((top - bottom) * (top + bottom)), rho = h * v
  const radius = Math.sqrt(bottom * bottom + rho * rho), distance = top - radius + u * (rho + h - (top - radius))
  return [radius, distance < 1e-9 ? 1 : Math.max(-1, Math.min(1, (h * h - rho * rho - distance * distance) / (2 * radius * distance)))]
}
export function sampleTable(data: Float32Array, width: number, height: number, u: number, v: number): Spectrum {
  const x = Math.max(0, Math.min(width - 1, u * (width - 1))), y = Math.max(0, Math.min(height - 1, v * (height - 1)))
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1)
  return [0, 1, 2].map(c => {
    const a = data[(y0 * width + x0) * 4 + c] * (1 - (x - x0)) + data[(y0 * width + x1) * 4 + c] * (x - x0)
    const b = data[(y1 * width + x0) * 4 + c] * (1 - (x - x0)) + data[(y1 * width + x1) * 4 + c] * (x - x0)
    return a * (1 - (y - y0)) + b * (y - y0)
  }) as Spectrum
}

export function sunTransmission(profile: AtmosphereProfile, point: Vector3, sun: Vector3,
  lookup?: (radius: number, cosine: number) => OpticalRgb): Spectrum {
  const radius = Math.max(profile.radiusKm + .001, point.length()), mu = point.dot(sun) / point.length()
  const horizon = -Math.sqrt(Math.max(0, 1 - (profile.radiusKm / radius) ** 2))
  const visibility = smoothstep(horizon - profile.sunAngularRadius, horizon + profile.sunAngularRadius, mu)
  if (visibility === 0) return [0, 0, 0]
  const transmission = (lookup ?? ((r, c) => transmissionToSpace(profile, r, c)))(radius, Math.max(horizon + 1e-6, mu))
  return transmission.map(v => v * visibility) as Spectrum
}

export type ScatteringResult = { radiance: Spectrum; transmission: Spectrum; scatteringReturn: Spectrum }
/** Reference clear-air integral. No ground endpoint is imposed on viewing rays;
 * the caller supplies actual terrain depth or a LUT integration boundary. */
export function integrateAtmosphere(profile: AtmosphereProfile, origin: Vector3, direction: Vector3, sun: Vector3,
  distance = Infinity, samples = 96, lookup?: (r: number, mu: number) => OpticalRgb,
  multiple?: (r: number, mu: number) => OpticalRgb): ScatteringResult {
  const result: ScatteringResult = { radiance: [0, 0, 0], transmission: [1, 1, 1], scatteringReturn: [0, 0, 0] }
  if (profile.model) {
    const core = raySphereInterval(origin, direction, profile.radiusKm - 30)
    if (core && core[0] > 0) distance = Math.min(distance, core[0])
  }
  const segment = atmosphereRaySegment(origin, direction, profile.radiusKm + profile.heightKm, distance)
  if (!segment) return result
  const cosine = direction.dot(sun), rayPhase = phaseRayleigh(cosine), aerosolPhase = phaseAsRgb(profile.aerosolG).map(g => phaseAerosol(cosine, g))
  const p = new Vector3()
  for (let i = 0; i < samples; i++) {
    // Symmetric quadrature puts more resolution near the camera AND endpoint.
    const t0 = segment[0] + (segment[1] - segment[0]) * (.5 - .5 * Math.cos(PI * i / samples))
    const t1 = segment[0] + (segment[1] - segment[0]) * (.5 - .5 * Math.cos(PI * (i + 1) / samples))
    p.copy(origin).addScaledVector(direction, (t0 + t1) * .5)
    const r = p.length(), medium = mediumAt(profile, r - profile.radiusKm), sunlight = sunTransmission(profile, p, sun, lookup)
    const extra = multiple?.(r, p.dot(sun) / r) ?? [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      const stepT = Math.exp(-medium.extinction[c] * (t1 - t0))
      const integral = result.transmission[c] * (1 - stepT) / Math.max(1e-10, medium.extinction[c])
      const source = (profile.model === 'dense-transport' ? medium.scattering[c] / (4 * PI)
        : profile.rayleigh[c] * medium.molecular * rayPhase + profile.aerosolScattering[c] * medium.aerosol * aerosolPhase[c]) * sunlight[c]
      result.radiance[c] += integral * (source + medium.scattering[c] * extra[c])
      result.scatteringReturn[c] += integral * medium.scattering[c]
      result.transmission[c] *= stepT
    }
  }
  return result
}

export function multiUv(profile: AtmosphereProfile, radius: number, cosine: number): [number, number] {
  return [.5 + .5 * Math.sign(cosine) * Math.sqrt(Math.abs(cosine)), Math.sqrt(Math.max(0, (radius - profile.radiusKm) / profile.heightKm))]
}

/** Built once in a worker. Hillaire-style isotropic higher-order closure:
 * average single-scattered radiance / (1 - average scattering return).
 * Only the clear Earth profile is validated; dense atmospheres need a new gate. */
export function buildAtmosphereTables(profile: AtmosphereProfile): AtmosphereTables {
  const transWidth = 256, transHeight = 64, multiWidth = 48, multiHeight = 24
  const transmittance = new Float32Array(transWidth * transHeight * 4)
  for (let y = 0; y < transHeight; y++) for (let x = 0; x < transWidth; x++) {
    const [r, mu] = transmissionParameters(profile, x / (transWidth - 1), y / (transHeight - 1))
    transmittance.set([...transmissionToSpace(profile, r, mu, profile.model ? 512 : 128), 1], (y * transWidth + x) * 4)
  }
  const lookup = (r: number, mu: number) => {
    const uv = transmissionUv(profile, r, mu)
    return sampleTable(transmittance, transWidth, transHeight, ...uv)
  }
  if (profile.model === 'dense-transport') return { transmittance, transWidth, transHeight, ...buildDenseScattering(profile, mediumAt) }
  const multiple = new Float32Array(multiWidth * multiHeight * 4), irradiance = new Float32Array(multiple.length)
  const directions = 32, p = new Vector3(), sun = new Vector3(), d = new Vector3()
  for (let y = 0; y < multiHeight; y++) for (let x = 0; x < multiWidth; x++) {
    const h = profile.heightKm * (y / (multiHeight - 1)) ** 2 + .001, m = x / (multiWidth - 1) * 2 - 1, mu = m * Math.abs(m)
    p.set(0, profile.radiusKm + h, 0); sun.set(Math.sqrt(Math.max(0, 1 - mu * mu)), mu, 0)
    const mean = [0, 0, 0], feedback = [0, 0, 0], sky = [0, 0, 0], skyFeedback = [0, 0, 0]
    for (let i = 0; i < directions; i++) {
      const z = 1 - 2 * (i + .5) / directions, phi = i * 2.399963229728653
      d.set(Math.sqrt(1 - z * z) * Math.cos(phi), z, Math.sqrt(1 - z * z) * Math.sin(phi))
      const ground = raySphereInterval(p, d, profile.radiusKm)
      const distance = ground && ground[0] > 0 ? ground[0] : Infinity
      const ray = integrateAtmosphere(profile, p, d, sun, distance, 32, lookup)
      if (Number.isFinite(distance)) {
        const hit = p.clone().addScaledVector(d, distance), transSun = sunTransmission(profile, hit, sun, lookup)
        for (let c = 0; c < 3; c++) ray.radiance[c] += ray.transmission[c] * profile.groundAlbedo * Math.max(0, hit.dot(sun) / hit.length()) * transSun[c] / PI
      }
      for (let c = 0; c < 3; c++) {
        mean[c] += ray.radiance[c] / directions; feedback[c] += ray.scatteringReturn[c] / directions
        sky[c] += ray.radiance[c] * Math.max(0, z) * 4 * PI / directions
        skyFeedback[c] += ray.scatteringReturn[c] * Math.max(0, z) * 4 * PI / directions
      }
    }
    const psi = mean.map((v, c) => v / Math.max(.05, 1 - feedback[c]))
    multiple.set([...psi, 1], (y * multiWidth + x) * 4)
    irradiance.set([...sky.map((v, c) => v + psi[c] * skyFeedback[c]), 1], (y * multiWidth + x) * 4)
  }
  return { transmittance, transWidth, transHeight, multiple, irradiance, multiWidth, multiHeight }
}
