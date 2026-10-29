# Terrain and surface-detail upgrade plan

Updated: 2026-10-30  
Status: Earth LOD, hosted color, focused shadows, and view-centered coverage implemented; full quality/hardware acceptance remains open. See [pilot results](terrain-pilot-results.md) for source downloads, derived sizes, validation, and remaining quality/performance gates.

## Implementation status

The shifting spikes have now been reproduced in Brave on localhost and traced to privacy-induced canvas pixel changes, not ordinary source uncertainty. Earth elevation now uses direct libwebp WASM decoding; numeric heights bypass canvas readback. Independent pixel checksums and a Brave before/after comparison verify the correction. See [confirmed cause and validation](terrain-pilot-results.md#confirmed-spike-cause-privacy-protected-canvas-readback).


Earth now streams native Mapterhorn tiles around the view beyond the three location bookmarks. Worker output is 129×129 heights; meshes use 33/65/129 samples according to level, capped at zoom 15. Selection hysteresis, measured surface bounds, welded mixed-density edges, a 32-visible-leaf/400,000-triangle cap, and a 48 MiB estimated cache control refinement. Hidden GPU meshes are evicted before retained height grids; zooming out rebuilds parent geometry locally. Ground clearance uses cached terrain independently of visibility.

Hosted Sentinel-2 / WorldCover 2021 RGB is mapped directly onto the measured meshes using Web Mercator UVs. It uses independent zoom-14/32 MiB/three-request limits and bundled color fallback. The provider's live KVP WMTS endpoint and browser CORS were checked; no preprocessing or local color archive is required. Acquisition lighting remains in the satellite color. Focused Earth/Moon shadows are restored, exclude skirts, have an on/off control, and fade at 30–50 km altitude. Earth's procedural grain, classification, raster slope override, and overlapping imagery shell remain disabled.

The Hadley SLDEM2015 overlay remains 341 tiles at approximately 118 m sampling. No other planetary archives were regenerated. Source-boundary blending, full geographic/datum validation, combined memory measurement, and real desktop/mobile GPU performance remain open. The bounded lunar manifest does not replace hierarchical metadata for future large overlays. See [current results](terrain-pilot-results.md#earth-lod-color-and-coverage-follow-up) for browser evidence and limitations.

## Objective

Improve measured terrain and dynamically lit surface appearance while balancing download size, offline processing, browser memory, and visible detail. Support exploration down to the current 100-meter camera limit without implying that every location has meter-scale measured topography.

Use the existing global elevation datasets as fallbacks, stream better regional data where worthwhile, and reserve the finest datasets for selected exploration destinations. Add procedural material detail below the scale resolved by measured elevation.

The material research and source limitations are documented in [Surface material options](surface-material-options.md).

## Review outcome: medium-distance accuracy first

The first deliverable is a geographically recognizable, dynamically lit planet at medium distance, followed by plausible material detail nearby. A 100 m camera limit is a navigation capability, not a promise of 100 m or better measured terrain everywhere.

Use three independent layers:

| Layer | Responsibility | Expansion rule |
| --- | --- | --- |
| Measured terrain and regional color | Known landforms, silhouettes, coastlines where supported, regional brightness/color patterns, and correctly aligned illumination | Improve only where source quality and projected error justify the cost |
| Surface materials | Dust/rock/vegetation/water/snow behavior, based on observed classes or explicitly inferred rules | Start with a small shared material library and coarse controls; introduce finer masks selectively |
| Procedural close detail | Stable grain, roughness, small normal variation, and eventually bounded microgeometry | Add appearance below measured resolution without moving known geography or manufacturing large landforms |

Do not fade measured regional identity into generic noise as the camera approaches. Legitimate observed color features can be smaller than the DEM spacing; they should not be blurred away merely because elevation is coarser. Material detail must preserve the regional mean color through its LOD transition.

Medium distance is defined by projected features, not one altitude for every body. For reference, at 48° vertical FOV and a 1080-pixel-high viewport, the locally flat, nadir-view footprint is approximately:

| Altitude | Vertical footprint | Ground distance per screen pixel |
| --- | --- | --- |
| 100 km | 89 km | 82 m |
| 10 km | 8.9 km | 8.2 m |
| 1 km | 890 m | 0.82 m |
| 100 m | 89 m | 0.082 m |

These are illustrative camera calculations, not dataset guarantees; grazing views, curvature, viewport size, and feature height change the requirements. Target approximately 1–2 pixels of mesh approximation error relative to the available source surface as an initial tuning goal. Source uncertainty is separate and may be much larger. Do not interpret this target as absolute geographic accuracy or generate denser geometry just to conceal missing measurements.

The planned 120 m and 60 m lunar tiers are candidate source/sampling scales within one hierarchy, not mandatory separate full-planet archives. Meter-scale lunar/Mars destinations, global high-resolution classification, a more elaborate lunar reflectance model, and Venus stereo processing are optional expansions after the medium-distance milestone passes.

## Decisions

- Evaluate Mapterhorn as the primary streamed Earth elevation source.
- Preserve the existing Moon, Mars, Mercury, and Venus global datasets as fallbacks.
- Prioritize shared terrain improvements, then Moon, Mars, Mercury's north pole, and selected Venus regions. Run the Earth source pilot early to validate streaming and resource budgets.
- Keep download resolution, mesh resolution, and material detail independent.
- Introduce regional overlays instead of requiring every finer level to cover an entire planet.
- Store larger terrain releases separately from the initial application bundle. Do not make routine development builds copy the full high-resolution dataset.
- Keep measured elevation, inferred surface classes, and generated detail distinguishable in metadata and documentation.
- Keep the terrain plan authoritative for shared implementation order; the surface study supplies material choices rather than a competing rollout sequence.
- Do not require every geological or material map before shipping the first improvement. Use observed regional color and a clearly marked provisional material mask where necessary.

## Per-body data strategy

| Body | Retained baseline | Recommended upgrade | Limit on initial scope |
| --- | --- | --- | --- |
| Earth | Small coarse globe fallback; no Earth terrain adapter existed at review time | Stream Mapterhorn elevation, using approximately 30 m global source coverage and finer regional sources where available | Test three representative areas before broad rollout; no bundled global high-resolution archive |
| Moon | Existing approximately 474 m LOLA source | Trial approximately 120 m sampling of SLDEM2015 in representative regions; retain approximately 60 m source detail only where the visual comparison warrants it | No full-belt or full-globe fine rebuild in the first milestone; retain LOLA outside 60°S–60°N; meter-scale sites are optional later work |
| Mars | Existing approximately 463 m MOLA source | Add a small number of contiguous HRSC regional overlays, with a processed sampling scale chosen from medium-view comparisons up to the approximately 50 m source detail | Do not download/process the full 200 m blend by default; evaluate a regional extract if it is simpler than the direct HRSC path; HiRISE is optional later work |
| Mercury | Existing approximately 665 m MESSENGER global source | Add improved 250 m north-polar topography covering 65–90°N | Start with the bounded polar dataset; defer other regional overlays until their benefit is demonstrated |
| Venus | Existing Magellan dataset on an approximately 4.6 km grid | Evaluate approximately 1–2 km radar-stereo topography in selected regions | Keep the global baseline; prioritize materials and atmospheric illumination over extensive elevation processing |

These figures describe source or proposed output grid spacing, not guaranteed effective resolution or elevation accuracy. In particular, the documented 200 m Mars blend includes finer HRSC coverage over 44% of Mars; elsewhere it interpolates MOLA. Venus's sampled grid also does not imply uniformly measured detail at that spacing.

## Availability and acquisition gates

Documentation availability, a downloadable numerical raster, browser access, and a production-ready service are different states. Do not mark an adapter ready from a map preview or paper alone.

| Candidate | Evidence reviewed | What must be proven before adoption |
| --- | --- | --- |
| Mapterhorn | Documented XYZ/TileJSON endpoint, PMTiles distribution, and advertised source coverage | Real tile decoding and channel fidelity, browser CORS, response sizes/timeouts, delivered resolution by latitude, source transitions, polar and outage fallback |
| SLDEM2015 | NASA product documentation and partitioned IMG/JP2 download listings; some documentation requests timed out during review | Fetch a real region, confirm checksum/projection/heights/NoData and compatible terms, then measure conversion and source granularity costs |
| HRSC / 200 m blend | Team regional distribution page and USGS metadata for an approximately 11 GB blended source | Identify actual numerical DEM granules; confirm coverage, usable access, datum and terms; prove range reads or account for a whole-file download |
| Mercury north pole | NASA lists a 250 m elevation GeoTIFF and measurement-count companion, with an approximately 260 MB elevation source | Download and validate a sample; align the updated reference frame and datum; assess sparse measurement areas |
| Venus stereo | Research establishes regional stereo topography, but a suitable first numerical product has not been selected | Find a distributable elevation raster with usable metadata, coverage, and terms before scheduling conversion; otherwise defer the upgrade |
| Surface classifications | WorldCover and selected planetary geology/property products have documented distributions | Start with one region; verify numeric/class data rather than shaded previews; preserve confidence, epoch, and class semantics |

For each candidate, record the exact URL/version, source terms and attribution, checksums when available, download granularity, compressed input size, normalized working size, conversion time, and output size. A small output crop does not necessarily mean a small source download. Never substitute 404/timeouts with invented high-resolution terrain: retain the last valid coarser source and bounded retry/backoff.

Source license metadata must be preserved per adapter. The current builder writes a generic public-domain license; it must not apply that label to new sources such as the HRSC/MOLA blend, whose metadata includes HRSC CC BY-SA 3.0 IGO terms. Source provenance and terms must travel with derived releases.

## Phase 1: Shared terrain foundation

- [ ] Measure the current source-to-tile-to-mesh resolution chain and record where detail is lost.
- [x] Improve Earth tile sampling and runtime refinement before acquiring larger datasets (129-sample worker grids, adaptive mesh densities, geometry eviction, bounded refinement). Other bodies retain their existing limits.
- [ ] Extend the existing full-coverage tile contract to support optional regional overlays, coverage masks, and fallback selection.
- [ ] Replace fixed-depth metadata pages with bounded hierarchical/sparse paging before enabling deeper levels. The current zoom-3 pages, 512,000-byte page limit, and complete-coverage validation do not scale merely by raising the maximum-level cap of 8.
- [ ] Record source resolution, effective resolution where documented, uncertainty/NoData, coordinate frame, vertical datum, version, and attribution for each source.
- [ ] Normalize horizontal coordinates and height references before blending datasets. Preserve valid gaps instead of filling them with unmarked invented terrain.
- [ ] Blend source boundaries without visible height steps, cracks, or abrupt normal changes.
- [x] Refine regional meshes using projected estimated geometric error with bounded triangle counts. Silhouette-specific refinement and conservative source-error validation remain follow-up work. Do not use sharper imagery alone as a reason to generate unsupported geometric detail.
- [x] Retain independent hosted Earth imagery LOD with Mercator mapping directly on terrain. Broader distortion/registration acceptance remains open. Replacing the current imagery-aware terrain refinement must preserve sharp, correctly projected imagery on flat terrain rather than regress its appearance.
- [x] Preserve request cancellation, parent fallback, worker decoding, cache eviction, and camera clearance through loading/source changes; retain hardware/path acceptance separately.
- [ ] Separate large data preparation/publication from normal application builds. Generate and validate regional releases incrementally.
- [ ] Replace whole-source normalization as a prerequisite for each crop with windowed/range-aware processing where supported; otherwise budget and cache the necessary whole-source work explicitly.
- [ ] Make regional jobs resumable. The current builder discards an incomplete staging job on restart; future larger jobs need checkpoints, stable fingerprints, and atomic publication.
- [ ] Recompute a conservative geometric-error bound against the source, including meaningful extrema and approximation error. The current estimated-midpoint-plus-chord metric needs validation before it drives accuracy claims.
- [ ] Choose tile quantization from source uncertainty and intended geometry accuracy, with explicit scale/offset and NoData. Existing zero-offset Int16 and fixed scale assumptions must not silently clip a new source or erase useful local elevation precision.
- [ ] Verify geographic registration between medium-distance terrain, regional color, class masks, and imagery before introducing procedural detail.

Start with the existing 48 MiB terrain-cache and 48-leaf settings as provisional limits. Verify actual CPU, worker, and GPU memory accounting rather than assuming the cache counter represents the entire rendering cost.

## Phase 2: Earth / Mapterhorn pilot

Mapterhorn supplies 512×512 Terrarium-encoded WebP elevation tiles through XYZ and PMTiles. Its advertised source coverage includes approximately 30 m globally and 2 m in Finland. Source spacing does not guarantee equally fine delivered samples at every zoom: calculate local ground spacing from latitude, tile size, and zoom, and inspect the actual product.

- [x] Add an Earth source adapter using the XYZ endpoint for the initial trial.
- [x] Decode Terrarium values as numerical heights, preserving encoded channel values through image decoding rather than applying color-texture transformations.
- [ ] Handle Web Mercator sampling on the globe, latitude limits, tile edges, height datum, water, and polar fallback.
- [ ] Preserve full downloaded heights when useful, but generate only the mesh density needed in the visible area. Do not turn every 512×512 tile into a full-resolution mesh.
- [ ] Share downloaded height tiles across smaller rendered patches where appropriate.
- [x] Browser-check Finland, the Bernese Alps, and New York with streamed elevation/color, plus disabled/unavailable-provider fallback. Wider accuracy comparisons remain open.
- [ ] Measure transfer size, decoding time, peak memory, frame time, terrain quality, and source-boundary behavior.
- [ ] Compare several mesh/detail settings at 100 m altitude; stop fetching finer data when it adds no measured or visible benefit.
- [x] Confirm browser access and include the relevant source attribution.
- [x] Establish an application-owned coarse fallback and avoid making launch or body selection depend on a third-party terrain request. Choose direct serving, a permitted mirror, or regional self-hosting only after the access test.
- [ ] After the trial, evaluate PMTiles regional extracts for offline use or self-hosting. Estimate extract size before downloading.

The pilot should establish practical resource limits for the other bodies, not trigger a full-world preprocessing job.

## Phase 3: Moon — first planetary upgrade

- [ ] Select representative SLDEM2015 regions containing plains, crater rims, and rugged terrain.
- [ ] Build the approximately 120 m tier first and compare it against the current LOLA path under identical lighting.
- [ ] Add the approximately 60 m tier only where closer views justify its additional cost.
- [ ] Retain LOLA outside SLDEM coverage and through any invalid regions; validate seams and registration.
- [ ] After the core milestone, optionally add one selected meter-scale LROC terrain destination to test genuinely detailed 100 m exploration.
- [ ] Use normalized regional color and restrained regolith/rock materials, with detail anchored to body-fixed coordinates.
- [ ] Expand geographic coverage only after transfer size, processing time, and visual benefit have been measured.

Expected benefit: improved crater profiles, slopes, silhouettes, and terrain illumination across useful exploration areas. Meter-scale coverage remains explicitly local.

## Phase 4: Mars — continuous regional detail before tiny patches

- [ ] Select a small number of substantial HRSC regions with available numerical elevation and acceptable quality.
- [ ] Compare direct approximately 50 m HRSC overlays against the existing MOLA terrain.
- [ ] Evaluate whether the existing 200 m HRSC/MOLA blend provides a worthwhile intermediate tier, accounting for limited improved coverage and documented blending artifacts.
- [ ] Match height references and blend regional boundaries into MOLA.
- [ ] After the core milestone, optionally add one selected 1–2 m HiRISE destination once regional processing cost and source quality are understood.
- [ ] Combine measured regional reflectance/property data with proposed dust, sand, and rock materials; keep generated fine detail distinct from measured topography.
- [ ] Expand only after demonstrating a useful increase in continuous explorable detail per unit of storage and processing.

Expected benefit: convincing large landforms and room to explore continuously, with exceptional detail confined to selected destinations.

## Phase 5: Mercury — bounded polar improvement

- [ ] Prepare NASA's improved 250 m north-polar dataset covering 65–90°N. The published elevation source file is approximately 260 MB; that is an input size, not a client-download estimate.
- [ ] Validate its reference frame and 2439.4 km height datum against the existing global source and body orientation.
- [ ] Preserve coverage/measurement-count information where useful for quality assessment.
- [ ] Blend the polar overlay into the 665 m global baseline.
- [ ] Compare relief and low-angle lighting before considering other regional datasets.

Expected benefit: a geographically bounded improvement with manageable preprocessing scope. Use regolith/rock material detail elsewhere without suggesting it supplies missing measured landforms.

## Phase 6: Venus — selective elevation work

- [ ] Keep the existing global Magellan terrain and valid coverage handling.
- [ ] Identify one volcanic or tectonic region with accessible numerical radar-stereo elevation, compatible terms, and documented quality.
- [ ] Keep this elevation upgrade deferred if that availability gate fails; it must not block medium-distance material and lighting improvements.
- [ ] Compare the regional dataset against the global baseline before building broader coverage.
- [ ] Retain observational radar imagery as a distinct display option from reconstructed visible-surface materials.
- [ ] Prioritize coherent rock materials and diffuse atmospheric illumination; mark unresolved close terrain appearance as reconstructed.

Expected benefit: better treatment of selected landforms without a disproportionate investment in sparse, coarse, or uncertain elevation products.

## Surface materials and dynamic lighting

Apply the shared hybrid material approach alongside the elevation work:

- Measured regional color/reflectance preserves geographic identity.
- Surface classes or property maps select material mixtures.
- Procedural normals, roughness, and restrained color variation supply unresolved fine appearance.
- Real terrain geometry supplies recognizable landforms and geometric shadows.

- [ ] Remove inappropriate texture-as-emission contributions from the physical-lighting path.
- [ ] Add focused close-view terrain shadows and appropriate atmospheric/sky fill.
- [ ] Fade detail by projected feature size, without changing regional mean color as the camera approaches.
- [ ] Keep procedural seeds and coordinates stable through body rotation, tile changes, and zoom.
- [ ] Avoid large generated craters, cliffs, dunes, or other features that could be mistaken for observed geography.
- [ ] Keep procedural normals/roughness as the first near-detail implementation. Treat displacement, scattered rocks, vegetation, buildings, and parallax as separate optional features with geometry, shadow, and collision costs.
- [ ] Test regional color with neutral lighting and terrain with neutral color, then combine them. Do not tune away baked directional shadows by changing the Sun or increasing emission.

## Cost and quality gates

Halving grid spacing produces roughly four times as many samples for the same area before compression. Dataset coverage, relief complexity, encoding, and compression determine actual storage and transfer costs; nominal resolution alone is not sufficient for estimates.

### Measured current baseline

Inspected `public/terrain/catalog.json` and its four referenced manifests on 2026-10-29. Sizes below are each manifest's recorded compressed height-tile payload totals, not browser download sizes, full directory sizes, metadata, or decoded memory. Unreferenced older releases are excluded.

| Body | Current tile payload | Configured finest mesh spacing, north–south | Source spacing |
| --- | --- | --- | --- |
| Moon | 283.3 MiB | 666 m | 474 m |
| Mars | 778.7 MiB | 650 m | 463 m |
| Mercury | 261.1 MiB | 935 m | 665 m |
| Venus | 14.8 MiB | 9,282 m | 4,641 m |

The four selected releases total approximately 1.31 GiB of compressed height payload. Check retained release duplication and metadata separately before publishing; this review does not delete any data.

### Why global fine pyramids are excluded initially

For the current two-root geographic hierarchy and 65×65 Int16 height tiles, a complete pyramid through level Z contains `2 × (4^(Z+1) − 1) / 3` tiles. Each raw height tile contains 8,450 bytes.

| Full global depth | Tile count | Raw height payload before compression |
| --- | --- | --- |
| 8 | 174,762 | 1.38 GiB |
| 9 | 699,050 | 5.50 GiB |
| 10 | 2,796,202 | 22.01 GiB |
| 11 | 11,184,810 | 88.02 GiB |

These are format-based estimates, not compressed-output forecasts. They exclude per-file storage, metadata, source downloads, normalized rasters, staging, retained releases, and backups. At higher detail, compare spatial archives/indexed range-readable containers against millions of loose files. Mapterhorn's existing PMTiles need not be converted into a second full-world archive, and its packaging is not assumed suitable for our custom planetary tiles without an adapter.

Keep one canonical measured source hierarchy with derived LODs. Do not store independent 120 m and 60 m full-coverage releases just to obtain two rendering tiers. Process only selected footprints plus the halo needed for sampling and smooth boundaries. Extend coverage in validated batches; do not assume a runtime server will generate arbitrary missing regions on demand.

### Pilot limits and required measurements

Earth delivery now follows the view using native provider tiles; offline processing remains limited to one lunar region and optional material-control experiments, with no mandatory meter-scale sites. Before bulk acquisition, prepare a job estimate covering the source granules required, scratch storage, output tiles/metadata, elapsed time, and any whole-file fetches. Use a source window or small existing granule for the first measurement rather than immediately starting an 11 GB download or a global WorldCover conversion.

Keep initial imagery, height, classification, and shared-material budgets separate, but measure a combined peak including simultaneous parent/child tiles, image decode buffers, workers, CPU arrays, GPU textures/geometry, and shadows. Decoded 512×512 RGBA8 pixels and a Float32 height array each take 1 MiB; wire compression does not reduce those allocations. The existing 48 MiB terrain counter is a starting control, not a total browser-memory budget.

Use the same reference devices and viewport sizes for before/after tests. Provisional frame-time goals are 16.7 ms on the chosen desktop and 33.3 ms on the chosen mobile device, measured at the 95th percentile on warm steady views. Report cold-streaming stalls separately. Establish device identities and measured combined memory/network limits in the pilot record; these goals are proposals, not achieved benchmarks.

Before expanding any upgrade, record:

| Measure | Required comparison |
| --- | --- |
| Offline preparation | Source download size, elapsed processing time, peak memory, and ability to resume/rebuild a region |
| Published data | Tile count, compressed size by level/region, and duplication between tiers |
| Network | Bytes and request count for the same orbit-to-100 m camera sequence |
| Runtime | Decode time, main-thread stalls, peak CPU/GPU memory, mesh count, triangle count, and frame time |
| Visible benefit | Better measured shape, silhouettes, and lighting at fixed camera positions |
| Continuity | Stable heights, normals, materials, and camera clearance across LOD/source boundaries |
| Availability | Exact numeric source and coverage, browser/server access tests, failure behavior, and reproducible version/terms |
| Classification/material cost | Source granules, control-map bytes, shared asset size, shader sampling cost, and mean-color stability |

Accept an upgrade when the visible improvement justifies the measured resource increase on desktop and mobile. Keep the coarser fallback if the difference is negligible at the current view.

## Validation and completion criteria

- [ ] Compare identical camera paths from orbit down to 100 m before and after each upgrade.
- [ ] Pass the medium-distance comparison first: preserve recognizable measured geography, regional color patterns, co-registration, and silhouettes; evaluate plains, rugged terrain, and a landmark crossing an LOD boundary. Record geographic source uncertainty independently of mesh error.
- [ ] Where available measurements cannot support the requested geographic detail, record the view as source-limited and retain its best measured surface. Extra mesh samples or procedural noise do not satisfy a failed measured-accuracy comparison.
- [ ] Check at least two Sun azimuths, low Sun, and tilted/grazing views; use a neutral material override to separate geometry from texture artifacts.
- [ ] Check coverage edges, missing tiles, source transitions, tile seams, poles, and the date line where applicable.
- [ ] Exercise zoom-to-cursor, surface dragging, ground-anchored tilt/rotation, body rotation, and camera clearance during streaming.
- [ ] Confirm that switching bodies cancels obsolete work and releases resources.
- [ ] Verify stable procedural detail with no sliding, shimmer, or conspicuous popping.
- [x] Run terrain/source-contract tests and the application build, followed by browser checks on desktop and mobile-sized views.
- [ ] Publish source provenance, resolution/coverage limits, attribution, and benchmark results with each accepted release.
- [ ] Test unavailable sources, offline fallback, sparse or invalid coverage, and interrupted conversions. Publish only complete validated regions; show coarser measured terrain when an overlay is absent.
- [ ] Compare close-detail on/off at the same location. Fine appearance may change, but known landforms, coastlines, mean color, and landmark positions must remain stable. At lower LOD, filter detail back to that same measured appearance.

The first implementation milestone is complete when medium-distance appearance is stable on the retained global baselines, and the bounded Earth pilot plus one lunar region demonstrate registered measured relief and procedural normal/roughness detail within recorded resource budgets. Class-only global color, full-resolution global rebuilds, meter-scale destinations, and geometric surface scattering are not required for that milestone. Later planetary upgrades reuse the verified path.

## Source references

- [Mapterhorn coverage](https://mapterhorn.com/), [data access and regional extracts](https://mapterhorn.com/data-access/), [attribution](https://mapterhorn.com/attribution/).
- [NASA SLDEM2015](https://pgda.gsfc.nasa.gov/products/54), [download tiles](https://grailteam.mit.edu/BROWSE/SLDEM2015/), [example 3 m LROC terrain product](https://data.lroc.imldi.com/lroc/view_rdr_product/NAC_DTM_MRINGENII5).
- [HRSC regional terrain distribution](https://hrscteam.dlr.de/public/data/regionaldtms.php), [USGS 200 m HRSC/MOLA blend](https://astrogeology.usgs.gov/search/map/mars_mgs_mola_mex_hrsc_blended_dem_global_200m), [HiRISE terrain documentation](https://hirise.lpl.arizona.edu/dtm/about.php).
- [NASA Mercury north-polar topography](https://pgda.gsfc.nasa.gov/products/87).
- [Venus terrain context and regional stereo limitations](https://doi.org/10.1029/2024je008675).

Earth native elevation and hosted RGB delivery have been checked in Finland, the Alps, and New York; offline lunar conversion/browser delivery remains limited to the bounded Hadley pilot. The [pilot record](terrain-pilot-results.md) separates implemented functionality from open quality/resource acceptance. Other planetary acquisitions and broader rollout remain unverified; the format-growth calculations are planning estimates.
