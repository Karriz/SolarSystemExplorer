import { init as initWebp } from '@jsquash/webp/decode.js'
import webpDecoderUrl from '@jsquash/webp/codec/dec/webp_dec.wasm?url'
import { decodeTerrariumTile } from './terrariumDecode.ts'
import { EARTH_HEIGHT_SIZE } from './terrainLod.ts'
import type { TileAddress } from './surfaceTiles.ts'

let initialized = false
self.onmessage = async (event: MessageEvent<{ id: number; buffer: ArrayBuffer; address: TileAddress }>) => {
  const { id, buffer, address } = event.data
  const started = performance.now()
  try {
    if (!initialized) {
      initialized = true
      // Vite publishes the decoder as a hashed asset, respecting BASE_URL.
      await initWebp({ locateFile: () => webpDecoderUrl })
    }
    const heights = await decodeTerrariumTile(buffer, address, EARTH_HEIGHT_SIZE)
    self.postMessage({ id, heights, sampleSize: EARTH_HEIGHT_SIZE, decodeMs: performance.now() - started }, { transfer: [heights.buffer] })
  } catch (error) {
    initialized = false
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
  }
}
