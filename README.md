# Solar System Explorer

A React, TypeScript, and Three.js explorer with physical body sizes/orbital distances, approximate dated positions and rotations, progressive imagery, and measured planetary terrain.

```sh
npm install
npm run dev
```

Use the URL Vite prints. Left drag orbits and smoothly becomes a surface grab nearby. Right drag tilts and turns around the ground at the center of the view; farther away it becomes orbital movement. Nearby scroll/pinch zoom follows the pointed surface. The camera can approach to 100 m above loaded terrain. Heights and orientation remain approximations, not survey-grade navigation.

## Terrain and material pilot

The current implementation of [the upgrade plan](docs/terrain-upgrade-plan.md) adds streamed Earth terrain and color, plus a bounded lunar terrain/material prototype. [Pilot results and remaining acceptance gates](docs/terrain-pilot-results.md) record measured costs and limitations. It preserves observed regional color instead of replacing geography with generic biome colors.

- **Earth:** Mapterhorn elevation streams around the ground point in view, including beyond the Finland/Alps/Namibia bookmarks. Native 512-pixel WebP tiles are decoded directly with libwebp WASM into 129×129 geographic height grids in a worker; meshes use 33, 65, or 129 samples per side according to tile level. Numerical heights never pass through canvas readback, which Brave privacy protection can perturb. Elevation stops at zoom 15. Four view-centered zoom-8 roots, a 32-visible-leaf limit, a 400,000-triangle cap, and a 48 MiB estimated terrain cache bound streaming. Hidden parent geometry can be rebuilt from retained heights without another download. Above roughly 319 km altitude, and beyond Web Mercator's latitude limit, the base imagery globe remains available.
- **Earth color:** hosted Sentinel-2 / WorldCover 2021 true-color PNG tiles load directly onto terrain meshes, independently capped at zoom 14. No global download, preprocessing, or application-owned imagery archive is required. Three concurrent requests and a separate 32 MiB estimated bitmap/texture cache bound color delivery. The provider covers approximately 60°S–83°N; missing/transparent tiles retain Blue Marble. This is observed satellite color, including acquisition lighting, not calibrated shadow-free albedo.
- **Moon:** the Hadley–Apennine overlay samples SLDEM2015 at approximately 118 m, retaining the existing global LOLA release outside the overlay. Geographic tiles have common source-derived slope normals across LODs. The bounded overlay contains 341 tiles and approximately 6.7 MB of compressed height/slope data. A single view downloads only its needed tiles.
- **Materials:** body-fixed, filtered procedural grain and roughness remain available on the Moon. Fine normals do not imply observed rocks or meter-scale measured landforms. Use **Surface detail on/off** to compare the same measured color and relief. Focused Sun shadows are available on Earth and the lunar pilot. **Shadows on/off** compares them; their contribution fades between 30 and 50 km altitude. Crack-hiding skirts do not cast shadows.
- **Color:** Earth uses the bundled NASA Blue Marble base without added relief; the overlapping streamed imagery shell is disabled. The Moon terrain uses the normalized CGI Moon Kit color rather than the baked lighting in the morphological WAC detail mosaic. Other bodies retain their existing display composites.

Select Earth or Moon, then a location under **Explore measured terrain**. The buttons place the camera over that location; they follow loaded ground briefly while detail arrives. A measured-region status and elevation credit identify active overlays. Failed or missing overlays leave the underlying globe/global terrain visible.

### Prepare the bounded data

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

`build:app` avoids repeatedly copying the approximately 1.31 GiB of selected global height payloads and older retained releases. Its globe fallback and bundled pilot still work. To retain global planetary relief in a lean deployment, serve the existing static terrain backend separately and set `VITE_TERRAIN_BASE_URL` to its catalog directory, including a trailing slash, when building. That endpoint needs browser CORS if hosted on another origin. `BASE_URL` remains respected for bundled assets.

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

```sh
npm test
npm run terrain:validate
```

Tests cover camera safety and anchoring, imagery/tile mapping, numerical decoding, sparse regional contracts, shared-edge normals, parent fallback, cancellation, disposal, and cache bounds. Existing terrain validation checks the prepared global releases independently of the pilot.

## Existing global planetary terrain

`npm run terrain:build` prepares the versioned Moon, Mars, Mercury, and Venus baselines described in `scripts/terrain-sources.json`. It requires NumPy/Rasterio. `--offline` reuses cached sources. These datasets remain unchanged by the pilot; rebuilding them is not required to prepare the bounded overlays.

The current catalog selects approximately 474 m LOLA (Moon), 463 m MOLA (Mars), 665 m MESSENGER (Mercury), and 4.6 km-grid Magellan (Venus). Source pixel spacing is not effective resolution or guaranteed accuracy. Global tiles use a 65×65 height grid with boundary skirts, parent retention, four concurrent requests, and an estimated 48 MiB terrain allocation budget. Worker decoding checks hashes and lengths. Regional layers have a separate 48 MiB estimated terrain budget and a 32-visible-leaf limit; Earth color adds a separate 32 MiB estimate; that separation is exposed in pilot measurements rather than presented as one combined memory limit.

## Sources and limits

- [Mapterhorn coverage](https://mapterhorn.com/), [delivery](https://mapterhorn.com/data-access/), [source attribution](https://mapterhorn.com/attribution/). Advertised source resolutions vary; delivered resolution also depends on zoom/latitude. Earth relief is shown on the prototype's mean-radius sphere, not a survey-grade ellipsoid/geoid.
- [SLDEM2015](https://pgda.gsfc.nasa.gov/products/54), NASA/GSFC/MIT/JAXA; cite Barker et al. (2016). This prototype uses one source tile and an explicitly downsampled regional subset.
- [ESA WorldCover Sentinel-2 composites](https://esa-worldcover.org/en/data-access): hosted 2021 RGB via Terrascope WMTS, `esa-worldcover-s2rgbnir-10m-2021-v2_tcc`, EPSG:3857, zooms 8–14. Service availability is external; fallback remains bundled.
- [ESA WorldCover 2021 v200](https://esa-worldcover.org/en/data-access), CC BY 4.0: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. Land-cover classes are not exact material/rock measurements or historical observations for arbitrary simulation dates.
- [NASA Blue Marble base composite](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/) and [CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/). Photometric normalization/base composites are better rendering inputs, but are not guaranteed perfectly unlit calibrated albedo. Source details are in `src/textureSources.ts`.
- Other streamed imagery providers/grids are in `src/surfaceTiles.ts`. Coverage can fail; retain local textures and measured parents. Geographic imagery may still contain lighting in its original observations.
- Planet positions use [JPL approximate elements](https://ssd.jpl.nasa.gov/planets/approx_pos.html), valid 1800–2050; lunar motion is deliberately simplified. Rotation uses [NAIF planetary constants](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc) and [USNO approximate Earth sidereal time](https://aa.usno.navy.mil/faq/GAST). UTC approximates UT1/TDB. Time changes orientation/illumination, not the observation epoch of fixed surface maps.

Further source comparisons and constraints are in [Surface material options](docs/surface-material-options.md) and [Terrain upgrade plan](docs/terrain-upgrade-plan.md).
