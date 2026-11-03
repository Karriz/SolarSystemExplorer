# Mercury: measured visible color and shared cube terrain

Implemented November 3, 2026 through the same `PlanetSurfaceRenderer` used by
Moon and Mars. Mercury now uses fixed true-scale measured terrain, compact
continuous visible color and streamed DEM-derived hillshade. Generated
normal/reflectance/roughness detail supplies nearby regolith and fractured-rock
variation; cast terrain self-shadows remain unavailable. There are no rendering or location controls.

## Dataset choices

| Purpose | Source | Use and limits |
| --- | --- | --- |
| Global height | [USGS MESSENGER global DEM v2](https://astrogeology.usgs.gov/search/map/mercury_messenger_global_dem_665m) | Installed geographic 64 ppd grid, approximately 665 m spacing, 2439.4 km reference sphere. Controlled stereo-derived heights, filtered/interpolated from a point cloud; grid spacing is not uniform measured feature resolution. |
| Visible color | [MESSENGER MDIS MDR](https://pds.nasa.gov/ds-view/pds/viewDataset.jsp?dsid=MESS-H-MDIS-5-RDR-MDR-V1.0), final product version 4 | Measured narrow-band I/F reflectance with photometric normalization. Select 630/560/480 nm for approximate visible RGB; do not use infrared composites or PCA enhanced color as natural color. |
| Future northern terrain upgrade | [NASA GSFC north-polar MLA maps](https://pgda.gsfc.nasa.gov/products/87) | 250 m grid over 65–90°N, or 500 m over 55–90°N, with data-count maps. Polar stereographic, 2439.4 km datum, updated Mercury reference frame. Laser measurements are sparse; use counts and verify frame alignment before merging. |
| Future southern terrain upgrade | [NASA GSFC south-polar map](https://pgda.gsfc.nasa.gov/products/88) | 250 m grid over 75–90°S, inferred by shape from shading. No southern MLA data. Permanently shadowed regions are interpolated/model-filled; retain the supplied no-data mask and distinguish inferred heights from directly observed data. |

The current enhanced-color JPEG remains an explicitly labeled fallback if the
new compact image fails. Neither the enhanced mosaic nor the common
1000/750/430 nm three-channel composite is human-visible RGB.

## Color build

`scripts/build-mercury-color.py` reads 54 standard 64 ppd MDR version-4 tiles,
plus the documented `_2700_` south-polar variant. The [PDS errata](https://planetarydata.jpl.nasa.gov/img/data/messenger/msgrmds_5001/ERRATA.TXT)
explain that this additional tile uses coarser observations to improve polar
coverage. Standard valid pixels replace its lower-resolution pixels.

Only the contiguous 480, 560 and 630 nm float32 band planes are downloaded,
using HTTP 206 byte ranges with checked total sizes and response lengths.
Raw ranges and original labels remain under `.terrain-cache/mercury-color/`.
Each range has a SHA-256, original label hash, URL, byte range and HTTP source
identity in `public/textures/mercury-color.json`. These are hashes of selected
band ranges, not checksums of the entire 17-band upstream files.

Original PDS projections are preserved for reprojection: cylindrical charts
and stereographic polar maps are averaged into a 4096 × 2048 geographic grid.
RGB is assigned measured 630/560/480 nm reflectance, with fixed gain 1 and sRGB
encoding. No per-channel stretch, infrared channel, enhanced-color transform
or hillshade is included. This is a narrow-band approximation to visible
appearance, not a calibrated colorimetric reconstruction of human vision or
a complete bidirectional albedo model. The source is normalized to a standard
illumination/viewing geometry; photometric seams can remain.

At the delivery-grid resolution, measured coverage is **99.60% by spherical surface area** and
95.27% of equirectangular pixels. The difference is concentrated at high
latitudes, where equirectangular pixels represent little surface area.
The coarser southern fill supplies 1.70% of output pixels. Missing pixels
are neutral gray, not invented color; `mercury-color-coverage.png` marks
measured pixels. The delivery WebP is 1,105,198 bytes (about 1.05 MiB), with
mean channel error 0.99 and 99th-percentile error 4 on a 0–255 scale against
the same-source reference PNG. Source-derived control samples are published
in the metadata.

## Terrain, datum and hillshade

The installed immutable height release is
`mercury/messenger-v2-defce776241d-g65-z7-v3-r2`: 43,690 geographic tiles with
65 × 65 samples, half-metre encoding and source level 7. The cube renderer
samples these measured tiles without changing the source projection.

Mercury's display mean radius is 2439.7 km, while this DEM measures heights
above a 2439.4 km sphere. Cube terrain now places vertices using the manifest
reference radius rather than adding those heights to the display sphere.
The 300 m offset is independent of relief exaggeration; normals, bounds, LOD
distance and camera clearance use the same placement. Moon/Mars have matching
display/source radii and retain their existing geometry.

The shared hillshade baker now derives output density and derivative spacing
for additional bodies from their radius and source spacing, preserving the
accepted Moon/Mars parameters. Mercury uses a 15360 × 7680 finest grid
(approximately 998 m at the equator), six levels and approximately 665 m
derivative offsets. Its 2,412 pages occupy 42,934,070 compressed bytes
(40.9 MiB in the complete archive), streamed into the existing bounded pool.
Polar compass shading fades to a direction-independent slope response, and
NoData shading is neutral. Cartographic hillshade stays separate from color
and solar illumination.

Serve the new `public/hillshade/mercury/` release with the hillshade catalog
alongside terrain. Bundled `mercury-hillshade-base.*` assets provide a complete
coarse fallback in lean builds; full pages are not copied into `build:app`.

## Reproduction and validation

```sh
npm run mercury:build-color
npm run mercury:check-color-source
npm run mercury:build-hillshade
npm run hillshade:validate
npm run hillshade:test-pipeline
npm run mercury:check-source-samples
npm test
npm run build:app
# Against Vite on port 5175:
npm run mercury:check-color
npm run mercury:check-cube -- --fast-stream
npm run surfaces:check-planets
GLOBAL_SURFACE_CASES=mercury-caloris,mercury-north,mercury-south,mercury-date npm run surfaces:check-global
```

Native elevation validation checks 18 samples against the original GeoTIFF
with maximum error 0.25 m. Full terrain validation covers every compressed
tile/hash, bounds, shared edge, poles and parent alignment. All Mercury
hillshade pages pass hash, gutter and pyramid checks with zero gutter-code
mismatch. Four independent visible-color checks average the original PDS
float32 pixels using label projection math, agreeing within 3.4e-9 reflectance.
Browser GPU probes check all six recorded color samples, including the
dateline, polar measured data and neutral missing-color fill.

All 117 JS tests, the lean build, eight Mercury terrain browser views, six
GPU color samples, the explicitly labeled enhanced-color fallback, the shared
three-body browser regression and four Mercury full-hillshade views passed.
The hillshade check also passed camera-motion, pool release/reuse, offline
recovery and corrupt-page checks. No page/shader errors were reported.

The current JS suite includes Mercury cube stability/release
and native-datum placement. Browser artifacts live under
`.terrain-cache/mercury-cube/browser/`, `.terrain-cache/mercury-color/browser/`
and `.terrain-cache/planet-surfaces-browser/`. Live Vite serving now handles both terrain and hillshade release directories,
including files generated after server startup. Software WebGL checks do not
establish real-device performance or terrain self-shadow quality.
