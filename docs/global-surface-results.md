# Continuous color and global detailed hillshade

Implemented November 3, 2026, following the [reviewed plan](global-planet-surface-plan.md).
Moon and Mars now default to compact continuous color and approximately 1 km
global measured-DEM hillshade, independent of terrain mesh LOD.

## Color

Mars retains its accepted 4096 × 2048 MOC-WA compact image (249,594 bytes).
Moon uses a 4096 × 2048 image derived directly from the original NASA CGI Moon
Kit sRGB 16-bit 8K TIFF, with 2 × 2 downsampling in linear light and WebP Q95
encoding. The Moon delivery image is 2,256,820 bytes (2.15 MiB). Both have
lossless same-source references and retain previous/original comparison modes.
Neither default loads vector paths or builds view-dependent color windows.
Original JPEGs, including the 8K Moon comparison, now load only when requested.
Returning to compact color releases the original comparison bitmap and GPU
texture, so an earlier 8K comparison does not keep its large allocation alive.

The common `PlanetColorTexture` loader handles source dimensions, sRGB sampling,
longitude wrapping, cancellation, superseded decodes and bitmap disposal.
The Mars-named module remains a compatibility export. Source hashes and error
measurements are in `public/textures/moon-color.json` and `mars-color.json`.

Moon compact/reference rendered mean channel differences were approximately
0.59–1.18 on a 0–255 scale across Hadley, Tycho, far side, dateline, north polar,
and close views; the previous ten-region appearance differed by about 2.5–6.6.
Independent source samples verify GPU orientation and color-space handling.
These compare representations, not absolute physical color accuracy.
The original 8K option remains available for closer inspection of fine markings.

The [NASA source](https://svs.gsfc.nasa.gov/4720/) is a visual, LROC-derived
product with adjusted exposure/white balance and lower-resolution polar albedo
fill. Existing radial artifacts in that polar color fill remain visible under
some lighting. The new delivery does not invent missing polar color or label
the visual product as scientific albedo. Mars green remains estimated from
measured red/blue. Hillshade and actual Sun illumination remain separate.

## Global hillshade releases

| Body | Finest grid | Tile payload, compressed | Pages across all levels | Four-worker bake |
| --- | ---: | ---: | ---: | ---: |
| Moon | 11264 × 5632 | 53,794,860 bytes / 51.3 MiB | 1,302 | 84.7 s |
| Mars | 22016 × 11008 | 115,878,085 bytes / 110.5 MiB | 4,976 | 265.5 s |

Combined tile payload is approximately **161.8 MiB**, excluding small manifests
and base fallbacks. This is the complete archive, not a per-view download.
The finest equatorial spacing is approximately 969 m for Moon and 967 m for
Mars. Each release has six independently streamed levels.

The baker samples the existing measured geographic DEMs with geodesic
300 m derivative offsets and four shading samples per texel. It retains the
accepted multidirectional formula and slope accent, smoothly changing to a
direction-independent slope response from 78° to 88° latitude. This avoids
choosing an undefined compass direction at a pole. NoData is neutral. The
existing elevation adapter supplies source scaling, longitude conventions,
physical-pole handling and Mars's bounded final-column repair.

Coarser levels average the finest encoded linear shading field, preserving its
mean contrast. Tiles have 256 × 256 interiors and two-pixel gutters. Polar
gutters reflect across the pole and rotate longitude by half a globe; longitude
wraps periodically. Versioned manifests contain hashes, sizes and parameters.
A cached Moon rebuild completed in about 2 seconds without replacing published
release files. Resuming uses staged pages; completed releases are immutable and new release
directories/catalog selection are published atomically.

## Runtime and hosting

`GlobalHillshadeLayer` selects pages from geographic bounds and projected texel
footprint. Selection does not depend on loaded terrain meshes. A 128-layer R8
texture-array pool uses 8,652,800 bytes (8.25 MiB) on the GPU and the same size
in its CPU upload buffer. Tiny base maps, lookup textures, decoded in-flight
pages and metadata are additional allocations. Fine pages are released when
switching bodies. The layer allows four concurrent requests, keeps local
fallbacks during errors, verifies payload hashes, and blends arriving pages
over 300 ms. A four-texel edge/corner blend falls back to parents while adjacent
pages are missing or fading in, including across the longitude wrap. An actual
GPU fixture reproduced a 100-code discontinuity before that fix and verifies
the smooth transition afterward. Explicit filtered pyramid levels avoid regenerating a full array
mip chain on each page arrival. The whole-body base has conventional mipmaps.

The shader samples a shared page table/pool on both the base globe and terrain.
Detailed shading replaces mesh-derived hillshade; the two are not multiplied.
The normal Hillshade switch controls the result on both bodies. The Valles-only
switch is superseded. True-scale baked shading remains true-scale when the
geometry is exaggerated. Silhouettes, picking and actual shadows follow geometry.

Full releases live under `public/hillshade/`, selected by its `catalog.json`.
They are generated data, excluded from Git, Vite watching, and `build:app` copy
output. **Deploy the hillshade directory alongside the separately hosted terrain**
at `/hillshade/`, or configure `VITE_HILLSHADE_BASE_URL` to its trailing-slash
HTTP(S) root. The host must allow the app's origin if cross-origin. Gzip-file and
HTTP-decoded gzip responses are both supported. Do not publish the numeric
pages through an image optimizer or a service that changes their bytes.

Small fallback metadata/data files in `public/textures/*-hillshade-base.*` ship
with the lean app. If the bulk catalog is unavailable, they retain complete
world coverage without allocating the fine pool. The layer retries metadata
after 30 seconds and upgrades automatically once hosting recovers. Missing or
corrupt individual pages retain parent/base shading and back off locally.
Color uses ordinary RGBA GPU textures: approximately 42.7 MiB per 4K map with
mipmaps. Small compressed files do not remove that separate allocation.

## Reproduction and validation

```sh
# Original lunar input is retained under .terrain-cache/moon-color/.
npm run moon:build-color
npm run hillshade:build -- --workers 4
npm run hillshade:validate
npm run hillshade:test-pipeline
npm run hillshade:check-edges
npm test
npm run build:app
# Against Vite, default http://127.0.0.1:5175:
npm run moon:check-color
npm run surfaces:check-global
```

`hillshade:validate` checks every hash/length, all neighbor and longitude-wrap
gutters, and independent parent/finer samples from published pages. All 6,278
pages passed with zero gutter-code mismatch. It also refreshes bundled base
fallbacks. Six analytic-source tests cover flat poles/dateline, periodic seams,
pole rotation/reflection, direction-independent polar response, and resuming
without resampling a valid page.

Browser checks cover both poles, dateline, cube boundaries and regional/orbital
views on both bodies, fixed-camera loading, cache pressure, actual camera pans,
unchanged geometry during comparisons, body-switch release, phone controls,
offline fallback/recovery and corrupt-page rejection. A fixed-ground sampled
field comparison isolates hillshade from color/Sun shading while moving the
camera; the three sampled ground values were identical (152, 152, 152). Color checks include rapid switching, delayed bitmap completion and
failure recovery. Artifacts are in `.terrain-cache/global-surfaces-browser/`
and `.terrain-cache/moon-color-review/browser/`.

The 116 existing tests and lean app build pass. Software-renderer browser
coverage does not establish real-device performance or resolve pre-existing
terrain-shadow artifacts. Global shading and source-color artifacts are tested
separately rather than reported as physical-shadow fixes.
