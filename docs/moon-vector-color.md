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

The smoothed variant starts with one conservative relaxation to shared vertices with exactly two neighbors. Junctions and outer image boundaries stay fixed. Vertices belonging to regions where movement would introduce invalid geometry are pinned on both sides, then the remaining smoothing is validated again. This control coverage must contain individually valid polygons, edge-matched coverage without overlaps, and exactly the image's total area. Holes remain occupied by their adjacent color regions. Validated control geometry is cached locally to avoid repeating the expensive whole-globe topology work when exporting.

The current smoothed variant then fits **actual shared quadratic Bézier corners**. Each accepted corner uses the same control vertex and trim radius on both adjacent regions. Curve tangents align with the connecting straight sections. The trim is bounded by 35% of the shorter neighboring edge and capped at 0.65 source pixels. A curve stays inside a corner triangle that must not intersect unrelated boundaries or overlap another accepted influence triangle. Junctions and vertices on tile cuts remain pinned; curves crossing a tile cut are also excluded. This retains some straight sections and protected corners while avoiding new intersections, lost islands, or gaps at tile boundaries.

The current release contains **714,942 accepted shared curved corners**. Tiles store control vertices and compact corner radii; `compileMoonPath` expands them directly with native `Path2D.quadraticCurveTo`, not pre-tessellated line strips. The encoding is `shared-quadratic-radii-v1`. Rounding a vertex directly on a tile cut is specifically prohibited: it could create a curved sliver in a neighboring tile where the original face had zero exported area.

| 10-color variant | Exported vertices | Stored gzip tiles |
| --- | ---: | ---: |
| Original trace | 2,403,158 | 4.38 MB |
| Diagonal | 1,571,396 | 3.55 MB |
| Curved / Smoothed | 1,571,902 control vertices | 7.55 MB |

Floating-point coordinates and curve radii make the curved export larger despite fewer control vertices. The diagonal version changes about 1.52% of the classified image area; the pre-curve smoothing changes about 5.56% relative to the baseline. These numbers describe the control polygons before Bézier rounding, not final curved area or geographic accuracy. Seven sensitive regions needed their vertices pinned during the smoothing pass. Rendering adds disjoint antialiased region coverage before compositing a background, avoiding dark hairlines between adjacent pale regions.

Both new variants redraw their vector paths into a **1024 × 1024 close-view color window** covering approximately twice the projected ground footprint. The shared Moon material samples it in body-fixed geographic coordinates, independent of terrain mesh level. This allows much finer display sampling than stretching the global atlas or a whole 21-km terrain tile across a close view. A hysteresis margin reuses the window until the view moves or changes scale enough to require a redraw. The window blends into the global atlas at its perimeter and wraps longitude when drawing across the dateline. No terrain vertices or collision surfaces change.

The sharp window uses approximately 9.3 MiB estimated canvas/GPU/mipmap storage. The smoothed variant also retains a soft window of up to 1024 × 1024, bringing the persistent window estimate to at most approximately 18.7 MiB. Temporary filter canvases and replacement textures add working memory beyond that counter. Both textures are released when selecting the original/baseline palettes, leaving the Moon, or looking outside supported close-view coverage. Polar detail fades from 78° to 80° latitude; this does not resolve existing polar source/mesh artifacts. All selected-release vector tiles are still fetched and their compiled paths retained; this is adaptive **rasterization**, not yet adaptive vector delivery. Hardware performance, frame-time cost during navigation, combined browser memory, and arbitrary grazing-angle coverage remain quality gates.

## Fixed surface-space color transition

The smoothed mode uses a Gaussian field with **120 m sigma**, approximately **300 m between 10% and 90% of a straight color transition**. This width is a material parameter in Moon coordinates. The shader does not fade between hard and blurred boundaries based on camera distance. Zooming changes display sampling and how much ground is visible, rather than changing the material itself. At a whole-Moon scale the band is unresolved; nearby it occupies a meaningful part of the view.

