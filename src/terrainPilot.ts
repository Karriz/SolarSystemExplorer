import * as THREE from 'three'
import { terrainBounds, terrainChildren, type TerrainBody, type TerrainTileInfo } from './terrain.ts'
import type { TileAddress, TileBounds } from './surfaceTiles.ts'

export type PilotBody = TerrainBody | 'earth'
export type PilotLocation = { id: string; body: PilotBody; name: string; lat: number; lon: number; altitude: number }
export const pilotLocations: PilotLocation[] = [
  { id: 'finland', body: 'earth', name: 'Southern Finland', lat: 60.38, lon: 25.0, altitude: 12000 },
  { id: 'alps', body: 'earth', name: 'Bernese Alps', lat: 46.57, lon: 8.02, altitude: 18000 },
  { id: 'namibia', body: 'earth', name: 'Brandberg, Namibia', lat: -21.12, lon: 14.58, altitude: 24000 },
  { id: 'hadley', body: 'moon', name: 'Hadley–Apennine', lat: 26.13, lon: 3.63, altitude: 30000 },
]

export function mercatorAddress(lon: number, lat: number, z: number): TileAddress {
  const n = 2 ** z, phi = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(lat, -85.0511287, 85.0511287))
  return { z, x: Math.min(n - 1, Math.max(0, Math.floor((lon + 180) / 360 * n))),
    y: Math.min(n - 1, Math.max(0, Math.floor((1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n))) }
}
export function mercatorBounds({ z, x, y }: TileAddress): TileBounds {
  const n = 2 ** z
  const latitude = (v: number) => THREE.MathUtils.radToDeg(Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))))
  return { west: x / n * 360 - 180, east: (x + 1) / n * 360 - 180, north: latitude(y), south: latitude(y + 1), span: 360 / n }
}
/** Four native roots surround the viewed ground. Only visible descendants are
 * fetched; this expands coverage without preparing a world-sized archive. */
export function earthViewRoots(lon: number, lat: number): TileAddress[] {
  if (lat < -85.0511287 || lat > 85.0511287) return []
  const n = 256, x = (lon + 180) / 360 * n
  const y = (1 - Math.asinh(Math.tan(THREE.MathUtils.degToRad(lat))) / Math.PI) / 2 * n
  const x0 = Math.floor(x - .5), y0 = THREE.MathUtils.clamp(Math.floor(y - .5), 0, n - 2)
  return [0, 1, 2, 3].map(i => ({ z: 8, x: ((x0 + i % 2) % n + n) % n, y: y0 + Math.floor(i / 2) }))
}
export function tileKey(a: TileAddress) { return `${a.z}/${a.x}/${a.y}` }
export function insideRoot(a: TileAddress, root: TileAddress) {
  const factor = 2 ** (a.z - root.z)
  return a.z >= root.z && Math.floor(a.x / factor) === root.x && Math.floor(a.y / factor) === root.y
}

/** Sample numerical Terrarium channels at geographic mesh vertices. No image
 * color management or lossy re-encoding is permitted before this function. */
export function sampleTerrarium(rgba: Uint8ClampedArray, width: number, height: number, bounds: TileBounds, address: TileAddress, size = 65, gradients?: Float32Array) {
  if (width !== 512 || height !== 512 || rgba.length !== width * height * 4) throw new Error('Unexpected Terrarium tile dimensions')
  const result = new Float32Array(size * size), n = 2 ** address.z
  const value = (x: number, y: number) => {
    const i = (Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4
    return rgba[i + 3] === 0 ? NaN : rgba[i] * 256 + rgba[i + 1] + rgba[i + 2] / 256 - 32768
  }
  const sample = (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy
    const samples = [value(ix, iy), value(ix + 1, iy), value(ix, iy + 1), value(ix + 1, iy + 1)]
    return samples.every(Number.isFinite)
      ? THREE.MathUtils.lerp(THREE.MathUtils.lerp(samples[0], samples[1], fx), THREE.MathUtils.lerp(samples[2], samples[3], fx), fy) : NaN
  }
  if (gradients && gradients.length !== 2 * size * size) throw new Error('Unexpected gradient length')
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const lat = bounds.north + (bounds.south - bounds.north) * r / (size - 1)
    const phi = THREE.MathUtils.degToRad(lat)
    const v = (1 - Math.asinh(Math.tan(phi)) / Math.PI) / 2 * n - address.y
    const x = c / (size - 1) * width - .5, y = v * height - .5
    result[r * size + c] = sample(x, y)
    if (gradients) {
      // Derive normals from the delivered raster, independently of the much
      // coarser render mesh. Edge stencils are one-sided until halo fetching.
      const px = THREE.MathUtils.clamp(x, 0, width - 1), py = THREE.MathUtils.clamp(y, 0, height - 1)
      const left = Math.max(0, px - 1), right = Math.min(width - 1, px + 1)
      const top = Math.max(0, py - 1), bottom = Math.min(height - 1, py + 1)
      const meters = 2 * Math.PI * 6371000 * Math.cos(phi) / (width * n)
      gradients[r * size + c] = (sample(right, py) - sample(left, py)) / ((right - left) * meters)
      gradients[size * size + r * size + c] = (sample(px, top) - sample(px, bottom)) / ((bottom - top) * meters)
    }
  }
  return result
}

