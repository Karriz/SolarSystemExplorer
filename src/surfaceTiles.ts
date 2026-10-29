export type TileBody = 'earth' | 'moon' | 'mars' | 'mercury'
export type TileAddress = { z: number; x: number; y: number }
export type TileBounds = { west: number; east: number; north: number; south: number; span: number }
export type SurfaceTileSource = {
  label: string
  page: string
  credit: string
  tileSize: number
  rootSpan: number
  maxZoom: number
  url: (tile: TileAddress) => string
}

// Verified against each service's WMTS GetCapabilities. GIBS CRS84 uses a
// 288-degree root tile with padding at the eastern and southern edges.
export const surfaceTileSources: Record<TileBody, SurfaceTileSource> = {
  mercury: {
    label: 'NASA Trek · MESSENGER enhanced color',
    page: 'https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mercury',
    credit: 'NASA / JHUAPL / ASU / Carnegie / ACT',
    tileSize: 256, rootSpan: 180, maxZoom: 7,
    url: ({ z, x, y }) => `https://trek.nasa.gov/tiles/Mercury/EQ/Mercury_MESSENGER_MDIS_Basemap_EnhancedColor_Mosaic_Global_665m/1.0.0/default/default028mm/${z}/${y}/${x}.jpg`,
  },
  earth: {
    label: 'GIBS Blue Marble base color',
    page: 'https://nasa-gibs.github.io/gibs-api-docs/',
    credit: 'NASA/GSFC GIBS / ESDIS',
    tileSize: 512, rootSpan: 288, maxZoom: 7,
    url: ({ z, x, y }) => `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_NextGeneration/default/500m/${z}/${y}/${x}.jpeg`,
  },
  moon: {
    label: 'NASA Trek · LRO WAC',
    page: 'https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=moon',
    credit: 'NASA/GSFC/ASU',
    tileSize: 256, rootSpan: 180, maxZoom: 8,
    url: ({ z, x, y }) => `https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/${z}/${y}/${x}.jpg`,
  },
  mars: {
    label: 'NASA Trek · Viking MDIM 2.1',
    page: 'https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars',
    credit: 'NASA/JPL/USGS',
    tileSize: 256, rootSpan: 180, maxZoom: 7,
    url: ({ z, x, y }) => `https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/${z}/${y}/${x}.jpg`,
  },
}

export function tileBounds(source: SurfaceTileSource, { z, x, y }: TileAddress): TileBounds | null {
  const span = source.rootSpan / 2 ** z
  const west = -180 + x * span, north = 90 - y * span
  if (z < 0 || z > source.maxZoom || x < 0 || y < 0 || west >= 180 || north <= -90) return null
  return { west, east: Math.min(180, west + span), north, south: Math.max(-90, north - span), span }
}

export function tileChildren(source: SurfaceTileSource, tile: TileAddress): TileAddress[] {
  if (tile.z >= source.maxZoom) return []
  return [0, 1, 2, 3].map(i => ({ z: tile.z + 1, x: tile.x * 2 + i % 2, y: tile.y * 2 + Math.floor(i / 2) }))
    .filter(child => tileBounds(source, child) !== null)
}
