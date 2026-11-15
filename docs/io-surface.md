# Io

Implemented November 15, 2026 using the shared solid-body renderer. Io is
selectable beneath Jupiter, searchable, and connected to Jupiter by parent
navigation, distance labels, orbit lines and satellite markers.

## Global terrain

The numeric source is [White et al. (2014)](https://doi.org/10.1002/2013JE004591),
distributed as the Float32 `IoDEM` TIFF through
[NASA Io Trek](https://trek.nasa.gov/io/). Download URL:
`https://trek.nasa.gov/io/TrekWS/rest/cat/data/stream?label=IoDEM`.
The delivered source has 11,500 × 5,750 cells on an approximately 1 km angular
grid, with residual elevations in meters. Its peak is 16,941.75 m near
9.88° S, 88.83° E (Boösaule Montes), which also checks longitude registration.
The grid spacing does not imply uniform kilometer-scale measured detail.

Although the publication/catalog describes about 75% coverage, valid pixels in
this downloadable numeric product support **53.83% of spherical surface area**.
The shipped coverage mask records this actual source support. The other areas
use constrained interpolation from neighboring relief and seeded, low-amplitude
volcanic-plains variation. Wave amplitudes are 140/65/25/8 m, tapered toward
observed boundaries. Isolated mountains do not propagate as unobserved plateaus;
unsupported polar rows converge smoothly to one height. Valid resampled source
pixels are preserved exactly before the reference-shape conversion.

The source's residual datum is a limb-derived triaxial figure. Its exact updated
axes are not included in the Trek product. We adopt the documented Thomas (1998)
equilibrium figure, **1,829.7 / 1,819.2 / 1,815.8 km**, as an explicit datum
approximation; it differs from the paper's updated figure by up to roughly
300 m. This uncertainty is separate from stereo elevation error. Preparation
restores the direction-dependent ellipsoid radius, then stores radial heights
above the app's 1,821.6 km sphere. The unloaded fallback uses the same ellipsoid.

Terrain is baked once into immutable geographic height releases, using 129 × 129
Int16 samples, 1 m quantization and levels 0–6 (10,922 tiles). Finest delivery
spacing is about 699 m at the equator. Rendering, picking and camera clearance
all sample the same measured-plus-reconstructed heights. There is no runtime
regeneration when the camera moves or LOD changes.

## Visible color and material

The [USGS Galileo color-merge mosaic](https://astrogeology.usgs.gov/search/map/io_galileo_ssi_global_color_merge_mosaic_1km)
contains near-IR (756 nm), green (559 nm) and violet (404 nm) channels. It is an
empirically processed multispectral composite, rather than measured RGB.
Preparation applies its per-band scale/offset before reconstructing visible red
by interpolation at 671 nm and blue as `0.55 G + 0.45 V`. The blue approximation
follows the Io processing method discussed by image processor
[Jason Perry](https://www.planetary.org/articles/2629). A common linear factor
of 0.8 followed by sRGB encoding preserves channel relationships. Polar gaps
use neighboring color; above 85° latitude a smooth blend converges to one pole
mean, avoiding radial mosaic seams. No third-party artist map is bundled.

The resulting 4096 × 2048 lossless WebP preserves observed geographic deposits,
with the same reconstructed PNG as a failure fallback. It remains a visible-color
approximation: source illumination and multispectral processing are not fully
removed. The app identifies both reconstructed color and terrain gaps.

Separate generated packed textures add fine/medium volcanic rock normals,
roughness and restrained brightness detail. This material detail is shading-only.
The global hillshade is cartographic relief baked from the completed height
field, separate from solar lighting. This implementation does not add live
volcanism, plumes or terrain self-shadowing.

## Motion

Rotation uses [NAIF PCK00011](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc),
including Io's J3/J4 periodic terms. The first visual orbit is a mean circle at
421,700 km from Jupiter, anchored against JPL Horizons reference vectors.
It follows the app's approximate Jupiter position. Four frozen epochs from
1900 through 2049 remain within 3,500 km of their independent reference vectors;
this is not an event-prediction ephemeris.

## Rebuild and preservation

```sh
npm run io:fetch
npm run io:prepare
npm run io:build-terrain
npm run io:build-detail
# Optional color-only rebuild: npm run io:build-color
npm run io:build-hillshade
sh scripts/terrain-python.sh scripts/validate-global-hillshade.py --bodies io
npm run io:check-source
npm run io:check -- --fast-stream --part=surface
npm run io:check -- --fast-stream --part=navigation
```

The three original files total approximately 462 MB. Downloads pin expected
lengths and SHA-256 hashes. Preserve `.terrain-cache/io/` for rebuilding and the
active `public/terrain/io/` and `public/hillshade/io/` releases for serving; these
large deployed releases are Git-ignored data. The lean app build serves them
separately using the existing terrain/hillshade base URL configuration.

Source metadata and coverage are stored in `public/textures/io-terrain.json`,
`io-terrain-coverage.png` and `io-color.json`. Validation reports and screenshots
are under `.terrain-cache/io/`.

The active local assets total **155.38 MB** (148.18 MiB): 138.60 MB of
terrain including metadata, 5.16 MB of hillshade, and 11.63 MB of color,
fallbacks, detail and provenance. The original downloads and intermediate
rebuild files are additional local preparation storage.

## Validation

All 174 unit tests and the lean production build pass. Every delivered terrain
tile was checked for hashes, bounds, seams, poles and parent alignment. The
hillshade validator checked all 1,409 pages with zero shared-gutter code error.
Seventeen independent original-DEM controls differ from the delivered heights
by at most 7.7 m; units, longitude registration, datum conversion, finite gap
completion, measured-pixel preservation and deterministic completion are checked
by `io:check-source`.

Real Chromium checks passed across separate surface/navigation runs: orbit view,
Boösaule Montes, the reconstructed north pole, dateline, cube corner, 100 m
clearance, camera motion, parent navigation, date changes, phone layout and failed
color/terrain downloads. The close-range ground tilt reached
84.8°. The largest sampled terrain cache was
77.4 MiB against its 128 MiB budget, with at most
366,336 triangles against 400,000. Generated detail changed rendered
pixels while preserving geometry. The polar color discontinuity found during
inspection was corrected and rechecked. SwiftShader checks establish rendering
correctness; hardware frame-rate performance remains unmeasured.
