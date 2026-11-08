/// <reference lib="webworker" />
import { decodeEarthSurface } from './earthSurfaceData.ts'
const scope = self as unknown as DedicatedWorkerGlobalScope
scope.onmessage = event => {
  const { id, tiles, address, size } = event.data
  try {
    const result = decodeEarthSurface(tiles, address, size)
    scope.postMessage({ id, ...result }, [result.classes.buffer, result.water.buffer, result.color.buffer, result.surface.buffer])
  } catch (error) { scope.postMessage({ id, error: String(error) }) }
}
