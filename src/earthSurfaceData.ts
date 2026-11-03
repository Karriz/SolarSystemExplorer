import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'

// Numeric material IDs, not display colors. Unknown preserves the global base.
export const EARTH_CLASS = { unknown: 0, forest: 1, grass: 2, crop: 3, sand: 4, rock: 5, snow: 6, urban: 7, wetland: 8, ocean: 9, lake: 10 } as const
export const MASK_SIZE = 256
export const MASK_GUTTER = 2
export const MASK_WIDTH = MASK_SIZE + MASK_GUTTER * 2
export type MaskPoint = { x: number; y: number }
export type WaterFeature = { key: string; shore: [number, number][] }
export type EarthMask = { classes: Uint8Array; water: Uint16Array; waters: WaterFeature[]; counts: Record<string, number>; width: number }
export const earthMaskSize = (zoom: number) => zoom >= 13 ? 512 : MASK_SIZE

export function materialClass(layer: string, properties: Record<string, unknown>): number {
  const value = String(properties.class ?? '')
  if (layer === 'water') {
    if (properties.brunnel === 'tunnel' || properties.intermittent === 1) return 0
    return value === 'ocean' ? EARTH_CLASS.ocean : EARTH_CLASS.lake
  }
  if (layer === 'landcover') {
    if (value === 'wood') return EARTH_CLASS.forest
    if (value === 'grass') return EARTH_CLASS.grass
    if (value === 'farmland') return EARTH_CLASS.crop
    if (value === 'sand') return EARTH_CLASS.sand
    if (value === 'rock') return EARTH_CLASS.rock
    if (value === 'ice') return EARTH_CLASS.snow
    if (value === 'wetland') return EARTH_CLASS.wetland
  }
  if (layer === 'landuse') {
    if (['residential', 'commercial', 'industrial', 'retail', 'railway', 'garages'].includes(value)) return EARTH_CLASS.urban
    if (['pitch', 'cemetery', 'recreation_ground'].includes(value)) return EARTH_CLASS.grass
    if (value === 'quarry') return EARTH_CLASS.rock
  }
  return 0
}

/** Even/odd scan conversion includes holes and disconnected outer rings.
 * Work directly on numeric buffers: privacy-protected canvas readback must
 * never change classification IDs or water ownership. */
export function rasterizeRings(rings: MaskPoint[][], extent: number, paint: (index: number) => void, size = MASK_SIZE) {
  const scale = size / extent, width = size + MASK_GUTTER * 2
  const edges: number[][] = []
  let minY = width, maxY = 0
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i]
    if (a.y === b.y) continue
    const edge = [a.x * scale + MASK_GUTTER, a.y * scale + MASK_GUTTER, b.x * scale + MASK_GUTTER, b.y * scale + MASK_GUTTER]
    edges.push(edge); minY = Math.min(minY, edge[1], edge[3]); maxY = Math.max(maxY, edge[1], edge[3])
  }
  for (let y = Math.max(0, Math.ceil(minY - .5)); y < Math.min(width, Math.ceil(maxY - .5)); y++) {
    const intersections: number[] = [], row = y + .5
    for (const [ax, ay, bx, by] of edges) if ((ay <= row && by > row) || (by <= row && ay > row)) intersections.push(ax + (row - ay) / (by - ay) * (bx - ax))
    intersections.sort((a, b) => a - b)
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const start = Math.max(0, Math.ceil(intersections[i] - .5)), end = Math.min(width, Math.ceil(intersections[i + 1] - .5))
      for (let x = start; x < end; x++) paint(y * width + x)
    }
  }
}

export function decodeEarthMask(buffer: ArrayBuffer, address: { z: number; x: number; y: number }): EarthMask {
  const size = earthMaskSize(address.z), width = size + MASK_GUTTER * 2
  const tile = new VectorTile(new PbfReader(buffer)), classes = new Uint8Array(width ** 2), water = new Uint16Array(width ** 2)
  const waters: WaterFeature[] = [], counts: Record<string, number> = {}
  let shoreBudget = 4096
  // More specific land use refines landcover; water always owns its footprint.
  for (const name of ['landcover', 'landuse', 'water']) {
    const layer = tile.layers[name]
    counts[name] = layer?.length ?? 0
    for (let i = 0; i < (layer?.length ?? 0); i++) {
      const feature = layer.feature(i), id = materialClass(name, feature.properties)
      if (feature.type !== 3 || !id) continue
      const rings = feature.loadGeometry()
      let waterIndex = 0
      if (id === EARTH_CLASS.lake && address.z >= 10 && ['lake', 'pond'].includes(String(feature.properties.class)) && waters.length < 512) {
        const shore: [number, number][] = [], n = 2 ** address.z
        for (const ring of rings) for (let j = 0; j < ring.length && shore.length < 48 && shoreBudget > 0; j += Math.max(1, Math.ceil(ring.length / 24))) {
          const p = ring[j]
          // Buffered/clipped tile boundaries are not actual lake shores.
          if (p.x <= 0 || p.y <= 0 || p.x >= feature.extent || p.y >= feature.extent) continue
          const x = (address.x + p.x / feature.extent) / n, y = (address.y + p.y / feature.extent) / n
          shore.push([Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI, x * 360 - 180])
          shoreBudget--
        }
        const sourceId = feature.properties.id ?? feature.id
        waters.push({ key: sourceId === undefined ? `${address.z}/${address.x}/${address.y}/${i}` : String(sourceId), shore })
        waterIndex = waters.length
      }
      rasterizeRings(rings, feature.extent, index => { classes[index] = id; water[index] = waterIndex }, size)
    }
  }
  // Lines have no observed width. Record availability without fabricating a river polygon.
  counts.waterway = tile.layers.waterway?.length ?? 0
  return { classes, water, waters, counts, width }
}
