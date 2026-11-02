# Moon vector color experiment

The Moon information panel offers **Moon color → Original image / Vector · 6 / 10 / 16 colors**, plus **10 · Diagonal** and **10 · Smoothed**. The original remains the default. Each vector option replaces base color on both the globe and the measured terrain. Surface normals, roughness, illumination, and elevation remain independent. Adaptive raster sharpening is disabled for vector colors. The two new contour variants include a **Boundary close-up** button for a repeatable view near Hadley.

## Preparation

Run `npm run moon:build-vectors` with the existing terrain Python environment (`numpy` and `rasterio`). The input is `public/textures/moon.jpg`, an 8192 × 4096 equirectangular image. The first experiment averages it to 4096 × 2048, trains a deterministic CIELAB color clustering, and removes connected regions smaller than 12 pixels. Longitude wrapping participates in that cleanup. These are appearance classes derived from the image, not geological classifications or additional measurements.

The builder traces the remaining regions into 32 vector tiles per palette. JSON tiles contain closed vector paths and holes; their manifest provides the palette, source hash, image dimensions, tile grid, and complexity counts. Coordinates are source-image pixels, increasing eastward/right and southward/down. The grid uses the same placement as the original image. Only collinear vertices are removed, preserving shared boundaries exactly. There is no curved-boundary reconstruction or independently simplified polygon topology.

| Palette | Regions across tiles | Vertices | Uncompressed paths | Stored gzip tiles |
| --- | ---: | ---: | ---: | ---: |
| 6 colors | 22,468 | 1,847,422 | 14.03 MB | 3.36 MB |
| 10 colors | 35,904 | 2,403,158 | 18.26 MB | 4.38 MB |
| 16 colors | 55,322 | 2,566,696 | 19.51 MB | 4.73 MB |

The source JPEG is about 5.6 MiB. Gzip-compressed JSON paths reduce the selected baseline palette's transfer to 3.36–4.73 MB, although all three alternatives together occupy more space than the JPEG. The browser uses native stream decompression. The first trace retains many irregular boundaries; shared-edge simplification is implemented in the two new variants below.

## Rendering and limits

The browser fetches only the selected palette, with four concurrent tile requests, and rasterizes its paths into a 4096 × 2048 canvas texture. It swaps the complete atlas into the existing terrain materials. Switching palettes cancels previous work; failures restore the original image; replacing a palette releases its old GPU texture. The original JPEG remains available for immediate comparison. Detail controls and terrain toggles work independently.

The baseline 6/10/16 modes test **color quantization and traced regions** with a fixed-resolution atlas. One atlas is 32 MiB of RGBA pixels, plus mipmaps/GPU storage; switching temporarily holds the previous and next atlas. Texture disposal does not imply an immediate reduction in browser process memory.

Tracing cannot recover features absent from the source, and small bright rays or crater markings may disappear during classification and cleanup. Existing source artifacts at the poles are also eligible to become polygons. View-dependent vector fetching and multiple geometry LODs remain future work.

## Shared diagonal and smoothed contours

