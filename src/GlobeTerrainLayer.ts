import * as THREE from 'three'
import { heightGrid, meshTriangles } from './terrainLod.ts'
import { captureTerrainEdge, stitchTerrainEdges, type TerrainEdge } from './terrainEdges.ts'
import { geoDirection } from './terrainPilot.ts'
import { terrainSurfaceSampler, sphereSurfaceSampler, firstTerrainSurfaceHit, type TerrainSurfaceSampler } from './terrainSurface.ts'
import { parseTerrainManifest, parseTerrainPage, terrainBounds, terrainChildren, terrainGeometry, type TerrainManifest, type TerrainBody, type TerrainTileInfo } from './terrain.ts'
import { tileBoundingSphere } from './GlobeTileLayer.ts'
import type { TileAddress } from './surfaceTiles.ts'
import { TerrainDecoder } from './TerrainDecoder.ts'
import { TerrainImagery } from './TerrainImagery.ts'
import { MoonWacGlobal } from './MoonWacGlobal.ts'
import { bodyInfo } from './ephemeris.ts'
import { configureSurfaceMaterial, configureTerrainDepth, type SurfaceState } from './surfaceMaterial.ts'

const MAX_REQUESTS = 4
const MAX_BYTES = 48 * 1024 * 1024
const MAX_LEAVES = 48
const RETRY_MS = 30_000
/** Low-poly lunar style: refine until a mesh facet covers about this many
 * pixels. Below that scale the surface reads as flat-shaded facet geometry. */
const MOON_FACET_PIXELS = 2
export type TerrainStatus = { body: TerrainBody; state: 'loading' | 'ready' | 'unavailable' | 'off'; loadedTiles: number; failedTiles: number; source?: { resolution: number; credit: string; url: string; gaps: boolean; approximate: boolean } }
type Node = { key: string; info: TerrainTileInfo; address: TileAddress; sphere: THREE.Sphere; box?: THREE.Box3; lastUsed: number; retryAt: number;
  bytes: number; request?: AbortController; heights?: Float32Array; mesh?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>; edge?: TerrainEdge }
type Decoder = Pick<TerrainDecoder, 'decode' | 'dispose'>

/** Versioned geographic terrain with region-paged metadata and independent imagery. */
export class GlobeTerrainLayer {
  readonly group = new THREE.Group()
  active = false
  private manifest?: TerrainManifest
  private manifestUrl = ''
  private nodes = new Map<string, Node>()
  private wanted = new Set<string>()
  private refined = new Set<string>()
  private metadataRequest = new AbortController()
  private decoder?: Decoder
  private disposed = false
  private enabled = true
  private exaggeration = 1
  private lastUpdate = -Infinity
  private bytes = 0
  private groundNode?: Node
  private requests = 0
  private reported = ''
  private stitchedSignature = ''
  private metadataFailed = false
  private baseMaterial: THREE.MeshStandardMaterial
  private material: THREE.MeshStandardMaterial
  private radiusMeters: number
  private bodyId: TerrainBody
  private imagery: TerrainImagery
  private wacGlobal?: MoonWacGlobal
  private pages = new Map<string, { keys: string[]; lastUsed: number; retryAt: number; request?: AbortController }>()
  private pageRequests = 0
  private sampleBase: TerrainSurfaceSampler
  private body: THREE.Mesh
  private onStatus: (status: TerrainStatus) => void
  private baseUrl: string
  private createDecoder: () => Decoder
  private surface?: SurfaceState

