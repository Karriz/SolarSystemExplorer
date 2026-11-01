import * as THREE from 'three'
import { firstTerrainSurfaceHit, type TerrainSurfaceSampler } from './terrainSurface.ts'
import { captureTerrainEdge, stitchTerrainEdges, type TerrainEdge } from './terrainEdges.ts'
import { earthMeshSize, heightGrid, meshTriangles, terrainSurfaceBounds, REGIONAL_TRIANGLE_BUDGET } from './terrainLod.ts'
import { EarthImagery, configureEarthColor, earthColorUvs, earthColorTransform } from './earthImagery.ts'
import { bodyInfo } from './ephemeris.ts'
import { terrainChildren, terrainGeometry } from './terrain.ts'
import { tileBoundingSphere } from './GlobeTileLayer.ts'
import { configureSurfaceMaterial, configureTerrainDepth, type SurfaceState } from './surfaceMaterial.ts'
import { geoDirection, tileKey, type RegionalSource, type TerrainPatch } from './terrainPilot.ts'
import type { TileAddress } from './surfaceTiles.ts'

type Node = { address: TileAddress; source: RegionalSource; sphere: THREE.Sphere; box?: THREE.Box3; origin: THREE.Vector3; mesh?: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  heights?: Float32Array; gradients?: Float32Array; edge?: TerrainEdge; color?: { value: number }; colorTransform?: { value: THREE.Vector4 }; request?: AbortController; meshBytes?: number; bytes: number; used: number; retry: number }
export type RegionalMetrics = { ready: boolean; visible: number; cached: number; memoryBytes: number; transferBytes: number;
  requests: number; failed: number; decodeMs: number; buildMs: number; triangles: number; sources: string[]; grids: Record<string, number>; maxLevel: number; triangleBudget: number; residentMeshes: number; imagery?: ReturnType<EarthImagery['metrics']> }

/** Small native-grid overlays. Parent patches stay visible until all replacing
 * children exist. The normal body/planetary terrain remains the outer fallback. */
export class RegionalTerrainLayer {
  readonly group = new THREE.Group()
  private nodes = new Map<string, Node>()
  private wanted = new Set<string>()
  private sources: RegionalSource[] = []
  private enabled = true
  private disposed = false
  private requests = 0
  private bytes = 0
  private transferBytes = 0
  private decodeMs = 0
  private buildMs = 0
  private lastUpdate = -Infinity
  private exaggeration = 1
  private readonly radius: number
  private readonly radiusMeters: number
  private readonly base: THREE.MeshStandardMaterial
  private imagery?: EarthImagery
  private fallbackColor = { value: null as THREE.Texture | null }
  private now = 0
  private selected = false
  private edgeSignature = ''
  private fallbackSurface?: TerrainSurfaceSampler
  private fallbackSignature = () => 'sphere'
  private refined = new Set<string>()
  private groundNode?: Node
  readonly budget = 48 * 1024 * 1024

  private body: THREE.Mesh
  readonly bodyId: 'earth' | 'moon'
  private state: SurfaceState

  constructor(body: THREE.Mesh, bodyId: 'earth' | 'moon', state: SurfaceState) {
    this.body = body; this.bodyId = bodyId; this.state = state
    this.radius = (body.geometry as THREE.SphereGeometry).parameters.radius
    this.radiusMeters = bodyInfo[bodyId].radiusKm * 1000
    this.base = body.material as THREE.MeshStandardMaterial
    if (bodyId === 'earth') this.imagery = new EarthImagery()
    this.group.name = `${bodyId}-regional-terrain`
    this.group.scale.setScalar(this.radius)
    body.add(this.group)
  }

