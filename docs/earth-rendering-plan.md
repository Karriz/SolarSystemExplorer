# Earth rendering plan

Proposed November 3, 2026. The first implementation is now described in
[Earth surface rendering](earth-surface.md). The WorldCover global overview
remains deferred after provider requests timed out; current global land remains
unclassified while local OpenFreeMap classes drive the material masks.
This supersedes the earlier proposal to retain streamed satellite RGB as an
Earth comparison mode. High-resolution Sentinel RGB loading will be removed.

## Direction

Use measured Mapterhorn elevation, compact global geographic color, mapped
land-cover and water boundaries, and generated close material detail. Share
surface ownership, material machinery, resource lifecycle, lighting conventions
and status handling with the other solid planets. Earth keeps adapters for its
terrain provider, water, and eventually mapped surface features.

Current code already streams Mapterhorn through `RegionalTerrainSource.ts` and
`earthTerrain.worker.ts`. `RegionalTerrainLayer.ts` owns the separate Sentinel
RGB loader in `earthImagery.ts`. `PlanetSurfaceRenderer.ts` currently constructs
`CubeTerrainLayer`, local-release height data, and global hillshade directly;
adding Earth to its profile table alone would therefore be insufficient.

## Data and appearance

| Purpose | Proposed input | Runtime representation |
| --- | --- | --- |
| Measured landforms | Existing Mapterhorn source | Existing bounded terrain stream and exact numeric WebP decoder |
| Broad ground color | NASA Blue Marble Next Generation base-map variant, without added relief shading | One continuous 4096×2048 color texture and mip chain |
| Material distribution | WorldCover global overview with OpenFreeMap landcover/landuse refinement | Compact overview plus bounded locally rasterized material masks |
| Ocean extent | Global overview; OpenFreeMap water polygons for close views | Water coverage masks with explicit coarse/fine ownership |
| Inland water | WorldCover water overview; OpenFreeMap water/waterway features nearby | Separate coverage and surface-height records |
| Unresolved ground texture | Generated soil, rock, sand, vegetation and snow material families | Small repeating normal/roughness assets with restrained color variation |

Color is an appearance composite, not calibrated shadow-free albedo. Use the
base-map source rather than the products with added topography/bathymetry
shading; record remaining acquisition/seasonal limitations. Start with one fixed
composite, not a seasonal system. Audit the existing Earth JPGs before reusing
them; their filenames alone do not establish source variant or processing.

WorldCover is derived from satellite observations, but the runtime will not
load Sentinel RGB. Do not use its cartographic legend as ground color. Map
classes to natural material mixtures and retain regional variation from the
compact color map. Ecoregion palette refinement can follow if the first pilot
shows a clear need.

Do not bundle the full global 10 m classification archive. First produce the
global overview and one Finland pilot. Use OpenFreeMap's existing vector stream
for mapped local refinement before adding a separate fine classification
distribution. Missing polygons retain the overview; missing OSM mapping is not
evidence of bare ground. Add derived WorldCover tiles only where the pilot
demonstrates a coverage or quality need. Source COGs remain build inputs, not an
assumed ready-made browser tile service.

## Early OpenFreeMap integration

Load OpenFreeMap vector tiles before roads or buildings are rendered. Its
documented schema is OpenMapTiles. Initially decode `water`, `waterway`,
`landcover` and `landuse`; inspect `park` only where it adds useful material
information. Water polygons supply ocean/lake/river coverage, while mapped
vegetation, fields, sand, rock and urban land use refine surface mixtures where
the actual class/subclass supports that interpretation. A waterway line alone
does not establish a measured river width or surface elevation.

Use one view-driven vector loader with a bounded cache, request cancellation
and worker decoding. Resolve the source TileJSON from the published style/source
metadata rather than pinning a dated tile URL. Prototype direct PBF decoding and
mask generation for the existing Three.js surface; a second MapLibre map is
not required. Tiles contain other layers, but defer their decoding/geometry
creation until needed. Loading vector tiles cannot selectively omit those
layers from transfer when they share the same PBF response.

Rasterize useful polygons into local lossless coverage/material masks. Handle
holes, multipolygons, tile buffers, dateline wrapping and neighboring-tile
gutters. Share vector requests between material and water consumers. Keep
source zoom/generalization explicit, particularly beyond the source maximum
zoom: overzooming adds no geographic detail. Define a deterministic overlap
policy: explicit water coverage overrides land material; specific mapped land
features refine the global classification; unmapped areas retain the baseline.
Validate conflicting coarse/fine boundaries and zoom transitions visually.

The first acceptance gate is a live Finland tile probe: inspect actual layers,
class attributes, geometry, TileJSON zoom limits, payload sizes and browser CORS
before selecting zoom ranges or promising precision. Documentation confirms the
source/schema direction; direct tile access has not yet been validated in this
planning pass. Keep lake-height estimation separate from polygon loading.

Preserve OpenMapTiles/OSM attribution in the custom Three.js client. Start with
on-demand view loading; offline region downloads are a separate feature with
provider limits. The later road/building renderer reuses this loader and cache.

## Implementation sequence

### 1. Remove high-resolution RGB streaming

Remove `EarthImagery` construction, updates, requests, textures and associated
metrics/UI attribution. Audit the older `surfaceTiles` Earth path too so no
second imagery stream remains. Keep or extract useful geographic UV helpers
and the GPU precision regression before retiring `earthImagery.ts`.

Use the existing compact Earth map temporarily on both terrain and fallback
globe, then replace it with the verified base-map asset. A failed color load
retains a placeholder without disabling terrain. No satellite comparison mode.

Acceptance: browser request capture shows zero Terrascope/Sentinel RGB requests
through approach, pan, zoom, Earth departure and revisit. Terrain remains
recognizable and continuous throughout those operations.

