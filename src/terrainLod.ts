/** A close Earth tile uses four times the triangles of the previous 65 grid.
 * Coarse ancestors stay small; the selector also caps the visible triangle sum. */
export const REGIONAL_TRIANGLE_BUDGET = 400_000
export const EARTH_HEIGHT_SIZE = 129
export function earthMeshSize(zoom: number) { return zoom >= 14 ? 129 : zoom >= 11 ? 65 : 33 }
export function meshTriangles(size: number) { return 2 * (size - 1) ** 2 + 8 * (size - 1) }
export function heightGrid(heights: Float32Array, sourceSize: number, size: number) {
  if (sourceSize === size) return heights
  if (heights.length !== sourceSize ** 2 || (sourceSize - 1) % (size - 1)) throw new Error('Incompatible height grid')
  const result = new Float32Array(size ** 2), step = (sourceSize - 1) / (size - 1)
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) result[r * size + c] = heights[r * step * sourceSize + c * step]
  return result
}

/** LOD visibility follows the measured surface, not the long crack-hiding
 * skirts below it. Including skirts makes off-screen tiles consume the budget. */
export function terrainSurfaceBounds(position: { count: number; getX: (i: number) => number; getY: (i: number) => number; getZ: (i: number) => number }, size: number) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < Math.min(position.count, size * size); i++) {
    const x = position.getX(i), y = position.getY(i), z = position.getZ(i)
    min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z)
    max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z)
  }
  return { min, max }
}
