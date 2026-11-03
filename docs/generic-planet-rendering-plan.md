# Generic planet rendering review and implementation plan

Reviewed November 3, 2026 against the current working tree, including its
uncommitted Moon/Mars color and global hillshade implementation. This is a
planning document. The first consolidation is now implemented; see
[implementation and validation](planet-rendering-consolidation.md). The later
user decision supersedes the proposed Moon/Mars settings panel below: these
bodies use fixed defaults without rendering toggles, color selectors or
location shortcuts. [Mercury is now integrated](mercury-surface.md) through
the same renderer with measured visible-band color and the installed global DEM.

## Recommendation

Consolidate the existing Moon/Mars approach into a configurable solid-surface
renderer. Keep a shared body-rendering interface with separate solid-surface
and cloud/atmosphere implementations. Adopt Mercury next, then Venus surface
mode, and integrate Earth through provider interfaces. Add giant-planet
cloud rendering as a separate implementation behind the shared interface.

Retain these Moon/Mars defaults: measured terrain on, true-scale relief,
compact continuous color, DEM-derived cartographic hillshade on, and generated
normal/roughness detail on. Preserve Moon's current shadow setting during
migration only as an explicit requested setting: lunar terrain currently does not
cast shadows despite the enabled toggle. Restore and validate effective lunar
self-shadowing separately; enable it on additional bodies after visual validation.

## What is implemented now

| Layer | Moon | Mars | Assessment |
| --- | --- | --- | --- |
| Base geometry | Equiangular cube sphere | Equiangular cube sphere | Already shared through `cubeSphere.ts` |
| Terrain | `CubeTerrainLayer`, geographic LOLA release, 129 samples, source level 8 | Same renderer, geographic MOLA–HRSC release, 129 samples, source level 9 | Already uses a generic numeric `PlanetHeightSource` adapter |
| Default color | Continuous 4096 × 2048 compact WebP from NASA CGI Moon Kit | Continuous 4096 × 2048 compact WebP from MOC-WA | Same `PlanetColorTexture`; Mars-named module is a compatibility export |
| Comparison color | Same-source PNG, original 8K JPEG, experimental vector variants | Same-source PNG, Viking fallback, previous ten-region variant | Useful review tools, unnecessarily body-specific application code |
| Hillshade | On; streamed global DEM-derived field, approximately 1 km | Same | Independent of mesh LOD, shared shader and paging implementation |
| Close material detail | On; generated normal/roughness maps | On; different physical repeat scales | Shared implementation still named `moonSurfaceMaterial` |
| Cast shadows | Toggle on; focused light active close up, but cube terrain does not cast shadows | No Mars shadow control or activation through the current close-terrain predicate | Neither currently provides terrain self-shadowing |

The installed Moon manifest reports approximately 118 m source spacing; Mars
reports a 200 m grid. These are source-grid descriptions, not guarantees of
uniform measured detail. Mars combines partial HRSC coverage with MOLA and
records a reference-sphere approximation.

The cube sphere describes the **render mesh**, not the storage projection.
Six equiangular quadtrees avoid the latitude/longitude mesh singularity at the
poles. `PlanetHeightSource` samples the measured geographic elevation release
onto those meshes. Color and hillshade remain geographic maps sampled from
body-fixed directions. Keep this separation; harmonization does not require
rebaking all source data into cube faces.

Color is continuous imagery today; smoothed vector regions are comparison
modes, not the default. The compact color files are bandwidth optimizations:
a 4096 × 2048 RGBA texture with mipmaps still uses approximately 42.7 MiB of
GPU memory. The current hillshade pool adds approximately 8.25 MiB GPU plus
8.25 MiB CPU upload storage per allocated pool, with metadata/fallbacks extra.
Terrain has a separate 256 MiB accounting ceiling and approximately 400,000
visible-triangle budget. These are separate allocations, not a total app cap.

Global hillshade replaces mesh-derived hillshade where available. It is a
body-fixed cartographic contrast treatment multiplied into diffuse color
before physical lighting. It remains true-scale when geometry is exaggerated.
It neither follows the current Sun nor casts shadows. Hillshade on therefore
means the default appearance is an enhanced visualization, not pure solar lighting.

Primary code: `src/ExplorerScene.ts`, `src/App.tsx`, `src/CubeTerrainLayer.ts`,
`src/PlanetHeightSource.ts`, `src/PlanetColorTexture.ts`,
`src/GlobalHillshadeLayer.ts`, `src/terrainHillshade.ts`,
`src/moonSurfaceMaterial.ts`, and `src/cubeColorMaterial.ts`.
See [the existing implementation report](global-surface-results.md) for prior
validation evidence; its browser/test results were not rerun for this review.

## Gaps to address

1. `ExplorerScene` repeats body lists, color loading, request generations,
   uniforms, shader setup, update calls, fallbacks, and disposal. Several
   reusable classes still restrict bodies to `'moon' | 'mars'`.
