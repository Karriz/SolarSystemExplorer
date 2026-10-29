import { mercatorAddress, mercatorBounds, parseRegionalManifest, earthViewRoots, terrainBounds, tileKey, type RegionalSource } from './terrainPilot.ts'
import type { TileAddress } from './surfaceTiles.ts'
import { EARTH_HEIGHT_SIZE } from './terrainLod.ts'
import { TerrainDecoder } from './TerrainDecoder.ts'

export function earthPilotSources(): RegionalSource[] {
  const worker = new Worker(new URL('./earthTerrain.worker.ts', import.meta.url), { type: 'module' })
  const locations = [{ id: 'mapterhorn', lon: 0, lat: 0 }]
  let nextId = 0, remaining = locations.length, failed = false
  const pending = new Map<number, { resolve: (value: { heights: Float32Array; sampleSize: number; decodeMs: number }) => void; reject: (error: Error) => void }>()
  worker.onmessage = event => {
    const p = pending.get(event.data.id)
    if (!p) return
    pending.delete(event.data.id)
    if (event.data.error) p.reject(new Error(event.data.error)); else p.resolve(event.data)
  }
  worker.onerror = () => {
    failed = true
    for (const p of pending.values()) p.reject(new Error('Elevation decoder unavailable'))
    pending.clear()
  }
  return locations.map(location => ({
    id: location.id, body: 'earth', sampleSize: EARTH_HEIGHT_SIZE, root: mercatorAddress(0, 0, 8), roots: earthViewRoots, maxZoom: 15,
    minHeight: -500, maxHeight: 9000, resolution: 30,
    credit: 'Mapterhorn · source resolution varies', url: 'https://mapterhorn.com/attribution/', bounds: mercatorBounds,
    async load(address, signal) {
      const response = await fetch(`https://tiles.mapterhorn.com/${tileKey(address)}.webp`, { signal, credentials: 'omit', mode: 'cors' })
      if (!response.ok) throw new Error(`Elevation HTTP ${response.status}`)
      const buffer = await response.arrayBuffer(), transferBytes = buffer.byteLength
      if (signal.aborted || failed) throw new Error('Elevation request cancelled or decoder unavailable')
      const id = nextId++
      const decoded = await new Promise<{ heights: Float32Array; sampleSize: number; decodeMs: number }>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, buffer, address }, [buffer])
      })
      return { ...decoded, transferBytes }
    },
    dispose() {
      if (--remaining !== 0) return
      worker.terminate()
      for (const p of pending.values()) p.reject(new Error('Elevation decoder disposed'))
      pending.clear()
    },
  }))
}

export async function lunarPilotSource(baseUrl: string, signal: AbortSignal): Promise<RegionalSource> {
  const response = await fetch(new URL('moon-hadley-v2/manifest.json', baseUrl), { signal })
  if (!response.ok) throw new Error('Lunar pilot is not prepared')
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > 512000) throw new Error('Regional manifest exceeds pilot budget')
  const m = parseRegionalManifest(JSON.parse(new TextDecoder().decode(bytes)))
  const release = new URL('moon-hadley-v2/', baseUrl)
  let decoder: TerrainDecoder | undefined
  return { id: m.id, body: 'moon', root: m.root, maxZoom: m.maxZoom, minHeight: m.minHeightMeters, maxHeight: m.maxHeightMeters,
    resolution: m.sourceResolutionMeters, credit: m.credit, url: m.sourceUrl, bounds: terrainBounds,
    info: a => m.tiles[tileKey(a)],
    async load(address: TileAddress, signal: AbortSignal) {
      const info = m.tiles[tileKey(address)]
      if (!info) throw new Error('Outside measured pilot coverage')
      const response = await fetch(new URL(`tiles/${tileKey(address)}.bin`, release), { signal })
      if (!response.ok) throw new Error(`Regional terrain HTTP ${response.status}`)
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength !== info.bytes) throw new Error('Regional terrain length mismatch')
      const transferBytes = buffer.byteLength, started = performance.now()
      const decoded = await (decoder ??= new TerrainDecoder()).decode(buffer, 65, info.sha256, m.scaleMeters, m.noData, m.components ?? 1)
      const heights = decoded.slice(0, 65 * 65)
      const gradients = m.components === 3 ? decoded.slice(65 * 65) : undefined
      if (gradients) for (let i = 0; i < gradients.length; i++) gradients[i] /= 2048
      for (let i = 0; i < heights.length; i++) if (Number.isFinite(heights[i])) heights[i] += m.offsetMeters
      return { heights, gradients, transferBytes, decodeMs: performance.now() - started }
    },
    dispose: () => decoder?.dispose(),
  }
}
