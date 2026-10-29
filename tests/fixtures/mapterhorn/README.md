# Numeric elevation decoder fixtures

Two real 512×512 Terrarium WebP tiles, fetched 2026-10-29 from the exact URLs in `reference.json`. These are numeric elevation inputs, not display textures.

The reference RGBA SHA-256 hashes were generated independently using Rasterio/GDAL's WebP decoder: read the three RGB bands, transpose to interleaved pixels, and append opaque alpha (255). Height extrema use `R * 256 + G + B / 256 - 32768` meters. Fixture source byte hashes are included too.

Attribution: © Mapterhorn, https://mapterhorn.com/attribution/ . Finland contains National Land Survey of Finland Elevation model 2 m data (CC BY 4.0). Switzerland contains Federal Office of Topography swisstopo swissALTI3D data (open government data). See https://download.mapterhorn.com/attribution.json and https://github.com/mapterhorn/mapterhorn/blob/main/source-catalog/swissalti3d/metadata.json .

The regression deliberately flips one red-channel bit to reproduce the height spike caused by privacy-protected canvas readback. The production decoder uses libwebp WebAssembly directly and never reads canvas pixels.
The fixtures are used only to test numerical elevation decoding. Their exact URLs, source byte checksums and independently decoded RGBA checksums are in `reference.json`; attribution is in `README.md`.

Generation of reference RGBA bytes (Rasterio/GDAL):

```python
with rasterio.open(path) as dataset:
    rgb = numpy.moveaxis(dataset.read(), 0, -1)
rgba = numpy.concatenate([rgb, numpy.full((512, 512, 1), 255, dtype='uint8')], axis=2)
reference_sha256 = hashlib.sha256(rgba.tobytes()).hexdigest()
```

This reference does not call browser image/canvas APIs. Browser checks compare the direct libwebp output to that reference, then exercise the production worker's height decoding. The old canvas path is compared only to demonstrate privacy-induced corruption; it is not used as the reference.
