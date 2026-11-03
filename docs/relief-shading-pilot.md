# Relief readability — November 3, 2026

The historical Valles experiment below is superseded by [global detailed hillshade](global-surface-results.md), enabled by default for both Moon and Mars. Current build/check commands target the global pipeline; the prototype scripts remain as historical reproduction tools.

Moon and Mars use four weighted hillshade directions (southwest, west,
northwest, north), plus a restrained direction-independent slope accent.
Both use measured mesh normals before generated material normals. Flat ground
has a neutral multiplier. This retains readable relief under frontal sunlight
while reducing reliance on the previous single northwest light. The existing
Hillshade toggle switches the enhancement off without changing terrain.

A bounded Valles sky-view shading experiment was evaluated and removed after
user review: its additional effect was subtle and did not justify retaining
the texture, shader sampling, preprocessing, and separate control.

## Independent-resolution hillshade experiment

The Mars panel offers **View Valles** and **High-res hillshade**, initially off.
This separate experiment bakes the accepted multidirectional formula from the
measured MOLA–HRSC source. Inside the pilot it replaces mesh-derived hillshade;
it does not multiply a second relief layer over it. The same body-fixed map is
available on the base globe and streamed terrain. A two-degree boundary blend
returns to ordinary mesh shading outside the pilot. The master Hillshade switch
still controls both. Baked shading represents true-scale relief even when the
geometry exaggeration control is set to 4×.

The region spans 100°W–42°W and 28°S–8°N. Its 3072 × 2048 samples are spaced
approximately 1.10 km east–west at the region's central latitude and 1.04 km
north–south. Derivatives use 300 m physical offsets in the existing measured
source. Four shading samples are averaged per output texel before quantization.
The full formula, including slope accent, is preserved; this introduces no
generated landforms or additional measured detail beyond the source.

The gzip payload is 3,025,905 bytes (2.89 MiB); decoded CPU storage is 6 MiB.
The R8 single-channel GPU texture occupies approximately 8 MiB with mipmaps.
These are separate allocations, not total browser memory. Loading/decompression
adds transient buffers. It is fetched only when enabled and retained for quick
comparison until the scene is disposed. Disabling while loading cancels the
request. Missing data leaves mesh shading available and reports failure.

`npm run mars:build-hillshade` rebuilds the map from the already-normalized
measured source in `.terrain-cache`. Provenance, source fingerprint, attribution,
license, bounds, encoding, and the raw payload checksum accompany the binary
asset in `public/textures/valles-hillshade.json`. The loader verifies dimensions,
length, and checksum and uploads numeric R8 values directly, avoiding canvas
readback. It handles both HTTP-decoded gzip and ordinary gzip-file responses.

This is one bounded atlas, not a global streaming pyramid. The pilot estimates
visual benefit and cost before committing to global packaging or delivery.
Silhouettes, ground clearance, and actual shadows still follow the terrain mesh.

`npm run mars:check-hillshade` captures matched mesh/texture pairs with the
geometry held fixed at Valles from 300 km, 1,000 km, and 3,000 km altitude, with
90° and 15° illumination. It also checks outside-region/Moon isolation, master
toggle behavior, unavailable-map fallback, download failures/retry, cancellation,
disposal, and phone controls. Artifacts go to `.terrain-cache/highres-hillshade`.

## Validation

Run `node scripts/check-relief-comparison.mjs` against Vite on port 5175
(`VECTOR_PREVIEW_URL` overrides it). The diagnostic injects the old northwest
formula into the browser session only. It captures off, old, and
multidirectional modes at regional Valles, a canyon wall, and lunar Hadley,
with controlled 90° and 15° Sun elevations. Material detail and focused shadows
are disabled to isolate relief shading. Normal color remains enabled.

The check verifies visible pixel changes, reversible toggles, unchanged terrain
selection, and phone control behavior. Images and measurements go to
`.terrain-cache/hillshade-comparison/`. Software-renderer checks establish
functionality, not hardware performance or general shadow acceptance.
