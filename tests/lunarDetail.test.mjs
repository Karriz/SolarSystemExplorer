import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveSyntheticHeights, lunarDetailField, LUNAR_DETAIL_CLAMP, LUNAR_DETAIL_CUMULATIVE, LUNAR_DETAIL_LEVELS } from '../src/lunarDetail.ts'
import { terrainBounds, terrainChildren } from '../src/terrain.ts'

const R = 1737400
const size = 129

function parentGrid(size) {
  const grid = new Float32Array(size * size)
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
    grid[r * size + c] = Math.sin(r / 8) * 40
  return grid
}

// Exact bilinear upsample of the parent into child quadrant 1 (east half, north row).
function upsample(parent, size, quadrant) {
  const out = new Float32Array(size * size)
  const px0 = (quadrant % 2) * (size - 1) / 2, py0 = Math.floor(quadrant / 2) * (size - 1) / 2
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    const px = px0 + c / 2, py = py0 + r / 2
    const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy
    const i = iy * size + ix
    out[r * size + c] = parent[i] * (1 - fx) * (1 - fy) + parent[i + 1] * fx * (1 - fy)
      + parent[i + size] * (1 - fx) * fy + parent[i + size + 1] * fx * fy
  }
  return out
}

test('synthetic derivation is deterministic and bounded around the measured upsample', () => {
  const parent = parentGrid(size)
  const parentAddress = { z: 8, x: 300, y: 88 }
  const child = terrainChildren(parentAddress)[1]
  const a = deriveSyntheticHeights(parent, size, terrainBounds(parentAddress), terrainBounds(child), size, 1, R)
  const b = deriveSyntheticHeights(parent, size, terrainBounds(parentAddress), terrainBounds(child), size, 1, R)
  assert.deepEqual([...a], [...b])
  const up = upsample(parent, size, 1)
  let maxOffset = 0, moved = 0
  for (let i = 0; i < a.length; i++) {
    const offset = Math.abs(a[i] - up[i])
    maxOffset = Math.max(maxOffset, offset)
    if (offset > 1e-6) moved++
  }
  assert.ok(moved > a.length / 4, 'synthesis changes the surface')
  assert.ok(maxOffset > .5, 'synthesis has visible amplitude')
  assert.ok(maxOffset <= LUNAR_DETAIL_CLAMP[0], 'level offsets stay within the declared bound')
})

test('the detail field is a pure bounded function of body-fixed direction and level', () => {
  assert.equal(lunarDetailField(.3, .5, -.2, 1, R), lunarDetailField(.3, .5, -.2, 1, R))
  assert.notEqual(lunarDetailField(.3, .5, -.2, 1, R), lunarDetailField(.3, .5, -.2, 2, R))
  for (const level of [1, 2]) {
    assert.ok(Math.abs(lunarDetailField(.3, .5, -.2, level, R)) <= LUNAR_DETAIL_CLAMP[level - 1])
    assert.ok(LUNAR_DETAIL_CUMULATIVE[level - 1] <= LUNAR_DETAIL_CUMULATIVE[LUNAR_DETAIL_LEVELS - 1])
  }
})

test('equal-level synthetic neighbors match exactly on their shared border', () => {
  const parent = parentGrid(size)
  const parentAddress = { z: 8, x: 300, y: 88 }
  const [west, east] = terrainChildren(parentAddress)
  const westGrid = deriveSyntheticHeights(parent, size, terrainBounds(parentAddress), terrainBounds(west), size, 1, R)
  const eastGrid = deriveSyntheticHeights(parent, size, terrainBounds(parentAddress), terrainBounds(east), size, 1, R)
  for (let r = 0; r < size; r++) {
    assert.ok(Math.abs(westGrid[r * size + size - 1] - eastGrid[r * size]) < 1e-12, `row ${r}`)
  }
})

test('synthesis is suppressed on steep measured slopes', () => {
  const size = 129
  const flat = new Float32Array(size * size)
  const steep = new Float32Array(size * size)
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) steep[r * size + c] = c * 40
  const parentAddress = { z: 8, x: 300, y: 88 }
  const child = terrainChildren(parentAddress)[1]
  const bounds = terrainBounds(parentAddress)
  const flatGrid = deriveSyntheticHeights(flat, size, bounds, terrainBounds(child), size, 1, R)
  const steepGrid = deriveSyntheticHeights(steep, size, bounds, terrainBounds(child), size, 1, R)
  const amp = (grid, base) => {
    let max = 0
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
      max = Math.max(max, Math.abs(grid[r * size + c] - base(r, c)))
    return max
  }
  const flatAmp = amp(flatGrid, () => 0)
  const steepAmp = amp(steepGrid, (r, c) => 40 * (64 + c / 2))
  assert.ok(flatAmp > .5)
  assert.ok(steepAmp < flatAmp, `steep ${steepAmp} should be calmer than flat ${flatAmp}`)
})

test('missing measured data propagates as missing synthetic coverage', () => {
  const parent = parentGrid(size)
  parent.fill(NaN, 0, size * 10)
  const parentAddress = { z: 8, x: 300, y: 88 }
  const child = terrainChildren(parentAddress)[0]
  const grid = deriveSyntheticHeights(parent, size, terrainBounds(parentAddress), terrainBounds(child), size, 1, R)
  assert.ok(Number.isNaN(grid[0]))
  assert.ok(Number.isFinite(grid[grid.length - 1]))
})
