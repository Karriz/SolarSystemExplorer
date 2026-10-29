import { decodeTerrain } from './terrainDecode'

self.onmessage = async (event: MessageEvent<{ id: number; buffer: ArrayBuffer; sampleSize: number; sha256: string; scaleMeters: number; noData?: number; components?: number }>) => {
  const { id, buffer, sampleSize, sha256, scaleMeters, noData, components } = event.data
  try {
    const heights = await decodeTerrain(buffer, sampleSize, sha256, scaleMeters, noData, components)
    self.postMessage({ id, heights }, { transfer: [heights.buffer] })
  } catch (error) {
    self.postMessage({ id, error: String(error) })
  }
}
