import { VectorTile } from '@mapbox/vector-tile'
import { PbfReader } from 'pbf'

// Numeric material IDs, not display colors. Unknown preserves the global base.
export const EARTH_CLASS = { unknown: 0, forest: 1, grass: 2, crop: 3, sand: 4, rock: 5, snow: 6, urban: 7, wetland: 8, ocean: 9, lake: 10 } as const
export const MASK_SIZE = 256
export const MASK_GUTTER = 4
export const MASK_WIDTH = MASK_SIZE + MASK_GUTTER * 2
export type MaskPoint = { x: number; y: number }
export type WaterFeature = { key: string; shore: [number, number][] }
export type EarthMask = { classes: Uint8Array; water: Uint16Array; waters: WaterFeature[]; counts: Record<string, number>; width: number; color: Uint8Array; surface: Uint8Array }
export const earthMaskSize = (zoom: number) => zoom >= 13 ? 512 : MASK_SIZE

export const SHORE_DISTANCE = 8
// Linear natural palettes and generated material response, not legend colors.
const materials = [
  [0, 0, 0, 0, .5, .97], [.035, .075, .025, 1, .14, .97],
  [.11, .16, .045, 1, .14, .97], [.19, .20, .075, 1, .14, .97],
  [.50, .39, .22, 1, .18, .98], [.21, .20, .18, 1, 1, .86],
  [.75, .80, .82, 1, .12, .89], [.20, .19, .17, 1, .12, .92],
  [.06, .12, .07, 1, .12, .97], [.008, .045, .075, 1, 0, .24],
  [.008, .045, .075, 1, 0, .24],
]
const srgbByte = (v: number) => Math.round(255 * (v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055))

/** Approximate shoreline distance using an exact distance transform of fractional seeds.
 * Coverage preserves subpixel areas; signed distance supplies a crisp edge
 * when magnified. Distant shading uses coverage, never averaged distances. */
export function shoreDistance(coverage: Float32Array, width: number) {
  const distance = new Float64Array(width * width).fill(SHORE_DISTANCE ** 2)
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, c = coverage[i]
    if (c > 0 && c < 1) distance[i] = (c - .5) ** 2
    else if ((x && (coverage[i - 1] >= .5) !== (c >= .5)) || (x + 1 < width && (coverage[i + 1] >= .5) !== (c >= .5))
      || (y && (coverage[i - width] >= .5) !== (c >= .5)) || (y + 1 < width && (coverage[i + width] >= .5) !== (c >= .5))) distance[i] = .25
  }
  const f = new Float64Array(width), result = new Float64Array(width), v = new Int32Array(width), z = new Float64Array(width + 1)
  const transform = () => {
    let k = 0
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity
    for (let q = 1; q < width; q++) {
      let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]))
      while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k])) }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity
    }
    k = 0
    for (let q = 0; q < width; q++) { while (z[k + 1] < q) k++; result[q] = (q - v[k]) ** 2 + f[v[k]] }
  }
  for (let y = 0; y < width; y++) {
    f.set(distance.subarray(y * width, (y + 1) * width)); transform(); distance.set(result, y * width)
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < width; y++) f[y] = distance[y * width + x]
    transform()
    for (let y = 0; y < width; y++) distance[y * width + x] = Math.min(SHORE_DISTANCE, Math.sqrt(result[y])) * (coverage[y * width + x] >= .5 ? 1 : -1)
  }
  return distance
}

