# Enceladus

Implemented November 15, 2026 with the shared solid-body renderer. Enceladus is
selectable beneath Saturn, searchable, and connected to Saturn by parent
navigation, a parent-relative distance label and an orbit line.

## Terrain and reference figure

The authoritative input is the [Schenk & McKinnon Cassini global DEM](https://astrogeology.usgs.gov/search/map/enceladus-cassini-global-dem-200m-schenk),
published August 2024, associated with [Icarus 408, 115827](https://doi.org/10.1016/j.icarus.2023.115827).
The grid is 200 m; effective horizontal detail is approximately 400 m, with
reported vertical precision roughly 25–100 m depending on location. A gridded
stereo/shape solution is not direct altimetry at every pixel.

Source values are kilometers relative to the Thomas et al. (2016) triaxial
figure, with radii 256.2 / 251.4 / 248.6 km. Preparation converts residuals to
meters and restores this direction-dependent reference radius before encoding
heights above the app's 252.1 km sphere. Body-local Y is north; the long axis
lies along the prime-meridian X direction. The equirectangular projection radius
(256.2 km) is not the vertical datum.

The complete release has 2,730 geographic tiles, 129 × 129 Int16 samples,
1 m quantization, levels 0–5, approximately 193 m finest equatorial delivery
spacing and about 60.3 MB of compressed payload. Cube meshes, normals,
ground picking and collision clearance all sample the same radial heights.
The unloaded/unavailable fallback uses the triaxial reference figure.

The source contains NoData in its padded raster margins. Reprojection into the
global angular domain provided valid source-supported values everywhere in the
prepared grid, so no extra procedural terrain was necessary. Preparation retains
a bounded interpolation path for missing residuals and records coverage; it
never changes valid residual samples to add generated landforms.

`public/textures/enceladus-terrain.json` records input hashes, units, datum and
conversion. Its coverage refers to valid published source support, not a
per-pixel confidence assessment of stereo measurements.

## Color and material

The [paired Schenk Cassini monochrome mosaic](https://astrogeology.usgs.gov/search/map/enceladus-cassini-global-mosaic-100m-schenk)
preserves global morphology. A restrained logarithmic brightness transfer maps
it into a bright, near-neutral ice material. This reduces source-image shadow
contrast but does not fully remove baked illumination.

The [2014 Cassini color map, PIA18435](https://science.nasa.gov/photojournal/color-maps-of-enceladus-2014/)
provides geographic chromatic variation. It includes UV/IR and enhanced color;
it is not installed as natural RGB. The visible reconstruction assumes at most
2% composite-derived channel variation around the near-neutral material. This
is an explicit appearance assumption, not a calibrated spectral conversion.
Longitude orientation was checked against the georeferenced monochrome mosaic;
the correct orientation uses an unmirrored 180-degree roll into -180..180 E.

The 4096 × 2048 lossless WebP is about 2.7 MB. A PNG of the same reconstruction
provides a labeled fallback. Metadata in `enceladus-color.json` records the
assumptions, limitations and source hashes. The UI identifies reconstructed
visible color; neither map is claimed to be measured global RGB or live imagery.

Separate 512 × 512 packed frost/ice textures provide fine and medium normal,
roughness and restrained brightness detail. They are seeded, periodic,
body-fixed and shading-only. They do not alter terrain or introduce measured
fractures. Hillshade is generated from the radial DEM at approximately 400 m
spacing and streamed through the existing bounded R8 page pool. It is
cartographic relief, separate from physical solar lighting; this change does
not implement terrain self-shadowing or plumes.

## Motion and navigation

Rotation uses [NAIF PCK00011](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc)
Enceladus pole and prime-meridian terms. The first orbital model is a mean
circular orbit at 238,037 km in the moon's mean equatorial plane, anchored
independently against a JPL Horizons geometric reference state. It follows the
app's approximate Saturn center, not a separate heliocentric satellite model.
Eccentric motion, small inclination/libration terms and precise event timing
remain outside this first visual model. The timeline identifies moon positions
as approximate. Frozen JPL reference vectors are retained in tests. At the four
checked epochs (1900, 2000, 2026 and 2049), the circular model differs from JPL
by about 1,100–4,900 km. This is a visual orbit, not mission navigation or an
event-prediction ephemeris.

## Rebuild and preserve

```sh
npm run enceladus:fetch
npm run enceladus:prepare
npm run enceladus:build-terrain
npm run enceladus:build-hillshade
sh scripts/terrain-python.sh scripts/validate-global-hillshade.py --bodies enceladus
npm run enceladus:check-source
```

Downloads use official USGS S3 and NASA source products, verified byte ranges,
expected lengths and pinned SHA-256 hashes. All source files total about
667 MB. Retain `.terrain-cache/enceladus/` for offline rebuilding. Prepared
terrain and hillshade under `public/terrain/enceladus/` and
`public/hillshade/enceladus/` are active, Git-ignored served data: preserve them
alongside the existing planetary releases. The lean app build requires these
releases to be served separately, using the existing terrain/hillshade URL
configuration when appropriate.

The active terrain release, 400 m hillshade release, color/reference textures,
fine ice textures and provenance total **75.9 MB** (decimal; about 72.4 MiB).
This excludes source/build caches and superseded release directories. The
browser streams visible terrain/hillshade; it does not load that entire archive
into memory.

## Verification

The terrain builder checks hashes, all tile boundaries, poles and nested parent
samples before publication. `enceladus:check-source` independently samples the
original kilometer-valued raster and reference ellipsoid, comparing eight
delivered vertices; the recorded maximum difference is 10.2 m after resampling
and quantization. This checks preparation fidelity, not the scientific accuracy
of the source DEM.

With Vite on port 5175, run `npm run enceladus:check`. Browser artifacts are in
`.terrain-cache/enceladus/browser/`. It covers orbit, polar terrain, dateline,
cube corner, 100 m clearance, ground tilt, stationary selection, date changes,
Saturn navigation, phone layout and unavailable-data fallbacks. Software WebGL
checks are not physical-GPU performance acceptance.

Recorded acceptance: 172 tests and the lean production build passed. Browser
checks completed with no page/shader errors or unexpected missing Enceladus
assets. The tested terrain allocation peak was 79.8 MiB against the 128 MiB
terrain budget; visible geometry remained within 400,000 triangles. Close ice
detail changed the rendered pixels without changing the terrain signature.
The grazing right-drag reached approximately 84.5° from nadir while preserving
the 100 m clearance floor. Hillshade validation checked all 172 pages with zero
shared-gutter code mismatch. Screenshots were inspected for orbital appearance,
close material, grazing terrain and unavailable-data fallback.
