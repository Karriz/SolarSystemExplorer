import * as THREE from 'three'
import { BRIGHT_STARS } from './brightStars.ts'

const DEG = Math.PI / 180

/** Mean obliquity of the J2000 ecliptic, matching ExplorerScene and ephemeris. */
export const J2000_OBLIQUITY_DEG = 23.43928
const OBLIQUITY = J2000_OBLIQUITY_DEG * DEG
const COS_OBL = Math.cos(OBLIQUITY)
const SIN_OBL = Math.sin(OBLIQUITY)

/** IAU 1958 / Hipparcos J2000 Galactic coordinate poles (degrees). */
export const GALACTIC_POLE_RA_DEG = 192.85948
export const GALACTIC_POLE_DEC_DEG = 27.12825
export const GALACTIC_NCP_LON_DEG = 122.93192

const BACKGROUND_STAR_COUNT = 5800

/** Convert a J2000 equatorial (ICRS) vector into the scene's right-handed
 * J2000 ecliptic frame (+X vernal equinox, +Y ecliptic north, -Z lambda 90 deg). */
export function equatorialVectorToScene(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(
    x,
    -SIN_OBL * y + COS_OBL * z,
    -COS_OBL * y - SIN_OBL * z,
  )
}

/** Convert J2000 Right Ascension and Declination (degrees) to a scene unit vector. */
export function equatorialToScene(raDeg: number, decDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const ra = raDeg * DEG, dec = decDeg * DEG
  const cosDec = Math.cos(dec)
  return equatorialVectorToScene(cosDec * Math.cos(ra), cosDec * Math.sin(ra), Math.sin(dec), out)
}

/** Orthonormal Galactic basis expressed in scene coordinates:
 * x -> Galactic Center (l=0, b=0), y -> Cygnus (l=90, b=0), z -> North Galactic Pole (b=+90). */
export function galacticBasisInScene(): { center: THREE.Vector3; east: THREE.Vector3; pole: THREE.Vector3; sceneToGalactic: THREE.Matrix3 } {
  const pole = equatorialToScene(GALACTIC_POLE_RA_DEG, GALACTIC_POLE_DEC_DEG).normalize()
  const ncp = equatorialToScene(0, 90).normalize()
  const dirNcpLon = ncp.clone().addScaledVector(pole, -ncp.dot(pole)).normalize()
  const center = dirNcpLon.clone().applyAxisAngle(pole, -GALACTIC_NCP_LON_DEG * DEG).normalize()
  const east = new THREE.Vector3().crossVectors(pole, center).normalize()
  const sceneToGalactic = new THREE.Matrix3().set(
    center.x, center.y, center.z,
    east.x, east.y, east.z,
    pole.x, pole.y, pole.z,
  )
  return { center, east, pole, sceneToGalactic }
}

/** Convert J2000 Galactic longitude and latitude (degrees) to a scene unit vector. */
export function galacticToScene(lDeg: number, bDeg: number, basis = galacticBasisInScene(), out = new THREE.Vector3()): THREE.Vector3 {
  const l = lDeg * DEG, b = bDeg * DEG
  const cosB = Math.cos(b)
  return out.set(0, 0, 0)
    .addScaledVector(basis.center, cosB * Math.cos(l))
    .addScaledVector(basis.east, cosB * Math.sin(l))
    .addScaledVector(basis.pole, Math.sin(b))
    .normalize()
}