### 2. Share rendering ownership and material behavior

Separate `PlanetSurfaceRenderer`'s common ownership from its concrete terrain
backend. Start with a small adapter for update, height queries, metrics and
disposal; wrap the existing cube/local-release backend and Earth's existing
regional backend. Keep backend-specific selection and stitching internal.

Give Earth a material profile using the shared `planetSurfaceMaterial.ts`
machinery. Apply the same compact color, class inputs and detail behavior to
regional patches and the fallback globe. Share lazy loading, cancellation,
failure reporting and disposal. Avoid combining two independent shader patches
that both assume ownership of the same shader chunks.

Preserve true-scale geometry, body-fixed coordinates and existing camera
gestures. Keep Mapterhorn's current mesh/cache budgets initially. Conversion to
cube meshes is a later profiling decision, not a prerequisite or a reason to
duplicate the worldwide elevation archive.

### 3. Stream OpenFreeMap masks and establish water placement

Implement ocean coverage independently of DEM sign: negative elevation does
not imply ocean. Use a coarse global mask immediately and consistent tiled
shoreline refinement from OpenFreeMap for close views. Natural Earth's 1:10
million scale is suitable for overview, not ground-level shoreline accuracy.
Use separately processed OSM coastlines only if the tile probe shows a specific
need. Start landcover/landuse mask generation in the same integration; OSM
buildings and roads remain later work.

Render ocean at the application's reference sea surface, clipped by mapped
coverage, with low roughness, Fresnel response and subtle animated normals.
Exclude underwater terrain from above-water land rendering where needed and
avoid an overlapping coplanar globe/water shell. Coarse and fine water masks
need shared boundary ownership and seam-aware filtering.

Treat lakes separately: derive or obtain a consistent lake surface elevation,
validate it against shore samples, and use a flat mapped fallback when a height
is uncertain. Do not put every lake at ocean height or make a lake follow DEM
noise. Rivers can initially be mapped surface color rather than simulated flow.

Keep the current mean-radius-sphere height convention explicit. Investigate
coastal datum mismatches locally; do not apply a guessed worldwide offset.
Specify a conservative polar/coarse terrain fallback beyond Mercator coverage.
Bathymetry, tides, refraction and foam simulation are deferred.

### 4. Add classified ground detail

Prototype southern Finland: archipelago, inland lakes, forest, fields and urban
ground. Use continuous mixture weights near class edges. Coarse levels aggregate
fine coverage fractions; never average categorical class codes into new IDs.
Numeric masks require lossless encoding and channel-preserving decoding.

Use body-fixed, meter-scaled sampling, matching the other planets' detail system.
Begin with shader normal/roughness detail; geometry and collision remain based
on measured terrain. Fade fine frequencies using distance and pixel footprint
to avoid shimmer. Generated vegetation texture represents ground appearance,
not individually observed grass or trees. Do not invent accurate field or road
boundaries from noise.

Preserve dynamic lighting and test the existing shadow path explicitly. Importing
the other planets' material code does not establish stable terrain self-shadows;
do not copy a static hillshade as a substitute without a separate visual review.

### 5. Validate and expand

Review screenshots after each stage before adding the next visual layer. Cover
Finland, Alpine relief, desert coast, tropical vegetation, a below-sea-level dry
basin, an elevated lake, dateline crossings and both poles. Inspect orbit,
approach and actual low-altitude views, with stationary and moving cameras.

Acceptance includes no visible terrain/water seams, stable material placement,
no water z-fighting, safe camera clearance, clean body switching and recovery
from failed terrain/color/class/water loads. Check desktop and phone layouts.
Retain numeric height fixtures and geographic/GPU mapping regressions; run the
app tests/build and shared-planet browser checks after ownership changes.

Keep the current 48 MiB regional terrain estimate and 400,000-triangle cap as
initial limits. Aim for at most 8 MiB compressed added global appearance assets;
measure actual output rather than promising compression. A 4K RGBA texture with
mips costs about 43 MiB GPU memory regardless of its WebP download size. Start
with a separate 32 MiB cap for streamed material/water data, account for global
textures separately, and report total GPU/CPU residency and transfer on a repeatable
camera route. Accept performance on real hardware as well as browser automation.

## Later: OpenStreetMap 3D features

Add a separately budgeted layer for terrain-draped roads, visible land-use boundaries,
building footprints/heights and eventually vegetation instances. Reuse the same
geographic frame, elevation sampling, water boundaries, lifecycle and LOD rules.
Keep height-query hooks ready for feature-aware picking and camera clearance.

Reuse the OpenFreeMap stream, checking whether its available building and road
attributes suffice; public map tiles need not expose all building tags. Mark
inferred heights and generated appearances. Account for
surface-model canopy/building heights before adding objects to avoid double
height. Preserve OSM attribution and assess derived-data distribution terms.

## Source references

- [Mapterhorn data access](https://mapterhorn.com/data-access/): existing XYZ and PMTiles elevation distribution.
- [NASA BMNG base map](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/): broad geographic color candidate.
- [ESA WorldCover data](https://esa-worldcover.org/en/data-access): classification and RGB composites are separate products.
- [OpenFreeMap](https://openfreemap.org/) and [quick start](https://openfreemap.org/quick_start/): public vector source, OpenMapTiles schema, attribution and offline-download conditions.
- [OpenMapTiles schema](https://openmaptiles.org/docs/schema/): water, waterway, landcover and landuse layer definitions; verify actual tile contents in the pilot.
- [Natural Earth ocean polygons](https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-ocean/): overview water geometry.
- [Processed OSM water polygons](https://osmdata.openstreetmap.de/data/water-polygons.html): coastline-derived ocean geometry; inland water requires separate inputs.
