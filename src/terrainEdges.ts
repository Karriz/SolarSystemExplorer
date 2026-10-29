import * as THREE from 'three'
import type { TileBounds } from './surfaceTiles.ts'

export type TerrainEdge = { size: number; indices: number[]; positions: Float32Array; normals: Float32Array; skirtIndices: number[]; skirtDepths: Float32Array }
export type EdgePatch = { key: string; level: number; bounds: TileBounds; origin: THREE.Vector3; geometry: THREE.BufferGeometry; edge: TerrainEdge }

/** Keep only the original perimeter, so changing visible neighbors can restore
 * source geometry without copying/rebuilding the entire mesh every frame. */
export function captureTerrainEdge(geometry: THREE.BufferGeometry, size = 65): TerrainEdge {
  const indices: number[] = []
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (!r || !c || r === size - 1 || c === size - 1) indices.push(r * size + c)
  }
  const perimeter = [
    ...Array.from({ length: size }, (_, c) => c),
    ...Array.from({ length: size - 1 }, (_, r) => (r + 1) * size + size - 1),
    ...Array.from({ length: size - 1 }, (_, c) => size * size - 2 - c),
    ...Array.from({ length: size - 2 }, (_, r) => (size - 2 - r) * size),
  ]
  const skirtIndices = indices.map(index => size * size + perimeter.indexOf(index))
  const skirtDepths = new Float32Array(indices.length)
  const positions = new Float32Array(indices.length * 3), normals = new Float32Array(indices.length * 3)
  const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal')
  indices.forEach((index, i) => {
    positions.set([p.getX(index), p.getY(index), p.getZ(index)], i * 3)
    normals.set([n.getX(index), n.getY(index), n.getZ(index)], i * 3)
    const lower = skirtIndices[i]
    skirtDepths[i] = Math.hypot(p.getX(index) - p.getX(lower), p.getY(index) - p.getY(lower), p.getZ(index) - p.getZ(lower))
  })
  return { size, indices, positions, normals, skirtIndices, skirtDepths }
}

/** Match the complete 3D edge polyline, including spherical chord error.
 * Fine edges follow coarse ones; equal-level edges have one deterministic
 * owner. Coarse-to-fine processing also resolves multi-patch corner junctions.
 * No measured interior samples are smoothed or clipped. */
export function stitchTerrainEdges(patches: EdgePatch[]) {
  const ordered = [...patches].sort((a, b) => a.level - b.level || a.key.localeCompare(b.key))
  const eps = 1e-9, point = new THREE.Vector3(), normal = new THREE.Vector3()
  for (const patch of ordered) {
    const p = patch.geometry.getAttribute('position'), n = patch.geometry.getAttribute('normal')
    patch.edge.indices.forEach((index, i) => {
      p.setXYZ(index, patch.edge.positions[i * 3], patch.edge.positions[i * 3 + 1], patch.edge.positions[i * 3 + 2])
      n.setXYZ(index, patch.edge.normals[i * 3], patch.edge.normals[i * 3 + 1], patch.edge.normals[i * 3 + 2])
    })
  }
  for (let rank = 0; rank < ordered.length; rank++) {
    const patch = ordered[rank], b = patch.bounds, size = patch.edge.size
    const p = patch.geometry.getAttribute('position'), n = patch.geometry.getAttribute('normal')
    const neighbors = ordered.slice(0, rank).filter(other => {
      const o = other.bounds
      return b.west <= o.east + eps && b.east >= o.west - eps && b.south <= o.north + eps && b.north >= o.south - eps
    })
    for (const index of patch.edge.indices) {
      const row = Math.floor(index / size), col = index % size
      const lon = b.west + (b.east - b.west) * col / (size - 1)
      const lat = b.north + (b.south - b.north) * row / (size - 1)
      const owner = neighbors.find(other => {
        const o = other.bounds
        return lon >= o.west - eps && lon <= o.east + eps && lat >= o.south - eps && lat <= o.north + eps
          && (Math.abs(lon - o.west) < eps || Math.abs(lon - o.east) < eps || Math.abs(lat - o.north) < eps || Math.abs(lat - o.south) < eps)
      })
      if (!owner) continue
      const o = owner.bounds, ownerSize = owner.edge.size
      let u: number, first: number, second: number
      if (Math.abs(lon - o.west) < eps || Math.abs(lon - o.east) < eps) {
        u = THREE.MathUtils.clamp((o.north - lat) / (o.north - o.south) * (ownerSize - 1), 0, ownerSize - 1)
        const c = Math.abs(lon - o.west) < eps ? 0 : ownerSize - 1
        first = Math.floor(u) * ownerSize + c; second = Math.min(ownerSize - 1, Math.floor(u) + 1) * ownerSize + c
      } else {
        u = THREE.MathUtils.clamp((lon - o.west) / (o.east - o.west) * (ownerSize - 1), 0, ownerSize - 1)
        const r = Math.abs(lat - o.north) < eps ? 0 : ownerSize - 1
        first = r * ownerSize + Math.floor(u); second = r * ownerSize + Math.min(ownerSize - 1, Math.floor(u) + 1)
      }
      const a = owner.geometry.getAttribute('position'), an = owner.geometry.getAttribute('normal'), f = u - Math.floor(u)
      point.set(THREE.MathUtils.lerp(a.getX(first), a.getX(second), f), THREE.MathUtils.lerp(a.getY(first), a.getY(second), f), THREE.MathUtils.lerp(a.getZ(first), a.getZ(second), f))
        .add(owner.origin).sub(patch.origin)
      normal.set(THREE.MathUtils.lerp(an.getX(first), an.getX(second), f), THREE.MathUtils.lerp(an.getY(first), an.getY(second), f), THREE.MathUtils.lerp(an.getZ(first), an.getZ(second), f)).normalize()
      p.setXYZ(index, point.x, point.y, point.z); n.setXYZ(index, normal.x, normal.y, normal.z)
    }
    // Move each skirt's bottom with its corrected top. Otherwise lowering an
    // edge by more than the skirt depth turns the old bottom into an upward spike.
    patch.edge.indices.forEach((index, i) => {
      const bottom = patch.edge.skirtIndices[i]
      point.fromBufferAttribute(p, index).add(patch.origin)
      point.setLength(point.length() - patch.edge.skirtDepths[i]).sub(patch.origin)
      p.setXYZ(bottom, point.x, point.y, point.z)
      n.setXYZ(bottom, n.getX(index), n.getY(index), n.getZ(index))
    })
    p.needsUpdate = true; n.needsUpdate = true
    patch.geometry.computeBoundingSphere()
    patch.geometry.computeBoundingBox()
  }
}
