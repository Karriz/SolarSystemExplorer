import * as THREE from 'three'
import type { SurfaceState } from './surfaceMaterial'

export type MoonColorMode = 'raster' | '6' | '10' | '16' | '10-diagonal' | '10-smooth'
type Manifest = {
  schema: number; width: number; height: number; tileSize: number; palette: string[]
  tiles: { x: number; y: number; file: string }[]
  variant?: string; previewPoint?: { lat: number; lon: number }
}
type VectorTile = { x: number; y: number; paths: Path2D[] }
type Release = { manifest: Manifest; tiles: VectorTile[] }
const MOON_RADIUS_METERS = 1737400
/** Gaussian sigma: the 10–90% color transition is approximately 308 meters. */
export const MOON_BOUNDARY_SIGMA_METERS = 120

function drawRegion(release: Release, left: number, top: number, width: number, height: number, pixelWidth: number, pixelHeight: number) {
  const canvas = document.createElement('canvas'); canvas.width = pixelWidth; canvas.height = pixelHeight
  const context = canvas.getContext('2d')!
  const { manifest, tiles } = release
  context.globalCompositeOperation = 'lighter'
  context.scale(pixelWidth / width, pixelHeight / height); context.translate(-left, -top)
  for (const wrap of [-manifest.width, 0, manifest.width]) for (const tile of tiles) {
    const x = tile.x * manifest.tileSize + wrap, y = tile.y * manifest.tileSize
    if (x > left + width || x + manifest.tileSize < left || y > top + height || y + manifest.tileSize < top) continue
    context.save(); context.translate(x, y)
    tile.paths.forEach((path, i) => { context.fillStyle = manifest.palette[i]; context.fill(path, 'evenodd') })
    context.restore()
  }
  context.resetTransform(); context.globalCompositeOperation = 'destination-over'
  context.fillStyle = manifest.palette[0]; context.fillRect(0, 0, pixelWidth, pixelHeight)
  context.globalCompositeOperation = 'source-over'
  return canvas
}

function softRegion(release: Release, left: number, top: number, width: number, height: number, metersX: number, metersY: number) {
  // Use approximately square physical pixels. A modest-resolution soft map
  // resolves a 120 m sigma without allocating a huge kernel at ground level.
  const pitch = Math.max(2, Math.max(metersX, metersY) / 512)
  const w = Math.max(2, Math.ceil(metersX / pitch)), h = Math.max(2, Math.ceil(metersY / pitch))
  const sigma = MOON_BOUNDARY_SIGMA_METERS * .5 * (w / metersX + h / metersY)
  const pad = Math.ceil(4 * sigma)
  // Draw neighboring geography beyond the visible window BEFORE filtering.
  // This keeps the same ground point's mixture stable when a window moves.
  const padded = drawRegion(release, left - pad * width / w, top - pad * height / h,
    width * (w + 2 * pad) / w, height * (h + 2 * pad) / h, w + 2 * pad, h + 2 * pad)
  const filtered = document.createElement('canvas'); filtered.width = padded.width; filtered.height = padded.height
  const filterContext = filtered.getContext('2d')!
  filterContext.filter = `blur(${sigma}px)`
  filterContext.drawImage(padded, 0, 0)
  const output = document.createElement('canvas'); output.width = w; output.height = h
  output.getContext('2d')!.drawImage(filtered, pad, pad, w, h, 0, 0, w, h)
  return output
}

/** First visual trial: assemble vector tiles into one bounded color atlas.
 * No terrain geometry is added. Only the active palette has a GPU texture.
 * Cancellation makes rapid palette changes and scene disposal safe.
 */
export class MoonVectorColor {
  private request?: AbortController
  texture?: THREE.CanvasTexture
  private releases = new WeakMap<THREE.Texture, Release>()
  private release?: Release
  private patch?: THREE.CanvasTexture
  private softPatch?: THREE.CanvasTexture
  private patchState?: SurfaceState
  private checkedAt = -Infinity
  private patchBuilds = 0

