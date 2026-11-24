# Callisto

Callisto uses the shared solid-body renderer and appears beneath Jupiter
alongside Io, Europa and Ganymede, completing all four Galilean moons. Global
color and terrain are complete; completeness includes reconstruction and does
not imply a global measured DEM.

## Sources and observed coverage

No global or public regional stereo DEM is currently distributed for Callisto
on USGS STAC or NASA Trek. Instead, global terrain is constrained by the
official [IAU / USGS Gazetteer of Planetary Nomenclature for Callisto](https://planetarynames.wr.usgs.gov/GIS_Downloads),
combined with published Callisto icy-crater morphometry (Schenk, 2002; Bray &
Schenk, 2024) and seeded ancient cratered plains. Measured numeric elevation
support is explicitly recorded as **0.0%** (`measuredElevationFraction: 0.0`).

All five downloaded official source products total approximately **115.7 MB**
and are checksum-pinned in `scripts/fetch-callisto.py`:

- **1 km global monochrome mosaic** (`Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif`,
  114.6 MB) plus PDS3 label (`_pds3.lbl`), public domain, providing global
  geography on its 2,409.3 km projection sphere.
- **IAU / USGS Callisto nomenclature center points & geometries**
  (`CALLISTO_nomenclature_center_pts.zip` and
  `CALLISTO_nomenclature_geometries_internal.zip`), supplying exact coordinates,
  diameters and geometries for **4 giant multi-ring basins** (Valhalla, Asgard,
  Adlinda, Utgard), **141 named impact craters** (including Heimdall 210 km,
  Lofn 200 km, Bran, Burr, Tindr), and **8 crater chains / catenae** (including
  Gipul Catena 641 km and Gomul Catena 343 km).
- **Galileo natural-color global mosaic** (`PIA03456.jpg`, 74 KB), used strictly
  as a visible-color appearance constraint.

## Nomenclature-constrained global terrain

All elevations are referenced to the [IAU 2015 / NAIF pck00011](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc)
2,410.3 km reference sphere (`BODY504_RADII`). Registration between the
monochrome mosaic and IAU nomenclature was verified across Valhalla, Asgard,
Burr, Lofn and Heimdall. Image brightness is never interpreted as elevation.

The deterministic offline preparation (seed `504`, 16,384 × 8,192 Float32)
combines:

- **Giant multi-ring impact basins:** Valhalla (3,000 km), Asgard (1,400 km),
  Adlinda (840 km) and Utgard (610 km) feature viscously relaxed flat central
  palimpsests surrounded by azimuth-modulated concentric tectonic graben troughs
  and outward-facing scarps.
- **141 named craters & 8 catenae:** Exact spherical great-circle profiles
  calibrated to Callisto icy-crater scaling (depths saturating near ~0.9–1.05 km
  for large complex craters, with central domes above ~58 km and central-ring
  morphology for Lofn and Heimdall), plus linear chains of overlapping impact
  craters along each mapped catena axis.
- **Heavily cratered ancient plains:** 8,448 seeded sub-85 km background craters
  (attenuated inside the smooth central palimpsests of the major multi-ring
  basins) plus seamless 3D harmonic undulations complete the global field.
  Features fade smoothly above 75°–85° latitude and converge to a single
  elevation at each pole.

The prepared raster spans **-1,411.8 m to +860.0 m** and is baked into 10,922
immutable geographic height tiles (`129 × 129` Int16, 1 m quantization, levels
0–6, ~924 m equatorial delivery spacing). `callisto-terrain-coverage.png`
records the IAU/USGS named feature constraint footprints (13.60% spherical area),
not measured stereo DEM support.

## Visible color and material

Global measured three-band RGB is unavailable. The 4096 × 2048 lossless WebP
color map (`5.73 MB`, with identical PNG fallback) uses the 1 km Voyager/Galileo
monochrome mosaic (with iterative smooth relaxation inside its 3.9% polar
imaging gaps), mapped to Callisto's characteristic dark ~0.22 geometric albedo
and Galileo `PIA03456` chromaticity: deep warm charcoal-brown ancient lag on
cratered plains transitioning to dusty tan-gray palimpsests (Valhalla, Asgard)
and crisp cool-white excavated water-ice ejecta on fresh craters (Burr, Lofn,
Heimdall). Polar rows converge smoothly above 85°.

Separate 512 × 512 periodic packed normal/roughness/albedo textures
(`callisto-detail.png`, `callisto-medium-detail.png`) add body-fixed,
shading-only sublimation-pitted rocky-ice regolith detail. The global 1 km
hillshade is derived from the completed terrain release and streamed through
the shared R8 page pool.

## Orbit and rotation

Rotation uses [NAIF PCK00011](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc)
`BODY504` pole, prime-meridian, and J5/J6/J8 periodic nutation/precession terms.
The visual orbit is a mean circular Jupiter-relative orbit at 1,882,700 km
anchored to a JPL Horizons J2000 geometric state. Across four frozen Horizons
epochs (1900, 2000, 2026 and 2049), the visual circular model stays within
42,600 km (~2.3% of orbital radius, and <6,000 km near 2000–2026); eccentricity
and long-period perturbations are omitted in this visual orbit.

## Rebuild and preserve

```sh
npm run callisto:fetch
npm run callisto:prepare
npm run callisto:build-terrain
npm run callisto:build-hillshade
sh scripts/terrain-python.sh scripts/validate-global-hillshade.py --bodies callisto
npm run callisto:check-source
# On a host with Playwright Chromium libraries installed (with Vite on port 5175):
npm run callisto:check -- --fast-stream --part=surface
npm run callisto:check -- --fast-stream --part=navigation
```

`callisto:build-color` rebuilds color independently. Keep
`.terrain-cache/callisto/` for offline rebuilding; preserve the Git-ignored
`public/terrain/callisto/` and `public/hillshade/callisto/` releases alongside
the other planetary releases.

The active prepared assets total **145.43 MB** (138.69 MiB): **122.28 MB** of
terrain tiles and metadata, **7.50 MB** of 1 km hillshade pages, and
**15.65 MB** of color, fallback, detail, and provenance files.

## Validation

- **Unit tests & production build:** All **180 unit tests** (`npm test`,
  including Callisto satellite registry, JPL Horizons orbit envelope, NAIF
  orientation, and cube-sphere terrain lifecycle) and the lean production build
  (`npm run build:app`) passed.
- **Terrain & hillshade integrity:** `build-terrain.py` validated all 10,922
  tiles (hashes, bounds, seams, poles, parent alignment).
  `validate-global-hillshade.py` validated all 2,412 hillshade pages with **zero
  shared-gutter seam code error**.
- **Independent source & landmark checks (`callisto:check-source`):** 12 global
  and landmark tile controls matched the prepared raster within **0.44 m**
  (Int16 quantization). Verified Valhalla (`-662 m`), Asgard (`-402 m`), Lofn
  (`-398 m`), Heimdall (`-665 m`), Burr (`-489 m`), Tindr (`-806 m`), polar
  height/color convergence, and dark-warm plains vs. bright Valhalla, Burr and
  Heimdall color registration.
- **Visual inspection:** Offline shaded landmark crops (Valhalla, Asgard/Burr,
  Lofn/Adlinda, Gipul Catena) and north/south polar azimuthal renders in
  `.terrain-cache/callisto/` were inspected to confirm feature alignment and
  polar continuity. Live Chromium Playwright checks (`npm run callisto:check`)
  could not run in this container because `libnspr4.so` / Chrome remote
  debugging was unavailable; run `npm run callisto:check` on a browser-capable
  host for live WebGL acceptance.
