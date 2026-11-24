# Titan

Titan uses the shared solid-body renderer and dense-atmosphere transport
pipeline beneath Saturn alongside Enceladus, completing all six major moons in
the [major-moons review](major-moons-data-review.md). Global terrain, inferred
neutral-light ground color, and Titan's layered nitrogen-tholin haze atmosphere
are complete.

## Sources and observed coverage

All five downloaded official source products total approximately **37.5 MB**
and are checksum-pinned in `scripts/fetch-titan.py`:

- **Corlies et al. (2017) global Titan topography archive**
  (`titan_topo_corlies.zip`, 27.5 MB, [doi:10.1002/2017GL075518](https://doi.org/10.1002/2017GL075518)),
  containing the global 4 PPD interpolated topography (`topo_4PPD_interp.cub`)
  plus three 32 PPD (~1.4 km) measured Cassini RADAR tracks: altimetry
  (`alt_32PPD.cub`), stereo/SAR DTM (`dtm_32PPD.cub`), and SARTopo
  (`sar_32PPD.cub`). Combined 32 PPD measurements cover **8.67%** of Titan's
  spherical surface area.
- **Cassini ISS 4 km global 938 nm mosaic** (`Titan_ISS_P19658_Mosaic_Global_4km.tif`,
  8.17 MB, PIA19658) plus PDS3 label, providing global methane-window surface
  geography.
- **IAU / USGS Titan planetary nomenclature**
  (`TITAN_nomenclature_center_pts.zip` and `TITAN_nomenclature_geometries.zip`),
  supplying named hydrocarbon lakes, islands, mountain ranges (Mithrim Montes,
  Doom Mons), labyrinths, dune fields, and eroded impact craters (Menrva, Selk,
  Sinlap). Five-vertex rectangular bounding-box placeholders in the shapefile
  are explicitly excluded.

## Terrain and measured provenance

All elevations are referenced to Corlies et al.'s **2,575.0 km** reference
sphere; Corlies heights already include Titan's physical flattening and geoid
relief (explaining why polar sea basins sit near `-1,088 m` while equatorial
highlands rise above `+1,000 m`). Authoritative 32 PPD tracks are merged in
precision priority order (`alt_32PPD` → `dtm_32PPD` → `sar_32PPD`) over the
4 PPD global interpolation, with measured interiors preserved identically and
outer ~4 km track edges feathered cleanly.

Only in unmeasured gaps (`91.33%`), conservative seeded landforms (seed `606`)
add subtle equatorial dune undulations, icy mountain ridges, dissected
labyrinths, eroded sediment-filled craters, coastal bluffs, and flat polar sea
basins. Image brightness is never interpreted as elevation.

The prepared `16,384 × 8,192` Float32 raster spans **-1,992.2 m to +1,125.9 m**
and is baked into 10,922 immutable geographic height tiles (`129 × 129` Int16,
1 m quantization, levels 0–6, ~988 m equatorial delivery spacing).
`titan-terrain-coverage.png` records the exact Cassini 32 PPD measured track
footprints (`8.67%`).

## Layered haze atmosphere and ground color

Titan's atmosphere uses the shared `dense-transport` discrete-ordinate solver
(`src/atmosphereProfiles.ts`, `titanAtmosphere`), configured specifically for
Titan rather than copying Venus cloud parameters:

- **360 km atmosphere** with nitrogen Rayleigh scattering (40 km scale height,
  vertical optical depth `~0.18 / 0.42 / 1.04` RGB) and a main stratospheric
  tholin haze deck (`55–245 km`, strong blue absorption, `albedo: [0.968, 0.895, 0.64]`,
  `g = 0.68`).
- **Orbital and surface appearance:** By default, dense golden-orange tholin
  haze obscures the ground from orbit (`< 1.2%` direct red transmission,
  `< 0.03%` blue) with a faint bluish Rayleigh upper-limb fringe above 250 km.
  Descending beneath the haze (below 280 km altitude) streams ground terrain
  under warm amber diffuse Huygens-like illumination. A **Reveal surface**
  toggle in the info panel hides the haze for scientific ground inspection.
- **Inferred neutral-light ground color (`3.96 MB` lossless WebP + PNG fallback):**
  Atmosphere orange is kept strictly in the atmosphere shader, not baked into
  ground albedo. Cassini ISS 938 nm brightness and real polar sea shorelines
  (Kraken Mare, Ligeia Mare, Punga Mare, Ontario Lacus, plus true multi-vertex
  lakes) map to muted neutral-light icy highlands (Xanadu), dark organic dune
  fields (Belet, Senkyo, Fensal, Shangri-La), and very dark charcoal-slate
  liquid hydrocarbon seas. A dedicated liquid hydrocarbon shader
  (`src/liquidSurfaceMaterial.ts`, driven by `public/textures/titan-liquid-mask.png`)
  renders mapped seas and lakes (Kraken Mare, Ligeia Mare, Punga Mare, Ontario
  Lacus and true multi-vertex polar lakes) with radial flat normals, low specular
  roughness (`0.14`) for specular Sun glints, and subtle animated capillary
  ripples at close range while suppressing rocky cobble detail over liquid.
  Separate 512 × 512 fluvial-eroded cobble/sediment
  textures (`titan-detail.png`, `titan-medium-detail.png`) provide shading-only
  close-range detail.

## Orbit and rotation

Rotation uses [NAIF PCK00011](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc)
`BODY606` pole and prime-meridian constants. The visual orbit is a mean circular
Saturn-relative orbit at 1,221,870 km anchored to a JPL Horizons J2000 state;
because Titan's real orbital eccentricity is `0.0288`, the circular visual
model stays within ~81,000 km (~6.6% of orbital radius) across 1900–2049.

## Rebuild and preserve

```sh
npm run titan:fetch
npm run titan:prepare
npm run titan:build-terrain
npm run titan:build-hillshade
sh scripts/terrain-python.sh scripts/validate-global-hillshade.py --bodies titan
npm run titan:check-source
# On a host with Playwright Chromium libraries installed (with Vite on port 5175):
npm run titan:check -- --fast-stream --part=surface
npm run titan:check -- --fast-stream --part=navigation
```

Keep `.terrain-cache/titan/` for offline rebuilding; preserve the Git-ignored
`public/terrain/titan/` and `public/hillshade/titan/` releases alongside the
other planetary releases.

The active prepared assets total **124.62 MB** (118.84 MiB): **109.81 MB** of
terrain tiles and metadata, **4.16 MB** of 1 km hillshade pages, and
**10.64 MB** of color, fallback, detail, and provenance files.

## Validation

- **Unit tests & production build:** All **183 unit tests** (`npm test`,
  including Titan dense-haze flux conservation `maxEnergyError = 1.43e-7`,
  orbital obscuration, amber ground irradiance, JPL Horizons orbit envelope,
  NAIF orientation, and cube-sphere terrain lifecycle) and the lean production
  build (`npm run build:app`) passed.
- **Terrain & hillshade integrity:** `build-terrain.py` validated all 10,922
  tiles (hashes, bounds, seams, poles, parent alignment).
  `validate-global-hillshade.py` validated all 1,432 hillshade pages with **zero
  shared-gutter seam code error**.
- **Independent Corlies 32 PPD source checks (`titan:check-source`):** 12
  independent controls inside measured `dtm_32PPD.cub` interiors matched
  delivered tiles with **2.58 m median error** (max `40.4 m` on one steep
  coastal cliff under double bilinear resampling); verified polar convergence
  and Xanadu vs. Belet dunes vs. Ligeia Mare color registration.
- **Visual inspection:** Inspected `titan-color-reference.png`,
  `titan-terrain-coverage.png`, and north/south polar azimuthal renders to
  confirm organic hydrocarbon sea/lake shorelines (after excluding IAU
  bounding-box placeholders) and clean polar continuity. Live Chromium
  Playwright checks (`npm run titan:check`) remain to run on a host with
  `libnspr4.so` / Chrome available.
