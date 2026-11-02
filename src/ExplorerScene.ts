import * as THREE from 'three'
import { bodyInfo, bodyOrder, orbitPathAt, planetOrder, positionAt, radiusAu, type BodyId } from './ephemeris'
import { textureSources } from './textureSources'
import { orientationAt } from './orientation'
import { constrainCamera, SURFACE_CLEARANCE } from './cameraSafety'
import { GlobeTileLayer, brightenOceans } from './GlobeTileLayer'
import { createCameraOrbit, type BodyCameraControls } from './cameraOrbit'
import { GlobeTerrainLayer, type TerrainStatus } from './GlobeTerrainLayer'
import { terrainBodies, type TerrainBody } from './terrain'
import { RegionalTerrainLayer, type RegionalMetrics } from './RegionalTerrainLayer'
import { earthPilotSources } from './RegionalTerrainSource'
import { configureSurfaceMaterial, surfaceState } from './surfaceMaterial'
import { configureMoonSurfaceMaterial, type MoonShade } from './moonSurfaceMaterial'
import { geoDirection, pilotLocations } from './terrainPilot'
import { fitTerrainShadow } from './terrainShadows'
import { MoonVectorColor, type MoonColorMode } from './MoonVectorColor'

export type ScreenMarker = { id: BodyId; x: number; y: number; visible: boolean }
const DAY_MS = 86400000
const DEG = Math.PI / 180
const RING_NORMAL = new THREE.Vector3(0, 0, 1)

function vector(id: BodyId, date: Date): THREE.Vector3 {
  const p = positionAt(id, date)
  return new THREE.Vector3(p.x, p.y, p.z)
}

