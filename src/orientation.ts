import { julianDate, type BodyId } from './ephemeris'

// JPL NAIF pck00011.tpc (IAU 2015 recommendations, except Earth/Moon).
// RA and Dec are the rotation pole in J2000 equatorial coordinates; W is
// the eastward prime-meridian angle. T is centuries, d is days from J2000.
// https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc
const models: Partial<Record<BodyId, { ra: [number, number]; dec: [number, number]; w: [number, number] }>> = {
  mercury: { ra: [281.0103, -.0328], dec: [61.4155, -.0049], w: [329.5988, 6.1385108] },
  venus: { ra: [272.76, 0], dec: [67.16, 0], w: [160.20, -1.4813688] },
  moon: { ra: [269.9949, .0031], dec: [66.5392, .0130], w: [38.3213, 13.17635815] },
  mars: { ra: [317.269202, -.10927547], dec: [54.432516, -.05827105], w: [176.049863, 350.891982443297] },
  jupiter: { ra: [268.056595, -.006499], dec: [64.495303, .002413], w: [284.95, 870.536] },
  saturn: { ra: [40.589, -.036], dec: [83.537, -.004], w: [38.90, 810.7939024] },
  uranus: { ra: [257.311, 0], dec: [-15.175, 0], w: [203.81, -501.1600928] },
  neptune: { ra: [299.36, 0], dec: [43.46, 0], w: [249.978, 541.1397757] },
}

const sin = (degrees: number) => Math.sin(degrees * Math.PI / 180)
const cos = (degrees: number) => Math.cos(degrees * Math.PI / 180)

export function orientationAt(id: BodyId, date: Date): { ra: number; dec: number; w: number } | null {
  if (id === 'sun') return null
  const jd = julianDate(date)
  const d = jd - 2451545
  const t = d / 36525

  if (id === 'earth') {
    // USNO approximate Greenwich mean sidereal time. UTC substitutes for UT1.
    // https://aa.usno.navy.mil/faq/GAST
    const jd0 = Math.floor(jd - .5) + .5
    const hours = (jd - jd0) * 24
    const gmstHours = 6.697375 + .065709824279 * (jd0 - 2451545)
      + 1.0027379 * hours + .0000258 * t * t
    return { ra: 0, dec: 90, w: ((gmstHours * 15) % 360 + 360) % 360 }
  }

  const model = models[id]!
  let ra = model.ra[0] + model.ra[1] * t
  let dec = model.dec[0] + model.dec[1] * t
  let w = model.w[0] + model.w[1] * d

  if (id === 'mercury') {
    const phases = [174.7910857, 349.5821714, 164.3732571, 339.1643429, 153.9554286]
    const rates = [4.092335, 8.184670, 12.277005, 16.369340, 20.461675]
    const terms = [.01067257, -.00112309, -.00011040, -.00002539, -.00000571]
    for (let i = 0; i < phases.length; i++) w += terms[i] * sin(phases[i] + rates[i] * d)
  } else if (id === 'moon') {
    // Mean Earth/polar-axis lunar model, including NAIF's periodic terms.
    const phases = [125.045, 250.089, 260.008, 176.625, 357.529, 311.589, 134.963, 276.617, 34.226, 15.134, 119.743, 239.961, 25.053]
    const rates = [-1935.5364525, -3871.072905, 475263.3328725, 487269.629985, 35999.0509575, 964468.49931, 477198.869325, 12006.300765, 63863.5132425, -5806.6093575, 131.84064, 6003.1503825, 473327.79642]
    const raTerms = [-3.8787, -.1204, .0700, -.0172, 0, .0072, 0, 0, 0, -.0052, 0, 0, .0043]
    const decTerms = [1.5419, .0239, -.0278, .0068, 0, -.0029, .0009, 0, 0, .0008, 0, 0, -.0009]
    const wTerms = [3.5610, .1208, -.0642, .0158, .0252, -.0066, -.0047, -.0046, .0028, .0052, .0040, .0019, -.0044]
    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i] + rates[i] * t
      ra += raTerms[i] * sin(phase)
      dec += decTerms[i] * cos(phase)
      w += wTerms[i] * sin(phase)
    }
    w -= 1.4e-12 * d * d
  } else if (id === 'mars') {
    // Largest pole/precession terms from the NAIF Mars model.
    ra += .419057 * sin(79.398797 + .5042615 * t)
    dec += 1.591274 * cos(166.325722 + .5042615 * t)
    w += .584542 * sin(95.391654 + .5042615 * t)
  } else if (id === 'neptune') {
    const n = 357.85 + 52.316 * t
    ra += .70 * sin(n)
    dec -= .51 * cos(n)
    w -= .48 * sin(n)
  }
  return { ra, dec, w: ((w % 360) + 360) % 360 }
}
