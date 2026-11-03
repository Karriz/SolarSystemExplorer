# Solar System Explorer

A React, TypeScript, and Three.js explorer with physical body sizes/orbital distances, approximate dated positions and rotations, progressive imagery, and measured planetary terrain.

```sh
npm install
npm run dev
```

Use the URL Vite prints. Left drag orbits and smoothly becomes a surface grab nearby. Right drag tilts and turns around the ground at the center of the view; farther away it becomes orbital movement. Nearby scroll/pinch zoom follows the pointed surface. The camera can approach to 100 m above loaded terrain. Heights and orientation remain approximations, not survey-grade navigation.

## Terrain and material pilot

[Mercury now uses measured visible-band color and shared cube terrain](docs/mercury-surface.md): final MESSENGER MDIS 630/560/480 nm reflectance, the installed 665 m USGS heightmap, and a streamed approximately 1 km hillshade release. The color is a visible-band approximation, with neutral missing-polar fill and no infrared/PCA enhancement.

Moon, Mars and Mercury share a [profile-driven surface renderer](docs/planet-rendering-consolidation.md). They use measured cube-sphere terrain at true scale, continuous compact color, global hillshade and body-specific material profiles. Moon/Mars have shading-only generated surface detail; Mercury initially leaves it off. Color and available detail assets load on first visit.

Moon and Mars now default to [continuous color and global detailed hillshade](docs/global-surface-results.md). The complete hillshade archive is about 162 MiB and streams only visible detail into an 8.3 MiB R8 page pool. The lean build includes coarse fallbacks; serve the generated `public/hillshade/` directory separately alongside terrain, or configure `VITE_HILLSHADE_BASE_URL`.

Mars defaults to [continuous MOC-WA regional color](docs/mars-color-review.md), delivered as a 244 KiB image without the previous ten-color posterization. Moon and Mars use the fixed default rendering path; their color selectors, rendering toggles, and location shortcuts have been removed. Green is estimated from measured red/blue; this is not a calibrated three-band RGB product.

The current implementation of [the upgrade plan](docs/terrain-upgrade-plan.md) adds streamed Earth terrain and color, plus global lunar terrain and procedural surface detail. [Pilot results and remaining acceptance gates](docs/terrain-pilot-results.md) record measured costs and limitations. It preserves observed regional color instead of replacing geography with generic biome colors.

- **Earth:** Mapterhorn elevation streams around the ground point in view, including beyond the Finland/Alps/Namibia bookmarks. Native 512-pixel WebP tiles are decoded directly with libwebp WASM into 129×129 geographic height grids in a worker; meshes use 33, 65, or 129 samples per side according to tile level. Numerical heights never pass through canvas readback, which Brave privacy protection can perturb. Elevation stops at zoom 15. Four view-centered zoom-8 roots, a 32-visible-leaf limit, a 400,000-triangle cap, and a 48 MiB estimated terrain cache bound streaming. Hidden parent geometry can be rebuilt from retained heights without another download. Above roughly 319 km altitude, and beyond Web Mercator's latitude limit, the base imagery globe remains available.
- **Earth color:** hosted Sentinel-2 / WorldCover 2021 true-color PNG tiles load directly onto terrain meshes, independently capped at zoom 14. No global download, preprocessing, or application-owned imagery archive is required. Three concurrent requests and a separate 32 MiB estimated bitmap/texture cache bound color delivery. The provider covers approximately 60°S–83°N; missing/transparent tiles retain Blue Marble. This is observed satellite color, including acquisition lighting, not calibrated shadow-free albedo.
- **Moon:** one global LOLA LDEM_256 release supplies approximately 118 m source spacing across the whole Moon, including the poles. The app no longer loads the Hadley SLDEM overlay. Versioned geographic tiles stream on demand from a 174,762-tile, approximately 4.07 GB compressed height archive; each view loads only the tiles it needs.
- **Materials:** Moon and Mars use body-specific pairs of mipmapped 512×512 normal/roughness textures through one shared material implementation for body-fixed fine and medium detail. The textures are generated offline with `node scripts/build-moon-detail.mjs`; there is no runtime crater-height generation or extra terrain refinement for material detail. The fine layer supplies dust and gravel; the medium layer adds sparse 2–10 m slabs, rubble patches, fractured outcrops, and shallow depressions, with overlapping distance fades. These normals represent generated appearance, not observed rocks or meter-scale measured landforms, and do not change silhouettes, collisions, or cast shadows. Generated detail is enabled by default on Moon and Mars and preserves measured relief and LOD. The focused shadow light fades between 30 and 50 km altitude, but current terrain meshes do not cast shadows, so lunar terrain self-shadowing remains an open task. Crack-hiding skirts are excluded from shadow depth rendering.

