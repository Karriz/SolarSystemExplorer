/// <reference lib="webworker" />
import { decodeEarthMask } from './earthSurfaceData.ts'
const scope = self as unknown as DedicatedWorkerGlobalScope
scope.onmessage = event => {
  const { id, buffer, address } = event.data
  try {
    const result = decodeEarthMask(buffer, address)
    scope.postMessage({ id, ...result }, [result.classes.buffer, result.water.buffer])
  } catch (error) { scope.postMessage({ id, error: String(error) }) }
}