export function filterEarthMaterials(fine: Uint8Array, width: number, aa: number) {
  const color = new Uint8Array(width * width * 4), surface = new Uint8Array(width * width * 4), coverage = new Float32Array(width * width)
  const fineWidth = width * aa, count = aa * aa
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
    let r = 0, g = 0, b = 0, mapped = 0, wet = 0, relief = 0, roughness = 0
    for (let sy = 0; sy < aa; sy++) for (let sx = 0; sx < aa; sx++) {
      const id = fine[(y * aa + sy) * fineWidth + x * aa + sx], m = materials[id] ?? materials[0]
      r += m[0]; g += m[1]; b += m[2]; mapped += m[3]; relief += m[4]; roughness += m[5]
      if (id === EARTH_CLASS.ocean || id === EARTH_CLASS.lake) wet++
    }
    const i = y * width + x, o = i * 4
    color[o] = srgbByte(r / count); color[o + 1] = srgbByte(g / count); color[o + 2] = srgbByte(b / count); color[o + 3] = Math.round(mapped / count * 255)
    coverage[i] = wet / count; surface[o] = Math.round(coverage[i] * 255)
    surface[o + 2] = Math.round(relief / count * 255); surface[o + 3] = Math.round(roughness / count * 255)
  }
  const distance = shoreDistance(coverage, width)
  for (let i = 0; i < distance.length; i++) surface[i * 4 + 1] = Math.round((distance[i] / SHORE_DISTANCE * .5 + .5) * 255)
  return { color, surface }
}

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
export function rasterizeRings(rings: MaskPoint[][], extent: number, paint: (index: number) => void, size = MASK_SIZE, gutter = MASK_GUTTER) {
  const scale = size / extent, width = size + gutter * 2
  const edges: number[][] = []
  let minY = width, maxY = 0
  for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i]
    if (a.y === b.y) continue
    const edge = [a.x * scale + gutter, a.y * scale + gutter, b.x * scale + gutter, b.y * scale + gutter]
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

export type EarthVectorTile = { buffer: ArrayBuffer; address: { z: number; x: number; y: number } }
export function decodeEarthMask(buffer: ArrayBuffer, address: { z: number; x: number; y: number }): EarthMask {
  return decodeEarthSurface([{ buffer, address }], address, earthMaskSize(address.z))
}

/** Multiple native vector tiles may feed one independently sized surface mask.
 * Overzoomed targets crop the original vector geometry before rasterization. */
export function decodeEarthSurface(tiles: EarthVectorTile[], target: { z: number; x: number; y: number }, size: number): EarthMask {
  const width = size + MASK_GUTTER * 2
  const classes = new Uint8Array(width ** 2), water = new Uint16Array(width ** 2)
  const aa = 4, fineSize = size * aa, fineWidth = width * aa
  // The supersampled raster retains the same physical gutter as the numeric grid.
  const fine = new Uint8Array(fineWidth ** 2)
  const decoded = tiles.map(({ buffer, address }) => ({ tile: new VectorTile(new PbfReader(buffer)), address }))
  const waters: WaterFeature[] = [], counts: Record<string, number> = {}
  let shoreBudget = 4096
  // More specific land use refines landcover; water always owns its footprint.
  for (const name of ['landcover', 'landuse', 'water']) {
    counts[name] = 0
    for (const { tile, address } of decoded) {
      const layer = tile.layers[name]
      counts[name] += layer?.length ?? 0
      for (let i = 0; i < (layer?.length ?? 0); i++) {
        const feature = layer.feature(i), id = materialClass(name, feature.properties)
        if (feature.type !== 3 || !id) continue
        const original = feature.loadGeometry(), factor = 2 ** (target.z - address.z)
        const rings = original.map(ring => ring.map(p => ({
          x: (p.x / feature.extent * factor + address.x * factor - target.x) * feature.extent,
          y: (p.y / feature.extent * factor + address.y * factor - target.y) * feature.extent,
        })))
        let waterIndex = 0
        if (id === EARTH_CLASS.lake && address.z >= 10 && ['lake', 'pond'].includes(String(feature.properties.class)) && waters.length < 512) {
          const shore: [number, number][] = [], n = 2 ** address.z
          for (const ring of original) for (let j = 0; j < ring.length && shore.length < 48 && shoreBudget > 0; j += Math.max(1, Math.ceil(ring.length / 24))) {
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
        // Keep a categorical supersampled buffer only inside the worker. Average
        // decoded material responses, never numeric class IDs.
        rasterizeRings(rings, feature.extent, index => { fine[index] = id }, fineSize, MASK_GUTTER * aa)
      }
      }
  }
  // Lines have no observed width. Record availability without fabricating a river polygon.
  counts.waterway = decoded.reduce((sum, d) => sum + (d.tile.layers.waterway?.length ?? 0), 0)
  const { color, surface } = filterEarthMaterials(fine, width, aa)
  return { classes, water, waters, counts, width, color, surface }
}
