# Earth surface rendering

Implemented November 3, 2026 from the [Earth rendering plan](earth-rendering-plan.md).

Earth now uses measured Mapterhorn terrain, one compact NASA base-color map,
OpenFreeMap surface masks, generated ground detail, and separate water material
response. No Sentinel RGB, Terrascope imagery or GIBS Earth imagery is requested
by the application. Roads, buildings and individual trees remain future work.

## Shared rendering and Earth adapters

`EarthSurfaceRenderer` owns Earth's color, detail, vector masks and existing
regional terrain backend. It uses `PlanetColorTexture`, `surfaceAssets` and
`planetSurfaceMaterial` alongside the other solid planets. Both globe fallback
and measured patches use the same Earth material configuration. Mapterhorn's
native Web Mercator stream, exact WASM numeric decoder, terrain selection,
camera gestures and provider-specific height convention are retained.

Ground detail is generated packed normal/reflectance/roughness data, using the
same triplanar shader as the other planets. Earth opts into patch-local physical
coordinates with CPU-computed repeat phases to retain fine-scale float precision
on its larger radius. Mapped vegetation and soft surfaces damp the generated
rock-like normal detail; water uses a separate radial normal, subtle animated
waves and lower roughness. No generated geometric displacement is added.

## Data and provenance

- NASA October 2004 Blue Marble Next Generation base composite, without added
  topography/bathymetry shading. The existing 5400×2700 JPEG was downloaded again
  from its declared NASA URL and matched byte-for-byte by SHA-256. A 4096×2048
  WebP is the default; the original JPEG remains the load-failure fallback.
- Natural Earth 1:10 million ocean polygons supply a bundled 4096×2048 fractional
  ocean-coverage overview, rasterized at four times the delivery resolution. Land is explicitly unclassified. This is generalized geography
  for the global fallback, not a fine coastline product.
- OpenFreeMap's live TileJSON supplies versioned XYZ PBF URLs and a source maximum
  zoom of 14. The application resolves metadata rather than hard-coding the
  November 1 source version. Worker decoding uses the actual OpenMapTiles
  `water`, `landcover` and `landuse` layers. `waterway` availability is recorded;
  line widths are not invented from it. Other layers are not decoded into
  renderable features, although they share the tile download.
- Local class palettes are inferred natural material colors, not measured
  reflectance. Unknown classes retain the NASA geographic color. The fixed
  composite's bright polar sea-ice appearance is retained with an explicitly
  heuristic material rule; it is not a dated sea-ice dataset.
- WorldCover is not currently installed. Both the global classification WMS
  request and a minimum-zoom WMTS classification request timed out during this
  implementation. No RGB-derived pseudo-classification or blanket claim of
  global measured material coverage replaces it.

Generated assets total 2,406,034 bytes: color 880,360; global ocean mask 156,555;
fine detail 668,710; medium detail 700,409. `earth-color.json` records source and
output hashes. The source composite is an appearance product, not calibrated
shadow-free albedo. Fixed surface data does not change with simulation time.

## Streaming and water placement

The vector source has three concurrent network requests and one worker build,
cancellation, timeouts and failure backoff. A 64 MiB conservative persistent
cache target includes retained source PBFs (separately capped at 8 MiB),
CPU classification/response buffers, GPU mip chains and metadata. Replacements
can temporarily use a further 64 MiB reserve (128 MiB total cap), keeping visible
masks resident until new masks are drawable. Unused entries are evicted toward
the 64 MiB target. Worker build
scratch buffers and browser/driver overhead are outside this estimate. Terrain
retains its separate 48 MiB budget.

Surface masks refine independently of mesh LOD. Projected patch size selects
128, 256, 512 or 1024 samples, with a shared two-megapixel core-texel allowance.
A coarse mesh can combine four finer source tiles. Render masks can crop native
zoom-14 geometry into zoom-15 targets without claiming additional source detail.
Raw PBFs are reused during refinement; coarse parents provide loading fallbacks,
and ready ancestors remain drawable until replacements are available.