  addSource(source: RegionalSource) {
    if (this.disposed) { source.dispose?.(); return }
    if (source.body !== this.bodyId) throw new Error('Regional body mismatch')
    this.sources.push(source)
    this.lastUpdate = -Infinity
  }
  setFallbackSurface(sample: TerrainSurfaceSampler, signature: () => string) {
    this.fallbackSurface = sample; this.fallbackSignature = signature; this.edgeSignature = ''
  }
  setEnabled(enabled: boolean) {
    this.enabled = enabled
    this.lastUpdate = -Infinity
    if (!enabled) this.deactivate()
  }
  setExaggeration(value: number) {
    if (value !== 1 && value !== 4) return
    this.exaggeration = value
    this.edgeSignature = ''
    for (const node of this.nodes.values()) {
      node.box = undefined
      node.sphere = tileBoundingSphere(node.source.bounds(node.address))
      node.sphere.radius += Math.max(Math.abs(node.source.minHeight), node.source.maxHeight) * value / this.radiusMeters
    }
    for (const node of this.nodes.values()) if (node.mesh && node.heights && node.edge) {
      node.mesh.geometry.dispose()
      node.mesh.geometry = this.geometry(node)
      node.edge = captureTerrainEdge(node.mesh.geometry, this.gridSize(node))
      node.sphere.copy(node.mesh.geometry.boundingSphere!); node.sphere.center.add(node.origin)
      node.mesh.geometry.computeBoundingBox(); node.box = this.surfaceBox(node)
    }
    this.lastUpdate = -Infinity
  }
  private key(source: RegionalSource, address: TileAddress) { return `${source.id}/${tileKey(address)}` }
  private node(source: RegionalSource, address: TileAddress) {
    const key = this.key(source, address)
    let node = this.nodes.get(key)
    if (!node) {
      const sphere = tileBoundingSphere(source.bounds(address))
      sphere.radius += Math.max(Math.abs(source.minHeight), source.maxHeight) * 4 / this.radiusMeters
      const b = source.bounds(address)
      const origin = geoDirection((b.north+b.south)/2,(b.west+b.east)/2)
      node = { source, address, sphere, origin, bytes: 0, used: this.now, retry: 0 }
      this.nodes.set(key, node)
    }
    return node
  }
  private surfaceBox(node: Node) {
    const bounds = terrainSurfaceBounds(node.mesh!.geometry.getAttribute('position'), this.gridSize(node))
    return new THREE.Box3(new THREE.Vector3().fromArray(bounds.min), new THREE.Vector3().fromArray(bounds.max)).translate(node.origin).expandByScalar(1e-9)
  }
  private gridSize(node: Node) { return node.source.sampleSize === 129 ? earthMeshSize(node.address.z) : 65 }
  private geometry(node: Node) {
    const bounds = node.source.bounds(node.address)
    const size = this.gridSize(node)
    const heights = heightGrid(node.heights!, node.source.sampleSize ?? 65, size)
    const geometry = terrainGeometry(bounds, heights, size, this.radiusMeters, this.radiusMeters, this.exaggeration, node.origin)
    if (this.bodyId === 'earth') geometry.setAttribute('earthColorUv', earthColorUvs(bounds, size, node.address))
    if (this.bodyId !== 'earth' && node.gradients) {
      const normal = geometry.getAttribute('normal'), p = new THREE.Vector3(), east = new THREE.Vector3(), north = new THREE.Vector3()
      for (let r = 0; r < 65; r++) for (let c = 0; c < 65; c++) {
        const i = r * 65 + c, lat = THREE.MathUtils.degToRad(bounds.north + (bounds.south - bounds.north) * r / 64)
        const lon = THREE.MathUtils.degToRad(bounds.west + (bounds.east - bounds.west) * c / 64)
        p.set(Math.cos(lat)*Math.cos(lon), Math.sin(lat), -Math.cos(lat)*Math.sin(lon))
        east.set(-Math.sin(lon),0,-Math.cos(lon)); north.set(-Math.sin(lat)*Math.cos(lon),Math.cos(lat),Math.sin(lat)*Math.sin(lon))
        p.addScaledVector(east, -node.gradients[i] * this.exaggeration).addScaledVector(north, -node.gradients[4225+i] * this.exaggeration).normalize()
        normal.setXYZ(i,p.x,p.y,p.z)
      }
    }
    return geometry
  }
  private deactivate() {
    this.edgeSignature = ''
    this.refined.clear()
    this.groundNode = undefined
    this.wanted.clear()
    this.imagery?.update([], this.now)
    this.state.clipCount.value = 0
    this.group.visible = false
    for (const node of this.nodes.values()) {
      node.request?.abort()
      if (node.mesh) node.mesh.visible = false
    }
  }

