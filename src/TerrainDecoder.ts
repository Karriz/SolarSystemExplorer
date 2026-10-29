export class TerrainDecoder {
  private worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' })
  private nextId = 0
  private failed = false
  private pending = new Map<number, { resolve: (heights: Float32Array) => void; reject: (error: Error) => void }>()

  constructor() {
    this.worker.onmessage = (event: MessageEvent<{ id: number; heights: Float32Array; error?: string }>) => {
      const pending = this.pending.get(event.data.id)
      if (!pending) return
      this.pending.delete(event.data.id)
      if (event.data.error) pending.reject(new Error(event.data.error))
      else pending.resolve(event.data.heights)
    }
    this.worker.onerror = () => { this.failed = true; this.failAll(new Error('Terrain worker failed')) }
  }

  decode(buffer: ArrayBuffer, sampleSize: number, sha256: string, scaleMeters = .5, noData?: number, components = 1): Promise<Float32Array> {
    if (this.failed) return Promise.reject(new Error('Terrain decoder unavailable'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.worker.postMessage({ id, buffer, sampleSize, sha256, scaleMeters, noData, components }, [buffer]) }
      catch (error) { this.pending.delete(id); reject(error) }
    })
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  dispose() {
    this.failed = true
    this.worker.terminate()
    this.failAll(new Error('Terrain decoder disposed'))
  }
}
