import * as THREE from 'three'
import { rayEllipsoidInterval } from './atmosphereMath'
import { giantBodies, giantPlanetProfiles, giantBoundaryRadius, isGiantBody, AU_KM } from './giantPlanetProfiles'
import { bodyInfo, bodyOrder, orbitPathAt, planetOrder, positionAt, radiusAu, satelliteOrder, satelliteParents, satellitePeriods, parentOf, type BodyId } from './ephemeris'
import { textureSources } from './textureSources'
import { orientationAt } from './orientation'
import { constrainCamera, SURFACE_CLEARANCE } from './cameraSafety'
import { GlobeTileLayer } from './GlobeTileLayer'
import { createCameraOrbit, type BodyCameraControls } from './cameraOrbit'
import { GlobeTerrainLayer, type TerrainStatus } from './GlobeTerrainLayer'
import { CubeTerrainLayer } from './CubeTerrainLayer'
import { cubeSphereGeometry } from './cubeSphere'
import { PlanetSurfaceRenderer, type SurfaceColorStatus } from './PlanetSurfaceRenderer'
import { isSolidSurfaceBody, solidSurfaceBodies, planetRenderProfiles, type SolidSurfaceProfile, type SolidSurfaceBody } from './planetRenderProfiles'
import { terrainBodies, type TerrainBody } from './terrain'
import { RegionalTerrainLayer, type RegionalMetrics } from './RegionalTerrainLayer'
import { EarthSurfaceRenderer } from './EarthSurfaceRenderer'
import { surfaceState } from './surfaceMaterial'
import { geoDirection, pilotLocations } from './terrainPilot'
import { fitTerrainShadow } from './terrainShadows'
import { AtmosphereRenderPipeline } from './AtmosphereRenderPipeline'
import type { AtmosphereBody } from './atmosphereProfiles'

export type ScreenMarker = { id: BodyId; x: number; y: number; visible: boolean }
const DAY_MS = 86400000
const DEG = Math.PI / 180

function vector(id: BodyId, date: Date): THREE.Vector3 {
  const p = positionAt(id, date)
  return new THREE.Vector3(p.x, p.y, p.z)
}

