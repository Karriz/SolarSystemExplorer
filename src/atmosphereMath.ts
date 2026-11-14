import { Vector3, type Matrix4 } from 'three'

/** Reference geometry in body-relative km. Direction must have unit length;
 * returned distances may be behind the ray origin. */
export function raySphereInterval(origin: Vector3, direction: Vector3, radius: number): [number, number] | null {
  const b = origin.dot(direction)
  // Cross-product distance avoids subtracting two large squared lengths near
  // the limb; factored c avoids cancellation just above the ground.
  const perpendicularSquared = new Vector3().crossVectors(origin, direction).lengthSq()
  const discriminant = radius * radius - perpendicularSquared
  if (discriminant < 0) return null
  const root = Math.sqrt(discriminant)
  if (root === 0) return [-b || 0, -b || 0]
  const q = -b - (b < 0 ? -root : root)
  if (q === 0) return [0, 0]
  const length = origin.length()
  const other = ((length - radius) * (length + radius)) / q
  return q < other ? [q, other] : [other, q]
}

/** Clip air to the actual opaque endpoint. Do not substitute a reference
 * ground sphere: measured terrain can lie above or below it. */
export function atmosphereRaySegment(origin: Vector3, direction: Vector3, topRadius: number,
  opaqueDistance = Infinity): [number, number] | null {
  const interval = raySphereInterval(origin, direction, topRadius)
  if (!interval) return null
  const start = Math.max(0, interval[0]), end = Math.min(opaqueDistance, interval[1])
  return end > start ? [start, end] : null
}

export function planetOccludesSun(point: Vector3, towardSun: Vector3, radius: number): boolean {
  const interval = raySphereInterval(point, towardSun, radius)
  return interval !== null && interval[1] > 1e-7 && interval[0] < interval[1]
}

/** Reference for standard WebGL perspective depth (not logarithmic/reversed).
 * UV is bottom-left origin, depth is [0,1], output uses the camera's units. */
export function reconstructViewPosition(u: number, v: number, depth: number,
  inverseProjection: Matrix4, target = new Vector3()): Vector3 {
  return target.set(u * 2 - 1, v * 2 - 1, depth * 2 - 1).applyMatrix4(inverseProjection)
}
