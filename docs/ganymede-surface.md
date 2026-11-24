# Ganymede

Ganymede uses the shared solid-body renderer and appears beneath Jupiter
alongside Io and Europa. Global color and terrain are complete; completeness
includes geologic reconstruction and does not imply a global measured DEM.

## Sources and observed coverage

No global or public regional stereo DEM is currently distributed for Ganymede
on USGS STAC or NASA Ganymede Trek. Instead, global terrain is constrained by
the [USGS Global Geologic Map of Ganymede, SIM 3237](https://pubs.usgs.gov/sim/3237/)
(Collins et al., 2013/2014), combined with published Ganymede icy-moon
morphometry (Schenk et al., 2001; Schenk, 2002; Pappalardo et al., 2004).
Measured numeric elevation support is explicitly recorded as **0.0%**
(`measuredElevationFraction: 0.0`).

All six downloaded official source products total approximately **443 MB** and
are checksum-pinned in `scripts/fetch-ganymede.py`:

- **1 km global monochrome mosaic** (`Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif`,
  136.8 MB) plus PDS3 label (`_pds3.lbl`), providing high-resolution calibrated
  geography (`scales: 0.0059055`, `offsets: -0.0029528`).
- **1.435 km global color mosaic** (`Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif`,
  199.2 MB; 991 nm NIR, 559 nm green, 413 nm violet) plus PDS3 label, providing
  visible green/violet geographic hue variation away from its monochrome polar
  fill.
- **USGS SIM 3237 GIS database** (`Ganymede_SIM3237_Database.zip`, 107.3 MB),
  supplying 3,046 mapped geologic unit polygons (`GeologyUnits.shp`), 869 mapped
  impact craters with diameters, classes and ages (`mapped_crater_materials.shp`),
  872 crater rim traces (`CraterRims.shp`), 2,283 tectonic groove traces
  (`GroovesRepresentative.shp`), 909 furrow traces (`Furrows.shp`), 119 central
  domes (`Domes.shp`), 33 depressions (`Depressions.shp`), 54 palimpsests
  (`mapped_palimpsests.shp`), and the Gilgamesh multi-ring basin.
- **Galileo natural-color reference** (`PIA00716.jpg`, 46 KB), used strictly as
  a visible-color appearance constraint.

## Geologically constrained global terrain

All elevations are referenced to the [IAU 2015 / NAIF pck00011](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc)
2,631.2 km reference sphere (`BODY503_RADII`). SIM 3237 shapefiles and the
USGS mosaics use the older 2,632.345 km projection sphere in angular lon/lat
coordinates; registration was cross-checked across all three products (0.9763
correlation between monochrome and color mosaics, and exact landmark agreement
at Galileo Regio, Uruk Sulcus, Osiris, Tros, Marius Regio, and Gilgamesh).
Image brightness is never interpreted as elevation.

The deterministic offline preparation (seed `503`, 16,384 × 8,192 Float32)
combines:

- **Regional dark vs. bright elevation offset:** ancient dark terrain (`d`,
  `dc`, `dl`) sits ~210 m higher on average than younger tectonically resurfaced
  bright grooved terrain (`lg1–lg3`, `ls1–ls3`, `r`), smoothed across unit
  contacts.
- **Mapped tectonic features:** 2,283 groove traces shape ridge-and-trough sulci
  (~+210 m flanking ridges, ~-170 m troughs), and 909 furrow traces shape
  concentric troughs (~-175 m) with raised flanking rims (~+70 m) in ancient dark
  regions such as Galileo Regio.
- **Mapped impact craters, domes, depressions, palimpsests and Gilgamesh:**
  869 mapped craters use spherical great-circle distance and icy-crater depth
  scaling (saturating near ~1.1 km for fresh `C3` craters, attenuated for `C2`
  and relaxed `C1` craters) with class-specific central peaks, pits or domes,
  plus 119 mapped domes, 33 depressions, 54 low-relief palimpsests, and the
  Gilgamesh multi-ring basin (-1,301 m inner plains, +368 m main ring).
- **Seeded background relief:** 3,495 terrain-weighted sub-30 km background
  craters (denser on ancient dark crust than bright grooved bands) and seamless
  3D harmonic undulations complete the global field. Features fade cleanly above
  75°–85° latitude and converge to a single elevation at each pole.

The prepared raster spans **-1,857.0 m to +941.1 m** and is baked into 10,922
immutable geographic height tiles (`129 × 129` Int16, 1 m quantization, levels
0–6, ~1,009 m equatorial delivery spacing). `ganymede-terrain-coverage.png`
records SIM 3237 mapped feature-constraint density (18.85% discrete feature
footprints atop 100% mapped geologic unit polygons), not measured stereo DEM
support.

## Visible color and material

Global measured three-band natural RGB is unavailable. The 4096 × 2048 lossless
WebP color map (`6.55 MB`, with identical PNG fallback) uses the calibrated
1 km monochrome mosaic for sharp geographic albedo (with iterative smooth
relaxation inside its 3.5% polar imaging gaps), mapped to physically restrained
linear reflectance anchored to Ganymede's geometric albedo (~0.43) and Galileo
`PIA00716`: warm brownish-gray ancient dark regions (Galileo/Marius Regio),
pale ivory-tan grooved sulci, bright cool-neutral fresh impact rays
(Osiris/Tros), and subtle high-latitude polar frost hoods. Visible green/violet
(`559 nm / 413 nm`) ratio residuals from the 1.435 km mosaic modulate low- and
mid-latitude hue and fade smoothly before the ~60°–70° monochrome polar fill
boundary so no latitude seam appears. Polar rows converge smoothly above 85°.

Separate 512 × 512 periodic packed normal/roughness/albedo textures
(`ganymede-detail.png`, `ganymede-medium-detail.png`) add body-fixed,
shading-only rocky-ice regolith microstructure. The global 1 km hillshade is
derived from the completed terrain release and streamed through the shared R8
page pool.

## Orbit and rotation

Rotation uses [NAIF PCK00011](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc)
`BODY503` pole, prime-meridian, and J4–J6 periodic nutation/precession terms.
The visual orbit is a mean circular Jupiter-relative orbit at 1,070,400 km
anchored to a JPL Horizons J2000 geometric state; across four frozen Horizons
epochs (1900, 2000, 2026, and 2049), the visual model stays within 5,500 km of
the reference vectors.

## Rebuild and preserve

```sh
npm run ganymede:fetch
npm run ganymede:prepare
npm run ganymede:build-terrain
npm run ganymede:build-hillshade
sh scripts/terrain-python.sh scripts/validate-global-hillshade.py --bodies ganymede
npm run ganymede:check-source
# On a host with Playwright Chromium libraries installed (with Vite on port 5175):
npm run ganymede:check -- --fast-stream --part=surface
npm run ganymede:check -- --fast-stream --part=navigation
```

`ganymede:build-color` rebuilds color independently. Keep
`.terrain-cache/ganymede/` for offline rebuilding; preserve the Git-ignored
`public/terrain/ganymede/` and `public/hillshade/ganymede/` releases alongside
the other planetary releases.

The active prepared assets total **148.23 MB** (141.36 MiB): **120.37 MB** of
terrain tiles and metadata, **10.17 MB** of 1 km hillshade pages, and
**17.70 MB** of color, fallback, detail, and provenance files.

## Validation

- **Unit tests & production build:** All **178 unit tests** (`npm test`,
  including Ganymede satellite registry, JPL Horizons orbit envelope, NAIF
  orientation, and cube-sphere terrain lifecycle) and the lean production build
  (`npm run build:app`) passed.
- **Terrain & hillshade integrity:** `build-terrain.py` validated all 10,922
  tiles (hashes, bounds, seams, poles, parent alignment).
  `validate-global-hillshade.py` validated all 2,925 hillshade pages with **zero
  shared-gutter seam code error**.
- **Independent source & landmark checks (`ganymede:check-source`):** 12 global
  and landmark tile controls matched the prepared raster within **0.49 m**
  (Int16 quantization). Verified Gilgamesh basin interior (`-1,301 m`) vs. main
  ring (`+368 m`), Osiris crater floor (`-973 m`), Tros crater floor (`-783 m`),
  polar height/color convergence, and warm-dark Galileo Regio vs. bright
  Osiris/Tros color registration.
- **Visual inspection:** Offline shaded global, landmark (Galileo Regio, Uruk
  Sulcus, Osiris, Gilgamesh), and north/south polar azimuthal renders in
  `.terrain-cache/ganymede/` were inspected to confirm feature alignment and
  polar continuity. Live Chromium Playwright checks (`npm run ganymede:check`)
  could not run in this container because `libnspr4.so` / Chrome remote
  debugging was unavailable; run `npm run ganymede:check` on a browser-capable
  host for live WebGL acceptance.