function makeTexture(id: BodyId): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const color = id === 'venus' ? '#575552' : bodyInfo[id].color
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 512, 256)
  let seed = id.split('').reduce((a, c) => a + c.charCodeAt(0), 1)
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

  if (id === 'venus') {
    // Neutral inferred basalt remains valid while color assets load or are offline.
  } else if (id === 'earth') {
    ctx.fillStyle = '#2c6c9f'
    ctx.fillRect(0, 0, 512, 256)
    ctx.fillStyle = '#9cbd8f'
    for (let i = 0; i < 25; i++) {
      const x = rand() * 512, y = 35 + rand() * 180
      ctx.beginPath(); ctx.ellipse(x, y, 8 + rand() * 35, 4 + rand() * 19, rand() * 3, 0, Math.PI * 2); ctx.fill()
    }
    ctx.fillStyle = 'rgba(236,248,244,.65)'
    for (let i = 0; i < 22; i++) {
      ctx.beginPath(); ctx.ellipse(rand() * 512, rand() * 256, 14 + rand() * 35, 2 + rand() * 6, 0, 0, Math.PI * 2); ctx.fill()
    }
  } else {
    for (let i = 0; i < 100; i++) {
      ctx.fillStyle = rand() > .5 ? 'rgba(255,246,226,.11)' : 'rgba(43,40,39,.09)'
      ctx.beginPath(); ctx.arc(rand() * 512, rand() * 256, 1 + rand() * 10, 0, Math.PI * 2); ctx.fill()
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function makeStars(): THREE.Points {
  const count = 1200
  const positions = new Float32Array(count * 3)
  let seed = 98231
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1
    const a = rand() * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    positions[i * 3] = Math.cos(a) * s * 75
    positions[i * 3 + 1] = u * 75
    positions[i * 3 + 2] = Math.sin(a) * s * 75
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#b7d7e6', size: 0.045, transparent: true, opacity: .72, sizeAttenuation: true, depthWrite: false }))
}

export class ExplorerScene {
  readonly renderer: THREE.WebGLRenderer
  private readonly renderPipeline: AtmosphereRenderPipeline
  readonly camera: THREE.PerspectiveCamera
  controls: BodyCameraControls
  readonly scene = new THREE.Scene()
  readonly bodies = new Map<BodyId, THREE.Mesh>()
  readonly orbits: THREE.Object3D[] = []
  readonly origin = new THREE.Vector3()
  readonly stars = makeStars()
  selected: BodyId = 'sun'
  date = new Date()
  showOrbits = true
  onMarkers: (markers: ScreenMarker[]) => void
  private frame = 0
  private previousFrameTime: number | null = null
  private focusDistance: number | null = null
  private focusDirection: THREE.Vector3 | null = null
  private resizeObserver: ResizeObserver
  private container: HTMLElement
  private sunLight: THREE.PointLight
  private terrainSun = new THREE.DirectionalLight('#fff0d0', 0)
  private satelliteOrbits = new Map<BodyId, THREE.LineLoop>()
  private moonOrbitDate = 0
  private planetOrbits = new Map<BodyId, THREE.LineLoop>()
  private planetOrbitDate = 0
  private textureLoader = new THREE.TextureLoader()
  private earthSurface!: EarthSurfaceRenderer
  private planetSurfaces = new Map<SolidSurfaceBody, PlanetSurfaceRenderer>()
  private terrainHillshade = { value: 1 }
  private venusHillshade = { value: 0 }
  private disposed = false
  private surfaceTiles: GlobeTileLayer
  private terrain = new Map<TerrainBody, GlobeTerrainLayer | CubeTerrainLayer>()
  private surfaces = { earth: surfaceState(), moon: surfaceState(), mars: surfaceState(), mercury: surfaceState(), venus: surfaceState(), enceladus: surfaceState(), io: surfaceState(), europa: surfaceState(), ganymede: surfaceState(), callisto: surfaceState() }
  private regional = new Map<'earth' | 'moon', RegionalTerrainLayer>()
  private pilotMetricsKey = ''
  private onPilotStatus?: (body: 'earth' | 'moon', metrics: RegionalMetrics) => void
  private pilotAltitude: { direction: THREE.Vector3; altitude: number; until: number } | null = null
  private lastAltitudeMeters = 0
  private hitGround = (ray: THREE.Ray) => this.giantHit(ray) ?? this.regional.get(this.selected as 'earth' | 'moon')?.hitGround(ray)
    ?? this.terrain.get(this.selected as TerrainBody)?.hitGround(ray) ?? null
  private groundRadius = (position: THREE.Vector3) => this.giantRadius(this.selected, position) ?? this.regional.get(this.selected as 'earth' | 'moon')?.cameraSurfaceRadius(position)
    ?? this.terrain.get(this.selected as TerrainBody)?.cameraSurfaceRadius(position) ?? radiusAu(this.selected)
  private giantRadius(id: BodyId, position: THREE.Vector3) {
    if (!isGiantBody(id)) return undefined
    const body = this.bodies.get(id)!
    const local = position.clone().sub(body.position).applyQuaternion(body.quaternion.clone().invert())
    return giantBoundaryRadius(giantPlanetProfiles[id], local)
  }
  private giantHit(ray: THREE.Ray) {
    if (!isGiantBody(this.selected)) return null
    const body = this.bodies.get(this.selected)!, p = giantPlanetProfiles[this.selected]
    const axes = new THREE.Vector3(p.equatorialKm, p.polarKm, p.equatorialKm).divideScalar(AU_KM)
    const inverse = body.quaternion.clone().invert()
    const interval = rayEllipsoidInterval(ray.origin.clone().sub(body.position).applyQuaternion(inverse),
      ray.direction.clone().applyQuaternion(inverse), axes)
    return interval && interval[1] >= 0 ? ray.at(interval[0] >= 0 ? interval[0] : interval[1], new THREE.Vector3()) : null
  }
  private onControlStart = () => { this.focusDistance = null; this.focusDirection = null; this.pilotAltitude = null }

  constructor(container: HTMLElement, onMarkers: (markers: ScreenMarker[]) => void,
    onTerrainStatus: (status: TerrainStatus) => void = () => {}, onPilotStatus?: (body: 'earth' | 'moon', metrics: RegionalMetrics) => void,
    onColorStatus: (body: SolidSurfaceBody, status: SurfaceColorStatus) => void = () => {}) {
    this.onPilotStatus = onPilotStatus
    this.container = container
    this.onMarkers = onMarkers
    // At AU-scale close-ups, logarithmic depth loses precision in 1 + clip.w
    // and makes imagery patches flicker. Adaptive near clipping keeps ordinary
    // perspective depth precise at both globe and Solar System distances.
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.terrainSun.castShadow = true
    this.terrainSun.shadow.mapSize.set(2048, 2048)
    this.scene.add(this.terrainSun, this.terrainSun.target)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.7
    this.renderPipeline = new AtmosphereRenderPipeline(this.renderer)
    container.appendChild(this.renderer.domElement)
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.000001, 200)
    this.camera.position.set(0, 8, 19)
    this.camera.lookAt(0, 0, 0)
    this.controls = createCameraOrbit(this.camera, this.renderer.domElement, new THREE.Vector3(),
      radiusAu('sun') + SURFACE_CLEARANCE, this.onControlStart, this.hitGround, this.groundRadius)

    this.scene.add(new THREE.AmbientLight('#c5d8f0', .25))
    // Normalize brightness across orbital distances so every globe shows its solar terminator.
    this.sunLight = new THREE.PointLight('#fff0d0', 3, 0, 0)
    this.scene.add(this.sunLight)
    // Draw the background before transmitting cloud/ring proxies, so their
    // alpha attenuates stars rather than their depth simply deleting them.
    this.stars.renderOrder = -10
    this.scene.add(this.stars)
    this.createBodies()
    this.surfaceTiles = new GlobeTileLayer(this.bodies, this.renderer, new Set(['earth', ...solidSurfaceBodies]))
    const terrainUrl = new URL(import.meta.env.VITE_TERRAIN_BASE_URL || `${import.meta.env.BASE_URL}terrain/`, window.location.href).href
    for (const id of terrainBodies) {
      if (isSolidSurfaceBody(id)) {
        const surface = new PlanetSurfaceRenderer(id, this.bodies.get(id)!, this.surfaces[id],
          this.renderer, terrainUrl, id === 'venus' ? this.venusHillshade : this.terrainHillshade, onTerrainStatus, onColorStatus,
          id === 'mars' || id === 'venus' ? this.renderPipeline.atmospheres[id].lighting : undefined)
        this.planetSurfaces.set(id, surface)
        this.terrain.set(id, surface.terrain)
      } else {
        this.terrain.set(id, new GlobeTerrainLayer(this.bodies.get(id)!, onTerrainStatus,
          terrainUrl, undefined, id, undefined, this.terrainHillshade))
      }
    }
    this.earthSurface = new EarthSurfaceRenderer(this.bodies.get('earth')!, this.surfaces.earth, this.renderer, this.renderPipeline.atmosphere.lighting)
    this.regional.set('earth', this.earthSurface.terrain)
    this.regional.set('moon', new RegionalTerrainLayer(this.bodies.get('moon')!, 'moon', this.surfaces.moon))
    this.updateBodyOrientations()
    this.createOrbits()
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    this.frame = requestAnimationFrame(this.tick)
  }

  private createBodies() {
    for (const id of bodyOrder) {
      const radius = radiusAu(id)
      const geometry = isSolidSurfaceBody(id)?cubeSphereGeometry(radius):new THREE.SphereGeometry(radius, id === 'sun' ? 96 : 128, 96)
      const profile: SolidSurfaceProfile | undefined = isSolidSurfaceBody(id) ? planetRenderProfiles[id] : undefined
      if (profile?.referenceAxesMeters) {
        const axes = profile.referenceAxesMeters, position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), d = new THREE.Vector3()
        for (let i = 0; i < position.count; i++) {
          d.fromBufferAttribute(position, i).normalize()
          const radial = 1 / Math.hypot(d.x / axes[0], d.y / axes[1], d.z / axes[2])
          d.multiplyScalar(radial / 149_597_870_700)
          position.setXYZ(i, d.x, d.y, d.z)
          d.set(d.x / axes[0] ** 2, d.y / axes[1] ** 2, d.z / axes[2] ** 2).normalize()
          normal.setXYZ(i, d.x, d.y, d.z)
        }
        geometry.computeBoundingSphere(); geometry.computeBoundingBox()
      }
      const material = id === 'sun' || isGiantBody(id)
        ? new THREE.MeshBasicMaterial({ color: '#ffda87' })
        : new THREE.MeshStandardMaterial({ map: makeTexture(id), roughness: 1, metalness: 0 })
      const mesh = new THREE.Mesh(geometry, material)
      mesh.castShadow = id !== 'earth'
      mesh.receiveShadow = id !== 'earth'
      mesh.userData.bodyId = id
      this.scene.add(mesh)
      this.bodies.set(id, mesh)
      if (textureSources[id] && id !== 'earth' && !isSolidSurfaceBody(id)) this.loadSurface(id)
    }
    for (const id of giantBodies) this.renderPipeline.attachGiant(id, this.bodies.get(id)!)
    this.renderPipeline.attachSun(this.bodies.get('sun')!)
  }

  private loadSurface(id: BodyId) {
    const source = textureSources[id]!
    this.textureLoader.load(`${import.meta.env.BASE_URL}textures/${source.file}`, texture => {
      if (this.disposed) { texture.dispose(); return }
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy())
      texture.wrapS = THREE.RepeatWrapping
      // SphereGeometry's default UVs put west of 0° at u < 0.5 for our
      // right-handed scene. These NASA maps must not be flipped horizontally.
      const material = this.bodies.get(id)!.material as THREE.MeshStandardMaterial
      material.map?.dispose()
      material.map = texture
      material.emissive.set('#ffffff')
      material.emissiveMap = texture
      material.emissiveIntensity = id === 'earth' ? 0 : .02
      material.needsUpdate = true
    }, undefined, () => {
      // Keep the procedural map when an asset is unavailable.
    })
  }

  private updateBodyOrientations() {
    // Convert the NAIF J2000 equatorial axes to the scene's J2000 ecliptic axes.
    const tilt = 23.43928 * DEG
    const toScene = (v: THREE.Vector3) => new THREE.Vector3(
      v.x,
      -Math.sin(tilt) * v.y + Math.cos(tilt) * v.z,
      -Math.cos(tilt) * v.y - Math.sin(tilt) * v.z,
    )
    const equatorialNorth = new THREE.Vector3(0, 0, 1)
    for (const id of bodyOrder) {
      const angles = orientationAt(id, this.date)
      if (!angles) continue
      const ra = angles.ra * DEG, dec = angles.dec * DEG
      const poleEq = new THREE.Vector3(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec))
      const meridianEq = id === 'earth'
        ? new THREE.Vector3(Math.cos(angles.w * DEG), Math.sin(angles.w * DEG), 0)
        : new THREE.Vector3().crossVectors(equatorialNorth, poleEq).normalize().applyAxisAngle(poleEq, angles.w * DEG)
      const prime = toScene(meridianEq).normalize()
      const pole = toScene(poleEq).normalize()
      const eastBasis = new THREE.Vector3().crossVectors(prime, pole).normalize()
      const basis = new THREE.Matrix4().makeBasis(prime, pole, eastBasis)
      this.bodies.get(id)!.quaternion.setFromRotationMatrix(basis)
    }
  }

  private createOrbits() {
    for (const id of planetOrder) {
      const points = orbitPathAt(id, this.date).map(p => new THREE.Vector3(p.x, p.y, p.z))
      const geometry = new THREE.BufferGeometry().setFromPoints(points)
      const orbit = new THREE.LineLoop(geometry, new THREE.LineBasicMaterial({ color: id === 'earth' ? '#6b9fc2' : '#668092', transparent: true, opacity: id === 'earth' ? .37 : .21, depthWrite: false }))
      this.scene.add(orbit)
      this.orbits.push(orbit)
      this.planetOrbits.set(id, orbit)
    }
    this.planetOrbitDate = this.date.getTime()
    for (const id of satelliteOrder) {
      const orbit = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#b1b9c0', transparent: true, opacity: .5, depthWrite: false }))
      orbit.userData.parent = parentOf(id)
      this.scene.add(orbit)
      this.orbits.push(orbit)
      this.satelliteOrbits.set(id, orbit)
    }
    this.updateMoonOrbit()
  }

  private updateMoonOrbit() {
    if (this.moonOrbitDate && Math.abs(this.date.getTime() - this.moonOrbitDate) < DAY_MS / 2) return
    for (const [id, orbit] of this.satelliteOrbits) {
      const points: THREE.Vector3[] = []
      for (let i = 0; i < 128; i++) {
        const sampleDate = new Date(this.date.getTime() + i / 128 * satellitePeriods[id]! * DAY_MS)
        points.push(vector(id, sampleDate).sub(vector(parentOf(id), sampleDate)))
      }
      orbit.geometry.dispose()
      orbit.geometry = new THREE.BufferGeometry().setFromPoints(points)
    }
    this.moonOrbitDate = this.date.getTime()
  }

  private updatePlanetOrbits() {
    if (Math.abs(this.date.getTime() - this.planetOrbitDate) < 30 * DAY_MS) return
    for (const id of planetOrder) {
      const orbit = this.planetOrbits.get(id)!
      const points = orbitPathAt(id, this.date).map(p => new THREE.Vector3(p.x, p.y, p.z))
      orbit.geometry.dispose()
      orbit.geometry = new THREE.BufferGeometry().setFromPoints(points)
    }
    this.planetOrbitDate = this.date.getTime()
  }

  setDate(date: Date) {
    this.date = date
    this.origin.copy(vector(this.selected, date))
    this.updateBodyOrientations()
    this.updatePlanetOrbits()
    this.updateMoonOrbit()
  }
  setOrbits(visible: boolean) { this.showOrbits = visible; this.orbits.forEach(o => { o.visible = visible }) }
  setTerrain(enabled: boolean, body?: BodyId) { this.terrain.forEach((layer, id) => { if (!body || id === body) layer.setEnabled(enabled) }); this.regional.forEach((layer, id) => { if (!body || id === body) layer.setEnabled(enabled) }) }
  setTerrainExaggeration(value: number, body?: BodyId) { this.terrain.forEach((layer, id) => { if (!body || id === body) layer.setExaggeration(value) }); this.regional.forEach((layer, id) => { if (!body || id === body) layer.setExaggeration(value) }) }
  setTerrainHillshade(enabled: boolean) { this.terrainHillshade.value = enabled ? 1 : 0 }
  setAtmosphereVisible(body: AtmosphereBody, visible: boolean) {
    this.renderPipeline.atmospheres[body].enabled = visible
    if (body === 'venus') this.venusHillshade.value = visible ? 0 : 1
  }

  private surfaceSelected(id: BodyId) {
    if (id !== this.selected) return false
    // Hidden terrain does not need to stream behind an opaque cloud deck.
    return id !== 'venus' || !this.renderPipeline.atmospheres.venus.enabled
      || this.camera.position.distanceTo(this.bodies.get('venus')!.position) * 149_597_870_700 - bodyInfo.venus.radiusKm * 1000 < 100000
  }
  private terrainShadows = true
  private bodyTerrainShadows = new Map<BodyId, boolean>()
  setTerrainShadows(enabled: boolean, body?: BodyId) { if (body) this.bodyTerrainShadows.set(body, enabled); else this.terrainShadows = enabled }
  setHighResHillshade(enabled: boolean) { this.planetSurfaces.forEach(surface => { surface.hillshade.enabled.value = enabled ? 1 : 0 }) }
  setSurfaceDetail(enabled: boolean) { this.earthSurface.state.detail.value = enabled ? 1 : 0; this.planetSurfaces.forEach(surface => { surface.state.detail.value = enabled ? 1 : 0 }) }
  pilot(id: string, altitude?: number) {
    const location = pilotLocations.find(p => p.id === id)
    if (!location) return
    this.surfaceLocation(location.body, location.lat, location.lon, altitude ?? location.altitude)
  }
  surfaceLocation(body: BodyId, lat: number, lon: number, altitude = 12000) {
    if (![lat, lon, altitude].every(Number.isFinite) || lat < -90 || lat > 90 || altitude < 100) return
    this.focus(body)
    this.focusDistance = null; this.focusDirection = null
    const direction = geoDirection(lat, lon).applyQuaternion(this.bodies.get(body)!.quaternion)
    const boundary = isGiantBody(body) ? giantBoundaryRadius(giantPlanetProfiles[body], geoDirection(lat, lon), 0) : radiusAu(body)
    this.camera.position.copy(direction).multiplyScalar(boundary + Math.max(isGiantBody(body) ? 20000 : 100, altitude) / 149_597_870_700)
    this.pilotAltitude = { direction: geoDirection(lat, lon), altitude, until: performance.now() + 15000 }
    this.camera.up.set(0, 1, 0).applyQuaternion(this.bodies.get(body)!.quaternion)
    this.camera.lookAt(0, 0, 0)
    this.rebaseControls()
  }
  pilotImageSample() {
    this.renderFrame()
    const gl = this.renderer.getContext(), pixels = new Uint8Array(32 * 32 * 4)
    gl.readPixels(Math.floor(gl.drawingBufferWidth / 2)-16, Math.floor(gl.drawingBufferHeight / 2)-16, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return Array.from(pixels)
  }
  pilotMetrics() {
    // Final-frame diagnostics include HDR allocation and compatibility fallback.
    return { renderPipeline: this.renderPipeline.metrics(), surfaces: { ...Object.fromEntries([...this.planetSurfaces].map(([id, surface]) => [id, surface.metrics()])), earth: this.earthSurface.metrics() }, hillshade: Object.fromEntries([...this.planetSurfaces].map(([id, surface]) => [id, surface.hillshade.metrics()])), selected: this.selected, elevationDecoder: 'libwebp-wasm', sunElevationDegrees: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(this.camera.position.clone().normalize().dot(this.sunLight.position.clone().sub(this.bodies.get(this.selected)!.position).normalize()), -1, 1))), altitudeMeters: this.lastAltitudeMeters, classificationReady: this.earthSurface.vectors.metrics().ready, lunarSourceError: '', global: Object.fromEntries([...this.terrain].map(([id, layer]) => [id, layer.metrics()])), regional: Object.fromEntries([...this.regional].map(([id, layer]) => [id, layer.metrics()])),
      renderer: { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, textures: this.renderer.info.memory.textures, geometries: this.renderer.info.memory.geometries } }
  }

  focus(id: BodyId) {
    this.pilotAltitude = null
    this.recenterControls(isGiantBody(id) ? (giantPlanetProfiles[id].equatorialKm + 20) / AU_KM : radiusAu(id))
    this.selected = id
    this.origin.copy(vector(id, this.date))
    this.focusDirection = null
    if (id === 'earth' || id === 'enceladus' || id === 'io' || id === 'europa' || id === 'ganymede' || id === 'callisto' || isGiantBody(id)) {
      // Show the illuminated hemisphere and terminator on initial focus.
      const towardSun = vector('sun', this.date).sub(vector(id, this.date)).normalize()
      const current = this.camera.position.clone().sub(this.controls.target).normalize()
      const tangent = current.addScaledVector(towardSun, -current.dot(towardSun))
      if (tangent.lengthSq() < 1e-6) tangent.set(0, 1, 0)
      this.focusDirection = tangent.normalize().multiplyScalar(Math.sqrt(1 - .3 * .3)).addScaledVector(towardSun, .3)
    }
    const r = radiusAu(id)
    this.focusDistance = id === 'sun' ? .05 : satelliteParents[id] ? r * 7 : Math.max(r * 9, .000085)
  }

  overview() {
    this.recenterControls(radiusAu('sun'))
    this.selected = 'sun'
    this.origin.set(0, 0, 0)
    this.focusDistance = 20
    this.focusDirection = null
  }

  private recenterControls(radius: number) {
    this.camera.up.set(0, 1, 0)
    this.camera.position.sub(this.controls.target)
    this.controls.target.set(0, 0, 0)
    this.controls.minDistance = radius + SURFACE_CLEARANCE
    // Switching from a small moon close-up to a larger body must start outside
    // that body without the collision correction translating the focus target.
    const clearance = radius + SURFACE_CLEARANCE
    if (this.camera.position.length() < clearance) {
      if (this.camera.position.lengthSq() === 0) this.camera.position.set(0, 0, 1)
      this.camera.position.setLength(clearance)
    }
    this.camera.lookAt(this.controls.target)
    this.rebaseControls()
  }

  private rebaseControls() {
    const target = this.controls.target, minDistance = this.controls.minDistance
    this.controls.dispose()
    this.controls = createCameraOrbit(this.camera, this.renderer.domElement, target, minDistance, this.onControlStart, this.hitGround, this.groundRadius)
  }

  private tick = (timestamp = performance.now()) => {
    this.frame = requestAnimationFrame(this.tick)
    const deltaSeconds = this.previousFrameTime === null ? 1 / 60 : Math.min(.1, Math.max(0, (timestamp - this.previousFrameTime) / 1000))
    this.previousFrameTime = timestamp
    const target = vector(this.selected, this.date)
    this.origin.copy(target)
    for (const id of bodyOrder) {
      const mesh = this.bodies.get(id)!
      mesh.position.copy(vector(id, this.date)).sub(this.origin)
    }
    for (const orbit of this.orbits) {
      orbit.position.copy(orbit.userData.parent ? vector(orbit.userData.parent, this.date) : new THREE.Vector3()).sub(this.origin)
    }
    this.sunLight.position.copy(this.bodies.get('sun')!.position)
    if (this.focusDistance !== null) {
      const offset = this.camera.position.clone().sub(this.controls.target)
      const distance = offset.length()
      const blend = 1 - Math.pow(.935, deltaSeconds * 60)
      const next = Math.exp(THREE.MathUtils.lerp(Math.log(Math.max(distance, 1e-8)), Math.log(this.focusDistance), blend))
      if (this.focusDirection) offset.normalize().lerp(this.focusDirection, 1 - Math.pow(.955, deltaSeconds * 60)).normalize()
      this.camera.position.copy(this.controls.target).add(offset.setLength(next))
      this.camera.lookAt(this.controls.target)
      if (Math.abs(Math.log(next / this.focusDistance)) < .003 && (!this.focusDirection || offset.angleTo(this.focusDirection) < .003)) {
        this.focusDistance = null
        this.focusDirection = null
      }
    }
    this.controls.target.set(0, 0, 0)
    const selectedBody = this.bodies.get(this.selected)!
    this.controls.setBody({ id: this.selected, center: selectedBody.position,
      rotation: selectedBody.quaternion, radius: this.giantRadius(this.selected, this.camera.position) ?? radiusAu(this.selected),
      ellipsoid: isGiantBody(this.selected) ? new THREE.Vector3(giantPlanetProfiles[this.selected].equatorialKm,
        giantPlanetProfiles[this.selected].polarKm, giantPlanetProfiles[this.selected].equatorialKm).divideScalar(AU_KM) : undefined }, this.focusDistance === null)
    const now = performance.now(), viewportHeight = this.container.clientHeight * this.renderer.getPixelRatio()
    let terrainBody: TerrainBody | null = null
    for (const [id, layer] of this.terrain) {
      layer.update(this.camera, viewportHeight, now, this.surfaceSelected(id))
      if (layer.active) terrainBody = id
    }
    for (const [id, layer] of this.regional) layer.update(this.camera, viewportHeight, now, this.selected === id)
    if (this.pilotAltitude) {
      if (now > this.pilotAltitude.until) this.pilotAltitude = null
      else {
        const normal = this.pilotAltitude.direction.clone().applyQuaternion(selectedBody.quaternion)
        const ray = new THREE.Ray(normal.clone().multiplyScalar(radiusAu(this.selected) * 2), normal.clone().negate())
        const ground = this.hitGround(ray)
        if (ground) this.camera.position.copy(normal).multiplyScalar(ground.length() + this.pilotAltitude.altitude / 149_597_870_700)
      }
    }
    this.controls.update(deltaSeconds)
    // Sample after smoothed zoom has moved the camera: its footprint may
    // already be over different terrain in this frame.
    const collisionSurfaces = bodyOrder.map(id => ({
      center: this.bodies.get(id)!.position,
      radius: this.giantRadius(id, this.camera.position) ?? this.regional.get(id as 'earth' | 'moon')?.cameraSurfaceRadius(this.camera.position)
        ?? this.terrain.get(id as TerrainBody)?.cameraSurfaceRadius(this.camera.position) ?? radiusAu(id),
    }))
    const selectedSurface = collisionSurfaces[bodyOrder.indexOf(this.selected)]
    this.controls.minDistance = selectedSurface.radius + SURFACE_CLEARANCE
    const near = constrainCamera(
      this.camera.position,
      this.controls.target,
      // Orbit motion follows an arc; its straight chord can cut through the
      // selected globe even though the camera stays outside the surface.
      null,
      collisionSurfaces,
    )
    // A collision with another body must not move the selected body's pivot.
    this.controls.target.set(0, 0, 0)
    this.lastAltitudeMeters = (this.camera.position.distanceTo(selectedBody.position) - selectedSurface.radius) * 149_597_870_700
    if (Math.abs(near - this.camera.near) > this.camera.near * .01) {
      this.camera.near = near
      this.camera.updateProjectionMatrix()
    }
    this.stars.position.copy(this.camera.position)
    this.earthSurface.update(this.camera, viewportHeight, now, this.selected === 'earth')
    this.regional.get('earth')?.updateShadeCamera(this.camera)
    this.regional.get('moon')?.updateShadeCamera(this.camera)
    this.planetSurfaces.forEach((surface, id) => surface.update(this.camera, viewportHeight, now, this.surfaceSelected(id)))
    this.surfaceTiles.update(this.camera, viewportHeight, now, terrainBody)
    const closeTerrain = this.selected === 'moon' ? !!this.terrain.get('moon')?.active
      : !!this.regional.get(this.selected as 'earth' | 'moon')?.metrics().ready
    const shadowWeight = closeTerrain && (this.bodyTerrainShadows.get(this.selected) ?? this.terrainShadows) ? 1 - THREE.MathUtils.smoothstep(this.lastAltitudeMeters, 30000, 50000) : 0
    this.terrainSun.castShadow = shadowWeight > 0
    this.terrainSun.intensity = 3 * shadowWeight
    this.sunLight.intensity = 3 * (1 - shadowWeight)
    if (shadowWeight > 0) {
      const inward = selectedBody.position.clone().sub(this.camera.position).normalize()
      const ground = this.hitGround(new THREE.Ray(this.camera.position.clone(), inward))
        ?? this.camera.position.clone().addScaledVector(inward, Math.max(100, this.lastAltitudeMeters) / 149_597_870_700)
      const sunlight = this.sunLight.position.clone().sub(selectedBody.position).normalize()
      fitTerrainShadow(this.terrainSun, this.camera, ground, sunlight, this.lastAltitudeMeters,
        selectedBody.position, radiusAu(this.selected))
    }
    this.renderFrame()
    const regionalStatus = [...this.regional].map(([id, layer]) => [id, layer.metrics()] as const)
    const metricsKey = JSON.stringify(regionalStatus)
    if (metricsKey !== this.pilotMetricsKey) {
      this.pilotMetricsKey = metricsKey
      regionalStatus.forEach(([id, metrics]) => this.onPilotStatus?.(id, metrics))
    }
    const width = this.container.clientWidth, height = this.container.clientHeight
    const markers = bodyOrder.map(id => {
      const mesh = this.bodies.get(id)!
      const projected = mesh.position.clone().project(this.camera)
      const distance = this.camera.position.distanceTo(mesh.position)
      const projectedRadius = radiusAu(id) * height / (2 * Math.tan(this.camera.fov * DEG / 2) * Math.max(distance, 1e-12))
      // Once the selected globe is visible, its center label must not intercept
      // drags intended to rotate it. Tiny overview bodies keep their labels.
      const closeSelected = id === this.selected && projectedRadius > 12
      return { id, x: (projected.x * .5 + .5) * width, y: (-projected.y * .5 + .5) * height, visible: !closeSelected && projected.z > -1 && projected.z < 1 && projected.x > -1.2 && projected.x < 1.2 && projected.y > -1.2 && projected.y < 1.2 }
    })
    for (const id of satelliteOrder) {
      const parent = parentOf(id), parentMarker = markers.find(marker => marker.id === parent)!
      const marker = markers.find(marker => marker.id === id)!
      const separation = Math.hypot(marker.x - parentMarker.x, marker.y - parentMarker.y)
      const distance = this.camera.position.distanceTo(this.bodies.get(parent)!.position)
      marker.visible &&= this.selected === id || (distance < (parent === 'earth' ? .08 : .025) && separation >= 28)
    }
    this.onMarkers(markers)
  }

  private renderFrame() {
    this.renderPipeline.render(this.scene, this.camera, (['earth', 'mars', 'venus'] as const).map(id => ({
      id, date: this.date, body: this.bodies.get(id)!, sun: this.bodies.get('sun')!.position, solarColor: this.sunLight.color,
      stars: { material: this.stars.material as THREE.PointsMaterial, opacity: .72 },
    })), this.date)
  }

  private resize() {
    const width = this.container.clientWidth, height = this.container.clientHeight
    this.renderer.setSize(width, height)
    this.renderPipeline.resize()
    this.camera.aspect = width / Math.max(height, 1)
    this.camera.updateProjectionMatrix()
  }

  dispose() {
    this.disposed = true
    this.planetSurfaces.forEach(surface => surface.dispose())
    this.earthSurface.dispose()
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.regional.forEach((layer, id) => { if (id !== 'earth') layer.dispose() })
    Object.values(this.surfaces).forEach(s => s.classification.value?.dispose())
    Object.values(this.surfaces).forEach(s => s.detailMap.value?.dispose())
    Object.values(this.surfaces).forEach(s => s.mediumDetailMap.value?.dispose())
    this.surfaceTiles.dispose()
    this.terrain.forEach((layer, id) => { if (!isSolidSurfaceBody(id)) layer.dispose() })
    // Atmosphere-owned proxy meshes detach before generic scene disposal.
    this.renderPipeline.dispose()
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points || object instanceof THREE.Sprite) {
        object.geometry?.dispose()
        if (object instanceof THREE.Mesh) object.customDepthMaterial?.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        materials.forEach(material => {
          if ('map' in material && material.map instanceof THREE.Texture) material.map.dispose()
          material.dispose()
        })
      }
    })
    this.terrainSun.shadow.dispose()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
