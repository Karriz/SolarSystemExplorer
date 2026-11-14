import type { AtmosphereProfile, OpticalRgb } from './atmosphereProfiles.ts'

export type OpticalLayer = { tau: number; albedo: number }
export type DenseColumn = {
  source: Float64Array; downFlux: Float64Array
  reflected: number; transmitted: number; absorbed: number
  energyError: number; iterations: number; residual: number
}
// Gauss-Legendre on each hemisphere separately. This integrates Lambertian
// boundary flux exactly; full-sphere quadrature does not integrate |mu| exactly.
const MU = [.0198550717512319,.101666761293187,.237233795041836,.408282678752175,
  .591717321247825,.762766204958164,.898333238706813,.980144928248768]
const W = [.0506142681451881,.111190517226687,.156853322938944,.181341891689181,
  .181341891689181,.156853322938944,.111190517226687,.0506142681451881]

/** Independent 1D discrete-ordinate solve for isotropic transport scattering.
 * Layers run from space to ground. Source iteration uses a diagonal accelerated
 * lambda operator and layer-average (not midpoint) intensities to conserve flux. */
export function solveDenseColumn(layers: OpticalLayer[], sunMu: number, groundAlbedo: number,
  options: { tolerance?: number; maxIterations?: number } = {}): DenseColumn {
  const n = layers.length, source = new Float64Array(n), mean = new Float64Array(n), direct = new Float64Array(n + 1)
  const downFlux = new Float64Array(n + 1), diagonal = new Float64Array(n), directMean = new Float64Array(n)
  const e = new Float64Array(n * MU.length), average = new Float64Array(e.length)
  if (sunMu <= 0) return { source, downFlux, reflected: 0, transmitted: 0, absorbed: 0, energyError: 0, iterations: 0, residual: 0 }
  direct[0] = 1
  for (let i = 0; i < n; i++) {
    const tau = Math.max(1e-12, layers[i].tau)
    direct[i + 1] = direct[i] * Math.exp(-tau / sunMu)
    directMean[i] = sunMu * (direct[i] - direct[i + 1]) / tau
    let self = 1
    for (let a = 0; a < MU.length; a++) {
      const t = tau / MU[a], index = i * MU.length + a
      e[index] = Math.exp(-t); average[index] = -Math.expm1(-t) / t
      self -= W[a] * average[index]
    }
    diagonal[i] = self
    source[i] = layers[i].albedo * directMean[i] / (4 * Math.PI)
  }
  let reflected = 0, absorbed = 0, residual = Infinity, iterations = 0
  for (; iterations < (options.maxIterations ?? 2048); iterations++) {
    mean.fill(0); downFlux.fill(0)
    for (let a = 0; a < MU.length; a++) {
      let intensity = 0
      for (let i = 0; i < n; i++) {
        const index = i * MU.length + a
        mean[i] += .5 * W[a] * (intensity * average[index] + source[i] * (1 - average[index]))
        intensity = intensity * e[index] + source[i] * (1 - e[index])
        downFlux[i + 1] += 2 * Math.PI * W[a] * MU[a] * intensity
      }
    }
    const ground = groundAlbedo * (downFlux[n] + sunMu * direct[n]) / Math.PI
    reflected = 0
    for (let a = 0; a < MU.length; a++) {
      let intensity = ground
      for (let i = n - 1; i >= 0; i--) {
        const index = i * MU.length + a
        mean[i] += .5 * W[a] * (intensity * average[index] + source[i] * (1 - average[index]))
        intensity = intensity * e[index] + source[i] * (1 - e[index])
      }
      reflected += 2 * Math.PI * W[a] * MU[a] * intensity
    }
    residual = 0; absorbed = 0
    for (let i = 0; i < n; i++) {
      const omega = layers[i].albedo
      absorbed += (1 - omega) * (4 * Math.PI * mean[i] * layers[i].tau + sunMu * (direct[i] - direct[i + 1]))
      const next = Math.max(0, omega * (mean[i] - diagonal[i] * source[i] + directMean[i] / (4 * Math.PI)) / (1 - omega * diagonal[i]))
      residual = Math.max(residual, Math.abs(next - source[i]) / Math.max(1e-8, next))
      source[i] = next
    }
    if (residual < (options.tolerance ?? 1e-7)) break
  }
  // Store diffuse J, excluding the collimated transport beam. The view integral
  // adds its directional source separately and does not count it twice.
  for (let i = 0; i < n; i++) source[i] = mean[i]
  const transmitted = (1 - groundAlbedo) * (downFlux[n] + sunMu * direct[n])
  return { source, downFlux, reflected, transmitted, absorbed,
    energyError: Math.abs(reflected + transmitted + absorbed - sunMu) / sunMu, iterations: iterations + 1, residual }
}

export type DenseValidation = { maxEnergyError: number; maxResidual: number; maxIterations: number; accepted: boolean }
export function buildDenseScattering(profile: AtmosphereProfile,
  medium: (profile: AtmosphereProfile, h: number) => { scattering: OpticalRgb; extinction: OpticalRgb }) {
  const multiWidth = 48, multiHeight = 96, layers = 160, dz = profile.heightKm / layers
  const multiple = new Float32Array(multiWidth * multiHeight * 4), irradiance = new Float32Array(multiple.length)
  const validation: DenseValidation = { maxEnergyError: 0, maxResidual: 0, maxIterations: 0, accepted: false }
  const optics = Array.from({ length: layers }, (_, i) => medium(profile, profile.heightKm - (i + .5) * dz))
  for (let x = 0; x < multiWidth; x++) {
    const m = x / (multiWidth - 1) * 2 - 1, mu = m * Math.abs(m)
    if (mu <= 0) continue
    for (let c = 0; c < 3; c++) {
      const column = solveDenseColumn(optics.map(v => ({ tau: v.extinction[c] * dz, albedo: v.scattering[c] / Math.max(1e-12, v.extinction[c]) })), mu, profile.groundAlbedo)
      validation.maxEnergyError = Math.max(validation.maxEnergyError, column.energyError)
      validation.maxResidual = Math.max(validation.maxResidual, column.residual)
      validation.maxIterations = Math.max(validation.maxIterations, column.iterations)
      for (let y = 0; y < multiHeight; y++) {
        const altitude = profile.heightKm * (y / (multiHeight - 1)) ** 2
        const index = (y * multiWidth + x) * 4 + c
        const layer = Math.max(0, Math.min(layers - 1, (profile.heightKm - altitude) / dz - .5))
        const i = Math.floor(layer), j = Math.min(layers - 1, i + 1), t = layer - i
        multiple[index] = column.source[i] * (1 - t) + column.source[j] * t
        const boundary = Math.max(0, Math.min(layers, (profile.heightKm - altitude) / dz))
        const b = Math.floor(boundary), next = Math.min(layers, b + 1)
        irradiance[index] = column.downFlux[b] * (1 - (boundary - b)) + column.downFlux[next] * (boundary - b)
      }
    }
  }
  for (let i = 3; i < multiple.length; i += 4) { multiple[i] = 1; irradiance[i] = 1 }
  validation.accepted = validation.maxEnergyError < .005 && validation.maxResidual < 2e-6
  return { multiple, irradiance, multiWidth, multiHeight, validation }
}
