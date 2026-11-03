# Mars regional color review — November 3, 2026

Mars now defaults to continuous MOC-WA source-derived color in a 249,594-byte
WebP. It preserves gradual regional variation instead of replacing it with
ten flat color classes. The previous smoothed regions, a lossless source
reference, and the older Viking fallback remain selectable for comparison.

## Source and color treatment

The reference was rebuilt from the same four-Mars-year, four-season subset
used for the vector experiment. Its SHA-256 is unchanged:
`93b8b25e061c7d0696d17fbaca6e86913ae63ca34a50b7d23646805a40fb72be`.
The source archive selections, input hashes, channel meanings, source and DOI
are retained in `.terrain-cache/mars-moc-wa/mocwa-multiseason.json`.
The rebuilt composite has 100% valid red/blue coverage for this subset.

The [USGS MOC-WA product](https://astrogeology.usgs.gov/search/map/mars_year_24_28_moc_wa_red_and_blue_2023)
provides photometrically corrected narrow red and blue reflectance bands.
Our reference estimates green as their linear mean, then encodes sRGB. It is
an approximate visible-color reconstruction, not measured three-band RGB,
a perfectly atmosphere-free albedo map, or proof of exact human-visible color.
The [processing paper](https://doi.org/10.1029/2022EA002673) discusses remaining
photometric/atmospheric effects and the limitations of synthetic green.
Seasonal averaging can retain atmospheric/frost variation; polar source bands
and artifacts are not corrected by changing the transport format.

The old delivered palette has considerably brighter, warmer fills than this
reference. The new map applies no additional gain, saturation boost, local
stretch, or hand-selected replacement palette. This keeps source fidelity
separate from presentation. Normal scene lighting/exposure still affects the
lit view. Mars texture emission is now zero in every color mode, avoiding a
loading-order-dependent extra brightness contribution.

## Size, accuracy, and processing

All encodings below use exactly the same 4096 × 2048 reference. Errors are
measured against that reference, not against independent ground truth.
Channel errors use 0–255 sRGB units over all pixels; CIE76 samples every fourth
pixel on both axes. Neither metric is a claim of absolute physical calibration.

| Encoding | Bytes | Mean channel error | 99th percentile channel error | Mean CIE76 |
| --- | ---: | ---: | ---: | ---: |
| WebP Q80 | 68,644 | 0.835 | 4 | 0.930 |
| WebP Q90 | 139,464 | 0.689 | 3 | 0.831 |
| WebP Q95, selected | 249,594 | 0.628 | 3 | 0.780 |
| Lossless WebP | 2,289,116 | 0 | 0 | 0 |

The previous curved vector release transfers 1,512,697 bytes of gzip paths,
plus its manifest. Q95 is approximately 83.5% smaller, preserves continuous
source colors, and takes approximately 0.5–0.6 seconds to encode locally.
The lossless PNG reference is approximately 3.2 MiB and loads only when selected.
Exact measurements and checksums are in `public/textures/mars-color.json`.

The browser fetches and decodes one bitmap rather than compiling 32 path tiles,
rasterizing their classes, and maintaining view-dependent color windows.
An initial local Chromium run measured median load/assembly times of about
78 ms for compact color, 107 ms for the reference, and 436 ms for old vectors.
These include local requests and decoder/assembly work; they are not production
network or real-GPU frame-time benchmarks. A 4096 × 2048 GPU color texture still
costs approximately 42.7 MiB with RGBA mipmaps. Compact transport does not reduce
that allocation. The new default avoids vector path retention and close-view
patch textures/redraws; old assets remain installed for comparison.

This evidence favors conventional continuous-image compression for the current
source over implementing a new gradient-mesh/diffusion-curve renderer. A future
vector or hybrid representation should beat this same-source baseline on
accuracy, size, and processing before replacing it. This does not rule out
vectors for classification or other sources.

## Reproduction and checks

`npm run mars:build-mocwa-color` obtains only the selected archive subset, with
four concurrent downloads. The retained source cache is roughly 660 MiB;
this is offline preparation, not an app download. A successful prior source
report supports `npm run mars:build-mocwa-color -- --offline`: cached source
hashes are verified and known missing seasonal products remain absent.
The verified cached rebuild took approximately 43 seconds locally, including
about one second for source preparation after checksum verification.
`npm run mars:build-color` benchmarks encodings and publishes the compact image,
lossless reference, and metadata. It does not download sources.

`npm run mars:check-color` compares old regions, lossless source, and compact
color with fixed geometry under neutral color-only rendering and fixed 45°
sunlight. Valles, Arabia, Syrtis, the dateline, north polar terrain, and a close
Valles view are covered. Independent source samples verify orientation and
color-space handling on the GPU. Switching colors preserves geometry. Tests
also exercise late fallback arrival, rapid selection, failed download/retry,
late bitmap completion after disposal, and actual phone controls.

Artifacts and JSON measurements are in `.terrain-cache/mars-color-review/browser`.
The first six-view comparison measured compact/reference mean rendered errors
of approximately 0.49–0.80 channel values, compared with 17–44 for the previous
palette. The general test suite and lean app build also pass. Hardware memory,
mobile performance, and independent multi-band color calibration remain
separate acceptance work.