2. Shader hooks compose through ordered string replacement. Mars's cube color
   hook replaces the color hook installed by the shared detail material; Moon
   uses the detail material's sampling/sharpening path. Define one geographic
   color sampler and an explicit per-profile sharpening setting before merging.
3. UI controls and status text use separate Moon/Mars conditions. Some toggles
   mutate both bodies, while displayed settings are separate React state.
   Report requested and effective fallback modes consistently after failures.
4. Terrain validation embeds body-specific sample-size, frame, scale, and
   maximum-level rules. These need validated descriptors, not weakened checks.
5. Hillshade runtime assumes six levels and a fixed value range; the baker
   chooses widths with a Moon/other-body branch. Expose configuration where
   necessary and select derivative spacing/output density from source quality.
6. Texture setup begins loading both Moon and Mars color/detail at startup.
   Extend to more bodies with lazy loading and explicit inactive-body budgets.
7. Mercury/Venus already have measured geographic releases but still use
   `GlobeTerrainLayer`. Earth has a separate regional DEM/imagery path.
8. Moon cube terrain sets `receiveShadow = true` but never sets `castShadow`;
   Three.js meshes default to non-casting. Older global/regional terrain paths
   explicitly disable casting too. The toggle enables the focused shadow light,
   not terrain casters. The base globe casts, but cannot represent crater/ridge
   occlusion. Restore terrain casting only alongside visual checks for the known
   moving-shadow artifacts. A successful hillshade migration cannot close this issue.

## Target design

```text
BodyRenderProfile + per-body user settings
                  |
          BodySurfaceRenderer interface
                  |
        +---------+------------------+
        |                            |
 SolidSurfaceRenderer       CloudAtmosphereRenderer
        |
 cube-sphere mesh and deterministic LOD
        +-- HeightProvider: measured geographic DEM / regional adapter
        +-- ColorProvider: compact global image / streamed imagery
        +-- HillshadeProvider: optional measured-DEM shading pyramid
        +-- MaterialProfile: roughness, body-fixed generated detail
        +-- LightingProfile: Sun, fill, validated close shadows
```

Proposed modules and contracts:

- `planetRenderProfiles.ts`: geometry family, shape/reference radius, coordinate
  frame, provider references, capabilities, default settings, detail scales,
  sharpening policy, and quality budgets. Keep scientific data provenance in
  validated asset manifests, referenced by these profiles.
- `PlanetSurfaceRenderer.ts`: common lifecycle (`update`, `setSettings`,
  `metrics`, `dispose`) and optional surface queries (`hitGround`,
  `cameraSurfaceRadius`). Cloud bodies explicitly lack terrain picking.
- `SolidSurfaceRenderer.ts`: owns the base globe, cube terrain, providers,
  material, and effective settings for one body. Move existing logic behind
  this owner incrementally rather than rewrite LOD.
- `planetSurfaceMaterial.ts`: extract the existing detail shader with neutral
  names and explicit options. Share direction-to-geographic sampling, wrapped
  derivatives, color-space handling, and shader cache keys across base/terrain.
  Preserve coverage, regional clipping and depth-material behavior.
- Provider contracts distinguish projection/storage, source resolution,
  coverage/NoData, reference frame/datum, and loaded/error/fallback states.
  Keep separate height/color/hillshade releases with hashes and attribution;
  reference compatible releases from a body surface descriptor.
- One capability-driven settings panel: Terrain, Relief, Color, Hillshade,
  Surface detail, Shadows. Store user choices per body. Unsupported features
  are absent; unavailable supported data produces a truthful fallback status.
  Put original/reference/vector comparisons in an advanced comparison section.

Keep shader stages explicit: geographic color → optional cartographic hillshade
→ material normals/roughness → Sun/fill/shadows. Generated detail remains
shading-only. Add a solar-lighting comparison preset with hillshade off;
do not claim scientific photometry from the existing exposure/fill/material model.

## Extension order and defaults

| Body | Proposed use of shared system | Initial policy |
| --- | --- | --- |
| Moon, Mars | Reference implementations | Preserve accepted appearance and existing defaults; fix shared ownership first |
| Mercury | First new cube-terrain profile using installed MESSENGER DEM | Terrain/true scale on; retain clearly labeled enhanced color initially; DEM hillshade on after validation; generated detail and cast shadows off until separately accepted |
| Venus | Cube-terrain surface mode using installed Magellan DEM; separate cloud mode | Label surface imagery as radar; radar hillshade off initially to avoid adding a second relief treatment; optional DEM-relief view with hillshade on; no unsupported optical material claims |
| Earth | Common lifecycle/settings with existing regional height and streamed imagery providers | Preserve imagery, camera safety and regional terrain; cartographic hillshade off initially; retain validated Earth lighting behavior |
| Jupiter, Saturn, Uranus, Neptune | Cloud/atmosphere renderer with shared lifecycle, orientation, quality controls and optional rings | No ground DEM, terrain exaggeration, terrain hillshade, or terrain picking; add cloud layers and atmosphere incrementally |

