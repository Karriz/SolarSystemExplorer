export type OpticalRgb = readonly [number, number, number]
export type AtmosphereBody = 'earth' | 'mars' | 'venus'
export type CloudProfile = {
  baseKm: number; topKm: number; edgeKm: number
  extinction: number; albedo: OpticalRgb; g: number
  radiansPerDay: number; variation: number
}
export type AtmosphereProfile = {
  id: AtmosphereBody
  radiusKm: number
  heightKm: number
  rayleigh: OpticalRgb
  rayleighScaleKm: number
  aerosolScattering: OpticalRgb
  aerosolAbsorption: OpticalRgb
  aerosolScaleKm: number
  aerosolG: number | OpticalRgb
  ozoneAbsorption: OpticalRgb
  ozoneCenterKm: number
  ozoneWidthKm: number
  groundAlbedo: number
  sunAngularRadius: number
  source: string
  description: string
  model?: 'dense-transport'
  clouds?: CloudProfile
}
export const phaseAsRgb = (g: number | OpticalRgb): OpticalRgb => typeof g === 'number' ? [g, g, g] : g

/** Reference clear air, not live weather. Coefficients are inverse km.
 * RGB optical approximation following Hillaire's Earth example; mean Earth
 * radius matches the existing measured terrain coordinate system. */
export const earthAtmosphere: AtmosphereProfile = {
  id: 'earth', radiusKm: 6371, heightKm: 100,
  rayleigh: [.005802, .013558, .0331], rayleighScaleKm: 8,
  aerosolScattering: [.003996, .003996, .003996],
  aerosolAbsorption: [.000444, .000444, .000444], aerosolScaleKm: 1.2, aerosolG: .8,
  ozoneAbsorption: [.00065, .001881, .000085], ozoneCenterKm: 25, ozoneWidthKm: 15,
  groundAlbedo: .1, sunAngularRadius: .004675,
  source: 'https://sebh.github.io/publications/egsr2020.pdf',
  description: 'Modeled clear-air reference · molecular scattering, aerosols and ozone · fixed conditions',
}

/** Fitted fixed dust state; wavelength-dependent forward scattering is needed
 * for blue light near the Sun rather than an Earth atmosphere with a red tint. */
export const marsAtmosphere: AtmosphereProfile = {
  id: 'mars', radiusKm: 3389.5, heightKm: 100,
  rayleigh: [.00008, .00018, .00045], rayleighScaleKm: 11,
  aerosolScattering: [.018, .014, .010], aerosolAbsorption: [.0015, .0018, .002],
  aerosolScaleKm: 11, aerosolG: [.68, .76, .86],
  ozoneAbsorption: [0, 0, 0], ozoneCenterKm: 25, ozoneWidthKm: 15,
  groundAlbedo: .15, sunAngularRadius: .00307,
  source: 'https://science.nasa.gov/photojournal/the-sun-sets-on-mars/',
  description: 'Modeled dust haze · fitted RGB optics · fixed dust loading',
}

/** Visible-light reference, not a spectral retrieval. Published cloud heights
 * and optical thickness constrain the model; optical/color detail is fitted.
 * Dense transport uses reduced aerosol scattering and an independently solved
 * plane-parallel diffuse field, not Earth's isotropic feedback closure. */
export const venusAtmosphere: AtmosphereProfile = {
  id: 'venus', radiusKm: 6051.8, heightKm: 120, model: 'dense-transport',
  rayleigh: [.25, .55, 1.3], rayleighScaleKm: 15,
  aerosolScattering: [.003, .0025, .002], aerosolAbsorption: [.0008, .0015, .003],
  aerosolScaleKm: 12, aerosolG: .5,
  ozoneAbsorption: [0, 0, 0], ozoneCenterKm: 25, ozoneWidthKm: 15,
  groundAlbedo: .1, sunAngularRadius: .00646,
  clouds: { baseKm: 48, topKm: 70, edgeKm: 2, extinction: 1.6,
    albedo: [.999, .998, .995], g: .82, radiansPerDay: -Math.PI / 2, variation: .08 },
  source: 'https://doi.org/10.1002/2016JE005087',
  description: 'Modeled dense air and clouds · generated structure and illustrative motion',
}
export const atmosphereProfiles = { earth: earthAtmosphere, mars: marsAtmosphere, venus: venusAtmosphere }
