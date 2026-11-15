# Europa

Europa uses the shared solid-body renderer and appears beneath Jupiter alongside
Io. Global color and terrain are complete; completeness includes reconstruction
and does not imply global measurements.

## Sources and observed coverage

The elevation inputs are the five [USGS controlled Galileo DTMs](https://stac.astrogeology.usgs.gov/docs/data/jupiter/europa/europa_controlled_usgs_dtms/):
Cilix crater, Pwyll crater, Rhadamanthys chaos/pits, Yelland ridged plains and
Agenor Linea. Cite Bland et al. (2021), [doi:10.3390/rs13245097](https://doi.org/10.3390/rs13245097).
Their combined valid footprints cover approximately **0.080%** of Europa.
The DTMs include stereophotogrammetry, manual correction and interpolation;
valid source support is not a claim of independently measured pixels everywhere.

The downloaded COG spacings are approximately 250, 815, 228, 62 and 614 m,
respectively. Effective detail varies: USGS reports approximately 1.1 km at
Cilix, 1.5 km at Pwyll, 1.8 km in the chaos site, 180 m in the ridged plains and
3 km at Agenor. Source post spacing, effective resolution and delivered grid
spacing are distinct. The delivered 299 m equatorial grid smooths some of the
smallest Yelland features; it does not invent measured fine resolution elsewhere.

All source DTM/FOM rasters and processing provenance are retained. The published
FOM COGs were cubic-warped, so their interpolated numbers cannot safely be read
as exact categorical confidence flags. We retain the original files and numeric
histograms, rather than pretending to recover exact flags. The source provenance
also contains a questionable confidence-map conversion command; the application
does not use that colorized confidence product as measured elevation.

## Vertical placement and reconstructed relief

Each site's local height median is subtracted, then its relative relief is placed
on the [IAU reference triaxial figure](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc)
with axes 1,562.6 / 1,560.3 / 1,559.5 km. These are deliberately chosen placements;
the DTMs do not establish a common global absolute-height datum. Source medians,
original extrema, valid counts and exact placement assumptions are recorded in
`europa-terrain.json`. The coverage PNG shows regional blend contribution, not
measurement confidence. Relative relief inside each footprint is preserved after
resampling. Its outer 1.5 km blends smoothly into the reconstructed surroundings.

Outside these sites, the [USGS global geologic map SIM 3513](https://doi.org/10.3133/sim3513)
(Leonard, Patthoff and Senske, 2024) supplies geographic constraints. Its 333
mapped ridge traces and 57 cycloid traces constrain inferred double-ridge relief.
The chosen ridge height scale is 180 m, with roughly kilometer-scale shoulders.
These heights and widths are inferred, not measured from the map. Undifferentiated
lineae are not all turned into ridges. Mapped chaos regions receive bounded,
block-like variation, with softened boundaries. Seeded broad ice-plains relief
completes the rest. No image brightness is interpreted as elevation.

The angular distance approximation used to shape inferred ridges narrows their
physical widths toward the poles; ridge amplitudes fade smoothly between 75°
and 85°, as does inferred chaos detail. The underlying three-dimensional plains field remains continuous at
the poles and longitude seam. The ellipsoid is restored before storing radial
meters above the app's 1,560.8 km reference sphere.

The 32,768 × 16,384 Float32 preparation is baked into 129 × 129 Int16 geographic
tiles at levels 0–7, with 1 m quantization. All 43,690 tiles use one immutable
release. Drawing, picking and collision clearance sample those same heights.
The unloaded or failed-data fallback uses the same ellipsoid.

## Color and surface material

The [USGS 500 m Voyager/Galileo mosaic](https://astrogeology.usgs.gov/search/map/europa_voyager_galileo_ssi_global_mosaic_500m)
provides global image geography, supplemented by updated controlled Galileo
imagery around the stereo sites. Those local images are percentile-matched to
the surrounding global mosaic and feathered at footprint edges. The older
global mosaic and newer controlled sites have different control networks;
this does not establish perfect global image/height registration.

Global measured natural RGB is unavailable in this preparation. We reconstruct
near-neutral ice and restrained brown non-ice appearance using the observed
monochrome structure and the approximate natural-color left hemisphere of
[NASA/JPL/DLR PIA00502](https://science.nasa.gov/science-research/natural-and-false-color-views-of-europa/)
as an appearance constraint. Dark image features receive restrained inferred
brown chroma. Image brightness cannot uniquely identify materials, so this is
an appearance model, not a calibrated spectral conversion. Geologic unit colors
are not installed as surface reflectance. Source-image lighting and mosaic
brightness differences remain partly baked into the image.

Polar colors above 85° smoothly converge to one pole mean. A lossless
4096 × 2048 WebP and equivalent PNG fallback provide complete global coverage.
The UI labels reconstructed color and global terrain. No restricted third-party
artist map is bundled. Generated frost/ice textures add body-fixed normal,
roughness and restrained brightness detail; those fine textures are shading-only
and share the deterministic microstructure model used for Enceladus.

Hillshade is a separate cartographic layer derived from the completed terrain.
This implementation does not add physical terrain self-shadows or an ocean
cutaway.

## Orbit and rotation

Europa follows Jupiter on an approximate 671,100 km mean circular orbit, with
phase anchored independently to a JPL Horizons J2000 reference state. Four
frozen reference epochs from 1900 to 2049 differ by about 6,800–9,400 km. The
model omits eccentricity and small orbital terms; it is for visualization,
not event prediction. Rotation includes the IAU/NAIF J4–J7 periodic terms.

## Rebuild and preserve

```sh
npm run europa:fetch
npm run europa:prepare
npm run europa:build-terrain
npm run europa:build-hillshade
sh scripts/terrain-python.sh scripts/validate-global-hillshade.py --bodies europa
npm run europa:check-source
npm run europa:check -- --fast-stream --part=surface
npm run europa:check -- --fast-stream --part=navigation
```

`europa:build-color` rebuilds color independently. All 26 original downloads
have pinned lengths and SHA-256 hashes and total about 417 MB. Keep
`.terrain-cache/europa/` for offline rebuilding. Terrain and hillshade releases
under `public/terrain/europa/` and `public/hillshade/europa/` are active served
data, even though Git ignores them. Preserve them with the other planetary
releases. The lean app build expects these releases to be served separately
through the existing terrain/hillshade URL configuration.

The active prepared assets total **306.19 MB**
(292.01 MiB): 283.72 MB of
terrain including metadata, 3.39 MB of hillshade, and
19.08 MB of textures, fallbacks and provenance. Original
downloads and preparation intermediates are additional rebuild storage.
