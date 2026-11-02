#!/usr/bin/env python3
"""Check the geographic HRSC/MOLA adapter, sampling and derived attribution offline."""
import importlib.util
import json
from pathlib import Path
import tempfile
import sys
from types import SimpleNamespace
import numpy as np
import rasterio
from rasterio.transform import from_origin

spec = importlib.util.spec_from_file_location('terrain_build', Path(__file__).with_name('build-terrain.py'))
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    cache = root / 'cache'
    cache.mkdir()
    width, height = 256, 128
    step = 360 / width - .00001
    values = (np.arange(height)[:, None] * 10 + np.arange(width)[None, :] - 1000).astype('int16')
    values[20, 30] = -32768
    values[40, -1] = -32768
    path = cache / 'fixture.tif'
    with rasterio.open(path, 'w', driver='GTiff', width=width, height=height, count=1,
                       dtype='int16', nodata=-32768, crs='+proj=longlat +R=3396190',
                       transform=from_origin(-180, 90, step, step)) as dataset:
        dataset.write(values, 1)
    source = dict(module.SOURCES['mars'])
    source.update(product='test-hrsc-mola', file=path.name, width=width, height=height,
                  sha256=module.file_hash(path), sourcePixelDegrees=step)
    raster = module.Raster(source, cache, True)
    columns = np.array([3, 70, 150])
    rows = np.array([4, 60, 100])
    np.testing.assert_allclose(raster.sample(-180 + (columns + .5) * step, 90 - (rows + .5) * step), values[rows, columns], atol=1e-6)
    assert np.isnan(raster.sample(np.array([-180 + 30.5 * step]), np.array([90 - 20.5 * step]))[0])
    repaired = raster.sample(np.array([-180 + (width - .5) * step]), np.array([90 - 40.5 * step]))[0]
    expected = values[40, -2] + (int(values[40, 0]) - int(values[40, -2])) / (360 / step - (width - 2))
    np.testing.assert_allclose(repaired, expected, atol=1e-5)
    np.testing.assert_allclose(raster.sample(np.array([-180, 180]), np.array([20, 20]))[0],
                               raster.sample(np.array([-180, 180]), np.array([20, 20]))[1])
    args = SimpleNamespace(cache=cache, output=root/'public', offline=True, max_zoom=1, workers=2)
    relative = module.build('mars', source, args)
    manifest = json.loads((args.output / relative).read_text())
    assert manifest['body'] == 'mars' and manifest['sampleSize'] == 129
    assert manifest['sourceResolutionMeters'] == 200
    for key in ('license', 'licenseUrl', 'sourceCitation', 'coverageNotes', 'sourcePixelDegrees'):
        assert manifest[key] == source[key]
    assert 'CC BY-SA' in manifest['license']
    assert manifest['sourceMissingPixels'] == 2 and manifest['wrappedEdgeFillPixels'] == 1
    assert manifest['missingPixels'] == 1
print('Passed geographic pixel centers, wrapped longitude, NoData, validated dense Mars release and source attribution')
