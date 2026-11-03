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
- Natural Earth 1:10 million ocean polygons supply a bundled 2048×1024 numeric
  ocean overview. Land is explicitly unclassified. This is generalized geography
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

Generated assets total 2,273,927 bytes: color 880,360; global ocean mask 24,448;
fine detail 668,710; medium detail 700,409. `earth-color.json` records source and
output hashes. The source composite is an appearance product, not calibrated
shadow-free albedo. Fixed surface data does not change with simulation time.

## Streaming and water placement

The vector source has three concurrent requests, cancellation, timeouts,
failure backoff and a 32 MiB conservative mask/metadata allocation budget.
Parents remain available during refinement. The worker scan-converts polygon
holes and disconnected outers directly into numeric buffers, including two
gutter pixels. Overview masks use 256 samples per tile; source zooms 13–14 use
512 for nearby boundaries. Shore metadata is capped separately from pixel data.
It never reads geographic IDs back from a canvas. CPU-local UVs
map parent masks onto children without globe-scale GPU projection drift.
Mapped land use refines landcover; mapped water owns its footprint.

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
suite passed 125 tests, the lean app build passed, and the shared
Moon/Mars/Mercury/Venus browser regression passed. The complete Earth run recorded
13 geographic/failure cases with no shader/page errors or forbidden imagery
requests; `results-all-views.json` preserves that run. A focused final run
rechecks close refinement, lake placement, eviction and failure handling.
The detail toggle was also checked against actual ground pixels: switching it
off changes the rendered sample, switching it back restores identical pixels,
and terrain triangle counts remain unchanged. Near masks stay within the
32 MiB estimate even when several fine tiles are resident.

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
