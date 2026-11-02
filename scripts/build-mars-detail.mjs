// Offline, seamless normal/roughness data for Mars. No lighting or measured
// topography is baked into this small reusable material texture. The Martian
// surface reads as dust and sand with wind-formed ripples and sparse angular
// rock fragments, so the fine grain stays smoother and sparser than the Moon's.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const size = 512
function hash(x, y, seed = 0) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177)
  h = Math.imul(h ^ h >>> 13, 1274126177)
  return ((h ^ h >>> 16) >>> 0) / 4294967296
}
function noise(x, y, cells) {
  const ix = Math.floor(x), iy = Math.floor(y)
  let fx = x - ix, fy = y - iy
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
  const wrap = value => (value % cells + cells) % cells
  const a = hash(wrap(ix), wrap(iy), cells), b = hash(wrap(ix + 1), wrap(iy), cells)
  const c = hash(wrap(ix), wrap(iy + 1), cells), d = hash(wrap(ix + 1), wrap(iy + 1), cells)
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy
}
// Integer cell counts keep the wave phase continuous across the tile edges.
function ripple(u, v, cells, amplitude, warp, seed) {
  const phase = u * cells + warp * (noise(u * 6 + seed, v * 6, 6) - .5)
  return Math.sin(6.2831853 * phase) * amplitude
}
function bakeMaterial(file, meters, medium = false) {
  const heights = new Float32Array(size * size), rockCover = new Float32Array(size * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // Warp the fields with a broad continuous warp so no lattice aligns.
    const u = x / size, v = y / size
    const wx = u + (noise(u * 8, v * 8, 8) - .5) * .06
    const wy = v + (noise(u * 8 + 3.7, v * 8 + 1.3, 8) - .5) * .06
    let height = (noise(u * 4, v * 4, 4) - .5) * (medium ? 2.4 : .3)
    const bands = medium ? [[8, .9], [24, .35], [64, .16], [128, .04]] : [[16, .05], [48, .03], [128, .018], [256, .01]]
    for (const [cells, amplitude] of bands) {
      height += (noise(wx * cells, wy * cells, cells) - .5) * amplitude
    }
    if (medium) {
      // Dune fields: broad masked wave trains plus broken outcrop ridges and
      // shallow dust-filled depressions bridging grain and measured elevation.
      const duneMask = Math.max(0, noise(wx * 5, wy * 5, 5) - .45) * 2.2
      height += duneMask * (ripple(wx, wy, 10, .6, 3, 11) + ripple(wx, wy, 20, .28, 1.5, 23))
      height += (Math.abs(noise(wx * 16, wy * 16, 16) - .5) - .25) * .8
      height -= Math.max(0, .52 - noise(wx * 6, wy * 6, 6)) ** 2 * 10
    } else {
      // Ripple patches: wind streaks a few meters apart, masked so they form
      // fields instead of covering the whole tile.
      const rippleMask = Math.max(0, noise(wx * 6 + 9.1, wy * 6 + 4.2, 6) - .42) * 2.4
      height += rippleMask * (ripple(wx, wy, 32, .05, 2, 31) + ripple(wx, wy, 64, .02, 1, 47))
    }
    heights[y * size + x] = height
  }
  // Partly buried angular fragments, with irregular polygon outlines and
  // unequal fractured faces. No circular bowls or raised crater rings.
  for (let feature = 0; feature < (medium ? 240 : 550); feature++) {
    const i = feature + (medium ? 20000 : 0)
    const cx = hash(i, 1) * size, cy = hash(i, 2) * size
    const cluster = noise(cx / size * 8, cy / size * 8, 8)
    if (hash(i, 4) > (medium ? .3 + cluster * .6 : .45 + cluster * .5)) continue
    const radius = (medium ? 2 + hash(i, 3) ** 2 * 7 : .4 + hash(i, 3) ** 3 * 2) / meters * size
    const aspect = (medium ? .35 : .45) + hash(i, 5) * .7, rotation = hash(i, 6) * Math.PI * 2
    const height = radius / size * meters * (medium ? .12 + hash(i, 7) * .14 : .12 + hash(i, 7) * .16)
    const sides = 4 + Math.floor(hash(i, 8) * 4)
    const planes = Array.from({ length: sides }, (_, face) => {
      const angle = (face + (hash(i, 10 + face) - .5) * .5) / sides * Math.PI * 2
      return { x: Math.cos(angle), y: Math.sin(angle), edge: .65 + hash(i, 20 + face) * .4 }
    })
    const extent = Math.ceil(radius * 1.6)
    for (let y = Math.floor(cy) - extent; y <= cy + extent; y++) for (let x = Math.floor(cx) - extent; x <= cx + extent; x++) {
      const dx = (x - cx) / radius, dy = (y - cy) / radius
      const rx = dx * Math.cos(rotation) - dy * Math.sin(rotation)
      const ry = (dx * Math.sin(rotation) + dy * Math.cos(rotation)) / aspect
      const edge = Math.max(...planes.map(p => (rx * p.x + ry * p.y) / p.edge))
      if (edge >= 1) continue
      const index = ((y % size + size) % size) * size + (x % size + size) % size
      const face = Math.min(1 - edge, .55 + rx * .13 - ry * .22)
      const embedded = Math.min(1, (1 - edge) * 5)
      heights[index] += Math.max(0, face) * height * embedded
      rockCover[index] = Math.max(rockCover[index], embedded)
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size), step = meters / size
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (heights[y * size + (x + 1) % size] - heights[y * size + (x + size - 1) % size]) / (2 * step)
    const dy = (heights[((y + 1) % size) * size + x] - heights[((y + size - 1) % size) * size + x]) / (2 * step)
    const length = Math.hypot(dx, dy, 1), offset = y * (size * 4 + 1) + 1 + x * 4
    raw[offset] = Math.round((-.5 * dx / length + .5) * 255)
    raw[offset + 1] = Math.round((-.5 * dy / length + .5) * 255)
    raw[offset + 2] = Math.round((.5 / length + .5) * 255)
    const dust = noise(x / size * 16, y / size * 16, 16)
    const sand = medium ? Math.max(0, noise(x / size * 8, y / size * 8, 8) - .4) * .03 : 0
    const roughness = .965 + dust * .02 - sand - rockCover[y * size + x] * .06 + (hash(x, y, 7) - .5) * .012
    raw[offset + 3] = Math.round(Math.max(.89, Math.min(.99, roughness)) * 255)
  }
  function crc32(data) {
    let crc = 0xffffffff
    for (const byte of data) {
      crc ^= byte
      for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0)
    }
    return (crc ^ 0xffffffff) >>> 0
  }
  function chunk(type, data) {
    const name = Buffer.from(type), head = Buffer.alloc(4), tail = Buffer.alloc(4)
    head.writeUInt32BE(data.length); tail.writeUInt32BE(crc32(Buffer.concat([name, data])))
    return Buffer.concat([head, name, data, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
  writeFileSync(new URL(`../public/textures/${file}`, import.meta.url), png)
  console.log(`Baked ${file}: ${size} x ${size}, ${meters} m repeat, ${png.length} bytes`)
}

bakeMaterial('mars-detail.png', 128)
bakeMaterial('mars-medium-detail.png', 512, true)