- **Color:** Earth uses the bundled NASA Blue Marble base without added relief; the overlapping streamed imagery shell is disabled. The Moon terrain uses the normalized CGI Moon Kit color rather than the baked lighting in the morphological WAC detail mosaic. Compact continuous color uses filtered sampling without sharpening. The original Moon fallback retains bounded sharpening over a limited magnification band; it does not change flat regional color or measured relief. Venus retains its radar display composite; Mercury uses measured visible-band color.

Check the shared Moon/Mars renderer with `npm run surfaces:check-planets` against Vite on port 5175. It verifies fixed defaults, lazy color/detail loading, fallback images, disposal, and the simplified desktop/phone UI. `npm run surfaces:check-global` checks streamed hillshade, camera motion, seams and failures. Older comparison scripts that depend on removed selectors are historical tools. Software-renderer frame times are not a hardware performance acceptance result.

Select Earth, then a location under **Explore measured terrain**. The buttons place the camera over that location; they follow loaded ground briefly while detail arrives. A measured-region status and elevation credit identify active overlays. Failed or missing overlays leave the underlying globe/global terrain visible.

### Prepare the optional bounded experiment

Python dependencies are listed in `scripts/terrain-requirements.txt`; the existing `.terrain-venv` is used automatically when present.

```sh
npm run terrain:pilot -- --skip-landcover
# Later runs can use cached, checksum-pinned source files:
npm run terrain:pilot -- --offline --skip-landcover
```

With `--skip-landcover`, the first run downloads one SLDEM2015 JP2 granule (171,864,155 bytes). The optional Finnish WorldCover COG (56,675,542 bytes) and derived control mask are retained as preparation experiments and are not used by the current Earth renderer. It decodes only a lunar regional window, downsampling by two before generating the hierarchy; it does not normalize or build a fine-resolution globe. The cached sources are `.terrain-cache/pilot/`. Generated data lives under `public/terrain/pilot/` and is Git-ignored. The optional Finnish control map is 65,536 bytes. Source hashes, units, attribution, sampled error estimates, and output sizes are retained in the generated manifests/report.

Hadley tile payloads are gzip-compressed Int16 planes: 65×65 half-meter heights, then eastward and northward slope planes in units of 1/4096. They are delivered as opaque `.bin` bytes, without HTTP `Content-Encoding: gzip`, so the worker can verify the compressed checksum before decoding. These are separate from the legacy height-only tile contract. The pilot manifest is size/count bounded and permits regional coverage without requiring a complete global pyramid.

The lunar source granule and prototype coverage remain deliberate limits. Hierarchical metadata for larger lunar/planetary overlays, source-boundary blending, Earth datum/coastal handling, and hardware GPU budget validation remain follow-up work. Meter-scale landing sites and geometric scattering are deferred.

### Build and serve

```sh
npm run build       # Existing self-contained build; copies all public terrain
npm run build:app   # Lean app + bounded pilot, without large global terrain releases
```

`build:app` avoids repeatedly copying the generated global height releases. Its globe fallback and bundled pilot still work. To retain global planetary relief in a lean deployment, serve the existing static terrain backend separately and set `VITE_TERRAIN_BASE_URL` to its catalog directory, including a trailing slash, when building. That endpoint needs browser CORS if hosted on another origin. `BASE_URL` remains respected for bundled assets.

The dev server serves generated pilot files directly even when they are prepared after startup. Large generated terrain and source caches are excluded from file watching. No runtime data-generation server is required.

### Reproduce browser checks

The numeric decoder has a separate check against independent GDAL pixel references. With Vite running:

```sh
npm run terrain:check-decoder -- --url http://localhost:5173
# Test Brave with its normal fingerprinting protection enabled:
npm run terrain:check-decoder -- --url http://localhost:5173 --executable /path/to/brave
```

The check reports canvas-induced height errors separately from exact byte decoding, then tests the actual elevation worker and WASM asset. Reload after updating the decoder to clear previously corrupted height tiles from memory.


```sh
npx playwright install chromium
npm run dev
# In another terminal; use the URL printed by Vite:
npm run terrain:benchmark -- --url http://127.0.0.1:5173
```

The script uses the explicit `?terrainPilot=1` diagnostic bridge, freezes simulation dates, waits for streamed terrain to settle, records tracked terrain bytes/requests/build/decode counters and animation-frame times, and saves detail-on/off screenshots for desktop, phone, and landscape views. It also checks an unavailable Earth source followed by a switch to measured lunar terrain. Results are in `.terrain-cache/pilot/browser/`. Tracked terrain bytes are not a complete GPU/browser memory measurement; RAF timings on software WebGL are not hardware GPU benchmarks.