function makeTexture(id: BodyId): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const color = bodyInfo[id].color
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 512, 256)
  let seed = id.split('').reduce((a, c) => a + c.charCodeAt(0), 1)
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

  if (id === 'earth') {
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
  } else if (['jupiter', 'saturn', 'uranus', 'neptune', 'venus'].includes(id)) {
    for (let i = 0; i < 48; i++) {
      ctx.fillStyle = `rgba(${id === 'neptune' ? '211,229,255' : '255,246,220'},${0.02 + rand() * 0.1})`
      ctx.fillRect(0, rand() * 256, 512, 1 + rand() * 11)
    }
    if (id === 'jupiter') {
      ctx.fillStyle = 'rgba(171,95,69,.55)'
      ctx.beginPath(); ctx.ellipse(350, 159, 35, 13, -.1, 0, Math.PI * 2); ctx.fill()
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
  private focusDistance: number | null = null
  private focusDirection: THREE.Vector3 | null = null
  private resizeObserver: ResizeObserver
  private container: HTMLElement
  private sunLight: THREE.PointLight
  private terrainSun = new THREE.DirectionalLight('#fff0d0', 0)
  private moonOrbit: THREE.LineLoop | null = null
  private moonOrbitDate = 0
  private planetOrbits = new Map<BodyId, THREE.LineLoop>()
  private planetOrbitDate = 0
  private saturnRings: THREE.Group | null = null
  private textureLoader = new THREE.TextureLoader()
  private moonVectorColor = new MoonVectorColor()
  private moonRasterColor?: THREE.Texture
  private moonColorMode: MoonColorMode = 'raster'
  private disposed = false
  private surfaceTiles: GlobeTileLayer
  private terrain = new Map<TerrainBody, GlobeTerrainLayer>()
  private surfaces = { earth: surfaceState(), moon: surfaceState() }
  private moonShade?: MoonShade
  private regional = new Map<'earth' | 'moon', RegionalTerrainLayer>()
  private pilotMetricsKey = ''
  private onPilotStatus?: (body: 'earth' | 'moon', metrics: RegionalMetrics) => void
  private pilotAltitude: { direction: THREE.Vector3; altitude: number; until: number } | null = null
  private lastAltitudeMeters = 0
  private hitGround = (ray: THREE.Ray) => this.regional.get(this.selected as 'earth' | 'moon')?.hitGround(ray)
    ?? this.terrain.get(this.selected as TerrainBody)?.hitGround(ray) ?? null
  private onControlStart = () => { this.focusDistance = null; this.focusDirection = null; this.pilotAltitude = null }

  constructor(container: HTMLElement, onMarkers: (markers: ScreenMarker[]) => void,
    onTerrainStatus: (status: TerrainStatus) => void = () => {}, onPilotStatus?: (body: 'earth' | 'moon', metrics: RegionalMetrics) => void) {
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
    container.appendChild(this.renderer.domElement)
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.000001, 200)
    this.camera.position.set(0, 8, 19)
    this.camera.lookAt(0, 0, 0)
    this.controls = createCameraOrbit(this.camera, this.renderer.domElement, new THREE.Vector3(),
      radiusAu('sun') + SURFACE_CLEARANCE, this.onControlStart, this.hitGround)

    this.scene.add(new THREE.AmbientLight('#c5d8f0', .25))
    // Normalize brightness across orbital distances so every globe shows its solar terminator.
    this.sunLight = new THREE.PointLight('#fff0d0', 3, 0, 0)
    this.scene.add(this.sunLight)
    this.scene.add(this.stars)
    this.surfaces.earth.detail.value = 0
    this.createBodies()
    this.moonRasterColor = (this.bodies.get('moon')!.material as THREE.MeshStandardMaterial).map ?? undefined
    for (const layer of [
      { file: 'moon-detail.png', map: this.surfaces.moon.detailMap, ready: this.surfaces.moon.detailMapReady },
      { file: 'moon-medium-detail.png', map: this.surfaces.moon.mediumDetailMap, ready: this.surfaces.moon.mediumDetailReady },
    ]) this.textureLoader.load(`${import.meta.env.BASE_URL}textures/${layer.file}`, texture => {
      if (this.disposed) { texture.dispose(); return }
      texture.colorSpace = THREE.NoColorSpace
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping
      texture.minFilter = THREE.LinearMipmapLinearFilter
      texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy())
      layer.map.value = texture
      layer.ready.value = 1
    }, undefined, () => { /* Measured terrain remains usable if detail is unavailable. */ })
    this.surfaceTiles = new GlobeTileLayer(this.bodies, this.renderer, new Set(['earth', 'moon']))
    for (const id of terrainBodies) this.terrain.set(id, new GlobeTerrainLayer(this.bodies.get(id)!, onTerrainStatus,
      new URL(import.meta.env.VITE_TERRAIN_BASE_URL || `${import.meta.env.BASE_URL}terrain/`, window.location.href).href, undefined, id, id === 'moon' ? this.surfaces.moon : undefined))
    for (const id of ['earth', 'moon'] as const) this.regional.set(id, new RegionalTerrainLayer(this.bodies.get(id)!, id, this.surfaces[id]))
    earthPilotSources().forEach(source => this.regional.get('earth')!.addSource(source))
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
      const geometry = new THREE.SphereGeometry(radius, id === 'sun' ? 96 : 128, 96)
      const material = id === 'sun'
        ? new THREE.MeshBasicMaterial({ color: '#ffda87' })
        : new THREE.MeshStandardMaterial({ map: makeTexture(id), roughness: 1, metalness: 0 })
      if (id === 'earth') configureSurfaceMaterial(material, this.surfaces[id], bodyInfo[id].radiusKm * 1000, 1 / radius, true)
      if (id === 'moon') this.moonShade = configureMoonSurfaceMaterial(material, this.surfaces.moon, 149_597_870_700, true)
      const mesh = new THREE.Mesh(geometry, material)
      mesh.castShadow = id !== 'earth'
      mesh.receiveShadow = id !== 'earth'
      if (id === 'earth') {
        mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
        configureSurfaceMaterial(mesh.customDepthMaterial, this.surfaces.earth, bodyInfo.earth.radiusKm * 1000, 1 / radius, true)
      }
      if (id === 'moon' && this.moonShade) {
        mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking })
        configureMoonSurfaceMaterial(mesh.customDepthMaterial, this.surfaces.moon, 149_597_870_700, true, new THREE.Vector3(), this.moonShade.camera)
      }
      mesh.userData.bodyId = id
      this.scene.add(mesh)
      this.bodies.set(id, mesh)
      if (textureSources[id]) this.loadSurface(id)
    }
    this.createSaturnRings()
    const sunGlowCanvas = document.createElement('canvas')
    sunGlowCanvas.width = sunGlowCanvas.height = 128
    const ctx = sunGlowCanvas.getContext('2d')!
    const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 64)
    gradient.addColorStop(0, 'rgba(255,222,151,.8)')
    gradient.addColorStop(.23, 'rgba(255,177,96,.28)')
    gradient.addColorStop(1, 'rgba(255,166,89,0)')
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128)
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(sunGlowCanvas), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }))
    glow.scale.setScalar(.1)
    this.bodies.get('sun')!.add(glow)
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
      if (id === 'moon') {
        this.moonRasterColor?.dispose()
        this.moonRasterColor = texture
        // A palette can finish loading before the original JPEG arrives.
        if (this.moonColorMode !== 'raster') return
      }
      if (id !== 'moon') material.map?.dispose()
      material.map = texture
      if (id === 'earth') {
        // The satellite composite's deep oceans are nearly black. Lift only blue
        // water pixels before lighting so coastlines and land colors stay intact.
        brightenOceans(material)
      }
      material.emissive.set('#ffffff')
      material.emissiveMap = texture
      material.emissiveIntensity = id === 'earth' || id === 'moon' ? 0 : .02
      material.needsUpdate = true
    }, undefined, () => {
      // Keep the procedural map when an asset is unavailable.
    })
  }

  private createSaturnRings() {
    const rings = new THREE.Group()
    const kmToAu = radiusAu('saturn') / bodyInfo.saturn.radiusKm
    // NASA ring radii: C, B, and A rings. The gap between B and A is the Cassini Division.
    for (const [innerKm, outerKm, color, opacity] of [
      [74658, 91975, '#a8a49c', .35],
      [91975, 117507, '#e5d4b2', .78],
      [122340, 136780, '#cdb991', .68],
    ] as const) {
      rings.add(new THREE.Mesh(
        new THREE.RingGeometry(innerKm * kmToAu, outerKm * kmToAu, 128),
        new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity, depthWrite: false }),
      ))
    }
    this.scene.add(rings)
    this.saturnRings = rings
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
      if (id === 'saturn') this.saturnRings?.quaternion.setFromUnitVectors(RING_NORMAL, pole)
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
    const moonOrbit = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#b1b9c0', transparent: true, opacity: .5 }))
    moonOrbit.userData.moonOrbit = true
    this.scene.add(moonOrbit)
    this.orbits.push(moonOrbit)
    this.moonOrbit = moonOrbit
    this.updateMoonOrbit()
  }

  private updateMoonOrbit() {
    if (!this.moonOrbit || Math.abs(this.date.getTime() - this.moonOrbitDate) < DAY_MS / 2) return
    const points: THREE.Vector3[] = []
    for (let i = 0; i < 128; i++) {
      const sampleDate = new Date(this.date.getTime() + i / 128 * 27.321661 * DAY_MS)
      points.push(vector('moon', sampleDate).sub(vector('earth', sampleDate)))
    }
    this.moonOrbit.geometry.dispose()
    this.moonOrbit.geometry = new THREE.BufferGeometry().setFromPoints(points)
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
  setTerrain(enabled: boolean) { this.terrain.forEach(layer => layer.setEnabled(enabled)); this.regional.forEach(layer => layer.setEnabled(enabled)) }
  setTerrainExaggeration(value: number) { this.terrain.forEach(layer => layer.setExaggeration(value)); this.regional.forEach(layer => layer.setExaggeration(value)) }
  private terrainShadows = true
  setTerrainShadows(enabled: boolean) { this.terrainShadows = enabled }
  setSurfaceDetail(enabled: boolean) { this.surfaces.moon.detail.value = enabled ? 1 : 0 }
  previewMoonBoundary() {
    const point = this.moonVectorColor.previewPoint()
    if (point) this.surfaceLocation('moon', point.lat, point.lon, 12000)
  }
  async setMoonColor(mode: MoonColorMode): Promise<boolean> {
    const material = this.bodies.get('moon')!.material as THREE.MeshStandardMaterial
    if (mode === 'raster') {
      this.moonVectorColor.cancel()
      material.map = this.moonRasterColor ?? material.map
      material.emissiveMap = material.map
      material.needsUpdate = true
      this.moonVectorColor.replace()
      this.moonColorMode = mode
      this.surfaces.moon.colorSharpen.value = 1
      return true
    }
    const texture = await this.moonVectorColor.load(mode)
    if (!texture) return false
    material.map = texture
    material.emissiveMap = texture
    material.needsUpdate = true
    this.moonVectorColor.replace(texture)
    this.moonColorMode = mode
    this.surfaces.moon.colorSharpen.value = 0
    return true
  }
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
    this.camera.position.copy(direction).multiplyScalar(radiusAu(body) + altitude / 149_597_870_700)
    this.pilotAltitude = { direction: geoDirection(lat, lon), altitude, until: performance.now() + 15000 }
    this.camera.up.set(0, 1, 0).applyQuaternion(this.bodies.get(body)!.quaternion)
    this.camera.lookAt(0, 0, 0)
    this.rebaseControls()
  }
  pilotImageSample() {
    this.renderer.render(this.scene, this.camera)
    const gl = this.renderer.getContext(), pixels = new Uint8Array(32 * 32 * 4)
    gl.readPixels(Math.floor(gl.drawingBufferWidth / 2)-16, Math.floor(gl.drawingBufferHeight / 2)-16, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return Array.from(pixels)
  }
  pilotMetrics() {
    return { selected: this.selected, elevationDecoder: 'libwebp-wasm', sunElevationDegrees: THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(this.camera.position.clone().normalize().dot(this.sunLight.position.clone().sub(this.bodies.get(this.selected)!.position).normalize()), -1, 1))), altitudeMeters: this.lastAltitudeMeters, classificationReady: this.surfaces.earth.hasClassification.value > 0, lunarSourceError: '', global: Object.fromEntries([...this.terrain].map(([id, layer]) => [id, layer.metrics()])), regional: Object.fromEntries([...this.regional].map(([id, layer]) => [id, layer.metrics()])),
      renderer: { calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, textures: this.renderer.info.memory.textures, geometries: this.renderer.info.memory.geometries } }
  }

  focus(id: BodyId) {
    this.pilotAltitude = null
    this.recenterControls(radiusAu(id))
    this.selected = id
    this.origin.copy(vector(id, this.date))
    this.focusDirection = null
    if (id === 'earth') {
      // Show both the illuminated ocean and the terminator on initial focus.
      const towardSun = vector('sun', this.date).sub(vector(id, this.date)).normalize()
      const current = this.camera.position.clone().sub(this.controls.target).normalize()
      const tangent = current.addScaledVector(towardSun, -current.dot(towardSun))
      if (tangent.lengthSq() < 1e-6) tangent.set(0, 1, 0)
      this.focusDirection = tangent.normalize().multiplyScalar(Math.sqrt(1 - .3 * .3)).addScaledVector(towardSun, .3)
    }
    const r = radiusAu(id)
    this.focusDistance = id === 'sun' ? .05 : id === 'moon' ? .00012 : Math.max(r * 9, .000085)
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
    this.controls = createCameraOrbit(this.camera, this.renderer.domElement, target, minDistance, this.onControlStart, this.hitGround)
  }

  private tick = () => {
    this.frame = requestAnimationFrame(this.tick)
    const target = vector(this.selected, this.date)
    this.origin.copy(target)
    for (const id of bodyOrder) {
      const mesh = this.bodies.get(id)!
      mesh.position.copy(vector(id, this.date)).sub(this.origin)
    }
    this.saturnRings?.position.copy(this.bodies.get('saturn')!.position)
    for (const orbit of this.orbits) {
      orbit.position.copy(orbit.userData.moonOrbit ? vector('earth', this.date) : new THREE.Vector3()).sub(this.origin)
    }
    this.sunLight.position.copy(this.bodies.get('sun')!.position)
    if (this.focusDistance !== null) {
      const offset = this.camera.position.clone().sub(this.controls.target)
      const distance = offset.length()
      const next = Math.exp(Math.log(Math.max(distance, 1e-8)) * .935 + Math.log(this.focusDistance) * .065)
      if (this.focusDirection) offset.normalize().lerp(this.focusDirection, .045).normalize()
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
      rotation: selectedBody.quaternion, radius: radiusAu(this.selected) }, this.focusDistance === null)
    const now = performance.now(), viewportHeight = this.container.clientHeight * this.renderer.getPixelRatio()
    let terrainBody: TerrainBody | null = null
    for (const [id, layer] of this.terrain) {
      layer.update(this.camera, viewportHeight, now, this.selected === id)
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
    const collisionSurfaces = bodyOrder.map(id => ({
      center: this.bodies.get(id)!.position,
      radius: this.regional.get(id as 'earth' | 'moon')?.cameraSurfaceRadius(this.camera.position)
        ?? this.terrain.get(id as TerrainBody)?.cameraSurfaceRadius(this.camera.position) ?? radiusAu(id),
    }))
    this.lastAltitudeMeters = (this.camera.position.distanceTo(selectedBody.position) - collisionSurfaces[bodyOrder.indexOf(this.selected)].radius) * 149_597_870_700
    this.controls.minDistance = collisionSurfaces[bodyOrder.indexOf(this.selected)].radius + SURFACE_CLEARANCE
    this.controls.update()
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
    if (Math.abs(near - this.camera.near) > this.camera.near * .01) {
      this.camera.near = near
      this.camera.updateProjectionMatrix()
    }
    this.stars.position.copy(this.camera.position)
    this.terrain.get('moon')?.updateShadeCamera(this.camera)
    this.regional.get('moon')?.updateShadeCamera(this.camera)
    const moonBody = this.bodies.get('moon')
    if (this.moonShade && moonBody) {
      moonBody.updateWorldMatrix(true, false)
      this.moonShade.camera.value.copy(moonBody.worldToLocal(this.camera.position.clone()))
    }
    if (moonBody) this.moonVectorColor.updateView(this.camera, moonBody, this.surfaces.moon,
      this.selected === 'moon', this.hitGround, now)
    this.surfaceTiles.update(this.camera, viewportHeight, now, this.selected === 'moon' ? 'moon' : this.selected === 'earth' && this.surfaces.earth.clipCount.value > 0 ? 'earth' : terrainBody)
    const closeTerrain = this.selected === 'moon' ? !!this.terrain.get('moon')?.active
      : !!this.regional.get(this.selected as 'earth' | 'moon')?.metrics().ready
    const shadowWeight = closeTerrain && this.terrainShadows ? 1 - THREE.MathUtils.smoothstep(this.lastAltitudeMeters, 30000, 50000) : 0
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
    this.renderer.render(this.scene, this.camera)
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
    const earthMarker = markers.find(marker => marker.id === 'earth')!
    const moonMarker = markers.find(marker => marker.id === 'moon')!
    const moonSeparation = Math.hypot(moonMarker.x - earthMarker.x, moonMarker.y - earthMarker.y)
    const earthDistance = this.camera.position.distanceTo(this.bodies.get('earth')!.position)
    moonMarker.visible &&= this.selected === 'moon' || (earthDistance < 0.08 && moonSeparation >= 28)
    this.onMarkers(markers)
  }

  private resize() {
    const width = this.container.clientWidth, height = this.container.clientHeight
    this.renderer.setSize(width, height)
    this.camera.aspect = width / Math.max(height, 1)
    this.camera.updateProjectionMatrix()
  }

  dispose() {
    this.disposed = true
    this.moonVectorColor.dispose()
    this.moonRasterColor?.dispose()
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.regional.forEach(layer => layer.dispose())
    Object.values(this.surfaces).forEach(s => s.classification.value?.dispose())
    Object.values(this.surfaces).forEach(s => s.detailMap.value?.dispose())
    Object.values(this.surfaces).forEach(s => s.mediumDetailMap.value?.dispose())
    this.surfaceTiles.dispose()
    this.terrain.forEach(layer => layer.dispose())
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