export type TerrainPatch = { sampleSize?: number; heights: Float32Array; gradients?: Float32Array; transferBytes: number; decodeMs: number }
export type RegionalSource = {
  id: string; body: PilotBody; sampleSize?: number; root: TileAddress; roots?: (lon: number, lat: number) => TileAddress[]; maxZoom: number; minHeight: number; maxHeight: number
  resolution: number; credit: string; url: string; bounds: (address: TileAddress) => TileBounds
  info?: (address: TileAddress) => TerrainTileInfo | undefined
  load: (address: TileAddress, signal: AbortSignal) => Promise<TerrainPatch>
  dispose?: () => void
}

export type RegionalManifest = {
  schema: 1; id: string; body: 'moon'; root: TileAddress; maxZoom: number; sampleSize: 65
  referenceRadiusMeters: 1737400; components?: 3; scaleMeters: number; offsetMeters: number; noData: -32768
  minHeightMeters: number; maxHeightMeters: number; sourceResolutionMeters: number
  credit: string; sourceUrl: string; license: string; frame: string; verticalDatum: string
  tiles: Record<string, TerrainTileInfo>
}

/** Pilot manifests are deliberately bounded, sparse overlays, never complete
 * global pyramids. Large releases must introduce hierarchical metadata. */
export function parseRegionalManifest(value: unknown): RegionalManifest {
  const m = value as RegionalManifest
  if (!m || m.schema !== 1 || m.body !== 'moon' || !/^[a-z0-9-]+$/.test(m.id) || m.sampleSize !== 65
    || m.referenceRadiusMeters !== 1737400 || m.frame !== 'MEAN EARTH/POLAR AXIS OF DE421'
    || (m.components !== undefined && m.components !== 3) || m.noData !== -32768 || !Number.isFinite(m.scaleMeters) || m.scaleMeters <= 0 || !Number.isFinite(m.offsetMeters)
    || !Number.isFinite(m.minHeightMeters) || !Number.isFinite(m.maxHeightMeters) || m.maxHeightMeters < m.minHeightMeters
    || !Number.isFinite(m.sourceResolutionMeters) || m.sourceResolutionMeters <= 0
    || !m.root || ![m.root.z, m.root.x, m.root.y, m.maxZoom].every(Number.isInteger)
    || m.root.z < 3 || m.root.z > 12 || m.maxZoom < m.root.z || m.maxZoom > 16
    || m.root.x < 0 || m.root.x >= 2 ** (m.root.z + 1) || m.root.y < 0 || m.root.y >= 2 ** m.root.z
    || !m.tiles || Object.keys(m.tiles).length > 4096 || typeof m.credit !== 'string' || typeof m.sourceUrl !== 'string'
    || typeof m.license !== 'string' || typeof m.verticalDatum !== 'string') throw new Error('Invalid bounded regional terrain manifest')
  for (const [key, info] of Object.entries(m.tiles)) {
    const [z, x, y] = key.split('/').map(Number), a = { z, x, y }
    if (![z, x, y].every(Number.isInteger) || key !== tileKey(a) || z > m.maxZoom || !insideRoot(a, m.root)
      || !info || ![info.min, info.max, info.error, info.bytes].every(Number.isFinite)
      || info.min < m.minHeightMeters || info.max > m.maxHeightMeters || info.min > info.max || info.error < 0
      || !Number.isInteger(info.bytes) || info.bytes <= 0 || info.bytes > 65536 || !/^[a-f0-9]{64}$/.test(info.sha256)) throw new Error('Invalid regional tile')
    if (z > m.root.z && !m.tiles[tileKey({ z: z - 1, x: Math.floor(x / 2), y: Math.floor(y / 2) })]) throw new Error('Orphan regional tile')
    const children = terrainChildren(a).filter(child => m.tiles[tileKey(child)])
    if (children.length && children.length !== 4) throw new Error('Incomplete regional sibling set')
  }
  if (!m.tiles[tileKey(m.root)]) throw new Error('Missing regional fallback root')
  return m
}

export function geoDirection(lat: number, lon: number) {
  const phi = THREE.MathUtils.degToRad(lon), theta = THREE.MathUtils.degToRad(lat)
  return new THREE.Vector3(Math.cos(theta) * Math.cos(phi), Math.sin(theta), -Math.cos(theta) * Math.sin(phi))
}
export { terrainBounds }