  constructor(body: THREE.Mesh, onStatus: (status: TerrainStatus) => void,
    baseUrl: string, createDecoder: () => Decoder = () => new TerrainDecoder(), bodyId: TerrainBody = 'moon', surface?: SurfaceState) {
    this.bodyId = bodyId
    this.surface = surface
    this.imagery = new TerrainImagery(bodyId)
    this.body = body
    this.sampleBase = sphereSurfaceSampler(body.geometry as THREE.SphereGeometry)
    this.onStatus = onStatus
    this.baseUrl = baseUrl
    this.createDecoder = createDecoder
    this.baseMaterial = body.material as THREE.MeshStandardMaterial
    this.material = this.baseMaterial.clone()
    // The lunar surface renders flat-shaded facets; other bodies stay smooth.
    if (bodyId === 'moon') this.material.flatShading = true
    this.radiusMeters = bodyInfo[bodyId].radiusKm * 1000
    const radius = (body.geometry as THREE.SphereGeometry).parameters.radius
    this.group.name = `${bodyId}-terrain`
    this.group.scale.setScalar(radius)
    body.add(this.group)
    this.material.onBeforeCompile = shader => {
      shader.vertexShader = 'attribute float terrainCoverage; varying float vTerrainCoverage;\n' + shader.vertexShader
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTerrainCoverage = terrainCoverage;')
      shader.fragmentShader = 'varying float vTerrainCoverage;\n' + shader.fragmentShader
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = mix(vec3(0.22), diffuseColor.rgb, step(0.999, vTerrainCoverage));')
    }
    this.material.customProgramCacheKey = () => 'terrain-coverage-v1'
    if (surface) configureSurfaceMaterial(this.material, surface, this.radiusMeters, 1, true)
    if (surface && bodyId === 'moon') { this.wacGlobal = new MoonWacGlobal(new URL('moon/wac643-304ppd-v1/', baseUrl).href); this.wacGlobal.configure(this.material) }
    this.report()
    void this.loadManifest()
  }

  async setWacPilot(enabled: boolean) { this.wacGlobal?.setEnabled(enabled) }

  private async loadManifest() {
    const timeout = setTimeout(() => this.metadataRequest.abort(), 15_000)
    try {
      const catalogUrl = new URL('catalog.json', this.baseUrl).href
      const catalogResponse = await fetch(catalogUrl, { signal: this.metadataRequest.signal })
      if (!catalogResponse.ok) throw new Error('Terrain catalog unavailable')
      const catalog = await catalogResponse.json()
      if (catalog.schema !== 1 || typeof catalog.bodies?.[this.bodyId] !== 'string') throw new Error('Invalid terrain catalog')
      this.manifestUrl = new URL(catalog.bodies[this.bodyId], this.baseUrl).href
      if (!this.manifestUrl.startsWith(this.baseUrl)) throw new Error('Terrain manifest outside release root')
      const response = await fetch(this.manifestUrl, { signal: this.metadataRequest.signal })
      if (!response.ok) throw new Error('Terrain manifest unavailable')
      const manifest = parseTerrainManifest(await response.json())
      if (manifest.body !== this.bodyId) throw new Error('Terrain body mismatch')
      if (this.disposed) return
      this.manifest = manifest

    } catch {
      if (!this.disposed) { this.metadataFailed = true; this.manifest = undefined }
    } finally {
      clearTimeout(timeout)
      if (!this.disposed) this.report()
    }
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled
    this.lastUpdate = -Infinity
    if (!enabled) {
      this.setActive(false)
      this.wanted.clear()
      for (const node of this.nodes.values()) node.request?.abort()
      for (const page of this.pages.values()) page.request?.abort()
      this.imagery.update([], performance.now())
      this.wacGlobal?.clear()
    }
    this.report()
  }

