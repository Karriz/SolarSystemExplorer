import { Vector3 } from 'three'
import type { BodyId } from './ephemeris.ts'
import type { OpticalRgb } from './atmosphereProfiles.ts'

export const giantBodies = ['jupiter', 'saturn', 'uranus', 'neptune'] as const
export type GiantBody = typeof giantBodies[number]
export const isGiantBody = (id: BodyId): id is GiantBody => (giantBodies as readonly string[]).includes(id)
export const AU_KM = 149_597_870.7
export type GiantPlanetProfile = {
  id: GiantBody
  equatorialKm: number
  polarKm: number
  referencePressureBar: number
  hazeHeightKm: number
  hazeScaleKm: number
  /** Fitted vertical optical depth, linear RGB; not a spectral retrieval. */
  hazeOpticalDepth: OpticalRgb
  hazeAlbedo: OpticalRgb
  cloudLight: string
  cloudDark: string
  bandContrast: number
  source: string
}

// Conventional 1-bar reference ellipsoids from NASA NSSDC fact sheets.
// The opaque visible deck is an appearance boundary, not a measured cloud altitude.
export const giantPlanetProfiles: Record<GiantBody, GiantPlanetProfile> = {
  jupiter: { id: 'jupiter', equatorialKm: 71492, polarKm: 66854, referencePressureBar: 1,
    hazeHeightKm: 180, hazeScaleKm: 27, hazeOpticalDepth: [.045, .065, .095], hazeAlbedo: [.97, .97, .98],
    cloudLight: '#e6d9bf', cloudDark: '#946b51', bandContrast: 1,
    source: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/jupiterfact.html' },
  saturn: { id: 'saturn', equatorialKm: 60268, polarKm: 54364, referencePressureBar: 1,
    hazeHeightKm: 240, hazeScaleKm: 42, hazeOpticalDepth: [.08, .105, .15], hazeAlbedo: [.99, .98, .95],
    cloudLight: '#e4d4aa', cloudDark: '#b39c71', bandContrast: .45,
    source: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/saturnfact.html' },
  uranus: { id: 'uranus', equatorialKm: 25559, polarKm: 24973, referencePressureBar: 1,
    hazeHeightKm: 180, hazeScaleKm: 28, hazeOpticalDepth: [.22, .18, .14], hazeAlbedo: [.90, .98, .99],
    cloudLight: '#a5cfce', cloudDark: '#8fbebf', bandContrast: .12,
    source: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/uranusfact.html' },
  neptune: { id: 'neptune', equatorialKm: 24764, polarKm: 24341, referencePressureBar: 1,
    hazeHeightKm: 160, hazeScaleKm: 25, hazeOpticalDepth: [.12, .10, .08], hazeAlbedo: [.88, .97, .99],
    cloudLight: '#88bbc5', cloudDark: '#699eaf', bandContrast: .28,
    source: 'https://nssdc.gsfc.nasa.gov/planetary/factsheet/neptunefact.html' },
}

/** Radial ellipsoid boundary in AU, with a declared 20 km supported-view margin.
 * Direction is body-local. Shared by orbit picking and camera safety. */
export function giantBoundaryRadius(profile: GiantPlanetProfile, direction: Vector3, clearanceKm = 20) {
  const unit = direction.clone().normalize()
  if (unit.lengthSq() === 0) unit.set(0, 0, 1)
  const a = profile.equatorialKm + clearanceKm, b = profile.polarKm + clearanceKm
  return 1 / Math.sqrt((unit.x ** 2 + unit.z ** 2) / (a * a) + unit.y ** 2 / (b * b)) / AU_KM
}