Additional continuity and height checks:

```sh
npm run terrain:check-heights
# Offscreen GPU regression for fine-tile and parent-image mapping:
npm run terrain:check-color-uv
npm run terrain:check-continuity -- --url http://127.0.0.1:5173
# Phone-sized viewport; use real hardware for performance acceptance:
npm run terrain:check-continuity -- --url http://127.0.0.1:5173 --phone
```

The continuity check records renderer identity, screenshots, network totals, JS heap, and sampled combined regional terrain/color allocations. It covers coastal water, negative land, moving root selection, and orbit fallback. These counters exclude some browser/worker/GPU allocations. See [current findings and remaining gates](docs/terrain-pilot-results.md#continuity-and-height-reference-follow-up--2026-10-31).

```sh
npm test
npm run terrain:validate
```

Tests cover camera safety and anchoring, imagery/tile mapping, numerical decoding, sparse regional contracts, shared-edge normals, parent fallback, cancellation, disposal, and cache bounds. Existing terrain validation checks the prepared global releases independently of the pilot.

## Existing global planetary terrain

`npm run terrain:build` prepares the versioned Moon, Mars, Mercury, and Venus baselines described in `scripts/terrain-sources.json`. It requires NumPy/Rasterio. `--offline` reuses cached sources. The Moon now uses one global LOLA LDEM_256 source; the earlier Hadley SLDEM overlay is retained as an optional preparation experiment and is not loaded by the app.

To restore missing global heightmaps after losing the generated data, install the Python dependencies described above, then run:

```sh
npm run terrain:fetch-moon
npm run mars:fetch-terrain
npm run terrain:build -- --workers 8
```

The build downloads the smaller Mercury and Venus sources, verifies pinned source checksums, and validates each complete release before updating `public/terrain/catalog.json`. Run the build as one process for all four bodies so catalog updates remain sequential. Both `.terrain-cache/` and `public/terrain/` are Git-ignored; preserve them separately if they need to survive a fresh checkout or environment replacement. Earth elevation streams remotely and needs no global rebuild.

The current catalog selects approximately 118 m LOLA LDEM_256 (Moon), 200 m MOLA–HRSC v2 (Mars), 665 m MESSENGER (Mercury), and 4.6 km-grid Magellan (Venus). Source pixel spacing is not effective resolution or guaranteed accuracy. Moon height tiles store a 129×129 grid through level 8; Mars uses 129×129 through level 9, approximately 163 m finest north–south delivery spacing. Mercury and Venus retain 65×65 grids. Moon and Mars render six cube-sphere trees with 33×33 meshes, source-derived normals, boundary skirts and parent retention. Their renderer keeps an estimated 128 MiB allocation budget per active body, including a numeric height cache bounded at 64 MiB and adjusted to leave room for metadata and geometry, and stays below 400,000 visible triangles. Worker decoding checks hashes and lengths. Regional layers have a separate 48 MiB estimated terrain budget; Earth vector material/water masks add a separate 32 MiB estimate, with compact global color/detail accounted separately. These counters exclude total browser/driver overhead.

Prepare the whole-Moon source and release:

```sh
npm run terrain:fetch-moon
npm run terrain:build -- --bodies moon --offline
npm run terrain:test-pipeline
npm run terrain:validate -- public/terrain/moon/<release>/manifest.json
```

The four official LOLA quadrants total 8.49 GB. They are pinned by SHA-256 and fetched in checked, resumable byte ranges into `.terrain-cache/moon-global/sources`. The build caches a normalized Float32 raster (16.99 GB), checkpoints completed tile columns, validates the release, and only then changes the terrain catalog. Validation uses a bounded tile cache rather than retaining the full pyramid in RAM. Moon and Mars use a shared cube-sphere renderer with a 126-leaf selection cap. `terrainPilot.metrics().global.moon` and `.mars` expose projection, visible terrain, source-data levels and allocation counters for browser checks.

Prepare the global 200 m Mars source and release:

```sh
npm run mars:fetch-terrain
npm run mars:build-terrain
npm run mars:test-pipeline
npm run mars:check-source-samples
npm run mars:check-terrain-upgrade
```

The official USGS MOLA–HRSC v2 GeoTIFF is 11.38 GB, with an approximately 22.77 GB normalized working raster. The downloader resumes checked HTTP ranges and verifies a pinned SHA-256. The builder preserves the actual geographic pixel transform, areoid height reference, source attribution and HRSC CC BY-SA 3.0 IGO terms. It interpolates the narrow NoData stripe in the final longitude column between adjacent measured samples across the dateline, recording that processing in the release; other NoData remains explicit. The catalog changes only after full tile integrity, seam, pole and parent-alignment validation. This v2 source incorporates HRSC over 44% of Mars; other areas retain interpolated MOLA, and the source has documented localized blending artifacts.

The Moon's current CGI Moon Kit texture is intentionally retained. The proposed global Kaguya MI 750 nm/237 m reflectance replacement is pending: the catalog entry remains, but its exact original global raster was not available from the checked official download services. The available ±65° regional dataset has not been substituted.

## Sources and limits

- [LOLA global elevation products](https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/), NASA/GSFC/MIT/LRO: the four LDEM_256 quadrants provide the current whole-Moon elevation source.

- [Mapterhorn coverage](https://mapterhorn.com/), [delivery](https://mapterhorn.com/data-access/), [source attribution](https://mapterhorn.com/attribution/). Advertised source resolutions vary; delivered resolution also depends on zoom/latitude. Earth relief is shown on the prototype's mean-radius sphere, not a survey-grade ellipsoid/geoid.
- [SLDEM2015](https://pgda.gsfc.nasa.gov/products/54), NASA/GSFC/MIT/JAXA; cite Barker et al. (2016). The optional preparation script retains one explicitly downsampled Hadley subset; this overlay is not active in the default whole-Moon configuration.
- Earth uses compact NASA base color, [OpenFreeMap](https://openfreemap.org/) / © OpenMapTiles / © OpenStreetMap contributors for local material and water masks, and a [Natural Earth](https://www.naturalearthdata.com/) ocean overview. Sentinel RGB streaming has been removed. See [Earth surface rendering](docs/earth-surface.md).
- Proposed, not currently installed: [ESA WorldCover 2021 v200](https://esa-worldcover.org/en/data-access), CC BY 4.0: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. Land-cover classes are not exact material/rock measurements or historical observations for arbitrary simulation dates.
- [NASA Blue Marble base composite](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/) and [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/). Photometric normalization/base composites are better rendering inputs, but are not guaranteed perfectly unlit calibrated albedo. Source details are in `src/textureSources.ts`.
- Other streamed imagery providers/grids are in `src/surfaceTiles.ts`. Coverage can fail; retain local textures and measured parents. Geographic imagery may still contain lighting in its original observations.
- Planet positions use [JPL approximate elements](https://ssd.jpl.nasa.gov/planets/approx_pos.html), valid 1800–2050; lunar motion is deliberately simplified. Rotation uses [NAIF planetary constants](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc) and [USNO approximate Earth sidereal time](https://aa.usno.navy.mil/faq/GAST). UTC approximates UT1/TDB. Time changes orientation/illumination, not the observation epoch of fixed surface maps.

Further source comparisons and constraints are in [Surface material options](docs/surface-material-options.md) and [Terrain upgrade plan](docs/terrain-upgrade-plan.md).

The Moon's **WAC detail** toggle uses LROC's normalized 643 nm imagery. The default fallback is remote, display-scaled WMS imagery, with a fade above 72° latitude. When a complete local numeric release is installed, the app switches to measured reflectance tiles with an explicit coverage mask and uses the polar stereographic source at both poles. Local tiles have 0.18° gutters, lossless 10-bit reflectance in WebP, and a separate estimated 64 MiB decoded/GPU cache. Both paths modulate the existing Moon color under dynamic lighting; the local polar source replaces the streaked legacy color near the poles. This is single-band brightness detail, not measured RGB or additional terrain geometry. The base color remains available when imagery is missing. See [the results](docs/terrain-pilot-results.md#global-streamed-wac-detail).

To prepare the local WAC release, run `npm run terrain:fetch-wac` and `npm run terrain:build-wac`. The downloader streams and checksums ten official 304 pixels/degree PDS products (eight equirectangular and two polar), with resumable `.stream` files in `.terrain-cache/wac-global/sources`. The builder validates those checksums and writes levels 4–8 to `public/terrain/moon/wac643-304ppd-v1/`; it publishes `manifest.json` only after all tiles finish. Restart the app after the manifest is installed to select the local release. The source files are roughly 18.8 GB in total. The WebP release size must be measured after generation; the one-tile Hadley sample was 53 KB. Host this directory beside the versioned terrain releases, since the lean app build excludes large terrain data. Local browser and polar acceptance remain required before relying on this release in production.

Venus now uses the same shared cube terrain and streamed relief shading as Moon, Mars and Mercury, with the existing measured Magellan 4.64 km-grid height release. Its color is explicitly inferred dark basalt under white light, informed by Venera analysis; no global measured visible RGB map is claimed. The orange radar composite is no longer the surface-color fallback. See [Venus sources, material assumptions and validation](docs/venus-surface.md).
