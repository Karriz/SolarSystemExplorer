import type { BodyId } from './ephemeris'
import { MARS_DETAIL_PROFILE, MOON_DETAIL_PROFILE, MERCURY_DETAIL_PROFILE, VENUS_DETAIL_PROFILE, type SurfaceDetailProfile } from './planetSurfaceMaterial.ts'

export type SolidSurfaceProfile = {
  id: BodyId
  detail: SurfaceDetailProfile
  /** Preserve the accepted Mars color sampler while sharing material ownership. */
  cubeColorSampling: boolean
  originalColorWidth: number
  fallbackColor?: { file: string; message: string }
  noDataColor?: readonly [number, number, number]
  generatedDetail: boolean
  colorDescription: string
  colorSource: { url: string; label: string; credit: string }
}

export const planetRenderProfiles = {
  moon: {
    id: 'moon', generatedDetail: true, originalColorWidth: 8192, detail: MOON_DETAIL_PROFILE, cubeColorSampling: false,
    colorSource: { url: 'https://svs.gsfc.nasa.gov/4720/', label: 'CGI Moon Kit color map', credit: 'NASA SVS / LRO' },
    colorDescription: 'Continuous NASA LROC-derived color; polar gaps use lower-resolution albedo.',
  },
  mercury: {
    id: 'mercury', generatedDetail: true, originalColorWidth: 2048,
    detail: MERCURY_DETAIL_PROFILE,
    cubeColorSampling: true,
    colorSource: { url: 'https://pds.nasa.gov/ds-view/pds/viewDataset.jsp?dsid=MESS-H-MDIS-5-RDR-MDR-V1.0', label: 'MESSENGER MDIS visible reflectance', credit: 'NASA / JHUAPL / Carnegie / ACT' },
    colorDescription: 'Approximate visible color from measured 630/560/480 nm reflectance; polar gaps are neutral gray; south-polar fill uses coarser images.',
  },
  venus: {
    id: 'venus', generatedDetail: true, originalColorWidth: 4096,
    detail: VENUS_DETAIL_PROFILE, cubeColorSampling: true,
    noDataColor: [0.0953074666, 0.0908417112, 0.0843762115],
    fallbackColor: { file: 'venus-color-reference.png', message: 'Compact color unavailable · showing inferred basalt reference' },
    colorSource: { url: 'https://ntrs.nasa.gov/citations/19870039592', label: 'Venera-informed basalt color model', credit: 'Pieters et al. (1986) / NASA NTRS; illustrative material' },
    colorDescription: 'Inferred dark, nearly neutral basalt under white light; not a measured global color map. Clouds and atmospheric orange illumination are omitted. Relief is measured Magellan topography; nearby rock detail is generated.',
  },
  mars: {
    id: 'mars', generatedDetail: true, originalColorWidth: 1440, detail: MARS_DETAIL_PROFILE, cubeColorSampling: true,
    colorSource: { url: 'https://astrogeology.usgs.gov/search/map/mars_year_24_28_moc_wa_red_and_blue_2023', label: 'MGS MOC-WA red/blue reflectance', credit: 'USGS / NASA / SwRI · Robbins (2023)' },
    colorDescription: 'MOC-WA seasonal mean: measured red/blue reflectance, estimated green.',
  },
} as const satisfies Partial<Record<BodyId, SolidSurfaceProfile>>

export type SolidSurfaceBody = keyof typeof planetRenderProfiles
export const solidSurfaceBodies = Object.keys(planetRenderProfiles) as SolidSurfaceBody[]
export function isSolidSurfaceBody(id: BodyId): id is SolidSurfaceBody {
  return Object.hasOwn(planetRenderProfiles, id)
}
