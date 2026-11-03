// Compatibility exports for existing regional terrain and material checks.
export * from './planetSurfaceMaterial.ts'
export { configurePlanetSurfaceMaterial as configureMoonSurfaceMaterial,
  configurePlanetTerrainDepth as configureMoonTerrainDepth,
  type PlanetShade as MoonShade } from './planetSurfaceMaterial.ts'