The worker scan-converts holes and disconnected polygon outers with four gutter
pixels. Original class IDs remain CPU-only for water placement. Fourfold
supersampling produces fractional mapped/water coverage, premultiplied palette
color, normal strength and roughness. Linear filtering and mipmaps operate on
these continuous material values, never numeric class IDs. A bounded signed
shore-distance estimate smooths magnified edges; minified views use fractional
coverage. The global ocean mask also uses coverage mipmaps, with explicit
wrapped longitude gradients and an exact-axis dateline guard.

Shore metadata is capped separately from pixel data. No geographic IDs are read
back from canvas. CPU-local UVs map parent masks onto children without globe-scale
GPU projection drift. Mapped land use refines landcover; mapped water owns its
footprint.

Ocean coverage changes height only where a matching-resolution vector mask
identifies ocean, setting rendered water vertices to the application's zero
height. Generalized parent masks supply temporary appearance without flattening
finer measured islands. Negative dry land remains negative. Original measured
height grids are preserved for source sampling; picking and camera clearance
use the displayed mesh.

Lakes and ponds use a shared feature-ID height estimate from available measured
shore samples, with at least three samples and a bounded interquartile spread.
This is an inferred visualization surface, not a measured lake-level product.
Clipped tile edges are excluded from shore observations. Uncertain levels retain
measured terrain, and river lines do not trigger lake flattening. Estimated
levels are bounded in memory and released on departure. Very small shores can
remain limited by mesh/mask resolution; ellipsoid/geoid corrections, bathymetry,
tides and detailed hydrodynamics remain outside this implementation.

Small global color/detail assets load on the first Earth visit and remain until
scene disposal. Regional terrain and vector masks release on departure. Late
responses cannot attach to a disposed owner. Color failure tries the original
NASA image once, then reports a placeholder. Missing vector/global masks report
their fallback state independently of measured terrain.

## Rebuild and validation

```sh
mkdir -p .terrain-cache/earth-source
curl -fL https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_ocean.geojson -o .terrain-cache/earth-source/ocean.geojson
npm run earth:build-surface -- --ocean .terrain-cache/earth-source/ocean.geojson
npm run earth:build-detail
npm test
npm run build:app
# With Vite on port 5175:
npm run terrain:check-color-uv
npm run earth:check-surfaces
npm run earth:check-shorelines
npm run earth:check-zoom
npm run surfaces:check-planets
```

The Earth browser check covers Finland coast/ground, an elevated Alpine lake,
below-sea-level dry land, desert coast, dateline, poles, orbit, ground motion,
phone layout, body switching and failed color/vector/terrain loads. It asserts
zero Sentinel/Terrascope/GIBS requests, bounded tracked allocations and no shader
or page errors. Screenshots and results are in `.terrain-cache/earth-rendering/`.
The geographic UV regression executes the actual mask projection helper in
WebGL at fine zooms and parent fallbacks. The independent fixture is a real,
attributed Finland PBF; unit checks include polygon holes, numeric classes,
late cancellation, backoff and ocean/lake/dry-land height behavior. The unit
initial suite passed 125 tests, the lean app build passed, and the shared
Moon/Mars/Mercury/Venus browser regression passed. The complete Earth run recorded
13 geographic/failure cases with no shader/page errors or forbidden imagery
requests; `results-all-views.json` preserves that run. A focused final run
rechecks close refinement, lake placement, eviction and failure handling.
The detail toggle was also checked against actual ground pixels: switching it
off changes the rendered sample, switching it back restores identical pixels,
and terrain triangle counts remain unchanged. Settled masks target
64 MiB; replacement transitions have a separate bounded reserve.

