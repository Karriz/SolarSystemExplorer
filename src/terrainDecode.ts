export async function decodeTerrain(buffer: ArrayBuffer, sampleSize: number, expectedSha256: string,
  scaleMeters = .5, noData?: number, components = 1): Promise<Float32Array> {
  if (components !== 1 && components !== 3) throw new Error('Unsupported terrain components')
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
  if (actual !== expectedSha256) throw new Error('Terrain tile checksum mismatch')
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  const raw = await new Response(stream).arrayBuffer()
  if (raw.byteLength !== sampleSize * sampleSize * components * 2) throw new Error('Unexpected terrain tile length')
  const data = new DataView(raw), heights = new Float32Array(sampleSize * sampleSize * components)
  for (let i = 0; i < heights.length; i++) {
    const sample = data.getInt16(i * 2, true)
    heights[i] = sample === noData ? NaN : sample * scaleMeters
  }
  return heights
}
