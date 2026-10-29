import decodeWebp from '@jsquash/webp/decode.js'
import { mercatorBounds, sampleTerrarium } from './terrainPilot.ts'
import type { TileAddress } from './surfaceTiles.ts'

/** Elevation channels are numerical bytes. Canvas readback can be deliberately
 * perturbed by browser fingerprinting protection: one red bit means 256 m.
 * Decode the source bytes directly; never pass this data through a canvas. */
export async function decodeTerrariumTile(buffer: ArrayBuffer, address: TileAddress, sampleSize = 65) {
  const pixels = await decodeWebp(buffer)
  return sampleTerrarium(pixels.data, pixels.width, pixels.height, mercatorBounds(address), address, sampleSize)
}