Software WebGL checks rendering correctness, not real-device performance.
Allocation estimates exclude driver/browser overhead. A 4K RGBA color texture
with mips still costs roughly 43 MiB GPU memory despite its compact download;
global masks and generated detail are additional. `surfaces.earth.assets`
separates estimated decoded-image and GPU storage for each global asset family;
the vector and terrain estimates are reported separately. Global WorldCover coverage,
hardware acceptance and stable terrain self-shadowing remain follow-up work.

## Sources

- [NASA base map](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/)
- [Natural Earth ocean](https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-ocean/)
- [OpenFreeMap](https://openfreemap.org/) / [OpenMapTiles schema](https://openmaptiles.org/docs/schema/) / [OpenStreetMap data terms](https://www.openstreetmap.org/copyright)
- [Mapterhorn data access](https://mapterhorn.com/data-access/)

## Coastal refinement fix — November 8, 2026

Southwest Iberia exposed a missing-elevation sibling problem: Mapterhorn returns
404 for some ocean tiles beside available coastal land tiles. Complete-sibling
replacement then left the entire parent at level 8, including its material mask.

Explicitly missing elevation children now inherit interpolated heights from the
loaded parent, allowing available land siblings and local surface masks to
refine. This preserves parent elevations, including negative dry-land heights;
a 404 is not treated as proof of ocean or zero elevation. Other HTTP errors keep
their existing failure/backoff behavior, and roots without a loaded parent keep
the global fallback. Inherited tiles are counted separately in regional metrics
and excluded from native-height samples used to estimate lake levels.

The unit suite passes 127 tests, including missing-sibling replacement and
Mercator/geographic-row interpolation. The app build passes. The tilted Iberian
browser comparison moved all 173 samples in the affected coastal footprint from
level 8 to levels 10–11, with matching material refinement and no shader/page
errors. Budgets remain unchanged. Captures are in
`.terrain-cache/earth-iberia/`; reproduce with Vite on port 5175 and
`node scripts/check-earth-coverage.mjs`.

## Shoreline filtering and independent surface LOD — November 8, 2026

The current unit suite passes 134 tests and the app build passes. Actual WebGL
checks cover 120 geographic UV cases, a magnified/minified analytic shoreline,
and the global dateline. The controlled magnified edge test reduces RMS edge
error from 1.81 to 0.36 screen pixels; minified coverage error also improves.
This measures filtering correctness, not geographic accuracy or hardware speed.

Browser validation includes close southwest Iberia, an elevated lake, globe
fallbacks, dateline, polar views, ground motion, body switching, phone layout and
provider failures. The final focused run has no shader/page errors or forbidden
imagery requests. Close Iberia reaches render-mask level 15 using native level-14
vectors; the tilted coastal regression still refines all 173 affected samples.
Captures and machine-readable results are in `.terrain-cache/earth-shorelines/`.

Filtering improves appearance without changing terrain triangle counts or
inventing measured detail. Coast silhouettes still depend on the measured height
grid and mesh; separate shoreline-conforming geometry remains future work.

## Zoom transition stability — November 8, 2026

Cache pressure previously reclaimed detailed visible fallbacks before their
replacement masks finished, briefly exposing the coarse overview. Ready visible
masks now remain pinned during replacement; the bounded transition reserve avoids
blocking refinement behind those masks. Mask-size and native-source LOD thresholds
use 20 percent hysteresis to prevent repeated rebuilds around a threshold.

The pressure regression checks every visible child retains its detailed parent
through repeated updates before worker completion, replacements finish, and
settled memory returns below the cache target. The zoom browser check records
fixed Iberian ground points every rendered frame while moving from 18 km to
300 m, checking missing masks, coarse fallback regressions and allocation limits.

The focused browser run recorded 168 fixed-ground samples with no missing masks,
large coarse-fallback regressions, shader errors or page errors. Tracked vector
allocations peaked at 85.4 MiB during replacement and settled to 63.1 MiB. All
134 unit tests and the app build pass. Results are retained under
`.terrain-cache/earth-zoom-stability/`.