  /** Use the rendered ground below the camera at close range, with a
   * conservative envelope until terrain is available at that location. */
  cameraSurfaceRadius(position: THREE.Vector3): number {
    const radius = this.group.scale.x
    if (!this.enabled || !this.manifest) return radius
    const center = this.body.getWorldPosition(new THREE.Vector3())
    const direction = position.clone().sub(center).normalize()
    if (this.active && position.distanceTo(center) < radius * 1.15) {
      const local = direction.clone().applyQuaternion(this.body.getWorldQuaternion(new THREE.Quaternion()).invert())
      const lat = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(local.y, -1, 1)))
      const lon = THREE.MathUtils.radToDeg(Math.atan2(-local.z, local.x))
      const candidates = [...this.nodes.values()].filter(n => {
        if (!n.mesh) return false
        const b = terrainBounds(n.address)
        return lon >= b.west - 1e-9 && lon <= b.east + 1e-9 && lat >= b.south - 1e-9 && lat <= b.north + 1e-9
      }).sort((a,b) => Number(!!b.mesh?.visible) - Number(!!a.mesh?.visible) || b.address.z - a.address.z)
      const point = new THREE.Vector3(), normal = new THREE.Vector3()
      for (const node of candidates) if (this.sampleCell(node.mesh!.geometry, terrainBounds(node.address), this.meshSize(node.address), lat, lon, point, normal)) {
        this.groundNode = node; node.lastUsed = performance.now()
        return point.length() * radius
      }
      const origin = center.clone().addScaledVector(direction, radius * 2)
      const ground = this.hitGround(new THREE.Ray(origin, direction.negate()))
      if (ground) return ground.distanceTo(center)
    }
    return radius * (1 + Math.max(0, this.manifest.maxHeightMeters) * this.exaggeration / this.radiusMeters)
  }

  hitGround(ray: THREE.Ray): THREE.Vector3 | null {
    if (!this.active || !this.enabled) return null
    this.group.updateWorldMatrix(true, true)
    const picker = new THREE.Raycaster()
    picker.ray.copy(ray)
    const meshes = [...this.nodes.values()].flatMap(node => node.mesh?.visible ? [node.mesh] : [])
    return firstTerrainSurfaceHit(picker, meshes)?.point ?? null
  }

  private sampleCell = terrainSurfaceSampler()
  surfaceSignature() {
    return !this.active ? 'sphere' : `${this.exaggeration}/` + [...this.nodes.values()].filter(n => n.mesh?.visible).map(n => n.key).sort().join('|')
  }
  sampleSurface = (lat: number, lon: number, point: THREE.Vector3, normal: THREE.Vector3) => {
    if (!this.active) return this.sampleBase(lat, lon, point, normal)
    for (const node of this.nodes.values()) if (node.mesh?.visible
      && this.sampleCell(node.mesh.geometry, terrainBounds(node.address), this.meshSize(node.address), lat, lon, point, normal)) return true
    return false
  }

  setExaggeration(value: number) {
    if (value !== 1 && value !== 4) return
    if (value === this.exaggeration) return
    this.exaggeration = value
    this.lastUpdate = -Infinity
    for (const node of this.nodes.values()) {
      node.box = this.surfaceBox(node)
      if (node.mesh && node.heights) {
        node.mesh.geometry.dispose()
        node.mesh.geometry = this.geometry(node)
        node.edge = captureTerrainEdge(node.mesh.geometry, this.meshSize(node.address))
      }
    }
    this.stitchedSignature = ''
  }

  private setActive(active: boolean) {
    this.active = active
    if (!active) { this.groundNode = undefined; this.refined.clear() }
    this.group.visible = active
    // Keep the body object visible: its child terrain inherits its transform.
    this.baseMaterial.visible = !active
  }

  update(camera: THREE.PerspectiveCamera, viewportHeight: number, now: number, selected: boolean) {
    if (this.disposed) return
    // loadSurface can replace the local fallback texture after initialization.
    this.material.map = this.baseMaterial.map
    this.material.emissiveMap = this.baseMaterial.emissiveMap
    this.material.emissive.copy(this.baseMaterial.emissive)
    this.material.emissiveIntensity = this.baseMaterial.emissiveIntensity
    if (this.material.map && !this.material.userData.hasMap) {
      this.material.userData.hasMap = true
      this.material.needsUpdate = true
    }
    if (now - this.lastUpdate < 120) return
    this.lastUpdate = now
    this.wanted.clear()
    if (!this.enabled || !this.manifest || !selected) {
      this.setActive(false)
      for (const node of this.nodes.values()) node.request?.abort()
      for (const page of this.pages.values()) page.request?.abort()
      this.imagery.update([], now)
      this.wacGlobal?.clear()
      if (!selected) {
        for (const node of this.nodes.values()) if (!node.request) { this.release(node); this.nodes.delete(node.key) }
        this.imagery.clear()
        this.trimPages(now, true)
      }
      this.report()
      return
    }
    camera.updateMatrixWorld()
    this.body.updateWorldMatrix(true, true)
    const localCamera = this.body.worldToLocal(camera.position.clone()).divideScalar(this.group.scale.x)
    const focal = viewportHeight / (2 * Math.tan(camera.fov * Math.PI / 360))
    const distance = localCamera.length()
    if (distance <= 1 + this.manifest.minHeightMeters * this.exaggeration / this.radiusMeters || focal * 2 / Math.max(1, distance - 1) < 32) {
      this.setActive(false)
      for (const node of this.nodes.values()) node.request?.abort()
      this.imagery.update([], now)
      this.wacGlobal?.clear()
      return
    }
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.group.matrixWorld))
    const score = (node: Node) => {
      if (!(node.box ? frustum.intersectsBox(node.box) : frustum.intersectsSphere(node.sphere))) return 0
      if (localCamera.dot(node.sphere.center) + distance * node.sphere.radius < .96) return 0
      const bounds = terrainBounds(node.address)
      const latitude = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(localCamera.y / distance,-1,1)))
      const longitude = THREE.MathUtils.radToDeg(Math.atan2(-localCamera.z,localCamera.x))
      // Adjacent tiles across the dateline must refine symmetrically.
      const closest = [-360, 0, 360].map(offset => geoDirection(
        THREE.MathUtils.clamp(latitude, bounds.south, bounds.north),
        THREE.MathUtils.clamp(longitude + offset, bounds.west, bounds.east)))
        .sort((a, b) => localCamera.distanceToSquared(a) - localCamera.distanceToSquared(b))[0]
      const height = (node.info.min + node.info.max) / 2
      closest.multiplyScalar(1+(Number.isFinite(height)?height*this.exaggeration/this.radiusMeters:0))
      const nearest = Math.max(100/this.radiusMeters,localCamera.distanceTo(closest))
      const density = (this.manifest!.sampleSize-1)/(this.meshSize(node.address)-1)
      const geometryError = focal * node.info.error * density * density * this.exaggeration / this.radiusMeters / nearest
      // Flat terrain still needs finer patches to carry sharper imagery.
      const imageryError = this.bodyId === 'venus' ? 0
        : focal * bounds.span * Math.PI / 180 / nearest / 256 * 2 / 1.35
      // The Moon refines to a target projected facet size rather than
      // subpixel measured error: close-range believability comes from
      // bounded procedural synthesis, not from finer measured meshes.
      const facetError = focal * bounds.span * Math.PI / 180 / (this.meshSize(node.address) - 1) / nearest / MOON_FACET_PIXELS
      return this.bodyId === 'moon' ? facetError : Math.max(geometryError, imageryError)
    }
    const want = (node: Node) => { this.wanted.add(node.key); node.lastUsed = now }
    const roots = [0, 1].map(x => this.getNode({ z: 0, x, y: 0 }))
    const leaves = roots.map(node => ({ node, score: score(node) }))
    roots.forEach(want)
    const refining = new Set<string>()
    while (leaves.length + 3 <= MAX_LEAVES) {
      leaves.sort((a, b) => b.score - a.score)
      const next = leaves.find(item => item.score > (this.refined.has(item.node.key) ? 1.5 : 2.5) && item.node.address.z < this.manifest!.maxZoom)
      if (!next) break
      const addresses = terrainChildren(next.node.address)
      if (!addresses.every(a => this.nodes.has(this.key(a)) || this.manifest!.tiles[this.key(a)])) {
        this.ensurePage(next.node.address, now)
        next.score = 0
        continue
      }
      // Select detail from the view and source metadata alone. A parent can
      // remain visible while its children stream, but residency must not
      // change the requested level at a stationary camera.
      const siblings = addresses.map(address => this.getNode(address))
      const children = siblings.map(node => ({ node, score: score(node) }))
        .filter(item => item.score > 0)
      if (!children.length) { next.score = 0; continue }
      if (this.manifest.sampleSize === 129) {
        const triangles = leaves.reduce((sum,item) => sum+meshTriangles(this.meshSize(item.node.address)),0)
        if (triangles-meshTriangles(this.meshSize(next.node.address))
          +children.reduce((sum,item) => sum+meshTriangles(this.meshSize(item.node.address)),0)>400000) { next.score=0; continue }
      }
      refining.add(next.node.key)
      leaves.splice(leaves.indexOf(next), 1, ...children)
      siblings.forEach(want)
    }
    this.refined = refining
    for (const node of this.nodes.values()) {
      if (node.mesh) node.mesh.visible = false
      if (!this.wanted.has(node.key)) node.request?.abort()
    }
    const show = (node: Node) => {
      if (score(node) === 0) return
      const children = node.address.z < this.manifest!.maxZoom
        ? terrainChildren(node.address).map(address => this.nodes.get(this.key(address)))
          .filter((child): child is Node => !!child && this.wanted.has(child.key)) : []
      if (children.length && children.every(child => child.mesh)) {
        children.forEach(show)
      } else if (node.mesh) node.mesh.visible = true
    }
    roots.forEach(show)
    const visible = [...this.nodes.values()].filter(n => n.mesh?.visible)
    const signature = visible.map(n => `${n.key}:${n.mesh!.geometry.id}`).sort().join('|')
    if (signature !== this.stitchedSignature) {
      stitchTerrainEdges(visible.map(n => ({ key: n.key, level: n.address.z,
        bounds: terrainBounds(n.address), origin: new THREE.Vector3(), geometry: n.mesh!.geometry, edge: n.edge! })))
      this.stitchedSignature = signature
    }
    this.wacGlobal?.update(visible.map(n => n.address), now)
    this.imagery.update(this.bodyId === 'moon' ? [] : visible.map(n => n.address), now)
    for (const node of this.nodes.values()) if (node.mesh) {
      const map = (this.bodyId === 'moon' ? undefined : this.imagery.texture(node.address)) ?? this.baseMaterial.map
      const material = node.mesh.material
      if (material.map !== map) {
        const hadMap = !!material.map
        material.map = map
        material.emissiveMap = map
        material.needsUpdate = hadMap !== !!map
      }
      material.emissive.copy(this.baseMaterial.emissive)
      material.emissiveIntensity = this.baseMaterial.emissiveIntensity
    }
    this.setActive(roots.every(node => !!node.mesh))
    this.pump(now)
    this.trimPages(now)
    for (const [key, node] of this.nodes) if (!this.wanted.has(key) && !node.mesh && !node.request
      && now - node.lastUsed > RETRY_MS) this.nodes.delete(key)
    this.report()
  }

  private ensurePage(address: TileAddress, now: number) {
    const factor = 2 ** (address.z - 3)
    const key = `${Math.floor(address.x / factor)}/${Math.floor(address.y / factor)}`
    const info = this.manifest!.indexPages?.pages[key]
    if (!info) return
    let page = this.pages.get(key)
    if (!page) { page = { keys: [], lastUsed: now, retryAt: 0 }; this.pages.set(key, page) }
    page.lastUsed = now
    if (page.keys.length || page.request || page.retryAt > now || this.pageRequests >= 2) return
    const request = new AbortController()
    page.request = request
    this.pageRequests++
    const entry = page
    void (async () => {
      const timeout = setTimeout(() => { entry.retryAt = performance.now() + RETRY_MS; request.abort() }, 15_000)
      try {
        const response = await fetch(new URL(info.url, this.manifestUrl), { signal: request.signal })
        if (!response.ok) throw new Error('Terrain metadata page unavailable')
        const buffer = await response.arrayBuffer()
        if (buffer.byteLength !== info.bytes) throw new Error('Terrain metadata size mismatch')
        const hash = await crypto.subtle.digest('SHA-256', buffer)
        const digest = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('')
        if (digest !== info.sha256) throw new Error('Terrain metadata checksum mismatch')
        const tiles = parseTerrainPage(JSON.parse(new TextDecoder().decode(buffer)), this.manifest!, key)
        if (this.disposed || request.signal.aborted) return
        Object.assign(this.manifest!.tiles, tiles)
        entry.keys = Object.keys(tiles)
        entry.retryAt = 0
      } catch {
        if (!request.signal.aborted) entry.retryAt = performance.now() + RETRY_MS
      } finally {
        clearTimeout(timeout)
        entry.request = undefined
        this.pageRequests--
        this.report()
      }
    })()
  }

  private trimPages(now: number, all = false) {
    const inUse = new Set([...this.wanted].map(key => {
      const [z, x, y] = key.split('/').map(Number), factor = 2 ** (z - 3)
      return z >= 3 ? `${Math.floor(x / factor)}/${Math.floor(y / factor)}` : ''
    }))
    for (const key of inUse) { const page = this.pages.get(key); if (page) page.lastUsed = now }
    const unused = [...this.pages].filter(([key, page]) => !inUse.has(key) && !page.request).sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    while ((all || this.pages.size > 16) && unused.length) {
      const [key, page] = unused.shift()!
      for (const tile of page.keys) delete this.manifest!.tiles[tile]
      this.pages.delete(key)
    }
  }

  private key(address: TileAddress) { return `${address.z}/${address.x}/${address.y}` }

  private getNode(address: TileAddress): Node {
    const key = this.key(address)
    let node = this.nodes.get(key)
    if (!node) {
      const sphere = tileBoundingSphere(terrainBounds(address))
      // Includes the full allowed displacement, including the 4x preview.
      sphere.radius += Math.max(Math.abs(this.manifest!.minHeightMeters), this.manifest!.maxHeightMeters) * 4 / this.radiusMeters
      node = { key, info: this.manifest!.tiles[key], address, sphere, lastUsed: this.lastUpdate, retryAt: 0, bytes: 0 }
      node.box = this.surfaceBox(node)
      this.nodes.set(key, node)
    }
    return node
  }

  private meshSize(address: TileAddress) {
    return this.manifest!.sampleSize === 129 && address.z < this.manifest!.maxZoom ? 65 : this.manifest!.sampleSize
  }
  private surfaceBox(node: Node) {
    // Selection must not change when a tile is decoded or evicted. Bound the
    // physical surface from immutable metadata, excluding artificial skirts.
    const b = terrainBounds(node.address)
    const lons = [b.west, b.east, ...[-180,-90,0,90,180].filter(v => v > b.west && v < b.east)]
    const lats = [b.south, b.north, ...[0].filter(v => v > b.south && v < b.north)]
    const box = new THREE.Box3()
    for (const lat of lats) for (const lon of lons) for (const height of [node.info.min, node.info.max]) {
      box.expandByPoint(geoDirection(lat,lon).multiplyScalar(1 + height*this.exaggeration/this.radiusMeters))
    }
    // Include rounding of the Float32 vertex positions.
    return box.expandByScalar(1e-7)
  }
  private geometry(node: Node) {
    const size=this.meshSize(node.address)
    return terrainGeometry(terrainBounds(node.address),heightGrid(node.heights!,this.manifest!.sampleSize,size),size,
      this.manifest!.referenceRadiusMeters,this.radiusMeters,this.exaggeration)
  }

  private pump(now: number) {
    if (this.disposed || !this.enabled || !this.manifest) return
    const pending = [...this.wanted].map(key => this.nodes.get(key)!)
      .filter(node => !node.mesh && !node.request && node.retryAt <= now)
      .sort((a, b) => a.address.z - b.address.z)
    for (const node of pending) {
      if (this.requests >= MAX_REQUESTS) break
      // Reserve a conservative CPU+GPU allocation before asynchronous decoding.
      const reserve = (this.meshSize(node.address) === 129 ? 3 : 1) * 1024 * 1024
      const unused = [...this.nodes.values()].filter(n => n !== this.groundNode && n.mesh && !this.wanted.has(n.key))
        .sort((a, b) => a.lastUsed - b.lastUsed)
      while (this.bytes + reserve > MAX_BYTES && unused.length) this.release(unused.shift()!)
      if (this.bytes + reserve > MAX_BYTES) break
      node.bytes = reserve
      this.bytes += reserve
      this.requests++
      node.request = new AbortController()
      void this.load(node, node.request)
    }
  }

  private async load(node: Node, request: AbortController) {
    const timeout = setTimeout(() => { node.retryAt = performance.now() + RETRY_MS; request.abort() }, 15_000)
    try {
      const url = new URL(this.manifest!.tileUrl.replace('{z}', String(node.address.z))
        .replace('{x}', String(node.address.x)).replace('{y}', String(node.address.y)), this.manifestUrl)
      const response = await fetch(url, { signal: request.signal })
      if (!response.ok) throw new Error(`Terrain HTTP ${response.status}`)
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength !== node.info.bytes) throw new Error('Terrain download size mismatch')
      if (this.disposed || request.signal.aborted || !this.wanted.has(node.key)) return
      const heights = await (this.decoder ??= this.createDecoder()).decode(buffer, this.manifest!.sampleSize, node.info.sha256, this.manifest!.scaleMeters, this.manifest!.noData)
      if (this.disposed || request.signal.aborted || !this.wanted.has(node.key)) return
      node.heights = heights
      node.mesh = new THREE.Mesh(this.geometry(node), this.material.clone())
      node.edge = captureTerrainEdge(node.mesh.geometry, this.meshSize(node.address))
      if (this.wacGlobal) node.mesh.onBeforeRender = () => this.wacGlobal?.bind(node.address)
      node.mesh.material.onBeforeCompile = this.material.onBeforeCompile
      node.mesh.material.customProgramCacheKey = this.material.customProgramCacheKey
      node.box = this.surfaceBox(node)
      node.mesh.name = `${this.bodyId}-terrain/${node.key}`
      node.mesh.visible = false
      if (this.surface) {
        const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
      node.mesh.customDepthMaterial = depth
        configureTerrainDepth(depth, this.surface, this.radiusMeters, true)
      }
      node.mesh.castShadow = true
      node.mesh.receiveShadow = true
      this.group.add(node.mesh)
      const geometry = node.mesh.geometry
      const actual = heights.byteLength + Object.values(geometry.attributes).reduce((sum, a) => sum + a.array.byteLength * 2, 0)
        + (geometry.index?.array.byteLength ?? 0) * 2
      this.bytes += actual - node.bytes
      node.bytes = actual
      node.retryAt = 0
    } catch {
      if (!request.signal.aborted) node.retryAt = performance.now() + RETRY_MS
    } finally {
      clearTimeout(timeout)
      if (!node.mesh) { this.bytes -= node.bytes; node.bytes = 0; node.heights = undefined }
      node.request = undefined
      this.requests--
      this.report()
      this.pump(performance.now())
    }
  }

  private release(node: Node) {
    node.mesh?.removeFromParent()
    node.mesh?.customDepthMaterial?.dispose()
    node.mesh?.geometry.dispose()
    node.mesh?.material.dispose()
    node.mesh = undefined
    node.heights = undefined
    node.edge = undefined
    this.bytes -= node.bytes
    node.bytes = 0
  }

  metrics() {
    const visible = [...this.nodes.values()].filter(n => n.mesh?.visible && this.active)
    return { ready: this.active, visible: visible.length, cached: [...this.nodes.values()].filter(n => n.mesh).length,
      requests: this.requests + this.pageRequests, memoryBytes: this.bytes, sampleSize: this.manifest?.sampleSize ?? 0,
      grids: Object.fromEntries([65,129].map(size=>[size,visible.filter(n=>this.meshSize(n.address)===size).length])),
      maxLevel: visible.reduce((level,n) => Math.max(level,n.address.z),0),
      failed: [...this.nodes.values()].filter(n => n.retryAt > 0).length,
      triangles: visible.reduce((sum,n) => sum + n.mesh!.geometry.index!.count / 3,0),
      triangleBudget: this.manifest?.sampleSize === 129 ? 400000 : 417792, imagery: this.imagery.metrics(), wac: this.wacGlobal?.metrics() }
  }

  private report() {
    if (this.disposed) return
    const status: TerrainStatus = { body: this.bodyId, state: !this.enabled ? 'off' : this.metadataFailed ? 'unavailable' : this.active ? 'ready' : 'loading',
      loadedTiles: [...this.nodes.values()].filter(node => node.mesh).length,
      failedTiles: [...this.nodes.values()].filter(node => node.retryAt > 0).length + [...this.pages.values()].filter(page => page.retryAt > 0).length,
      source: this.manifest ? { resolution: this.manifest.sourceResolutionMeters, credit: this.manifest.credit,
        url: this.manifest.sourceUrl, gaps: !!this.manifest.missingPixels, approximate: !!this.manifest.referenceSurfaceApproximation } : undefined }
    const key = JSON.stringify(status)
    if (key !== this.reported) { this.reported = key; this.onStatus(status) }
  }

  dispose() {
    this.disposed = true
    this.metadataRequest.abort()
    this.setActive(false)
    this.wanted.clear()
    for (const node of this.nodes.values()) { node.request?.abort(); this.release(node) }
    for (const page of this.pages.values()) page.request?.abort()
    this.imagery.dispose()
    this.wacGlobal?.dispose()
    this.decoder?.dispose()
    this.material.dispose()
    this.group.removeFromParent()
  }
}
