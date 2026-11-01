import type { TileBounds } from './surfaceTiles.ts'

/** Bounded sub-resolution lunar surface synthesis.
 *
 * The measured LOLA pyramid ends where its source sampling ends. These
 * functions extend the height field beyond that with deterministic,
 * body-fixed, level-band-limited detail: small degraded craterlets and
 * rolling regolith noise whose feature size stays above the rendering
 * facet size of their level, so each LOD shows only detail it can carry.
 * Every value is a pure function of the body-fixed direction and level:
 * equal-LOD tile borders match exactly and results are reproducible.
 * This is synthesized appearance below measured resolution, not observed
 * topography, and its amplitude is bounded for camera-clearance safety.
 */

export const LUNAR_DETAIL_LEVELS = 2
/** Per-level offset clamp in meters. */
export const LUNAR_DETAIL_CLAMP = [18, 9]
/** Cumulative synthesis bound by synthetic level, for selection bounds. */
export const LUNAR_DETAIL_CUMULATIVE = [18, 27]

type LevelConfig = { cellMeters: number; rMin: number; rMax: number; gate: number; depthRatio: number; rimRatio: number; noise: [scale: number, amp: number][] }
const LEVELS: LevelConfig[] = [
  { cellMeters: 300, rMin: 60, rMax: 120, gate: .38, depthRatio: .11, rimRatio: .05,
    noise: [[460, 1.3], [210, .8]] },
  { cellMeters: 150, rMin: 34, rMax: 66, gate: .38, depthRatio: .11, rimRatio: .05,
    noise: [[230, .8], [105, .5]] },
]

function hash(x: number, y: number, z: number, w: number) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1) ^ Math.imul(w | 0, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

function noise3(x: number, y: number, z: number, seed: number) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  let fx = x - ix, fy = y - iy, fz = z - iz
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz)
  const c = (dx: number, dy: number, dz: number) => hash(ix + dx, iy + dy, iz + dz, seed)
  return (c(0, 0, 0) * (1 - fx) + c(1, 0, 0) * fx) * (1 - fy) * (1 - fz)
    + (c(0, 1, 0) * (1 - fx) + c(1, 1, 0) * fx) * fy * (1 - fz)
    + (c(0, 0, 1) * (1 - fx) + c(1, 0, 1) * fx) * (1 - fy) * fz
    + (c(0, 1, 1) * (1 - fx) + c(1, 1, 1) * fx) * fy * fz
}

/** Craterlets scattered on a jittered lattice over the sphere. Features
 * are smaller than the measured source resolves but everywhere-present on
 * the real Moon, which is what makes this honest as synthesis. */
function craterField(px: number, py: number, pz: number, cfg: LevelConfig, seed: number) {
  const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz)
  let sum = 0
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
    const gx = cx + i, gy = cy + j, gz = cz + k
    if (hash(gx, gy, gz, seed) > cfg.gate) continue
    const jx = gx + .15 + .7 * hash(gx, gy, gz, seed + 1)
    const jy = gy + .15 + .7 * hash(gx, gy, gz, seed + 2)
    const jz = gz + .15 + .7 * hash(gx, gy, gz, seed + 3)
    const radiusMeters = cfg.rMin + (cfg.rMax - cfg.rMin) * hash(gx, gy, gz, seed + 4)
    const radius = radiusMeters / cfg.cellMeters
    const dx = px - jx, dy = py - jy, dz = pz - jz
    const t = Math.sqrt(dx * dx + dy * dy + dz * dz) / radius
    if (t >= 1.35) continue
    const depth = cfg.depthRatio * radiusMeters * (.7 + .6 * hash(gx, gy, gz, seed + 5))
    if (t < 1) sum -= depth * (1 - t * t) ** 2
    const rim = t - 1
    sum += cfg.rimRatio * radiusMeters * Math.exp(-(rim * rim) / .026)
  }
  return sum
}

/** Height offset in meters for a body-fixed unit direction at the given
 * synthetic level (1-based). */
export function lunarDetailField(dx: number, dy: number, dz: number, level: number, referenceRadius: number) {
  const cfg = LEVELS[level - 1]
  let offset = craterField(dx * referenceRadius / cfg.cellMeters, dy * referenceRadius / cfg.cellMeters,
    dz * referenceRadius / cfg.cellMeters, cfg, level * 7919)
  for (let n = 0; n < cfg.noise.length; n++) {
    const [scale, amp] = cfg.noise[n]
    const f = referenceRadius / scale
    offset += (noise3(dx * f, dy * f, dz * f, level * 617 + n) - .5) * 2 * amp
  }
  return Math.max(-LUNAR_DETAIL_CLAMP[level - 1], Math.min(LUNAR_DETAIL_CLAMP[level - 1], offset))
}

/** Upsample a parent height grid to a child tile and add the child level's
 * synthesis. Slopes from the measured parent surface suppress craterlets on
 * steep terrain, the way real regolith ponds. */
export function deriveSyntheticHeights(parent: Float32Array, parentSize: number, parentBounds: TileBounds,
  childBounds: TileBounds, size: number, level: number, referenceRadius: number) {
  if (parent.length !== parentSize * parentSize || level < 1 || level > LUNAR_DETAIL_LEVELS) throw new Error('Invalid synthetic height derivation')
  const sample = (x: number, y: number) => {
    const cx = Math.min(parentSize - 2, Math.max(0, Math.floor(x))), cy = Math.min(parentSize - 2, Math.max(0, Math.floor(y)))
    const fx = Math.min(1, Math.max(0, x - cx)), fy = Math.min(1, Math.max(0, y - cy))
    const i = cy * parentSize + cx
    const a = parent[i], b = parent[i + 1], c = parent[i + parentSize], d = parent[i + parentSize + 1]
    if (![a, b, c, d].every(Number.isFinite)) return NaN
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy
  }
  const result = new Float32Array(size * size)
  const degrees = Math.PI / 180
  const upsampled = new Float32Array(size * size)
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const lon = childBounds.west + (childBounds.east - childBounds.west) * c / (size - 1)
    const lat = childBounds.north + (childBounds.south - childBounds.north) * r / (size - 1)
    const px = (lon - parentBounds.west) / (parentBounds.east - parentBounds.west) * (parentSize - 1)
    const py = (lat - parentBounds.north) / (parentBounds.south - parentBounds.north) * (parentSize - 1)
    upsampled[r * size + c] = sample(px, py)
  }
  const rowMeters = (childBounds.north - childBounds.south) * degrees * referenceRadius / (size - 1)
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const i = r * size + c
    const height = upsampled[i]
    if (!Number.isFinite(height)) { result[i] = NaN; continue }
    const lon = childBounds.west + (childBounds.east - childBounds.west) * c / (size - 1)
    const lat = childBounds.north + (childBounds.south - childBounds.north) * r / (size - 1)
    const columnMeters = rowMeters * Math.cos(lat * degrees)
    const dw = c > 0 ? upsampled[i - 1] : height, de = c < size - 1 ? upsampled[i + 1] : height
    const dn = r > 0 ? upsampled[i - size] : height, ds = r < size - 1 ? upsampled[i + size] : height
    const slope = Math.hypot((de - dw) / (2 * columnMeters), (ds - dn) / (2 * rowMeters))
    const suppress = 1 - smoothstep(.18, .5, slope)
    const theta = lat * degrees, phi = lon * degrees
    const dirX = Math.cos(theta) * Math.cos(phi), dirY = Math.sin(theta), dirZ = -Math.cos(theta) * Math.sin(phi)
    result[i] = height + lunarDetailField(dirX, dirY, dirZ, level, referenceRadius) * suppress
  }
  return result
}
