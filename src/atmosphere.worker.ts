import { buildAtmosphereTables } from './atmosphereOptics.ts'
import type { AtmosphereProfile } from './atmosphereProfiles.ts'

self.onmessage = (event: MessageEvent<AtmosphereProfile>) => {
  const tables = buildAtmosphereTables(event.data)
  self.postMessage(tables, { transfer: [tables.transmittance.buffer, tables.multiple.buffer, tables.irradiance.buffer] })
}
