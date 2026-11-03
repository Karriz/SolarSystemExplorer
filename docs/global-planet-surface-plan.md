# Moon color and global Moon/Mars hillshade plan

Reviewed November 3, 2026. Status: implemented; see [results and hosting](global-surface-results.md).
Original review target: compact continuous Moon color and globally
available, approximately 1 km hillshade enabled by default for Moon and Mars.

## Findings

The Mars color result is reusable: one continuous image preserves the source
without classification boundaries or runtime vector-path compilation. Its
loader is currently Mars-specific, with hard-coded dimensions and filenames.
Moon still starts the smoothed vector path and its adaptive close-view redraws.

The Moon's current original image is 8192 × 4096, 5,768,687 bytes. Its configured
source is NASA's 2025 CGI Moon Kit. NASA describes three-band LROC-derived color,
with visual exposure/white-balance adjustment and lower-resolution monochrome
fill at high latitudes. Preserve that product's appearance and provenance;
do not label it untouched scientific RGB or expect compression to repair its
polar source limitations. Source: https://svs.gsfc.nasa.gov/4720/ .

Read-only recompression benchmarks of the existing JPEG gave:

| Candidate | Encoded size | Local encode time | Mean sRGB channel error |
| --- | ---: | ---: | ---: |
| 4096 × 2048, WebP Q90 | 1,498,748 bytes | 0.86 s | 1.64 |
| 4096 × 2048, WebP Q95 | 2,302,768 bytes | 0.89 s | 1.11 |
| 8192 × 4096, WebP Q90 | 5,077,774 bytes | 9.47 s | 1.46 |
| 8192 × 4096, WebP Q95 | 7,732,254 bytes | 9.55 s | 1.03 |

These are preliminary transport estimates, not source-quality acceptance.
The 4K errors are measured against a 4K downsample, so they exclude the loss
from reducing 8K to 4K. The original 16-bit TIFF should be the implementation
reference, avoiding another generation of JPEG loss. Compare sizes again from
that source, using linear-light downsampling. WebP is not automatically smaller
at every quality: 8K Q95 is larger than the existing JPEG.

RGBA GPU allocation with mipmaps is about 42.7 MiB at 4K and 170.7 MiB at 8K.
Recommend testing a 4K default against 8K before choosing: preserve Tycho rays,
maria, subtle hue differences, and far-side markings. If the 4K loss is visible,
use tiled higher-resolution color rather than requiring a full 8K upload on
every device. Keep the existing original and vector modes for comparison.

The current hillshade loader is a Valles-only atlas capped at 4096 pixels per
axis, with hard-coded bounds. It cannot serve global high-resolution data as-is.
The baker also uses latitude/longitude derivative offsets unsuitable at the
poles and omits the global Mars seam/NoData repairs already in the terrain
source adapter. Reuse the verified geographic elevation sampler, not that
bounded prototype's assumptions.

Both normalized DEMs are already cached: Moon LOLA LDEM_256 and Mars MOLA–HRSC.
The geographic measured sources remain authoritative; there is no need to
rebuild or change the terrain releases or rendering mesh projection.

## Proposed architecture

### Continuous color

Generalize the Mars image loader and offline comparison tooling into a
body-configured color path. Retain cancellation, late-bitmap cleanup, correct
sRGB sampling, fallback, and same-source reference modes. Each body gets its
own resolution, provenance, and quality thresholds. Do not introduce a common
palette, reinterpret colors through a legend, or alter exposure to hide errors.
The normal Moon default should no longer request vector paths or build color
windows; old modes remain available during review.

### Global hillshade build

1. Preserve the accepted multidirectional formula and slope accent outside
   special polar handling. Bake from the measured DEM at approximately 1 km
   equatorial delivery spacing, with the pilot's approximately 300 m derivative
   baseline initially retained. Record that baseline separately from output
   spacing and source resolution.
2. Use geodesic neighborhood samples, the existing source-specific longitude,
   pole, missing-data and Mars dateline handling, and a consistent physical
   tangent frame. A compass-based northwest direction is undefined at a pole:
   prototype a smooth azimuth-independent polar blend before the global bake.
   A new texture projection alone would not fix that directional singularity.
3. Average fine shading samples before quantization. Build coarser levels by
   filtering the resulting linear multipliers, not by shading increasingly
   coarse DEMs. This preserves mean relief contrast during zoom transitions.
4. Deliver single-channel numeric tiles, initially 256 × 256 interiors with
   tested gutters. Keep longitude periodic and generate boundary neighborhoods
   from a shared global sampling grid. Missing measurements produce neutral
   multipliers with explicit coverage handling.
5. Build in bounded, resumable parallel jobs, outside published assets. Record
   source hashes, coordinate conventions, scale, filter parameters, coverage,
   tile lengths/checksums and actual compressed sizes in versioned manifests.
   Validate before atomically selecting the completed release in a catalog.

