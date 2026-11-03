import * as THREE from 'three'
import type { TileAddress, TileBounds } from './surfaceTiles.ts'

/** Project in double precision before upload. GPU tan/log approximations at
 * globe scale can shift a fine tile by a sizeable fraction of its height. */
export function earthColorUvs(bounds: TileBounds, size: number, address: TileAddress) {
  const values: number[] = [], n = 2 ** address.z
  for (let r = 0; r < size; r++) {
    const lat = bounds.north + (bounds.south - bounds.north) * r / (size - 1)
    const phi = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(lat, -85.0511287798066, 85.0511287798066))
    const v = (.5 + Math.asinh(Math.tan(phi)) / (2 * Math.PI)) * n - (n - address.y - 1)
    for (let c = 0; c < size; c++) {
      const lon = bounds.west + (bounds.east - bounds.west) * c / (size - 1)
      values.push((lon + 180) / 360 * n - address.x, v)
    }
  }
  // Same perimeter order as terrainGeometry; skirt bottoms retain their tops' UVs.
  const edge = [
    ...Array.from({ length: size }, (_, c) => c),
    ...Array.from({ length: size - 1 }, (_, r) => (r + 1) * size + size - 1),
    ...Array.from({ length: size - 1 }, (_, c) => size * size - 2 - c),
    ...Array.from({ length: size - 2 }, (_, r) => (size - 2 - r) * size),
  ]
  for (const i of edge) values.push(values[i * 2], values[i * 2 + 1])
  return new THREE.Float32BufferAttribute(values, 2)
}

/** Convert mesh-local UVs to the currently available image, including parents.
 * Evaluate the global offset subtraction on the CPU, keeping GPU values small. */
export function earthColorTransform(address: TileAddress, texture: THREE.Texture, target = new THREE.Vector4()) {
  const n = 2 ** address.z
  return target.set(texture.repeat.x / n, texture.repeat.y / n,
    address.x / n * texture.repeat.x + texture.offset.x,
    (n - address.y - 1) / n * texture.repeat.y + texture.offset.y)
}