  cancel() { this.request?.abort(); this.request = undefined }

  async load(mode: Exclude<MoonColorMode, 'raster'>): Promise<THREE.CanvasTexture | null> {
    this.cancel()
    const request = this.request = new AbortController()
    const base = `${import.meta.env.BASE_URL}moon-vectors/${mode}/`
    const read = async (file: string) => {
      const response = await fetch(base + file, { signal: request.signal })
      if (!response.ok) throw new Error(`Vector color unavailable (${response.status})`)
      if (file.endsWith('.gz') && !response.headers.get('Content-Encoding')) {
        if (!response.body) throw new Error('Empty vector color tile')
        return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json()
      }
      return response.json()
    }
    try {
      const manifest: Manifest = await read('manifest.json')
      if (manifest.schema !== 1 || manifest.width > 8192 || manifest.height > 4096
        || manifest.width < 1 || manifest.height < 1 || manifest.palette.length !== Number(mode.split('-')[0])) {
        throw new Error('Unsupported vector color manifest')
      }
      const canvas = document.createElement('canvas')
      canvas.width = manifest.width; canvas.height = manifest.height
      const context = canvas.getContext('2d')!
      // Sum disjoint premultiplied coverage, so antialiased shared edges blend
      // their two actual colors instead of exposing a dark underpaint seam.
      context.globalCompositeOperation = 'lighter'
      const tiles = [...manifest.tiles]
      const release: Release = { manifest, tiles: [] }
      // Four bounded fetches; drawing uses globally aligned coordinates.
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (tiles.length && !request.signal.aborted) {
          const tile = tiles.shift()!
          const { paths }: { paths: string[] } = await read(tile.file)
          if (request.signal.aborted) return
          const compiled = paths.map(path => new Path2D(path))
          release.tiles.push({ x: tile.x, y: tile.y, paths: compiled })
          context.save()
          context.translate(tile.x * manifest.tileSize, tile.y * manifest.tileSize)
          compiled.forEach((path, i) => {
            context.fillStyle = manifest.palette[i]
            context.fill(path, 'evenodd')
          })
          context.restore()
          await new Promise(resolve => requestAnimationFrame(resolve))
        }
      }))
      if (request.signal.aborted) return null
      context.globalCompositeOperation = 'destination-over'
      context.fillStyle = manifest.palette[0]; context.fillRect(0, 0, canvas.width, canvas.height)
      context.globalCompositeOperation = 'source-over'
      const texture = new THREE.CanvasTexture(canvas)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.wrapS = THREE.RepeatWrapping
      texture.anisotropy = 8
      this.releases.set(texture, release)
      return texture
    } catch (error) {
      if (request.signal.aborted) return null
      request.abort()
      throw error
    }
  }

  replace(texture?: THREE.CanvasTexture) {
    this.clearPatch()
    if (this.texture) this.releases.delete(this.texture)
    this.texture?.dispose()
    this.texture = texture
    this.release = texture ? this.releases.get(texture) : undefined
  }

  private clearPatch() {
    if (this.patchState) {
      this.patchState.vectorColorReady.value = 0
      this.patchState.vectorColorMap.value = null
      this.patchState.vectorColorSoftMap.value = null
      this.patchState.vectorColorSoftReady.value = 0
    }
    this.patch?.dispose(); this.patch = undefined
    this.softPatch?.dispose(); this.softPatch = undefined
  }

  previewPoint() { return this.release?.manifest.previewPoint }

  metrics() { return { ready: !!this.patch, softReady: !!this.softPatch, builds: this.patchBuilds,
    transitionMeters: this.softPatch ? 2.563103 * MOON_BOUNDARY_SIGMA_METERS : 0,
    patchBytes: ((this.patch ? 1024 * 1024 : 0) + (this.softPatch ? this.softPatch.image.width * this.softPatch.image.height : 0)) * 4 * (1 + 4 / 3),
    bounds: this.patchState?.vectorColorBounds.value.toArray() } }

  /** A body-fixed close-view window, shared by the globe and every terrain LOD.
   * Redraw vector paths for the projected footprint, rather than stretching
   * a whole-terrain-tile texture over a tiny nearby part of that tile.
   */
  updateView(camera: THREE.PerspectiveCamera, body: THREE.Mesh, state: SurfaceState,
    selected: boolean, hitGround: (ray: THREE.Ray) => THREE.Vector3 | null, now: number) {
    this.patchState = state
    if (!selected || !this.release?.manifest.variant) { this.clearPatch(); return }
    if (now - this.checkedAt < 200) return
    this.checkedAt = now
    const radius = (body.geometry as THREE.SphereGeometry).parameters.radius
    const distance = camera.position.distanceTo(body.position)
    if (distance > radius * 1.45) { this.clearPatch(); return }
    const ray = new THREE.Ray(camera.position.clone(), camera.getWorldDirection(new THREE.Vector3()))
    const hit = hitGround(ray) ?? ray.intersectSphere(new THREE.Sphere(body.position, radius), new THREE.Vector3())
    // Looking above the horizon needs the normal globe fallback.
    if (!hit || hit.distanceTo(camera.position) > radius * .8) { this.clearPatch(); return }
    body.updateWorldMatrix(true, false)
    const local = body.worldToLocal(hit.clone()).normalize()
    const lat = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)))
    const lon = THREE.MathUtils.radToDeg(Math.atan2(-local.z, local.x))
    if (Math.abs(lat) > 80) { this.clearPatch(); return }
    const radial = hit.clone().sub(body.position).normalize()
    const incidence = Math.max(.2, Math.abs(ray.direction.dot(radial)))
    const footprint = 2 * hit.distanceTo(camera.position) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / incidence
    const needY = THREE.MathUtils.radToDeg(footprint / radius)
    const needX = needY * camera.aspect / Math.cos(THREE.MathUtils.degToRad(lat))
    if (needX > 100 || needY > 100) { this.clearPatch(); return }
    const b = state.vectorColorBounds.value
    const lonDelta = THREE.MathUtils.euclideanModulo(lon - (b.x + b.z) / 2 + 180, 360) - 180
    const fits = this.patch && b.z - b.x >= needX * 1.3 && b.z - b.x <= needX * 3.2
      && b.w - b.y >= needY * 1.3 && b.w - b.y <= needY * 3.2
      && Math.abs(lonDelta) + needX / 2 < (b.z - b.x) * .40
      && Math.abs(lat - (b.y + b.w) / 2) + needY / 2 < (b.w - b.y) * .40
    if (fits) return
    const spanX = needX * 2, spanY = needY * 2
    const west = lon - spanX / 2, north = lat + spanY / 2
    const { manifest } = this.release
    const left = (west + 180) / 360 * manifest.width, top = (90 - north) / 180 * manifest.height
    const width = spanX / 360 * manifest.width, height = spanY / 180 * manifest.height
    const canvas = drawRegion(this.release, left, top, width, height, 1024, 1024)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8
    const softTexture = manifest.variant === '10-smooth' ? new THREE.CanvasTexture(softRegion(this.release, left, top, width, height,
      THREE.MathUtils.degToRad(spanX) * MOON_RADIUS_METERS * Math.cos(THREE.MathUtils.degToRad(lat)),
      THREE.MathUtils.degToRad(spanY) * MOON_RADIUS_METERS)) : undefined
    if (softTexture) { softTexture.colorSpace = THREE.SRGBColorSpace; softTexture.anisotropy = 4 }
    const previous = this.patch
    const previousSoft = this.softPatch
    this.patch = texture
    this.softPatch = softTexture
    state.vectorColorMap.value = texture
    state.vectorColorSoftMap.value = softTexture ?? null
    state.vectorColorSoftReady.value = softTexture ? 1 : 0
    state.vectorColorBounds.value.set(west, north - spanY, west + spanX, north)
    state.vectorColorReady.value = 1
    previous?.dispose()
    previousSoft?.dispose()
    this.patchBuilds++
  }

  dispose() { this.cancel(); this.replace() }
}