Geographic output tiles are the initial choice: they reuse the existing
coordinate/source contract and scalar-texture shader. Cube meshes keep their
current projection. Cube-face delivery can be reconsidered only if profiling
shows a concrete advantage.

### Independent streaming and rendering

- Select shading detail from projected texel footprint, frustum and horizon,
  independently of geometry LOD and geometry residency. Use immutable geographic
  bounds rather than loaded meshes to decide requests.
- Bundle a tiny whole-body fallback derived from the same finest shading field.
  Load it when a body is needed; request sharper visible tiles progressively.
- Use a bounded R8 page pool, preferably a texture array with an indirection
  table shared by the body's base globe and all terrain materials. The installed
  Three.js version supports array-layer updates. Prototype upload and filtering
  behavior before committing: avoid regenerating a whole array's mip chain for
  every arriving page. The offline pyramid can supply explicit filtered LODs
  with parent/child blending instead.
- Begin with 8–16 MiB of resident hillshade GPU pages plus small fallbacks/page
  tables, at most four concurrent requests, separate decoded-CPU accounting,
  and a measured combined budget alongside geometry and color. Reuse/release
  fine pages when changing bodies; do not keep two full fine caches by default.
- Keep parents drawable until replacements are usable; blend residency/LOD
  changes without briefly exposing empty pages. Test bilinear filtering,
  gutters, parent transitions and grazing views for seams and shimmer.
- Replace the mesh hillshade contribution where detailed shading is ready;
  never multiply both. Actual Sun lighting, shadows, silhouettes and picking
  remain geometry-driven. Baked hillshade continues to represent true-scale
  relief when geometry exaggeration is selected, as in the accepted pilot.
- Enable detailed global hillshade by default for Moon and Mars. Keep one clear
  Hillshade on/off control and expose comparison modes through diagnostics
  during review. A failed tile falls back locally and retries; it must not turn
  off the entire body's shading.

Publish bulk shading separately from ordinary bundled textures, with a
configurable same-origin/external base URL. Extend Vite's generated-data watcher
exclusions and lean-build copy rules: the current lean build excludes terrain
but would otherwise copy every new global hillshade file into app output.

## Cost expectations

At exactly 1 km equatorial geographic sampling, one-byte global shading is
approximately 57 MiB for Moon and 216 MiB for Mars, or about 364 MiB combined
including lower-resolution levels. Tile-grid rounding, gutters, manifests and
fallbacks add overhead. These are archive figures, not per-view downloads.

Six review tiles, each 256-square at 1 km equatorial sampling, compressed to
32–47 KiB on the Moon and 14–23 KiB on Mars. They took approximately 0.6–1.0 s
each to sample, shade, average, quantize and gzip serially. Those samples do not
establish global compression or polar quality. Reserve a provisional 150–300
MiB compressed archive budget for both bodies and measure the real release.
Expect an offline job on the order of tens of minutes serially; profile bounded
parallelism and a representative strip before scheduling full builds. Runtime
does not resample DEMs to produce these textures.

The resident hillshade pool is small, but color remains a separate allocation:
roughly 43 MiB GPU at 4K per active color map, plus terrain and other materials.
Report actual combined CPU/GPU estimates and distinguish them from total
browser/device memory. Download savings alone do not prove a mobile memory win.

## Implementation order and acceptance

1. **Moon color:** obtain/hash the original NASA source; compare continuous 4K
   and 8K candidates under neutral and identical lit views. Generalize the
   shared loader, choose the smallest visually accepted candidate, and enable
   it as Moon default. Preserve old modes for direct comparison.
2. **Streaming prototype:** build small Moon/Mars regions plus dateline and both
   polar caps. Exercise the R8 page pool, independent selection, fallback,
   boundary handling and upload costs before generating thousands of tiles.
3. **Global releases:** resume parallel builds, validate coverage and all
   neighbor/pyramid seams, publish immutable catalog entries, and verify actual
   archive size/build time against budget.
4. **Default rollout:** enable global detailed hillshade on both bodies, remove
   Valles-only assumptions, and verify color/shading controls and fallback in
   the production build/hosting layout.

Required visual cases include Moon Hadley/Tycho/maria/far side and Mars
Valles/Arabia/Syrtis/Olympus, plus both poles, dateline and cube-face boundaries
for each body. Compare orbital, regional, near-ground and grazing views under
frontal and low Sun. Include fixed-camera loading/eviction and camera-motion
comparisons, with geometry held fixed for the independent-shading checks.
Verify independent source samples on actual WebGL, deterministic requests,
failure/retry/cancellation/disposal, body switching, phone controls, and tracked
budgets. Run the test suite and lean build. Software-renderer coverage is not
real desktop/mobile GPU performance acceptance.

Review artifacts: `.terrain-cache/global-surface-review/moon-codec.json` and
`hillshade-samples.json`. Only this plan and temporary benchmark artifacts were
added by the review; existing runtime changes belong to earlier work.