The renderer draws neighboring vector geography out to four sigma beyond the window before filtering and cropping. This halo prevents mixtures from being clamped to the current view and keeps overlapping windows consistent. Sampling uses approximately square physical pixels, accounting for longitude's latitude-dependent ground scale. Pixels are bounded at 2 m minimum pitch and 1024 samples per axis; bilinear/mipmap filtering handles display sampling. The global atlas is a coarse area-filtered representation and cannot resolve the 300 m band itself; existing polar fallback remains separate.

Colors are encoded in **linear light before compositing and Gaussian filtering**, then uploaded with `LinearSRGBColorSpace`. CSS filter functions operate in sRGB component space ([W3C Filter Effects](https://www.w3.org/TR/filter-effects-1/)), so deliberately storing linear components makes their arithmetic a linear-light mixture rather than a gamma-encoded brightness blend. This is an appearance model from image-derived colors, not a calibrated lunar photometric material.

## Checks

`npm run moon:check-vectors` runs against Vite at `http://127.0.0.1:5173` (override with `VECTOR_PREVIEW_URL`). It captures matched original/6/10/16-color views on the same globe geometry, checks classified source samples at tile corners against the vector-rendered atlas, and exercises camera preservation, restoring the original, rapid cancellation, missing-tile fallback, and phone controls. `npm run moon:check-vectors -- --terrain` separately checks visible measured-terrain map replacement and captures polar, dateline, and close views. Terrain selection can continue streaming during those captures; they are functional mapping checks, not settled LOD acceptance. Artifacts go to `.terrain-cache/moon-vectors/browser/`. These browser checks use Chromium; software rendering is not hardware performance acceptance.

Both browser commands passed on 2026-11-02 with no page/shader errors. All three palettes preserve the 128 classified samples at tile corners, including image edges. The 103 existing tests and the lean production build pass. Visual inspection confirms recognizable maria and bright rays at globe scale, stronger posterization with six colors, and broad uniform patches nearby. The north-polar capture still shows severe radial streaking: this experiment does not resolve the existing polar source/mesh limitations. Close-view sharpness and polar quality remain unaccepted.

The contour follow-up includes `npm run moon:test-contours` (nine geometry tests), the 103 existing tests, and the lean app build. Geometry tests cover shared quadratic tangents and flattened face coverage, protection of unrelated islands, and vertices exactly on tile cuts. `npm run moon:check-contours` captures the diagonal/smoothed/baseline views and verifies exported interior samples, actual GPU pixel changes with close redraw enabled, stationary window reuse, dateline wrapping, source-tile boundaries, polar fallback, texture disposal when returning to the original or leaving the Moon, rapid cancellation, and phone controls. Smoothed interior sample expectations use linear-light encoded palette values.

`npm run moon:check-soft-boundaries` independently measures the physical 10–90% transition at several camera distances and compares the same ground samples after moving the window. It also verifies linear-light values, dateline halo wrapping, actual GPU softening, distant appearance, cleanup, phone controls, and bit-identical expansion of a compact curve fixture against native SVG quadratic paths. Native complementary curved masks may differ from full coverage by a few quantized alpha levels; production composites the residual to opaque after summing all regions.

Artifacts are in `.terrain-cache/moon-vectors/contours/` and `.terrain-cache/moon-vectors/soft-boundaries/`. The close-up button centers on an actual quadratic section near Hadley. These are color-rendering checks and do not establish general terrain LOD stability, accepted polar quality, real-hardware performance, or a physically calibrated material model.

The quadratic/fixed-material follow-up passes the 103 existing tests, nine geometry tests, lean app build, and both browser commands. The independent linear-light fixture measures approximately 298–301 m transition widths at 500/1,000/2,000 m camera heights. The same ground samples change by at most half a linear-byte level across those zooms, and remain consistent after a 650 m window translation. Compact curve expansion is pixel-identical to the native quadratic reference. Use full rendered screenshots for color assessment: raw patch PNG captures now contain linear-encoded values and appear dark in ordinary image viewers.