Mercury currently uses an enhanced-color display product, so converting its
file format does not produce natural color. Evaluate corrected reflectance
bands as a separate data decision. Venus radar brightness likewise is not
visible-light albedo. Its installed DEM is approximately 4.6 km spacing; do not
bake nominal 1 km hillshade and imply 1 km measured relief.

External context: [USGS Mercury enhanced-color product](https://astrogeology.usgs.gov/search/map/mercury_messenger_mdis_basemap_enhanced_color_global_mosaic_665m),
[USGS Venus Magellan products](https://astrogeology.usgs.gov/search/map/venus-magellan-global-products),
[NASA Jupiter facts](https://science.nasa.gov/jupiter/jupiter-facts/), and
[NASA Neptune facts](https://science.nasa.gov/neptune/neptune-facts/).
USGS product search metadata was available during review, but direct page
fetches returned 403; source downloads/licensing/delivery must be verified
before adopting new products. No new archive ingestion is assumed by this plan.

## Implementation sequence and completion gates

1. **Capture the current baseline.** Record defaults, shader behavior, source
   identities, screenshots, requests, CPU/GPU allocations and timings for both
   bodies. Include Hadley, Tycho, Valles, poles, dateline, cube edges/corners,
   orbital/close views and stationary/moving cameras. Resolve baseline failures
   explicitly so migration does not hide them. Preserve current navigation.
2. **Introduce profiles and common ownership.** Add Moon/Mars profiles, shared
   settings/state, renderer lifecycle and generic status callbacks. Parameterize
   color dimensions/URLs, hillshade configuration and detail profiles. Preserve
   compatibility exports while call sites migrate. Gate: both bodies retain
   appearance, defaults, fallbacks and source identity; no additional startup loads.
3. **Consolidate materials and UI.** Use one tested geographic sampler, explicit
   shader composition, and capability-driven controls. Match each body's
   existing sampling/sharpening deliberately. Lazy-load comparison assets and
   inactive bodies. Gate: color/detail/hillshade toggles cause no terrain rebuild,
   selection changes or geometry displacement; rapid mode switches cannot apply
   stale results, leak bitmaps, or misreport the effective mode.
4. **Migrate Mercury end to end.** Parameterize validation and hillshade builds
   using the installed release; route Mercury through cube terrain and shared
   color loading. Gate: adding Mercury requires a profile/asset adapter rather
   than new scene/UI branches; geographic source samples and visual seams pass.
   Profile on actual hardware before selecting device budgets or shadow defaults.
5. **Add Venus surface mode.** Reuse the solid core with Magellan data, explicit
   radar semantics, appropriate source-resolution limits and fallback coverage.
   Gate: no fabricated fine terrain or color, and radar/relief modes are clear.
   Add cloud mode separately with explicit surface/cloud selection.
6. **Integrate Earth adapters.** Share lifecycle, settings and accounting first.
   Retain Web Mercator color and regional height providers. Consider global
   cube terrain only after projection, ocean, regional replacement and precision
   regressions pass and profiling shows a benefit. Earth does not block Mercury.
7. **Implement giant-planet rendering.** Add cloud appearance, shape/oblateness,
   atmosphere and rings behind the same lifecycle. Gate: capability controls,
   camera limits and provenance accurately describe an atmospheric body.
   Shape support must precede any claim of accurate giant-planet silhouettes.

Each stage should be a reviewable change with browser evidence before proceeding.
New measured color/material datasets and compressed GPU formats are follow-up
optimizations, not prerequisites for consolidating the current renderer.

## Validation and resource policy

- Retain numeric source checks, hashes, NoData, pole/dateline and parent alignment
  validation. Validate frame/radius/vertical datum compatibility across layers.
- Keep deterministic metadata-based LOD, parent retention until complete child
  replacement, hysteresis and mixed-LOD stitching independent of cache residency.
- Exercise actual WebGL color orientation, wrapped texture gradients, polar
  sampling, shader combinations and hillshade page arrival/neighbor transitions.
- Visually inspect fixed-camera loading, camera pans, body rotation/date changes,
  close zoom and exaggerated relief. Compare hillshade independently from solar
  lighting. Validate cast shadows at low Sun and during camera motion separately.
- Exercise missing catalogs, corrupt pages, delayed/superseded decodes, rapid
  body switches, offline recovery and disposal. Count color, decoded bitmaps,
  terrain, metadata, hillshade CPU/GPU buffers and shadow maps separately.
- Apply a device-level total budget plus per-provider limits. Release inactive
  fine pages and large comparisons; keep small whole-body fallbacks. Begin with
  current limits as ceilings and tune from actual-device measurements, including
  phone layouts and interactions. Software-renderer timings are insufficient.
- Reuse the existing unit, pipeline and browser checks, parameterizing them for
  profiles. Require `npm test`, `npm run build:app` and affected visual/source
  checks for implementation stages; no renderer tests are needed for this
  planning-only document.
- Publish terrain/hillshade as immutable external releases with compatible
  catalog selections, bundled fallbacks and documented hosting/CORS. Preserve
  rollback to previous profile/catalog references; do not regenerate accepted
  scientific releases merely to rename client modules.
