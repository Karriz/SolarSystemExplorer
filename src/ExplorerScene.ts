import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { bodyInfo, bodyOrder, orbitPathAt, planetOrder, positionAt, radiusAu, type BodyId } from './ephemeris'
import { textureSources } from './textureSources'
import { orientationAt } from './orientation'

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
  readonly controls: OrbitControls
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
  private moonOrbit: THREE.LineLoop | null = null
  private moonOrbitDate = 0
  private planetOrbits = new Map<BodyId, THREE.LineLoop>()
  private planetOrbitDate = 0
  private saturnRings: THREE.Group | null = null
  private textureLoader = new THREE.TextureLoader()
  private disposed = false

  constructor(container: HTMLElement, onMarkers: (markers: ScreenMarker[]) => void) {
    this.container = container
    this.onMarkers = onMarkers
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.7
    container.appendChild(this.renderer.domElement)
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.000001, 200)
    this.camera.position.set(0, 8, 19)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = .18
    this.controls.mouseButtons.LEFT = THREE.MOUSE.PAN
    this.controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE
    // OrbitControls pans in proportion to camera distance for perspective views.
    this.controls.panSpeed = .85
    this.controls.minDistance = .000015
    this.controls.maxDistance = 85
    this.controls.zoomSpeed = 1.25
    this.controls.zoomToCursor = true
    this.controls.addEventListener('start', () => { this.focusDistance = null; this.focusDirection = null })

    this.scene.add(new THREE.AmbientLight('#c5d8f0', .25))
    // Normalize brightness across orbital distances so every globe shows its solar terminator.
    this.sunLight = new THREE.PointLight('#fff0d0', 3, 0, 0)
    this.scene.add(this.sunLight)
    this.scene.add(this.stars)
    this.createBodies()
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
      const geometry = new THREE.SphereGeometry(radius, id === 'sun' ? 48 : 36, 24)
      const material = id === 'sun'
        ? new THREE.MeshBasicMaterial({ color: '#ffda87' })
        : new THREE.MeshStandardMaterial({ map: makeTexture(id), roughness: 1, metalness: 0 })
      const mesh = new THREE.Mesh(geometry, material)
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
      material.map?.dispose()
      material.map = texture
      if (id === 'earth') {
        // The satellite composite's deep oceans are nearly black. Lift only blue
        // water pixels before lighting so coastlines and land colors stay intact.
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
      material.emissive.set('#ffffff')
      material.emissiveMap = texture
      material.emissiveIntensity = .02
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

  focus(id: BodyId) {
    this.recenterControls()
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
    this.controls.minDistance = r * 2.5
    this.focusDistance = id === 'sun' ? .05 : id === 'moon' ? .00012 : Math.max(r * 9, .000085)
  }

  overview() {
    this.recenterControls()
    this.selected = 'sun'
    this.origin.set(0, 0, 0)
    this.controls.minDistance = radiusAu('sun') * 2.5
    this.focusDistance = 20
    this.focusDirection = null
  }

  private recenterControls() {
    this.camera.position.sub(this.controls.target)
    this.controls.target.set(0, 0, 0)
    this.controls.update()
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
      if (Math.abs(Math.log(next / this.focusDistance)) < .003 && (!this.focusDirection || offset.angleTo(this.focusDirection) < .003)) {
        this.focusDistance = null
        this.focusDirection = null
      }
    }
    this.controls.update()
    this.stars.position.copy(this.camera.position)
    this.renderer.render(this.scene, this.camera)
    const width = this.container.clientWidth, height = this.container.clientHeight
    const markers = bodyOrder.map(id => {
      const mesh = this.bodies.get(id)!
      const projected = mesh.position.clone().project(this.camera)
      return { id, x: (projected.x * .5 + .5) * width, y: (-projected.y * .5 + .5) * height, visible: projected.z > -1 && projected.z < 1 && projected.x > -1.2 && projected.x < 1.2 && projected.y > -1.2 && projected.y < 1.2 }
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
    cancelAnimationFrame(this.frame)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    this.scene.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points || object instanceof THREE.Sprite) {
        object.geometry?.dispose()
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        materials.forEach(material => {
          if ('map' in material && material.map instanceof THREE.Texture) material.map.dispose()
          material.dispose()
        })
      }
    })
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
