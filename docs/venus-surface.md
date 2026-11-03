# Venus: measured topography with inferred basalt color

Venus uses the shared `PlanetSurfaceRenderer`, `CubeTerrainLayer`, continuous
color sampler, physical material detail, and bounded streamed hillshade used by
Moon, Mars and Mercury. Heights remain the existing authoritative geographic
Magellan release; cube meshes only resample this release for rendering.

## Height data

The installed immutable release is
`venus/magellan-v2-92dd2c8850b1-g65-z5-v3-r2`: 2,730 tiles, 65 × 65 samples,
1 m encoding, approximately 4.64 km source grid spacing. The original
[USGS Magellan global topography v2](https://astrogeology.usgs.gov/search/map/venus_magellan_global_topography_4641m)
is cached with SHA-256
`92dd2c8850b128f9dcceb400f1367e3df96229f5309840fee4275b74f192ea11`.
Grid spacing does not establish independent measurement resolution. Missing
source data, including polar gaps, remains explicitly missing and renders on
the reference sphere with the same inferred basalt color. No higher-resolution relief is invented.

The DEM reference radius is **6,051.0 km**, 800 m smaller than the application's
6,051.8 km mean display radius. Geometry, normals, bounds, picking and clearance
use the existing shared native-datum placement. Datum offsets are independent
of relief exaggeration; the normal user view uses true-scale relief.

The derived six-level hillshade archive contains 683 pages, 6,983,211 compressed
bytes, with an 8192 × 4096 finest grid and 4641.06 m derivative spacing.
Color has no baked hillshade. Cartographic relief shading is separate from
solar illumination, and is not a physical cloud/atmosphere lighting model.
`venus-hillshade-base.*` supplies a complete coarse fallback in lean builds.
Deploy the catalog-referenced `public/terrain/venus/` and
`public/hillshade/venus/` releases with their catalogs for complete streaming.

## Realistic color and its limits

There is no measured global visible RGB map used here. Magellan radar
brightness measures scattering behavior, including slopes, roughness and
electrical properties; assigning it to visible reflectance would introduce
unsupported bright/dark patterns and baked directional lighting.

[Pieters et al. (1986), The color of the surface of Venus](https://ntrs.nasa.gov/citations/19870039592)
reports dark, nearly colorless basalt after removing orange incident lighting
from Venera 13 images. This implementation therefore uses a deliberately
uniform, slightly warm, dark basalt material under white light. Linear RGB
`[0.095, 0.090, 0.085]` (sRGB `[87, 85, 82]`) is an **artistic assumption**,
not calibrated Venera reflectance or a claim about every location on Venus.
Measured landforms supply global geographic variation through shading.

Clouds and orange atmospheric illumination are omitted to expose terrain.
This is an inferred cloud-free surface visualization, not Venus's visible
appearance from orbit or a simulation of standing beneath its atmosphere.
Both the information panel and asset metadata state these limits.

The lossless 4096 × 2048 WebP is 396 bytes. Its PNG fallback uses the same
inferred color; network failure never silently restores the orange radar map.
If both fail, a neutral basalt placeholder remains and the UI reports failure.
Generated fine/medium fractured rock detail uses the shared seamless baker,
64 m / 256 m repeats, conservative reflectance strength 0.12, and no geometric
displacement. It is illustrative material, not measured local geology.

## Reproduction and checks

```sh
npm run venus:build-color
npm run venus:build-detail
npm run venus:build-hillshade
npm run venus:check-source-samples
sh scripts/terrain-python.sh scripts/validate-terrain.py public/terrain/venus/magellan-v2-92dd2c8850b1-g65-z5-v3-r2/manifest.json
npm run hillshade:validate
npm test
npm run build:app
# Against Vite on port 5175:
npm run venus:check-cube -- --fast-stream
npm run venus:check-color
node scripts/check-venus-views.mjs
npm run surfaces:check-planets
```

Independent native GeoTIFF checks compare 27 tile vertices, including missing
polar data, within 0.505 m. Full validation checks every height tile hash,
bounds, seam, pole and parent sample; hillshade validation checks all 683 pages,
hashes, shared gutters and pyramid samples with zero gutter-code mismatch.
The unit regression includes Venus stationary cube residency, departure cleanup
and the 800 m datum offset at both terrain scales. Browser checks cover orbit,
Maxwell Montes, Maat Mons, both poles, cube edge/corner, dateline and 100 m
clearance; separate GPU probes verify the inferred color and labeled fallback.
Software WebGL does not establish hardware performance or cast self-shadow quality.

Final validation: 122 JS tests and the lean production build pass. Nine cube
views, six GPU color samples with exact sRGB agreement, the labeled color
fallback, six full-hillshade comparisons and daylight/close material frames
passed without page or shader errors. Browser outputs are under
`.terrain-cache/venus-cube/browser/`, `.terrain-cache/venus-color/browser/`,
`.terrain-cache/venus-views/` and `.terrain-cache/global-surfaces-browser/`.
The shared four-planet browser regression also passed fixed defaults, lazy
asset loading, fallback, disposal and phone layout checks.
