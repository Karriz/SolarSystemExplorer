// Offline, seamless normal/roughness data. No lighting or measured topography
// is baked into this small reusable material texture.
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
function bakeMaterial(file, meters, medium = false) {
  const heights = new Float32Array(size * size), rockCover = new Float32Array(size * size)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // Warp the fine grains with a broad continuous field, avoiding visible
    // lattice alignment. All coordinates wrap so the material remains seamless.
    const u = x / size, v = y / size
    const wx = u + (noise(u * 8, v * 8, 8) - .5) * .045
    const wy = v + (noise(u * 8 + 3.7, v * 8 + 1.3, 8) - .5) * .045
    let height = (noise(u * 4, v * 4, 4) - .5) * (medium ? 1.6 : .07)
    const bands = medium ? [[8, .65], [24, .24], [64, .12], [128, .025]] : [[16, .024], [48, .016], [128, .011], [256, .006]]
    for (const [cells, amplitude] of bands) {
      height += (noise(wx * cells, wy * cells, cells) - .5) * amplitude
    }
    if (medium) {
      // Broken outcrop ridges and irregular shallow dust-filled depressions.
      // Their broad slopes bridge the grain texture and measured elevation.
      height += (Math.abs(noise(wx * 16, wy * 16, 16) - .5) - .25) * .6
      height -= Math.max(0, .52 - noise(wx * 6, wy * 6, 6)) ** 2 * 8
    }
    heights[y * size + x] = height
  }
  // Partly buried angular fragments, with irregular polygon outlines and
  // unequal fractured faces. No circular bowls or raised crater rings.
  for (let feature = 0; feature < (medium ? 220 : 900); feature++) {
    const i = feature + (medium ? 10000 : 0)
    const cx = hash(i, 1) * size, cy = hash(i, 2) * size
    const cluster = noise(cx / size * 8, cy / size * 8, 8)
    if (hash(i, 4) > (medium ? .12 + cluster * .7 : .22 + cluster * .8)) continue
    const radius = (medium ? 1.2 + hash(i, 3) ** 2 * 3.8 : .17 + hash(i, 3) ** 3 * .95) / meters * size
    const aspect = (medium ? .35 : .45) + hash(i, 5) * .7, rotation = hash(i, 6) * Math.PI * 2
    const height = radius / size * meters * (medium ? .08 + hash(i, 7) * .1 : .12 + hash(i, 7) * .16)
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
    const exposed = medium ? Math.max(0, noise(x / size * 8, y / size * 8, 8) - .35) * .045 : 0
    const roughness = .96 + dust * .025 - exposed - rockCover[y * size + x] * .065 + (hash(x, y, 7) - .5) * .012
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

bakeMaterial('moon-detail.png', 64)
bakeMaterial('moon-medium-detail.png', 256, true)
