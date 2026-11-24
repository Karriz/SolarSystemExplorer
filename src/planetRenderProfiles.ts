import type { BodyId } from './ephemeris'
import { MARS_DETAIL_PROFILE, MOON_DETAIL_PROFILE, MERCURY_DETAIL_PROFILE, VENUS_DETAIL_PROFILE, ENCELADUS_DETAIL_PROFILE, TITAN_DETAIL_PROFILE, IO_DETAIL_PROFILE, EUROPA_DETAIL_PROFILE, GANYMEDE_DETAIL_PROFILE, CALLISTO_DETAIL_PROFILE, type SurfaceDetailProfile } from './planetSurfaceMaterial.ts'
import type { LiquidSurfaceProfile } from './liquidSurfaceMaterial.ts'

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
  /** Reference figure in body-local X, north Y, west Z order. */
  referenceAxesMeters?: readonly [number, number, number]
  terrainDescription?: string
  liquid?: LiquidSurfaceProfile
}

export const planetRenderProfiles = {
  titan: {
    id: 'titan', generatedDetail: true, originalColorWidth: 4096,
    detail: TITAN_DETAIL_PROFILE, cubeColorSampling: true,
    liquid: { color: [0.018, 0.023, 0.030], roughness: 0.14, waveStrength: 0.014 },
    fallbackColor: { file: 'titan-color-reference.png', message: 'Compact color unavailable · showing inferred Titan ground reference' },
    colorSource: { url: 'https://astrogeology.usgs.gov/search/map/titan_cassini_iss_global_mosaic_4005m', label: 'Cassini ISS 938 nm geography with inferred neutral-light ground color', credit: 'NASA / JPL-Caltech / SSI / USGS; inferred ground albedo' },
    colorDescription: 'Ground beneath the haze: inferred neutral-light icy highlands, dark organic dunes and dark hydrocarbon seas from Cassini ISS 938 nm geography, not measured global visible RGB. Orange illumination is modeled separately in the atmosphere. Corlies et al. (2017) radar measurements support 8.67% of terrain; gaps use interpolation and conservative reconstructed landforms.',
    terrainDescription: 'Corlies (2017) measured tracks (8.67%) and interpolated/reconstructed global terrain',
  },
  callisto: {
    id: 'callisto', generatedDetail: true, originalColorWidth: 4096,
    detail: CALLISTO_DETAIL_PROFILE, cubeColorSampling: true,
    fallbackColor: { file: 'callisto-color-reference.png', message: 'Compact color unavailable · showing reconstructed Callisto reference' },
    colorSource: { url: 'https://astrogeology.usgs.gov/search/map/callisto_galileo_voyager_global_mosaic_1km', label: 'Voyager/Galileo-informed visible color reconstruction', credit: 'NASA / USGS; reconstructed visible RGB' },
    colorDescription: 'Voyager/Galileo monochrome geography with Galileo PIA03456-anchored brownish-gray non-ice lag and bright icy impact scars. Global terrain is reconstructed from IAU/USGS named basins, craters and catenae without a global measured DEM. Fine surface detail is generated.',
    terrainDescription: 'IAU/USGS nomenclature-constrained global terrain · no measured global DEM',
  },
  ganymede: {
    id: 'ganymede', generatedDetail: true, originalColorWidth: 4096,
    detail: GANYMEDE_DETAIL_PROFILE, cubeColorSampling: true,
    fallbackColor: { file: 'ganymede-color-reference.png', message: 'Compact color unavailable · showing reconstructed Ganymede reference' },
    colorSource: { url: 'https://astrogeology.usgs.gov/search/map/ganymede_voyager_galileo_ssi_color_global_mosaic_1_4km', label: 'Voyager/Galileo-informed visible color reconstruction', credit: 'NASA / USGS; reconstructed visible RGB' },
    colorDescription: 'Voyager/Galileo monochrome geography and visible green/violet cues with Galileo-anchored visible color; polar chroma is inferred. Global terrain is geologically constrained by USGS SIM 3237 without a global measured DEM. Fine surface detail is generated.',
    terrainDescription: 'SIM 3237 geologically constrained global terrain · no measured global DEM',
  },
  europa: {
    id: 'europa', generatedDetail: true, originalColorWidth: 4096,
    detail: EUROPA_DETAIL_PROFILE, cubeColorSampling: true,
    referenceAxesMeters: [1562600, 1559500, 1560300],
    fallbackColor: { file: 'europa-color-reference.png', message: 'Compact color unavailable · showing reconstructed Europa reference' },
    colorSource: { url: 'https://doi.org/10.3133/sim3513', label: 'Voyager/Galileo-informed visible ice reconstruction', credit: 'NASA / USGS; inferred visible color' },
    colorDescription: 'Observed image geography with inferred visible ice and non-ice colors. Five regional stereo sites retain local relief; the global surface and ridge heights are reconstructed. Fine ice detail is generated.',
    terrainDescription: 'Regional stereo relief and reconstructed global ice terrain',
  },
  io: {
    id: 'io', generatedDetail: true, originalColorWidth: 4096,
    detail: IO_DETAIL_PROFILE, cubeColorSampling: true,
    referenceAxesMeters: [1829700, 1815800, 1819200],
    fallbackColor: { file: 'io-color-reference.png', message: 'Compact color unavailable · showing reconstructed Io reference' },
    colorSource: { url: 'https://astrogeology.usgs.gov/search/map/io_galileo_ssi_global_color_merge_mosaic_1km', label: 'Galileo-informed visible color reconstruction', credit: 'NASA / JPL / USGS; reconstructed visible RGB' },
    colorDescription: 'Visible-color approximation from Galileo bands; polar colors are inferred. Stereo terrain is completed with reconstructed volcanic plains. Nearby rock detail is illustrative.',
    terrainDescription: 'Stereo relief and reconstructed gaps · 1 km source grid',
  },
  enceladus: {
    id: 'enceladus', generatedDetail: true, originalColorWidth: 4096,
    detail: ENCELADUS_DETAIL_PROFILE, cubeColorSampling: true,
    referenceAxesMeters: [256200, 248600, 251400],
    fallbackColor: { file: 'enceladus-color-reference.png', message: 'Compact color unavailable · showing reconstructed ice reference' },
    colorSource: { url: 'https://science.nasa.gov/photojournal/color-maps-of-enceladus-2014/', label: 'Cassini-informed visible ice reconstruction', credit: 'NASA / JPL-Caltech / SSI / LPI; reconstructed visible color' },
    colorDescription: 'Cassini geography with inferred subtle visible ice color, not calibrated global RGB. Measured Schenk/McKinnon relief includes the reference ellipsoid; missing coverage is reconstructed. Fine ice detail is generated.',
  },
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
    colorDescription: 'Ground beneath the clouds: inferred basalt, not measured global visible color. Relief is measured Magellan topography; nearby rock detail is generated. Atmospheric illumination is modeled separately.',
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