Run `npm run moon:build-contours` after installing `scripts/terrain-requirements.txt` in the terrain Python environment. This retains the original 10-color classes and adds two variants. The pipeline nodes shared boundaries over the complete globe before cutting tiles, then uses [Shapely coverage simplification](https://shapely.readthedocs.io/en/stable/reference/shapely.coverage_simplify.html) with a 0.85 source-pixel area-based tolerance and fixed exterior bounds. This removes staircase vertices in favor of diagonals. The tolerance is not a strict positional-error guarantee or an improvement in measured geographic accuracy.

The smoothed variant applies one conservative relaxation to shared vertices with exactly two neighbors. Junctions and outer image boundaries stay fixed. Vertices belonging to regions where movement would introduce invalid geometry are pinned on both sides, then the remaining smoothing is validated again. Both variants must contain individually valid polygons, edge-matched coverage without overlaps, and exactly the image's total area. Holes remain occupied by their adjacent color regions. Output consists of straight segments; this is restrained polygon smoothing, not a Bézier-curve fit. Validated geometry is cached locally to avoid repeating the expensive whole-globe topology work when exporting.

| 10-color variant | Exported vertices | Stored gzip tiles |
| --- | ---: | ---: |
| Original trace | 2,403,158 | 4.38 MB |
| Diagonal | 1,571,396 | 3.55 MB |
| Smoothed | 1,571,902 | 6.17 MB |

Floating-point coordinates make the smoothed export larger despite fewer vertices. The diagonal version changes about 1.52% of the classified image area; smoothing changes about 5.56% relative to the baseline. These numbers measure reclassified area, not geographic accuracy. Seven sensitive regions needed their vertices pinned during the smoothing pass. Rendering adds disjoint antialiased region coverage before compositing a background, avoiding dark hairlines between adjacent pale regions.

Both new variants redraw their vector paths into a **1024 × 1024 close-view color window** covering approximately twice the projected ground footprint. The shared Moon material samples it in body-fixed geographic coordinates, independent of terrain mesh level. This allows much finer display sampling than stretching the global atlas or a whole 21-km terrain tile across a close view. A hysteresis margin reuses the window until the view moves or changes scale enough to require a redraw. The window blends into the global atlas at its perimeter and wraps longitude when drawing across the dateline. No terrain vertices or collision surfaces change.

One close window uses approximately 9.3 MiB estimated canvas/GPU/mipmap storage, with a temporary second window during replacement. It is released when selecting the original/baseline palettes, leaving the Moon, or looking outside the supported close-view coverage. Polar detail fades from 78° to 80° latitude; this does not resolve existing polar source/mesh artifacts. All selected-release vector tiles are still fetched and their compiled paths retained; this is adaptive **rasterization**, not yet adaptive vector delivery. Hardware performance, frame-time cost during navigation, combined browser memory, and arbitrary grazing-angle coverage remain quality gates.

## Checks

`npm run moon:check-vectors` runs against Vite at `http://127.0.0.1:5173` (override with `VECTOR_PREVIEW_URL`). It captures matched original/6/10/16-color views on the same globe geometry, checks classified source samples at tile corners against the vector-rendered atlas, and exercises camera preservation, restoring the original, rapid cancellation, missing-tile fallback, and phone controls. `npm run moon:check-vectors -- --terrain` separately checks visible measured-terrain map replacement and captures polar, dateline, and close views. Terrain selection can continue streaming during those captures; they are functional mapping checks, not settled LOD acceptance. Artifacts go to `.terrain-cache/moon-vectors/browser/`. These browser checks use Chromium; software rendering is not hardware performance acceptance.

Both browser commands passed on 2026-11-02 with no page/shader errors. All three palettes preserve the 128 classified samples at tile corners, including image edges. The 103 existing tests and the lean production build pass. Visual inspection confirms recognizable maria and bright rays at globe scale, stronger posterization with six colors, and broad uniform patches nearby. The north-polar capture still shows severe radial streaking: this experiment does not resolve the existing polar source/mesh limitations. Close-view sharpness and polar quality remain unaccepted.

The contour follow-up passes `npm run moon:test-contours` (six geometry tests), the 103 existing tests, and the lean app build. `npm run moon:check-contours` captures the diagonal/smoothed/baseline views and verifies exported interior samples, actual GPU pixel changes with close redraw enabled, stationary window reuse, dateline wrapping, source-tile boundaries, polar fallback, texture disposal when returning to the original or leaving the Moon, rapid cancellation, and phone controls. An independent two-gray diagonal fixture blends to gray 200 instead of leaking an unused black background. The baseline palette browser checks also pass with the new shared-edge compositing.

Contour artifacts are in `.terrain-cache/moon-vectors/contours/`. The 12-km images show diagonal outlines and gentler corners; `close-sharp.png` and `close-atlas.png` compare adaptive rendering at 1 km against the fixed global atlas. These are color-rendering checks and do not establish general terrain LOD stability, accepted polar quality, real-hardware performance, or a physically calibrated material model. Curve fitting and more natural soft color transitions remain possible next experiments.
