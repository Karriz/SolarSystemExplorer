import * as THREE from 'three'
import { parseTerrainManifest, parseTerrainPage, terrainBounds, terrainChildren, terrainGeometry, type TerrainManifest, type TerrainBody, type TerrainTileInfo } from './terrain.ts'
import { tileBoundingSphere } from './GlobeTileLayer.ts'
import type { TileAddress } from './surfaceTiles.ts'
import { TerrainDecoder } from './TerrainDecoder.ts'
import { TerrainImagery } from './TerrainImagery.ts'
import { bodyInfo } from './ephemeris.ts'
import { configureSurfaceMaterial, configureTerrainDepth, type SurfaceState } from './surfaceMaterial.ts'

const MAX_REQUESTS = 4
const MAX_BYTES = 48 * 1024 * 1024
const MAX_LEAVES = 48
const RETRY_MS = 30_000
export type TerrainStatus = { body: TerrainBody; state: 'loading' | 'ready' | 'unavailable' | 'off'; loadedTiles: number; failedTiles: number; source?: { resolution: number; credit: string; url: string; gaps: boolean; approximate: boolean } }
type Node = { key: string; info: TerrainTileInfo; address: TileAddress; sphere: THREE.Sphere; lastUsed: number; retryAt: number;
  bytes: number; request?: AbortController; heights?: Float32Array; mesh?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> }
type Decoder = Pick<TerrainDecoder, 'decode' | 'dispose'>

/** Versioned geographic terrain with region-paged metadata and independent imagery. */
export class GlobeTerrainLayer {
  readonly group = new THREE.Group()
  active = false
  private manifest?: TerrainManifest
  private manifestUrl = ''
  private nodes = new Map<string, Node>()
  private wanted = new Set<string>()
  private metadataRequest = new AbortController()
  private decoder?: Decoder
  private disposed = false
  private enabled = true
  private exaggeration = 1
  private lastUpdate = -Infinity
  private bytes = 0
  private requests = 0
  private reported = ''
  private metadataFailed = false
  private baseMaterial: THREE.MeshStandardMaterial
  private material: THREE.MeshStandardMaterial
  private radiusMeters: number
  private bodyId: TerrainBody
  private imagery: TerrainImagery
  private pages = new Map<string, { keys: string[]; lastUsed: number; retryAt: number; request?: AbortController }>()
  private pageRequests = 0
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
    this.onStatus = onStatus
    this.baseUrl = baseUrl
    this.createDecoder = createDecoder
    this.baseMaterial = body.material as THREE.MeshStandardMaterial
    this.material = this.baseMaterial.clone()
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
    this.report()
    void this.loadManifest()
  }

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
    if (position.distanceTo(center) < radius * 1.15) {
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
    return picker.intersectObjects(meshes, false)[0]?.point ?? null
  }

  setExaggeration(value: number) {
    if (value !== 1 && value !== 4) return
    if (value === this.exaggeration) return
    this.exaggeration = value
    this.lastUpdate = -Infinity
    for (const node of this.nodes.values()) if (node.mesh && node.heights) {
      node.mesh.geometry.dispose()
      node.mesh.geometry = this.geometry(node)
    }
  }

  private setActive(active: boolean) {
    this.active = active
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
      return
    }
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.group.matrixWorld))
    const score = (node: Node) => {
      if (!frustum.intersectsSphere(node.sphere)) return 0
      if (localCamera.dot(node.sphere.center) + distance * node.sphere.radius < .96) return 0
      const nearest = Math.max(.01, localCamera.distanceTo(node.sphere.center) - node.sphere.radius)
      const geometryError = focal * node.info.error * this.exaggeration / this.radiusMeters / nearest
      // Flat terrain still needs finer patches to carry sharper imagery.
      const imageryError = this.bodyId === 'venus' ? 0
        : focal * terrainBounds(node.address).span * Math.PI / 180 / nearest / 256 * 2 / 1.35
      return Math.max(geometryError, imageryError)
    }
    const want = (node: Node) => { this.wanted.add(node.key); node.lastUsed = now }
    const roots = [0, 1].map(x => this.getNode({ z: 0, x, y: 0 }))
    const leaves = roots.map(node => ({ node, score: score(node) }))
    roots.forEach(want)
    while (leaves.length + 3 <= MAX_LEAVES) {
      leaves.sort((a, b) => b.score - a.score)
      const next = leaves.find(item => item.score > 2 && item.node.address.z < this.manifest!.maxZoom)
      if (!next) break
      const addresses = terrainChildren(next.node.address)
      if (!addresses.every(a => this.nodes.has(this.key(a)) || this.manifest!.tiles[this.key(a)])) {
        this.ensurePage(next.node.address, now)
        next.score = 0
        continue
      }
      const children = addresses.map(address => this.getNode(address)).map(node => ({ node, score: score(node) }))
        .filter(item => item.score > 0)
      if (!children.length) { next.score = 0; continue }
      leaves.splice(leaves.indexOf(next), 1, ...children)
      children.forEach(({ node }) => want(node))
    }
    for (const node of this.nodes.values()) {
      if (node.mesh) node.mesh.visible = false
      if (!this.wanted.has(node.key)) node.request?.abort()
    }
    const show = (node: Node) => {
      const children = node.address.z < this.manifest!.maxZoom
        ? terrainChildren(node.address).map(address => this.nodes.get(this.key(address)))
          .filter((child): child is Node => !!child && this.wanted.has(child.key)) : []
      if (children.length && children.every(child => child.mesh)) {
        children.forEach(show)
      } else if (node.mesh) node.mesh.visible = true
    }
    roots.forEach(show)
    const visible = [...this.nodes.values()].filter(n => n.mesh?.visible)
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
      this.nodes.set(key, node)
    }
    return node
  }

  private geometry(node: Node) {
    return terrainGeometry(terrainBounds(node.address), node.heights!, this.manifest!.sampleSize,
      this.manifest!.referenceRadiusMeters, this.radiusMeters, this.exaggeration)
  }

  private pump(now: number) {
    if (this.disposed || !this.enabled || !this.manifest) return
    const pending = [...this.wanted].map(key => this.nodes.get(key)!)
      .filter(node => !node.mesh && !node.request && node.retryAt <= now)
      .sort((a, b) => a.address.z - b.address.z)
    for (const node of pending) {
      if (this.requests >= MAX_REQUESTS) break
      // Reserve a conservative CPU+GPU allocation before asynchronous decoding.
      const reserve = 1024 * 1024
      const unused = [...this.nodes.values()].filter(n => n.mesh && !this.wanted.has(n.key))
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
      node.mesh.material.onBeforeCompile = this.material.onBeforeCompile
      node.mesh.material.customProgramCacheKey = this.material.customProgramCacheKey
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
    this.bytes -= node.bytes
    node.bytes = 0
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
    this.decoder?.dispose()
    this.material.dispose()
    this.group.removeFromParent()
  }
}
