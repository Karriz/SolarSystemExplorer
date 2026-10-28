import * as THREE from 'three'
import { surfaceTileSources, tileBounds, tileChildren, type TileAddress, type TileBody, type TileBounds } from './surfaceTiles.ts'

const DEG = Math.PI / 180
const MAX_REQUESTS = 6
const MAX_BYTES = 96 * 1024 * 1024
const RETRY_MS = 30_000
type TileNode = {
  key: string
  body: TileBody
  address: TileAddress
  bounds: TileBounds
  sphere: THREE.Sphere
  bytes: number
  lastUsed: number
  retryAt: number
  mesh?: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>
  request?: AbortController
}

function direction(longitude: number, latitude: number): THREE.Vector3 {
  const phi = (longitude + 180) * DEG, theta = (90 - latitude) * DEG
  return new THREE.Vector3(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta))
}

export function tileBoundingSphere(bounds: TileBounds): THREE.Sphere {
  // Axis extrema occur at the geographic edges, equator, and cardinal
  // longitudes. Their box gives a conservative, much tighter bound than a
  // spherical cap for large patches and areas near a pole.
  const longitudes = [bounds.west, bounds.east, ...[-180, -90, 0, 90, 180]
    .filter(lon => lon > bounds.west && lon < bounds.east)]
  const latitudes = [bounds.south, bounds.north]
  if (bounds.south < 0 && bounds.north > 0) latitudes.push(0)
  const points = longitudes.flatMap(lon => latitudes.map(lat => direction(lon, lat)))
  return new THREE.Box3().setFromPoints(points).expandByScalar(.001).getBoundingSphere(new THREE.Sphere())
}

// Kept separate so the geographic mapping (including GIBS padding) is testable.
export function tileGeometry(bounds: TileBounds, zoom: number): THREE.SphereGeometry {
  const { west, east, north, south, span } = bounds
  // Maintain nested tessellation across levels to avoid cracks between patches.
  const subdivisions = Math.max(4, 2 ** Math.ceil(Math.log2(span / 2.25)))
  const step = span / subdivisions
  const geometry = new THREE.SphereGeometry(
    1.0005 + zoom * .000001,
    Math.max(3, Math.round((east - west) / step)),
    Math.max(2, Math.round((north - south) / step)),
    (west + 180) * DEG, (east - west) * DEG, (90 - north) * DEG, (north - south) * DEG,
  )
  const uv = geometry.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) {
    // SphereGeometry offsets polar UVs; for cropped image tiles keep the pole
    // inside this tile and discard the WMTS padding outside the planet bounds.
    uv.setXY(i,
      THREE.MathUtils.clamp(uv.getX(i), 0, 1) * (east - west) / span,
      1 - (1 - uv.getY(i)) * (north - south) / span,
    )
  }
  geometry.computeBoundingSphere()
  return geometry
}

/** View-dependent imagery over the existing globes. All bodies share the same
 * request and texture budget; parent imagery stays underneath pending children. */
export class GlobeTileLayer {
  private nodes = new Map<string, TileNode>()
  private groups = new Map<TileBody, THREE.Group>()
  private wanted = new Set<string>()
  private disposed = false
  private lastUpdate = -Infinity
  private bytes = 0
  private requests = 0
  private suppressedBody: string | null = null
  private anisotropy: number
  private bodies: Map<string, THREE.Mesh>

  constructor(
    bodies: Map<string, THREE.Mesh>,
    renderer: THREE.WebGLRenderer,
  ) {
    this.bodies = bodies
    this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
    for (const body of Object.keys(surfaceTileSources) as TileBody[]) {
      const mesh = bodies.get(body)
      if (!mesh) continue
      const radius = (mesh.geometry as THREE.SphereGeometry).parameters.radius
      const group = new THREE.Group()
      group.name = `${body}-surface-tiles`
      group.scale.setScalar(radius)
      mesh.add(group)
      this.groups.set(body, group)
    }
  }

