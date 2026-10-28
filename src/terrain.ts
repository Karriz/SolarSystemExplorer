import * as THREE from 'three'
import type { TileAddress, TileBounds } from './surfaceTiles.ts'

export const terrainBodies = ['moon', 'mars', 'mercury', 'venus'] as const
export type TerrainBody = typeof terrainBodies[number]
export function isTerrainBody(id: string): id is TerrainBody { return terrainBodies.some(body => body === id) }
const adapters: Record<TerrainBody, { radius: number; scale: number; frame: string }> = {
  moon: { radius: 1737400, scale: .5, frame: 'MEAN EARTH/POLAR AXIS OF DE421' },
  mars: { radius: 3389500, scale: 1, frame: 'IAU2000' },
  mercury: { radius: 2439400, scale: .5, frame: 'MESSENGER MDIS body-fixed' },
  venus: { radius: 6051000, scale: 1, frame: 'Magellan body-fixed' },
}
export type TerrainTileInfo = { min: number; max: number; error: number; bytes: number; sha256: string }
export type TerrainIndexPage = { url: string; bytes: number; sha256: string }
export type TerrainManifest = {
  schema: 1 | 2; body: TerrainBody; version: string; grid: 'geographic-2x1'
  sampleSize: number; maxZoom: number; encoding: 'gzip-int16-le'
  scaleMeters: number; offsetMeters: number; referenceRadiusMeters: number
  frame: string; longitude: 'east-positive-minus180-to180'; rowOrder: 'north-to-south'
  minHeightMeters: number; maxHeightMeters: number; sourceResolutionMeters: number
  credit: string; sourceUrl: string; tileUrl: string; tiles: Record<string, TerrainTileInfo>
  noData?: number; missingPixels?: number; verticalDatum?: string; referenceSurfaceApproximation?: boolean
  indexPages?: { rootZoom: number; pages: Record<string, TerrainIndexPage> }
}

function validTile(t: TerrainTileInfo, m: TerrainManifest) {
  return t && [t.min, t.max, t.error, t.bytes].every(Number.isFinite)
    && t.min >= m.minHeightMeters && t.max <= m.maxHeightMeters && t.min <= t.max
    && t.error >= 0 && t.bytes > 0 && t.bytes <= 65536 && /^[a-f0-9]{64}$/.test(t.sha256)
}

export function parseTerrainManifest(value: unknown): TerrainManifest {
  const m = value as TerrainManifest
  if (!m || !isTerrainBody(m.body) || (m.schema !== 1 && m.schema !== 2) || (m.schema === 1 && m.body !== 'moon')
    || m.grid !== 'geographic-2x1' || m.encoding !== 'gzip-int16-le'
    || m.referenceRadiusMeters !== adapters[m.body].radius || m.scaleMeters !== adapters[m.body].scale
    || m.frame !== adapters[m.body].frame || m.longitude !== 'east-positive-minus180-to180' || m.rowOrder !== 'north-to-south'
    || m.offsetMeters !== 0 || m.tileUrl !== 'tiles/{z}/{x}/{y}.bin'
    || m.sampleSize !== 65 || !Number.isInteger(m.maxZoom) || m.maxZoom < 0 || m.maxZoom > 8
    || !Number.isFinite(m.minHeightMeters) || !Number.isFinite(m.maxHeightMeters)
    || m.minHeightMeters < -32767 * m.scaleMeters || m.maxHeightMeters > 32767 * m.scaleMeters || m.minHeightMeters > m.maxHeightMeters
    || !m.tiles || typeof m.credit !== 'string' || typeof m.sourceUrl !== 'string'
    || (m.schema === 2 && (m.noData !== -32768 || !m.indexPages || m.indexPages.rootZoom !== 3
      || !Number.isFinite(m.sourceResolutionMeters) || m.sourceResolutionMeters <= 0 || typeof m.verticalDatum !== 'string'))) {
    throw new Error('Unsupported terrain manifest')
  }
  const rootZoom = m.schema === 2 ? Math.min(3, m.maxZoom) : m.maxZoom
  for (let z = 0; z <= rootZoom; z++) for (let x = 0; x < 2 ** (z + 1); x++) for (let y = 0; y < 2 ** z; y++) {
    if (!validTile(m.tiles[`${z}/${x}/${y}`], m)) throw new Error('Incomplete or invalid terrain tile index')
  }
  if (m.schema === 2 && m.maxZoom > 3) {
    for (let x = 0; x < 16; x++) for (let y = 0; y < 8; y++) {
      const page = m.indexPages!.pages[`${x}/${y}`]
      if (!page || page.url !== `indices/${x}/${y}.json` || !Number.isInteger(page.bytes)
        || page.bytes <= 0 || page.bytes > 512000 || !/^[a-f0-9]{64}$/.test(page.sha256)) throw new Error('Invalid terrain metadata page')
    }
  }
  return m
}

