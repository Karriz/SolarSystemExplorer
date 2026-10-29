import { Vector3 } from 'three'

export type CameraSurface = { center: Vector3; radius: number }
export const SURFACE_CLEARANCE_METERS = 100
// Scene coordinates use astronomical units.
export const SURFACE_CLEARANCE = SURFACE_CLEARANCE_METERS / 149_597_870_700

// Keep both the camera and its path outside the globe, even when the orbit
// target has moved off-center through panning or zoom-to-cursor.
export function constrainCamera(
  position: Vector3,
  target: Vector3,
  previous: Vector3 | null,
  surfaces: CameraSurface[],
): number {
  const requested = position.clone()
  const movement = previous ? position.clone().sub(previous) : new Vector3()
  let fraction = 1
  if (previous && movement.lengthSq() > 0) {
    for (const { center, radius } of surfaces) {
      const offset = previous.clone().sub(center)
      // Sweep against the physical surface. The endpoint clearance below lets
      // short orbit steps follow the curved safety boundary without sticking.
      const c = offset.lengthSq() - radius * radius
      // A changed focus can start inside a different body; resolve that below.
      if (c < 0) continue
      const a = movement.lengthSq()
      const b = offset.dot(movement)
      const discriminant = b * b - a * c
      if (b >= 0 || discriminant < 0) continue
      const entry = (-b - Math.sqrt(discriminant)) / a
      if (entry >= 0 && entry < fraction) fraction = entry
    }
    position.copy(previous).addScaledVector(movement, fraction)
  }
  for (const { center, radius } of surfaces) {
    const offset = position.clone().sub(center)
    const safeRadius = radius + SURFACE_CLEARANCE
    if (offset.lengthSq() < safeRadius * safeRadius) {
      if (offset.lengthSq() === 0) offset.copy(position).sub(target)
      if (offset.lengthSq() === 0) offset.set(0, 0, 1)
      position.copy(center).add(offset.setLength(safeRadius))
    }
  }
  // Translate the target equally to preserve the user's viewing direction.
  target.add(position.clone().sub(requested))
  let altitude = Infinity
  for (const { center, radius } of surfaces) {
    altitude = Math.min(altitude, position.distanceTo(center) - radius)
  }
  return Math.max(1e-12, Math.min(1, altitude * .1))
}
