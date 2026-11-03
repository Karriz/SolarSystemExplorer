import * as THREE from 'three'

/** Bounded experiment, independent of mesh selection and source-height caches. */
export class TerrainHillshadeTexture {
  readonly enabled = { value: 0 }
  readonly ready = { value: 0 }
  readonly map = { value: null as THREE.DataTexture | null }
  readonly bounds = { value: new THREE.Vector4(-100, -28, -42, 8) }
  readonly range = { value: new THREE.Vector2(.55, 1.30) }
  private request?: AbortController
  private disposed = false

  async setEnabled(enabled: boolean): Promise<boolean> {
    if (this.disposed) return false
    this.enabled.value = enabled ? 1 : 0
    this.request?.abort()
    if (!enabled || this.ready.value) return true
    const request = new AbortController()
    this.request = request
    const timeout = setTimeout(() => request.abort(), 30000)
    try {
      const base = `${import.meta.env.BASE_URL}textures/valles-hillshade`
      const response = await fetch(`${base}.json`, { signal: request.signal })
      if (!response.ok) throw Error('Hillshade manifest unavailable')
      const m = await response.json()
      if (m.schema !== 1 || !Number.isInteger(m.width) || !Number.isInteger(m.height)
        || m.width < 1 || m.height < 1 || m.width > 4096 || m.height > 4096
        || m.rawBytes !== m.width * m.height || m.rowOrder !== 'south-to-north'
        || JSON.stringify(m.bounds) !== '[-100,-28,-42,8]' || JSON.stringify(m.range) !== '[0.55,1.3]') throw Error('Invalid hillshade manifest')
      const payload = await fetch(`${base}.bin.gz`, { signal: request.signal })
      if (!payload.ok || !payload.body) throw Error('Hillshade texture unavailable')
      // Vite serves .gz with Content-Encoding: gzip (Fetch already decodes it).
      // Static hosts may serve the same bytes as an ordinary gzip file.
      const httpDecoded = payload.headers.get('Content-Encoding')?.split(',').some(value => value.trim().toLowerCase() === 'gzip')
      const reader = (httpDecoded ? payload.body : payload.body.pipeThrough(new DecompressionStream('gzip'))).getReader()
      const data = new Uint8Array(m.rawBytes)
      let offset = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (offset + value.length > data.length) throw Error('Oversized hillshade texture')
          data.set(value, offset); offset += value.length
        }
      } finally { await reader.cancel() }
      if (offset !== data.length) throw Error('Incomplete hillshade texture')
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(v => v.toString(16).padStart(2, '0')).join('')
      if (digest !== m.sha256) throw Error('Hillshade checksum mismatch')
      if (this.disposed || request.signal.aborted || this.request !== request) return false
      const texture = new THREE.DataTexture(data, m.width, m.height, THREE.RedFormat, THREE.UnsignedByteType)
      texture.colorSpace = THREE.NoColorSpace
      texture.generateMipmaps = true
      texture.minFilter = THREE.LinearMipmapLinearFilter
      texture.magFilter = THREE.LinearFilter
      texture.unpackAlignment = 1
      texture.needsUpdate = true
      this.map.value = texture
      this.ready.value = 1
      return true
    } catch (error) {
      if (this.disposed || this.request !== request || !this.enabled.value) return false
      this.enabled.value = 0
      throw error
    } finally { clearTimeout(timeout) }
  }
  dispose() {
    this.disposed = true
    this.request?.abort()
    this.map.value?.dispose()
    this.map.value = null
    this.ready.value = this.enabled.value = 0
  }
}