export function parseTerrainPage(value: unknown, m: TerrainManifest, pageKey: string): Record<string, TerrainTileInfo> {
  const tiles = value as Record<string, TerrainTileInfo>
  const [px, py] = pageKey.split('/').map(Number)
  if (!tiles || typeof tiles !== 'object') throw new Error('Invalid terrain index page')
  let count = 0
  for (let z = 4; z <= m.maxZoom; z++) {
    const factor = 2 ** (z - 3)
    for (let x = px * factor; x < (px + 1) * factor; x++) for (let y = py * factor; y < (py + 1) * factor; y++) {
      if (!validTile(tiles[`${z}/${x}/${y}`], m)) throw new Error('Incomplete terrain metadata page')
      count++
    }
  }
  if (Object.keys(tiles).length !== count) throw new Error('Unexpected terrain metadata entries')
  return tiles
}

export function terrainBounds({ z, x, y }: TileAddress): TileBounds {
  const span = 180 / 2 ** z
  return { west: -180 + x * span, east: -180 + (x + 1) * span,
    north: 90 - y * span, south: 90 - (y + 1) * span, span }
}

export function terrainChildren({ z, x, y }: TileAddress): TileAddress[] {
  return [0, 1, 2, 3].map(i => ({ z: z + 1, x: x * 2 + i % 2, y: y * 2 + Math.floor(i / 2) }))
}

/** Input rows run north to south; UVs address the existing global color map. */
export function terrainGeometry(bounds: TileBounds, heights: Float32Array, size: number,
  referenceRadius: number, renderRadius: number, exaggeration: number): THREE.BufferGeometry {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [], coverage: number[] = []
  const { west, north, span } = bounds
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const lon = west + span * c / (size - 1), lat = north - span * r / (size - 1)
    const phi = lon * Math.PI / 180, theta = lat * Math.PI / 180
    const height = heights[r * size + c]
    const radius = (referenceRadius + (Number.isFinite(height) ? height : 0) * exaggeration) / renderRadius
    coverage.push(Number.isFinite(height) ? 1 : 0)
    positions.push(radius * Math.cos(theta) * Math.cos(phi), radius * Math.sin(theta),
      -radius * Math.cos(theta) * Math.sin(phi))
    uvs.push((lon + 180) / 360, (lat + 90) / 180)
    if (r < size - 1 && c < size - 1) {
      const a = r * size + c
      indices.push(a, a + size, a + 1, a + 1, a + size, a + size + 1)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  const normals = Array.from(geometry.getAttribute('normal').array)
  // Skirts cover mixed-LOD boundaries; preserve the surface's computed normals.
  const edge = [
    ...Array.from({ length: size }, (_, c) => c),
    ...Array.from({ length: size - 1 }, (_, r) => (r + 1) * size + size - 1),
    ...Array.from({ length: size - 1 }, (_, c) => size * size - 2 - c),
    ...Array.from({ length: size - 2 }, (_, r) => (size - 2 - r) * size),
  ]
  const skirtDepth = Math.max(1500, referenceRadius * (1 - Math.cos(span / (size - 1) * Math.PI / 180))) * exaggeration
  for (const i of edge) {
    const v = new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])
    v.setLength(v.length() - skirtDepth / renderRadius)
    positions.push(v.x, v.y, v.z)
    uvs.push(uvs[i * 2], uvs[i * 2 + 1])
    normals.push(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2])
    coverage.push(coverage[i])
  }
  for (let i = 0; i < edge.length; i++) {
    const j = (i + 1) % edge.length, a = edge[i], b = edge[j], c = size * size + i, d = size * size + j
    indices.push(a, b, c, b, d, c)
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('terrainCoverage', new THREE.Float32BufferAttribute(coverage, 1))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}