  update(camera: THREE.PerspectiveCamera, viewportHeight: number, now: number, selected: boolean) {
    if (this.disposed) return
    this.now = now
    this.selected = selected
    // Selection/disable must be handled before the LOD throttle.
    if (!this.enabled || !selected) {
      this.deactivate()
      if (!selected) {
        for (const [key, node] of this.nodes) if (!node.request) { this.release(node); this.nodes.delete(key) }
        this.imagery?.clear()
      }
      return
    }
    if (now - this.lastUpdate < 120) return
    this.lastUpdate = now
    this.body.updateWorldMatrix(true, true)
    camera.updateMatrixWorld()
    const local = this.body.worldToLocal(camera.position.clone()).divideScalar(this.radius)
    if (local.length() > (this.bodyId === 'earth' ? 1.05 : 3)) { this.deactivate(); return }
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4()
      .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.group.matrixWorld))
    const cameraLon = THREE.MathUtils.radToDeg(Math.atan2(-local.z, local.x))
    const cameraLat = THREE.MathUtils.radToDeg(Math.asin(local.y / local.length()))
    const focal = viewportHeight / (2 * Math.tan(camera.fov * Math.PI / 360))
    const score = (node: Node) => {
      if (!(node.box ? frustum.intersectsBox(node.box) : frustum.intersectsSphere(node.sphere)) || local.dot(node.sphere.center) + local.length() * node.sphere.radius < .98) return 0
      const bounds = node.source.bounds(node.address)
      const wrappedLon = cameraLon + 360 * Math.round(((bounds.west + bounds.east) / 2 - cameraLon) / 360)
      const closest = geoDirection(THREE.MathUtils.clamp(cameraLat, bounds.south, bounds.north), THREE.MathUtils.clamp(wrappedLon, bounds.west, bounds.east))
      const approximateHeight = node.heights ? node.heights[Math.floor(node.heights.length / 2)] : 0
      closest.multiplyScalar(1 + (Number.isFinite(approximateHeight) ? approximateHeight * this.exaggeration / this.radiusMeters : 0))
      const distance = Math.max(100 / this.radiusMeters, local.distanceTo(closest))
      const spacing = bounds.span * Math.PI / 180 * this.radiusMeters / (this.gridSize(node) - 1)
      const error = node.source.info?.(node.address)?.error ?? spacing * .5
      return focal * error * this.exaggeration / this.radiusMeters / distance
    }
    const viewDirection = camera.getWorldDirection(new THREE.Vector3()).applyQuaternion(this.body.getWorldQuaternion(new THREE.Quaternion()).invert())
    const viewed = new THREE.Ray(local, viewDirection).intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3()) ?? local.clone().normalize()
    const viewLon = THREE.MathUtils.radToDeg(Math.atan2(-viewed.z, viewed.x)), viewLat = THREE.MathUtils.radToDeg(Math.asin(viewed.y / viewed.length()))
    const roots = this.sources.flatMap(source => (source.roots?.(viewLon, viewLat) ?? [source.root]).map(address => this.node(source, address))).filter(node => score(node) > 0)
    const leaves = roots.map(node => ({ node, score: score(node) }))
    this.wanted.clear()
    const want = (node: Node) => { this.wanted.add(this.key(node.source, node.address)); node.used = now }
    roots.forEach(want)
    const refining = new Set<string>()
    while (leaves.length + 3 <= 32) {
      leaves.sort((a, b) => b.score - a.score)
      const triangles = leaves.reduce((sum, item) => sum + meshTriangles(this.gridSize(item.node)), 0)
      const next = leaves.find(item => item.score > (this.refined.has(this.key(item.node.source, item.node.address)) ? 1.5 : 2.5)
        && item.node.address.z < item.node.source.maxZoom
        && triangles - meshTriangles(this.gridSize(item.node)) + 4 * meshTriangles(item.node.source.sampleSize === 129 ? earthMeshSize(item.node.address.z + 1) : 65) <= REGIONAL_TRIANGLE_BUDGET)
      if (!next) break
      const parent = next.node
      const addresses = terrainChildren(parent.address)
      if (parent.source.info && !addresses.every(a => parent.source.info!(a))) { next.score = 0; continue }
      // Request only one generation beyond loaded parents. This bounds cold
      // downloads and protects memory from an entire visible ancestor chain.
      if (!parent.mesh) { next.score = 0; continue }
      refining.add(this.key(parent.source, parent.address))
      const children = addresses.map(a => this.node(parent.source, a))
      leaves.splice(leaves.indexOf(next), 1, ...children.map(node => ({ node, score: score(node) })).filter(item => item.score > 0))
      children.forEach(want)
    }
    this.refined = refining
    for (const node of this.nodes.values()) {
      if (node.mesh) node.mesh.visible = false
      if (!this.wanted.has(this.key(node.source, node.address))) node.request?.abort()
    }
    const show = (node: Node): { complete: boolean; nodes: Node[] } => {
      if (score(node) === 0) return { complete: true, nodes: [] }
      const children = terrainChildren(node.address).map(a => this.nodes.get(this.key(node.source, a)))
      const loaded = children.every(child => child?.mesh && this.wanted.has(this.key(child.source, child.address)))
      const plans = loaded ? children.map(child => show(child!)) : []
      const descendants = plans.flatMap(plan => plan.nodes)
      if (loaded && plans.every(plan => plan.complete)) return { complete: true, nodes: descendants }
      // Keep the parent until its entire visible replacement subtree is drawable,
      // including descendants of ancestors whose own GPU geometry was evicted.
      // Unprotect the partial subtree so a parent rebuild can reclaim its memory.
      descendants.forEach(n => { if (n.mesh) n.mesh.visible = false })
      if (node.mesh) {
        this.ensureGeometry(node)
        if (node.edge) { node.mesh.visible = true; return { complete: true, nodes: [node] } }
      }
      const available = descendants.filter(n => n.mesh && n.edge)
      available.forEach(n => { n.mesh!.visible = true })
      return { complete: false, nodes: available }
    }
    roots.forEach(show)
    const visible = [...this.nodes.values()].filter(n => n.mesh?.visible && n.edge)
    const signature = this.fallbackSignature() + '/' + visible.map(n => this.key(n.source, n.address)).sort().join('|')
    if (signature !== this.edgeSignature) {
      const started = performance.now()
      stitchTerrainEdges(visible.map(n => ({ key: this.key(n.source, n.address), level: n.address.z,
        bounds: n.source.bounds(n.address), origin: n.origin, geometry: n.mesh!.geometry, edge: n.edge! })), this.fallbackSurface)
      this.buildMs += performance.now() - started
      for (const node of visible) node.box = this.surfaceBox(node)
      this.edgeSignature = signature
    }
    this.state.clipCount.value = 0
    // Clip only footprints actually drawn. Cached roots can have evicted GPU
    // geometry, and a partial sibling replacement must leave fallback visible.
    for (const node of visible) {
      const b = node.source.bounds(node.address)
      this.state.clips.value[this.state.clipCount.value++].set(b.west, b.south, b.east, b.north)
    }
    this.group.visible = this.state.clipCount.value > 0
    this.fallbackColor.value = this.base.map
    this.imagery?.update(visible.map(n => n.address), now, { lon: viewLon, lat: viewLat })
    for (const node of this.nodes.values()) if (node.mesh) {
      const color = node.mesh.visible ? this.imagery?.texture(node.address) : undefined
      const map = color ?? this.base.map
      if (node.color) node.color.value = color ? 1 : 0
      if (color && node.colorTransform) earthColorTransform(node.address, color, node.colorTransform.value)
      if (node.mesh.material.map !== map) { node.mesh.material.map = map; node.mesh.material.needsUpdate = true }
    }
    this.pump()
    for (const [key, node] of this.nodes) if (!this.wanted.has(key) && !node.request && !node.mesh) this.nodes.delete(key)
  }

  private geometryBytes(node: Node) {
    const g = node.mesh!.geometry, edge = node.edge!
    return edge.positions.byteLength + edge.normals.byteLength + edge.skirtDepths.byteLength + (edge.indices.length + edge.skirtIndices.length) * 8
      + Object.values(g.attributes).reduce((sum, a) => sum + a.array.byteLength * 2, 0) + (g.index?.array.byteLength ?? 0) * 2
  }
  private trimGeometry(reserve: number, except?: Node) {
    // Keep decoded heights and metadata for hidden ancestors, not their GPU
    // meshes. They can be rebuilt locally when zooming out, without downloads.
    const hidden = [...this.nodes.values()].filter(n => n !== except && n !== this.groundNode && n.mesh && n.edge && !n.mesh.visible)
      .sort((a, b) => a.address.z - b.address.z || a.used - b.used)
    while (this.bytes + reserve > this.budget && hidden.length) {
      const node = hidden.shift()!
      node.mesh!.geometry.dispose(); node.mesh!.geometry = new THREE.BufferGeometry(); node.edge = undefined
      this.bytes -= node.meshBytes ?? 0; node.bytes -= node.meshBytes ?? 0; node.meshBytes = 0
    }
    const unused = [...this.nodes.values()].filter(n => n !== except && n !== this.groundNode && !n.request && !this.wanted.has(this.key(n.source, n.address))).sort((a,b) => a.used-b.used)
    while (this.bytes + reserve > this.budget && unused.length) this.release(unused.shift()!)
  }
  private ensureGeometry(node: Node) {
    if (!node.mesh || node.edge || !node.heights) return
    const reserve = this.gridSize(node) === 129 ? 3 * 1024 * 1024 : 1024 * 1024
    this.trimGeometry(reserve, node)
    if (this.bytes + reserve > this.budget) return
    const started = performance.now()
    node.mesh.geometry.dispose(); node.mesh.geometry = this.geometry(node)
    node.edge = captureTerrainEdge(node.mesh.geometry, this.gridSize(node))
    node.box = this.surfaceBox(node)
    node.meshBytes = this.geometryBytes(node); node.bytes += node.meshBytes; this.bytes += node.meshBytes
    this.edgeSignature = ''; this.buildMs += performance.now() - started
  }
  private pump() {
    if (this.disposed || !this.enabled || !this.selected) return
    const pending = [...this.nodes.values()].filter(n => this.wanted.has(this.key(n.source, n.address)) && !n.mesh && !n.request && n.retry <= performance.now())
      .sort((a, b) => a.address.z - b.address.z)
    for (const node of pending) {
      if (this.requests >= 4) break
      const reserve = meshTriangles(this.gridSize(node)) > 10000 ? 3 * 1024 * 1024 : 1024 * 1024
      this.trimGeometry(reserve)
      const unused = [...this.nodes.values()].filter(n => n !== this.groundNode && n.mesh && !this.wanted.has(this.key(n.source, n.address))).sort((a, b) => a.used - b.used)
      while (this.bytes + reserve > this.budget && unused.length) this.release(unused.shift()!)
      if (this.bytes + reserve > this.budget) break
      node.bytes = reserve; this.bytes += reserve
      const request = node.request = new AbortController()
      this.requests++
      void this.load(node, request)
    }
  }
  private async load(node: Node, request: AbortController) {
    const timeout = setTimeout(() => { node.retry = performance.now() + 30000; request.abort() }, 15000)
    try {
      const patch: TerrainPatch = await node.source.load(node.address, request.signal)
      this.transferBytes += patch.transferBytes; this.decodeMs += patch.decodeMs
      if (this.disposed || request.signal.aborted || !this.wanted.has(this.key(node.source, node.address))) return
      if (patch.heights.length !== (node.source.sampleSize ?? 65) ** 2 || !patch.heights.every(Number.isFinite)
        || patch.heights.some(h => Number.isFinite(h) && (h < node.source.minHeight - 1 || h > node.source.maxHeight + 1))) throw new Error('Invalid measured heights')
      if (patch.gradients && (patch.gradients.length !== 2 * 65 * 65 || !patch.gradients.every(Number.isFinite))) throw new Error('Invalid terrain gradients')
      node.heights = patch.heights
      node.gradients = patch.gradients
      const started = performance.now()
      const material = new THREE.MeshStandardMaterial({ map: this.base.map, roughness: 1, metalness: 0 })
      if (this.bodyId !== 'earth') configureSurfaceMaterial(material, this.state, this.radiusMeters, 1, false, node.origin)
      else { node.color = { value: 0 }; node.colorTransform = { value: new THREE.Vector4(1, 1, 0, 0) }; configureEarthColor(material, node.color, this.fallbackColor, node.colorTransform) }
      node.mesh = new THREE.Mesh(this.geometry(node), material)
      node.edge = captureTerrainEdge(node.mesh.geometry, this.gridSize(node))
      node.sphere.copy(node.mesh.geometry.boundingSphere!)
      node.sphere.center.add(node.origin)
      node.mesh.geometry.computeBoundingBox()
      node.box = this.surfaceBox(node)
      this.edgeSignature = ''
      node.mesh.position.copy(node.origin)
      node.mesh.name = `pilot/${this.bodyId}/${this.key(node.source, node.address)}`
      {
        const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
        node.mesh.customDepthMaterial = depth
        configureTerrainDepth(depth, this.state, this.radiusMeters, false, node.origin)
      }
      node.mesh.castShadow = true; node.mesh.receiveShadow = true; node.mesh.visible = false
      this.group.add(node.mesh)
      this.buildMs += performance.now() - started
      node.meshBytes = this.geometryBytes(node)
      const actual = patch.heights.byteLength + (patch.gradients?.byteLength ?? 0) + node.meshBytes
      this.bytes += actual - node.bytes; node.bytes = actual; node.retry = 0
      this.lastUpdate = -Infinity
    } catch {
      if (!request.signal.aborted) node.retry = performance.now() + 30000
    } finally {
      clearTimeout(timeout)
      if (!node.mesh) { this.bytes -= node.bytes; node.bytes = 0; node.heights = undefined }
      node.request = undefined; this.requests--
      this.pump()
    }
  }
  hitGround(ray: THREE.Ray) {
    if (!this.group.visible) return null
    this.group.updateWorldMatrix(true, true)
    const picker = new THREE.Raycaster()
    picker.ray.copy(ray)
    return firstTerrainSurfaceHit(picker, [...this.nodes.values()].flatMap(n => n.mesh?.visible ? [n.mesh] : []))?.point ?? null
  }
  cameraSurfaceRadius(position: THREE.Vector3) {
    if (!this.enabled || !this.selected) return
    const center = this.body.getWorldPosition(new THREE.Vector3())
    const direction = position.clone().sub(center).normalize()
    const local = direction.clone().applyQuaternion(this.body.getWorldQuaternion(new THREE.Quaternion()).invert())
    const lon = THREE.MathUtils.radToDeg(Math.atan2(-local.z, local.x)), lat = THREE.MathUtils.radToDeg(Math.asin(local.y))
    const candidates = [...this.nodes.values()].filter(n => {
      if (!n.mesh) return false
      const b = n.source.bounds(n.address)
      return lon >= b.west - 1e-9 && lon <= b.east + 1e-9 && lat >= b.south - 1e-9 && lat <= b.north + 1e-9
    // Prefer drawn, stitched geometry; retain cached off-screen ground for tilt.
    }).sort((a, b) => Number(!!b.mesh?.visible) - Number(!!a.mesh?.visible) || b.address.z - a.address.z)
    if (!candidates.length) return
    this.groundNode = candidates[0]
    this.ensureGeometry(candidates[0])
    if (!candidates[0].edge) return
    this.group.updateWorldMatrix(true, true)
    const picker = new THREE.Raycaster(center.clone().addScaledVector(direction, this.radius * 2), direction.negate())
    return firstTerrainSurfaceHit(picker, [candidates[0].mesh!])?.point.distanceTo(center)
  }
  metrics(): RegionalMetrics {
    const visible = [...this.nodes.values()].filter(n => n.mesh?.visible && this.group.visible)
    return { ready: visible.length > 0, visible: visible.length, cached: [...this.nodes.values()].filter(n => n.mesh).length,
      memoryBytes: this.bytes, transferBytes: this.transferBytes, requests: this.requests, failed: [...this.nodes.values()].filter(n => n.retry > 0).length,
      decodeMs: this.decodeMs, buildMs: this.buildMs, triangles: visible.reduce((s, n) => s + n.mesh!.geometry.index!.count / 3, 0),
      sources: this.sources.map(s => s.id), grids: Object.fromEntries([33, 65, 129].map(size => [size, visible.filter(n => this.gridSize(n) === size).length])),
      maxLevel: visible.reduce((z, n) => Math.max(z, n.address.z), 0), triangleBudget: REGIONAL_TRIANGLE_BUDGET, residentMeshes: [...this.nodes.values()].filter(n => n.edge).length, imagery: this.imagery?.metrics() }
  }
  private release(node: Node) {
    node.mesh?.removeFromParent(); node.mesh?.customDepthMaterial?.dispose(); node.mesh?.geometry.dispose(); node.mesh?.material.dispose()
    node.mesh = undefined; node.heights = undefined; node.gradients = undefined; node.edge = undefined; node.meshBytes = 0; this.bytes -= node.bytes; node.bytes = 0
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true; this.deactivate()
    for (const node of this.nodes.values()) this.release(node)
    this.nodes.clear(); this.imagery?.dispose(); this.sources.forEach(s => s.dispose?.()); this.group.removeFromParent()
  }
}