  update(camera: THREE.PerspectiveCamera, viewportHeight: number, now: number, suppressedBody: string | null = null) {
    if (this.suppressedBody !== suppressedBody) { this.suppressedBody = suppressedBody; this.lastUpdate = -Infinity }
    if (this.disposed || now - this.lastUpdate < 120) return
    this.lastUpdate = now
    this.wanted.clear()
    camera.updateMatrixWorld()
    const focal = viewportHeight / (2 * Math.tan(camera.fov * DEG / 2))
    for (const [body, group] of this.groups) {
      if (body === suppressedBody) { group.visible = false; continue }
      const mesh = this.bodies.get(body)!
      mesh.updateWorldMatrix(true, true)
      const radius = group.scale.x
      const localCamera = mesh.worldToLocal(camera.position.clone()).divideScalar(radius)
      const distance = localCamera.length()
      group.visible = distance > 1 && focal * 2 / Math.max(1, distance - 1) > 32
      if (!group.visible) continue
      const normalizedWorld = group.matrixWorld
      const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4()
        .multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(normalizedWorld))
      const score = (node: TileNode): number | null => {
        if (!frustum.intersectsSphere(node.sphere)) return null
        // A surface point is above the horizon when camera.dot(point) >= 1.
        if (localCamera.dot(node.sphere.center) + distance * node.sphere.radius < 1) return null
        const nearest = Math.max(.01, localCamera.distanceTo(node.sphere.center) - node.sphere.radius)
        return focal * node.bounds.span * DEG / nearest / surfaceTileSources[body].tileSize
      }
      const want = (node: TileNode) => {
        this.wanted.add(node.key)
        node.lastUsed = now
      }
      const leaves = [0, 1].map(x => this.getNode(body, { z: 0, x, y: 0 }))
        .map(node => ({ node, score: score(node) })).filter((item): item is { node: TileNode; score: number } => item.score !== null)
      leaves.forEach(({ node }) => want(node))
      // Refine the patch with the largest visible texels first, sharing the
      // budget across both hemispheres instead of exhausting it depth-first.
      const maxLeaves = surfaceTileSources[body].tileSize === 512 ? 32 : 64
      while (leaves.length + 3 <= maxLeaves) {
        leaves.sort((a, b) => b.score - a.score)
        const next = leaves.find(item => item.score > 1.35 && item.node.address.z < surfaceTileSources[body].maxZoom)
        if (!next) break
        const children = tileChildren(surfaceTileSources[body], next.node.address)
          .map(address => this.getNode(body, address)).map(node => ({ node, score: score(node) }))
          .filter((item): item is { node: TileNode; score: number } => item.score !== null)
        if (!children.length) { next.score = 0; continue }
        leaves.splice(leaves.indexOf(next), 1, ...children)
        children.forEach(({ node }) => want(node))
      }
    }
    for (const node of this.nodes.values()) {
      const wanted = this.wanted.has(node.key)
      if (node.mesh) node.mesh.visible = false
      if (!wanted && node.request) node.request.abort()
    }
    // Replace a parent only when all its visible children have coverage. This
    // keeps loading gap-free without drawing several complete globes at once.
    const childrenOf = (node: TileNode) => tileChildren(surfaceTileSources[node.body], node.address)
      .map(address => this.nodes.get(`${node.body}/${address.z}/${address.x}/${address.y}`))
      .filter((child): child is TileNode => !!child && this.wanted.has(child.key))
    const covered = (node: TileNode): boolean => {
      if (node.mesh) return true
      const children = childrenOf(node)
      return children.length > 0 && children.every(covered)
    }
    const show = (node: TileNode) => {
      if (!this.wanted.has(node.key)) return
      const children = childrenOf(node)
      if (children.length && children.every(covered)) children.forEach(show)
      else if (node.mesh) node.mesh.visible = true
      else children.forEach(show)
    }
    for (const body of this.groups.keys()) for (const x of [0, 1]) {
      const root = this.nodes.get(`${body}/0/${x}/0`)
      if (root) show(root)
    }
    this.pump(now)
    // Metadata for abandoned regions must not grow with every pan.
    for (const [key, node] of this.nodes) {
      if (!this.wanted.has(key) && !node.mesh && !node.request && now - node.lastUsed > RETRY_MS) this.nodes.delete(key)
    }
  }

  private getNode(body: TileBody, address: TileAddress): TileNode {
    const key = `${body}/${address.z}/${address.x}/${address.y}`
    let node = this.nodes.get(key)
    if (!node) {
      const bounds = tileBounds(surfaceTileSources[body], address)!
      node = {
        key, body, address, bounds, sphere: tileBoundingSphere(bounds),
        bytes: surfaceTileSources[body].tileSize ** 2 * 4 * 4 / 3,
        lastUsed: this.lastUpdate, retryAt: 0,
      }
      this.nodes.set(key, node)
    }
    return node
  }

  private pump(now: number) {
    if (this.disposed) return
    const pending = [...this.wanted].map(key => this.nodes.get(key)!)
      .filter(node => !node.mesh && !node.request && node.retryAt <= now)
      .sort((a, b) => a.address.z - b.address.z)
    for (const node of pending) {
      if (this.requests >= MAX_REQUESTS) break
      if (!this.makeRoom(node.bytes)) break
      this.bytes += node.bytes
      this.requests++
      node.request = new AbortController()
      void this.load(node, node.request)
    }
  }

  private makeRoom(required: number): boolean {
    const unused = [...this.nodes.values()].filter(node => node.mesh && !this.wanted.has(node.key))
      .sort((a, b) => a.lastUsed - b.lastUsed)
    while (this.bytes + required > MAX_BYTES && unused.length) this.release(unused.shift()!)
    return this.bytes + required <= MAX_BYTES
  }

  private async load(node: TileNode, request: AbortController) {
    let bitmap: ImageBitmap | undefined
    let texture: THREE.Texture | undefined
    const timeout = setTimeout(() => {
      node.retryAt = performance.now() + RETRY_MS
      request.abort()
    }, 20_000)
    try {
      const response = await fetch(surfaceTileSources[node.body].url(node.address), { signal: request.signal, mode: 'cors', credentials: 'omit' })
      if (!response.ok) throw new Error(`Tile HTTP ${response.status}`)
      // ImageBitmap ignores Texture.flipY: flip during decoding instead.
      const blob = await response.blob()
      if (this.disposed || request.signal.aborted || !this.wanted.has(node.key)) return
      bitmap = await createImageBitmap(blob, { imageOrientation: 'flipY', premultiplyAlpha: 'none' })
      if (this.disposed || request.signal.aborted || !this.wanted.has(node.key)) return
      const tileSize = surfaceTileSources[node.body].tileSize
      if (bitmap.width !== tileSize || bitmap.height !== tileSize) throw new Error('Unexpected tile dimensions')
      texture = new THREE.Texture(bitmap)
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = this.anisotropy
      texture.needsUpdate = true
      const material = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0, emissive: '#ffffff', emissiveMap: texture, emissiveIntensity: .02 })
      if (node.body === 'earth') brightenOceans(material)
      node.mesh = new THREE.Mesh(tileGeometry(node.bounds, node.address.z), material)
      node.mesh.name = node.key
      // Bounds are selected explicitly; avoid testing tiny AU spheres again.
      node.mesh.frustumCulled = false
      this.groups.get(node.body)!.add(node.mesh)
      bitmap = undefined
      texture = undefined
    } catch {
      if (!request.signal.aborted) node.retryAt = performance.now() + RETRY_MS
    } finally {
      clearTimeout(timeout)
      texture?.dispose()
      bitmap?.close()
      if (!node.mesh) this.bytes -= node.bytes
      node.request = undefined
      this.requests--
      this.pump(performance.now())
    }
  }

  private release(node: TileNode) {
    if (!node.mesh) return
    const { geometry, material } = node.mesh
    node.mesh.removeFromParent()
    geometry.dispose()
    const texture = material.map!
    const bitmap = texture.image as ImageBitmap
    bitmap.close()
    texture.dispose()
    material.dispose()
    node.mesh = undefined
    this.bytes -= node.bytes
  }

  dispose() {
    this.disposed = true
    for (const node of this.nodes.values()) {
      node.request?.abort()
      this.release(node)
    }
    for (const group of this.groups.values()) group.removeFromParent()
    this.wanted.clear()
    this.nodes.clear()
  }
}

export function brightenOceans(material: THREE.MeshStandardMaterial) {
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
      #include <map_fragment>
      float oceanMask = smoothstep(0.005, 0.025, diffuseColor.b - max(diffuseColor.r, diffuseColor.g))
        * (1.0 - smoothstep(0.08, 0.25, diffuseColor.r));
      diffuseColor.rgb = mix(diffuseColor.rgb,
        max(diffuseColor.rgb, vec3(0.025, 0.095, 0.28)), oceanMask * 0.7);
    `)
  }
}
