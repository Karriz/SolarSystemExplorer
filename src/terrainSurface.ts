import * as THREE from 'three'
import type { TileBounds } from './surfaceTiles.ts'

export type TerrainSurfaceSampler = (lat: number, lon: number, point: THREE.Vector3, normal: THREE.Vector3) => boolean

/** Intersect only the cells around a geographic point, never skirts. Coordinates
 * are body-local reference-radius units, matching global terrain geometry. */
export function terrainSurfaceSampler() {
  const ray = new THREE.Ray(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3()
  const bary = new THREE.Vector3(), triangle = new THREE.Triangle(), direction = new THREE.Vector3()
  return (geometry: THREE.BufferGeometry, bounds: TileBounds, size: number, lat: number, lon: number,
    point: THREE.Vector3, normal: THREE.Vector3, rows = size, unitScale = 1, oppositeDiagonal = false) => {
    if (lon < bounds.west - 1e-9 || lon > bounds.east + 1e-9 || lat < bounds.south - 1e-9 || lat > bounds.north + 1e-9) return false
    const row = Math.floor((bounds.north - lat) / (bounds.north - bounds.south) * (rows - 1))
    const col = Math.floor((lon - bounds.west) / (bounds.east - bounds.west) * (size - 1))
    const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180
    direction.set(Math.cos(phi) * Math.cos(lambda), Math.sin(phi), -Math.cos(phi) * Math.sin(lambda))
    ray.origin.copy(direction).multiplyScalar(2); ray.direction.copy(direction).negate()
    const positions = geometry.getAttribute('position'), normals = geometry.getAttribute('normal')
    // Spherical chords shift the actual triangle boundary slightly from the
    // latitude grid. Include adjacent cells, including exact tile endpoints.
    for (let r = Math.max(0, row - 1); r <= Math.min(rows - 2, row + 1); r++) {
      for (let k = Math.max(0, col - 1); k <= Math.min(size - 2, col + 1); k++) {
        const start = r * size + k
        for (let half = 0; half < 2; half++) {
          const ia = start + (oppositeDiagonal ? 1 - half : half)
          const ib = start + (oppositeDiagonal && half === 0 ? 0 : size)
          const ic = start + 1 + (oppositeDiagonal ? size : half * size)
          a.fromBufferAttribute(positions, ia).multiplyScalar(unitScale)
          b.fromBufferAttribute(positions, ib).multiplyScalar(unitScale)
          c.fromBufferAttribute(positions, ic).multiplyScalar(unitScale)
          if (!ray.intersectTriangle(a, b, c, false, point)) continue
          triangle.set(a, b, c).getBarycoord(point, bary)
          normal.set(0, 0, 0)
          normal.addScaledVector(a.fromBufferAttribute(normals, ia), bary.x)
            .addScaledVector(b.fromBufferAttribute(normals, ib), bary.y)
            .addScaledVector(c.fromBufferAttribute(normals, ic), bary.z).normalize()
          return true
        }
      }
    }
    return false
  }
}

export const referenceSphereSurface: TerrainSurfaceSampler = (lat, lon, point, normal) => {
  const phi = lat * Math.PI / 180, lambda = lon * Math.PI / 180
  point.set(Math.cos(phi) * Math.cos(lambda), Math.sin(phi), -Math.cos(phi) * Math.sin(lambda))
  normal.copy(point)
  return true
}

/** Crack-hiding skirts are not ground: picking them creates false vertical
 * surfaces for dragging/clearance at coverage edges and missing tiles. */
export function firstTerrainSurfaceHit(picker: THREE.Raycaster, meshes: THREE.Object3D[]) {
  return picker.intersectObjects(meshes, false).find(hit => {
    const skirt = (hit.object as THREE.Mesh).geometry?.getAttribute('terrainSkirt')
    return !skirt || !!hit.face && skirt.getX(hit.face.a) === 0 && skirt.getX(hit.face.b) === 0 && skirt.getX(hit.face.c) === 0
  })
}

/** Match the fallback's actual facets, including the coarser base globe when a
 * measured global release is unavailable. No ideal-sphere/mesh height mismatch. */
export function sphereSurfaceSampler(geometry: THREE.SphereGeometry): TerrainSurfaceSampler {
  const sample = terrainSurfaceSampler(), parameters = geometry.parameters
  const bounds = { west: -180, east: 180, north: 90, south: -90, span: 360 }
  return (lat, lon, point, normal) => sample(geometry, bounds, parameters.widthSegments + 1,
    lat, lon, point, normal, parameters.heightSegments + 1, 1 / parameters.radius, true)
}
