// JPL approximate planetary elements, valid 1800–2050. Units: AU and degrees.
// Source: https://ssd.jpl.nasa.gov/planets/approx_pos.html
export type BodyId = 'sun' | 'mercury' | 'venus' | 'earth' | 'moon' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune'
export type Vec3 = { x: number; y: number; z: number }
type Elements = { base: number[]; rate: number[] }

const DEG = Math.PI / 180
const AU_KM = 149_597_870.7
export const bodyInfo: Record<BodyId, { name: string; kind: string; radiusKm: number; color: string; description: string }> = {
  sun: { name: 'Sun', kind: 'STAR', radiusKm: 695700, color: '#ffc96b', description: 'The star at the center of our Solar System.' },
  mercury: { name: 'Mercury', kind: 'TERRESTRIAL PLANET', radiusKm: 2439.7, color: '#b4aaa0', description: 'A small, cratered world closest to the Sun.' },
  venus: { name: 'Venus', kind: 'TERRESTRIAL PLANET', radiusKm: 6051.8, color: '#e2bb83', description: 'A rocky planet wrapped in dense clouds.' },
  earth: { name: 'Earth', kind: 'TERRESTRIAL PLANET', radiusKm: 6371, color: '#5b9dda', description: 'Our home world, with oceans and life.' },
  moon: { name: 'Moon', kind: 'NATURAL SATELLITE', radiusKm: 1737.4, color: '#bdbbb6', description: 'Earth’s natural satellite and the first world humans visited.' },
  mars: { name: 'Mars', kind: 'TERRESTRIAL PLANET', radiusKm: 3389.5, color: '#dc8063', description: 'The red planet, home to giant volcanoes and ancient riverbeds.' },
  jupiter: { name: 'Jupiter', kind: 'GAS GIANT', radiusKm: 69911, color: '#d5a886', description: 'The largest planet in the Solar System.' },
  saturn: { name: 'Saturn', kind: 'GAS GIANT', radiusKm: 58232, color: '#dec99d', description: 'A gas giant known for its broad ring system.' },
  uranus: { name: 'Uranus', kind: 'ICE GIANT', radiusKm: 25362, color: '#a7d8df', description: 'An ice giant with an extreme axial tilt.' },
  neptune: { name: 'Neptune', kind: 'ICE GIANT', radiusKm: 24622, color: '#7095d7', description: 'A distant ice giant with fast-moving winds.' },
}

export const bodyOrder: BodyId[] = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']
export const planetOrder: BodyId[] = bodyOrder.filter(id => id !== 'sun' && id !== 'moon')

// Columns: semimajor axis, eccentricity, inclination, mean longitude,
// longitude of perihelion, longitude of ascending node.
const elements: Record<string, Elements> = {
  mercury: { base: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593], rate: [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081] },
  venus: { base: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255], rate: [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418] },
  earth: { base: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0], rate: [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0] },
  mars: { base: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891], rate: [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343] },
  jupiter: { base: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909], rate: [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106] },
  saturn: { base: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448], rate: [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794] },
  uranus: { base: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503], rate: [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589] },
  neptune: { base: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574], rate: [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664] },
}

export function julianDate(date: Date): number { return date.getTime() / 86400000 + 2440587.5 }
export function radiusAu(id: BodyId): number { return bodyInfo[id].radiusKm / AU_KM }

function planetPosition(id: BodyId, date: Date, phase = 0): Vec3 {
  const entry = elements[id]
  const t = (julianDate(date) - 2451545) / 36525
  const [a, e, inclination, longitude, perihelion, node] = entry.base.map((v, i) => v + entry.rate[i] * t)
  const meanAnomaly = ((longitude - perihelion) % 360) * DEG + phase
  let eccentricAnomaly = meanAnomaly
  for (let i = 0; i < 12; i++) {
    const delta = (eccentricAnomaly - e * Math.sin(eccentricAnomaly) - meanAnomaly) / (1 - e * Math.cos(eccentricAnomaly))
    eccentricAnomaly -= delta
    if (Math.abs(delta) < 1e-12) break
  }
  const xp = a * (Math.cos(eccentricAnomaly) - e)
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(eccentricAnomaly)
  const omega = (perihelion - node) * DEG
  const ascending = node * DEG
  const inc = inclination * DEG
  const x = (Math.cos(omega) * Math.cos(ascending) - Math.sin(omega) * Math.sin(ascending) * Math.cos(inc)) * xp + (-Math.sin(omega) * Math.cos(ascending) - Math.cos(omega) * Math.sin(ascending) * Math.cos(inc)) * yp
  // Scene axes are right-handed: +Y is ecliptic north, so conventional
  // ecliptic +Y maps to scene -Z.
  const z = -((Math.cos(omega) * Math.sin(ascending) + Math.sin(omega) * Math.cos(ascending) * Math.cos(inc)) * xp + (-Math.sin(omega) * Math.sin(ascending) + Math.cos(omega) * Math.cos(ascending) * Math.cos(inc)) * yp)
  const y = Math.sin(omega) * Math.sin(inc) * xp + Math.cos(omega) * Math.sin(inc) * yp
  return { x, y, z }
}

// Trace one orbit using the same elements and epoch as the planet marker.
// The first point is exactly the planet's current calculated position.
export function orbitPathAt(id: BodyId, date: Date, samples = 240): Vec3[] {
  return Array.from({ length: samples }, (_, i) => planetPosition(id, date, 2 * Math.PI * i / samples))
}

// The lunar model is a simple inclined circular orbit for this first visual prototype.
function moonOffset(date: Date): Vec3 {
  const days = julianDate(date) - 2451545
  const phase = (218.316 + 360 * days / 27.321661) * DEG
  const node = (125.08 - 0.052954 * days) * DEG
  const inc = 5.145 * DEG
  const r = 384400 / AU_KM
  return {
    x: r * (Math.cos(node) * Math.cos(phase) - Math.sin(node) * Math.sin(phase) * Math.cos(inc)),
    y: r * Math.sin(phase) * Math.sin(inc),
    z: -r * (Math.sin(node) * Math.cos(phase) + Math.cos(node) * Math.sin(phase) * Math.cos(inc)),
  }
}

export function positionAt(id: BodyId, date: Date): Vec3 {
  if (id === 'sun') return { x: 0, y: 0, z: 0 }
  if (id === 'moon') {
    const earth = planetPosition('earth', date)
    const offset = moonOffset(date)
    return { x: earth.x + offset.x, y: earth.y + offset.y, z: earth.z + offset.z }
  }
  return planetPosition(id, date)
}