/** Convert a stellar B-V color index to a natural, subtly tinted linear RGB color. */
export function bvToLinearRgb(bv: number): [number, number, number] {
  const clamped = Math.max(-0.35, Math.min(2.0, bv))
  // Ballesteros (2012) effective temperature approximation.
  const temp = 4600 * (1 / (0.92 * clamped + 1.7) + 1 / (0.92 * clamped + 0.62))
  const t = temp / 100
  let r: number, g: number, b: number
  if (t <= 66) {
    r = 1
    g = Math.max(0, Math.min(1, (99.4708025861 * Math.log(t) - 161.1195681661) / 255))
    b = t <= 19 ? 0 : Math.max(0, Math.min(1, (138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255))
  } else {
    r = Math.max(0, Math.min(1, (329.698727446 * Math.pow(t - 60, -0.1332047592)) / 255))
    g = Math.max(0, Math.min(1, (288.1221695283 * Math.pow(t - 60, -0.0755148492)) / 255))
    b = 1
  }
  // Restrain saturation slightly so star tints read as natural dark-sky vision.
  const mixWhite = 0.28
  const sr = r + (1 - r) * mixWhite
  const sg = g + (1 - g) * mixWhite
  const sb = b + (1 - b) * mixWhite
  const c = new THREE.Color().setRGB(sr, sg, sb, THREE.SRGBColorSpace)
  return [c.r, c.g, c.b]
}

const MILKY_WAY_VERTEX = /* glsl */`
  varying vec2 vNdc;
  void main() {
    vNdc = position.xy;
    // Full-screen clip-space quad at z=0: immune to adaptive near/far clipping
    // (at near <= 1e-6 AU, a 3D sky sphere clips triangles at the far plane).
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const MILKY_WAY_FRAGMENT = /* glsl */`
  varying vec2 vNdc;
  uniform mat3 uViewToGalactic;
  uniform vec2 uTanHalfFov;
  uniform float uVisibility;

  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(
        mix(hash31(i + vec3(0.0, 0.0, 0.0)), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x),
        f.y
      ),
      mix(
        mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x),
        f.y
      ),
      f.z
    );
  }

  float fbm4(vec3 p) {
    float sum = 0.0;
    float amp = 0.52;
    for (int i = 0; i < 4; i++) {
      sum += amp * noise3(p);
      p = p * 2.04 + vec3(17.1, -11.3, 7.7);
      amp *= 0.5;
    }
    return sum;
  }

  float sq(float x) {
    return x * x;
  }

  float cloudPatch(vec3 g, vec3 center, float radius) {
    float d = acos(clamp(dot(g, center), -0.999999, 0.999999)) / radius;
    return exp(-d * d);
  }

  void main() {
    vec3 viewRay = normalize(vec3(vNdc * uTanHalfFov, -1.0));
    vec3 g = normalize(uViewToGalactic * viewRay);
    float b = asin(clamp(g.z, -0.999999, 0.999999));
    float l = length(g.xy) > 1e-5 ? atan(g.y, g.x) : 0.0;

    // 3D noise evaluated in Galactic Cartesian space has no longitude seam or polar pinch.
    float nBroad = fbm4(g * 3.6 + vec3(1.7, -2.3, 0.9));
    float nCloud = fbm4(g * 8.8 + vec3(-3.1, 4.2, -1.4));
    float nDetail = fbm4(g * 21.0 + vec3(5.3, -1.8, 6.4));

    // Faint unresolved starlight grain, softly filtered to prevent shimmer under rotation.
    float footprint = max(length(dFdx(g)), length(dFdy(g)));
    float grainFade = 1.0 - smoothstep(0.004, 0.022, footprint);
    float grain = (noise3(g * 92.0) - 0.5) * 0.24 * grainFade;

    // Galactic plane warp and organic latitude undulation.
    float warp = 0.026 * sin(l - 0.35) + 0.032 * (nBroad - 0.5);
    float coreLon = exp(-sq(l / 0.54));
    float innerGal = 0.26 + 0.74 * pow(max(1e-5, 0.5 + 0.5 * cos(l)), 1.45);

    // Brightest star clouds: Sagittarius/Scutum, Cygnus, and Carina/Crux.
    float scutum = cloudPatch(g, normalize(vec3(0.95, 0.31, -0.03)), 0.24);
    float cygnus = cloudPatch(g, normalize(vec3(0.24, 0.97, 0.02)), 0.28);
    float carina = cloudPatch(g, normalize(vec3(0.32, -0.95, -0.02)), 0.28);
    float cloudBoost = 1.0 + 0.42 * scutum + 0.32 * cygnus + 0.26 * carina;

    // Narrow disk + wider diffuse galactic glow + central bulge.
    float diskWidth = 0.125 + 0.045 * coreLon + 0.045 * nBroad;
    float disk = exp(-sq((b - warp) / diskWidth));
    float halo = 0.26 * exp(-sq((b - warp * 0.55) / (0.31 + 0.09 * coreLon)));
    float bulge = 0.85 * coreLon * exp(-sq((b + 0.015) / 0.175));

    float mottling = (0.58 + 0.58 * nCloud + 0.26 * (nDetail - 0.5) + grain);
    float band = (disk * innerGal * cloudBoost + halo * innerGal + bulge) * max(0.0, mottling);

    // Great Rift: dark interstellar dust lane splitting the inner Milky Way from Cygnus to Scorpius.
    float riftSpan = smoothstep(-1.18, -0.35, l) * (1.0 - smoothstep(1.10, 1.78, l));
    float riftLine = 0.018 * sin(l * 2.1 + 0.5) + 0.030 * (nBroad - 0.5) + 0.022 * (nCloud - 0.5);
    float riftWidth = 0.040 + 0.024 * nCloud;
    float riftProfile = exp(-sq((b - riftLine) / riftWidth)) * riftSpan;
    float riftClumps = smoothstep(0.24, 0.72, 0.52 * nCloud + 0.48 * nDetail);
    float coalsack = cloudPatch(g, normalize(vec3(0.54, -0.84, -0.02)), 0.065) * 0.65;
    float secondaryDust = exp(-sq((b + 0.01) / 0.08)) * smoothstep(0.54, 0.82, nDetail) * 0.36;
    float dust = clamp(0.80 * riftProfile * riftClumps + coalsack + secondaryDust, 0.0, 0.86);

    float light = band * (1.0 - dust);
    // Keep high galactic latitudes strictly black so space never washes out to grey.
    light *= smoothstep(0.02, 0.12, light);

    // Subtle Large & Small Magellanic Clouds at their true southern Galactic coordinates.
    vec3 lmcDir = vec3(0.1526, -0.8256, -0.5430);
    vec3 smcDir = vec3(0.3877, -0.6012, -0.6988);
    float lmc = cloudPatch(g, lmcDir, 0.072) * (0.55 + 0.65 * nDetail);
    float smc = cloudPatch(g, smcDir, 0.040) * (0.55 + 0.65 * nDetail);

    // Natural, low-saturation dark-sky starlight palette in linear HDR radiance.
    vec3 diskTint = vec3(0.78, 0.84, 0.96);
    vec3 bulgeTint = vec3(1.00, 0.90, 0.77);
    vec3 baseColor = mix(diskTint, bulgeTint, clamp(bulge * 0.85, 0.0, 0.82));
    // Slight warm reddening along partially obscured dust edges.
    baseColor = mix(baseColor, baseColor * vec3(1.10, 0.94, 0.80), dust * 0.45);

    vec3 radiance = baseColor * light * 0.0135
      + vec3(0.76, 0.83, 0.96) * (lmc * 0.0085 + smc * 0.0060);
    radiance *= uVisibility;

    gl_FragColor = vec4(radiance, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const STAR_VERTEX = /* glsl */`
  attribute vec3 aColor;
  attribute float aMag;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vBrightness;
  varying float vHalo;

  void main() {
    // Rotate unit sky direction into view space using pure camera rotation
    // (no camera translation jitter) and project independently of near/far.
    vec3 viewDir = mat3(viewMatrix) * position;
    if (viewDir.z >= -1e-5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    float w = -viewDir.z;
    // Keep stars strictly inside the far clip plane while staying behind foreground bodies.
    gl_Position = vec4(
      viewDir.x * projectionMatrix[0][0],
      viewDir.y * projectionMatrix[1][1],
      w * 0.9999995,
      w
    );
    vColor = aColor;

    // Perceptual magnitude mapping: brightest stars pop cleanly without clipping
    // into giant blobs, while magnitude 5-6 stars remain delicate pinpoints.
    float magClamped = clamp(aMag, -1.5, 6.5);
    float flux = pow(10.0, -0.30 * (magClamped - 1.2));
    vBrightness = clamp(flux * 0.62, 0.018, 4.2);
    vHalo = 1.0 - smoothstep(-0.8, 2.2, magClamped);

    float sizeCss = mix(1.45, 6.2, pow(clamp((6.5 - magClamped) / 8.0, 1e-4, 1.0), 2.15));
    gl_PointSize = clamp(sizeCss * uPixelRatio, 1.2, 16.0);
  }
`

const STAR_FRAGMENT = /* glsl */`
  uniform float uVisibility;
  varying vec3 vColor;
  varying float vBrightness;
  varying float vHalo;

  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;

    float core = exp(-r2 * 8.2);
    float halo = vHalo * 0.22 * exp(-r2 * 2.4);
    float edge = 1.0 - smoothstep(0.72, 1.0, r2);
    float profile = (core + halo) * edge;

    vec3 rgb = vColor * vBrightness * profile * uVisibility;
    gl_FragColor = vec4(rgb, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

function buildStarGeometry(basis: ReturnType<typeof galacticBasisInScene>): THREE.BufferGeometry {
  const total = BRIGHT_STARS.length + BACKGROUND_STAR_COUNT
  const positions = new Float32Array(total * 3)
  const colors = new Float32Array(total * 3)
  const magnitudes = new Float32Array(total)
  const direction = new THREE.Vector3()

  let index = 0
  for (const [, raDeg, decDeg, mag, bv] of BRIGHT_STARS) {
    equatorialToScene(raDeg, decDeg, direction)
    positions[index * 3] = direction.x
    positions[index * 3 + 1] = direction.y
    positions[index * 3 + 2] = direction.z
    const [r, g, b] = bvToLinearRgb(bv)
    colors[index * 3] = r
    colors[index * 3 + 1] = g
    colors[index * 3 + 2] = b
    magnitudes[index] = mag
    index++
  }

  // Deterministic LCG for galactically concentrated magnitude 3.6 - 6.4 background stars.
  let seed = 421973
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-7, rand()))) * Math.cos(2 * Math.PI * rand())

  const lmcDir = galacticToScene(280.47, -32.89, basis)
  const smcDir = galacticToScene(302.81, -44.33, basis)

  for (let i = 0; i < BACKGROUND_STAR_COUNT; i++) {
    const population = rand()
    if (population < 0.012) {
      // Sparse resolved stars clustered in the Magellanic Clouds.
      const base = population < 0.008 ? lmcDir : smcDir
      const spread = population < 0.008 ? 0.045 : 0.025
      direction.copy(base).add(new THREE.Vector3(gauss() * spread, gauss() * spread, gauss() * spread)).normalize()
    } else if (population < 0.56) {
      // Galactic thin & thick disk stars concentrated toward the Milky Way plane and inner Galaxy.
      let lRad: number
      if (rand() < 0.45) {
        lRad = gauss() * 0.85
      } else {
        lRad = (rand() * 2 - 1) * Math.PI
      }
      const scaleB = population < 0.34 ? 0.12 : 0.28
      const bRad = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, gauss() * scaleB))
      galacticToScene(lRad / DEG, bRad / DEG, basis, direction)
    } else {
      // Isotropic field stars across the full celestial sphere.
      const sinB = rand() * 2 - 1
      const lRad = (rand() * 2 - 1) * Math.PI
      const bRad = Math.asin(sinB)
      galacticToScene(lRad / DEG, bRad / DEG, basis, direction)
    }

    positions[index * 3] = direction.x
    positions[index * 3 + 1] = direction.y
    positions[index * 3 + 2] = direction.z

    // Realistic steep luminosity function: far more faint stars than medium stars.
    const u = rand()
    const mag = 3.55 + Math.pow(u, 0.38) * 2.85

    // Natural spectral distribution: mix of blue-white, neutral white, and warm K/G stars.
    const spec = rand()
    const bv = spec < 0.16 ? -0.15 + rand() * 0.2
      : spec < 0.58 ? 0.05 + rand() * 0.55
      : spec < 0.90 ? 0.65 + rand() * 0.7
      : 1.35 + rand() * 0.45
    const [r, g, b] = bvToLinearRgb(bv)
    colors[index * 3] = r
    colors[index * 3 + 1] = g
    colors[index * 3 + 2] = b
    magnitudes[index] = mag
    index++
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute('aMag', new THREE.BufferAttribute(magnitudes, 1))
  return geometry
}

export class CelestialSky {
  readonly group = new THREE.Group()
  readonly milkyWay: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  readonly stars: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>
  readonly basis = galacticBasisInScene()
  private readonly viewToGalacticUniform = { value: new THREE.Matrix3() }
  private readonly tanHalfFovUniform = { value: new THREE.Vector2(0.45, 0.45) }
  private readonly visibilityUniform = { value: 1 }
  private readonly pixelRatioUniform = { value: 1 }
  private readonly cameraRotation = new THREE.Matrix3()
  private disposed = false

  constructor() {
    this.group.name = 'CelestialSky'
    this.viewToGalacticUniform.value.copy(this.basis.sceneToGalactic)

    const domeGeometry = new THREE.PlaneGeometry(2, 2)
    const domeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uViewToGalactic: this.viewToGalacticUniform,
        uTanHalfFov: this.tanHalfFovUniform,
        uVisibility: this.visibilityUniform,
      },
      vertexShader: MILKY_WAY_VERTEX,
      fragmentShader: MILKY_WAY_FRAGMENT,
      side: THREE.DoubleSide,
      transparent: false,
      depthTest: false,
      depthWrite: false,
    })
    this.milkyWay = new THREE.Mesh(domeGeometry, domeMaterial)
    this.milkyWay.name = 'MilkyWayDome'
    this.milkyWay.renderOrder = -20
    this.milkyWay.frustumCulled = false
    this.milkyWay.raycast = () => {}
    this.milkyWay.onBeforeRender = (_renderer, _scene, camera) => {
      this.syncCamera(camera)
    }

    const starGeometry = buildStarGeometry(this.basis)
    const starMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uVisibility: this.visibilityUniform,
        uPixelRatio: this.pixelRatioUniform,
      },
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
    })
    this.stars = new THREE.Points(starGeometry, starMaterial)
    this.stars.name = 'Starfield'
    // Draw before transmitting cloud/ring proxies so their alpha attenuates
    // stars, while depth testing still hides stars behind opaque globes.
    this.stars.renderOrder = -10
    this.stars.frustumCulled = false
    this.stars.raycast = () => {}

    this.group.add(this.milkyWay, this.stars)
  }

  setVisibility(visibility: number) {
    this.visibilityUniform.value = THREE.MathUtils.clamp(visibility, 0, 1)
  }

  get visibility() {
    return this.visibilityUniform.value
  }

  setPixelRatio(pixelRatio: number) {
    this.pixelRatioUniform.value = Math.max(1, pixelRatio)
  }

  syncCamera(camera: THREE.Camera) {
    camera.updateMatrixWorld()
    this.cameraRotation.setFromMatrix4(camera.matrixWorld)
    this.viewToGalacticUniform.value.multiplyMatrices(this.basis.sceneToGalactic, this.cameraRotation)
    const e = camera.projectionMatrix.elements
    if (e[0] !== 0 && e[5] !== 0) {
      this.tanHalfFovUniform.value.set(1 / e[0], 1 / e[5])
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.group.removeFromParent()
    this.milkyWay.geometry.dispose()
    this.milkyWay.material.dispose()
    this.stars.geometry.dispose()
    this.stars.material.dispose()
  }
}
