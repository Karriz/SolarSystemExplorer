import type { BodyId } from './ephemeris'

export type TextureSource = {
  file: string
  label: string
  page: string
  download: string
  credit: string
  note: string
}

// These are fixed visual composites, independent of the simulation date.
export const textureSources: Partial<Record<BodyId, TextureSource>> = {
  mercury: {
    file: 'mercury.jpg', label: 'MESSENGER enhanced-color mosaic',
    page: 'https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mercury',
    download: 'https://trek.nasa.gov/tiles/Mercury/EQ/Mercury_MESSENGER_MDIS_Basemap_EnhancedColor_Mosaic_Global_665m/1.0.0/WMTSCapabilities.xml',
    credit: 'NASA / JHUAPL / ASU / Carnegie / ACT',
    note: '2048 × 1024 fallback assembled from NASA Trek geographic level 2. Enhanced color, not natural color.',
  },
  venus: {
    file: 'venus.jpg', label: 'Magellan radar surface mosaic',
    page: 'https://science.nasa.gov/3d-resources/venus/',
    download: 'https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/image/venus/Venus.jpg',
    credit: 'NASA / JPL-Caltech',
    note: 'Radar surface composite with filled imagery gaps, not a visible-light or cloud image.',
  },
  earth: {
    file: 'earth.jpg',
    label: 'Blue Marble with bathymetry',
    page: 'https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/',
    download: 'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/october/world.topo.bathy.200410.3x5400x2700.jpg',
    credit: 'NASA Earth Observatory',
    note: 'October 2004 monthly composite with shaded topography and bathymetry, 5400 × 2700 equirectangular JPEG.',
  },
  moon: {
    file: 'moon.jpg',
    label: 'CGI Moon Kit color map',
    page: 'https://svs.gsfc.nasa.gov/4720/',
    download: 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg',
    credit: 'NASA Scientific Visualization Studio / LRO',
    note: '2025 LRO color composite, 2048 × 1024. Polar gaps use lower resolution albedo data.',
  },
  mars: {
    file: 'mars.jpg',
    label: 'Mars image texture',
    page: 'https://science.nasa.gov/3d-resources/mars/',
    download: 'https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/image/mars/Mars.jpg',
    credit: 'NASA / JPL-Caltech; Viking imagery processed at USGS',
    note: 'Global 1440 × 720 color map. Surface appearance is illustrative for all simulation dates.',
  },
}
