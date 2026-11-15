#!/usr/bin/env python3
"""Independent source-pixel / delivered tile check, including triaxial datum."""
import gzip
import json
import math
from pathlib import Path

import numpy as np
import rasterio

ROOT = Path(__file__).resolve().parents[1]
catalog = json.loads((ROOT / 'public/terrain/catalog.json').read_text())
path = ROOT / 'public/terrain' / catalog['bodies']['io']
manifest = json.loads(path.read_text())
with rasterio.open(ROOT / '.terrain-cache/io/sources/dem.tif') as source:
    assert source.shape == (5750, 11500) and source.dtypes == ('float32',)
    assert abs(source.transform.a - 360/11500) < 1e-12
    raw = source.read(1)
    nodata = source.nodata
    controls = []
    # Exact delivered level-5 grid vertices, not resampled screenshot pixels.
    for latitude in [-60, -30, -10, 0, 30, 60]:
      for longitude in [-150, -90, -30, 30, 88.83, 150]:
        z = 6
        lat = round(latitude * 2**z * 128 / 180) * 180 / (2**z * 128)
        lon = round(longitude * 2**z * 128 / 180) * 180 / (2**z * 128)
        col = (lon+180) / source.transform.a - .5
        row = (90-lat) / -source.transform.e - .5
        c, r = math.floor(col), math.floor(row)
        u, v = col - c, row - r
        block = raw[r:r+2, c:c+2].astype('float64')
        if block.shape != (2, 2) or np.any(block == nodata):
            continue
        residual = (block[0, 0]*(1-u)*(1-v) + block[0, 1]*u*(1-v)
                    + block[1, 0]*(1-u)*v + block[1, 1]*u*v)
        phi, lam = math.radians(lat), math.radians(lon)
        ellipsoid = 1 / math.sqrt((math.cos(phi)*math.cos(lam)/1829700)**2
                                  + (math.cos(phi)*math.sin(lam)/1819200)**2
                                  + (math.sin(phi)/1815800)**2)
        expected = residual + ellipsoid - 1821600
        span = 180 / 2**z
        x, y = min(2**(z+1)-1, int((lon+180)/span)), min(2**z-1, int((90-lat)/span))
        values = np.frombuffer(gzip.decompress((path.parent / f'tiles/{z}/{x}/{y}.bin').read_bytes()), dtype='<i2').reshape(129, 129)
        tx = round((lon - (-180+x*span)) / span * 128)
        ty = round((90-y*span-lat) / span * 128)
        actual = float(values[ty, tx])
        error = abs(expected-actual)
        assert error < 25, f'Datum/units/source mismatch at {lat},{lon}: {expected} vs {actual}'
        controls.append(dict(lat=lat, lon=lon, residualMeters=residual, ellipsoidRadiusMeters=ellipsoid,
                             expectedHeightMeters=expected, deliveredHeightMeters=actual, errorMeters=error))
assert len(controls) >= 10
assert manifest['missingPixels'] == 0
preparation = json.loads((ROOT/'public/textures/io-terrain.json').read_text())
assert .53 < preparation['sourceSupportedFraction'] < .55
# High ground remains at the published east-positive Boosaule location.
with rasterio.open(ROOT/'.terrain-cache/io/sources/dem.tif') as source:
    peak = np.unravel_index(np.argmax(np.where(raw == source.nodata, -np.inf, raw)), raw.shape)
    peak_lon, peak_lat = source.xy(*peak)
    assert abs(peak_lat+9.8765) < .04 and abs(peak_lon-88.8261) < .04
    assert 16900 < float(raw[peak]) < 17000
# Small synthetic coverage exercises constrained completion independently of
# the large prepared raster, including determinism and observed preservation.
import importlib.util
spec = importlib.util.spec_from_file_location('io_builder', ROOT/'scripts/build-io.py')
builder = importlib.util.module_from_spec(spec); spec.loader.exec_module(builder)
sample = np.full((64, 128), np.nan, dtype='float32')
valid = np.zeros_like(sample, dtype=bool); valid[16:48, 24:80] = True
sample[valid] = np.arange(valid.sum(), dtype='float32') / 10
filled = builder.complete_residual(sample, valid)
assert np.isfinite(filled).all() and np.array_equal(filled[valid], sample[valid])
assert np.array_equal(filled, builder.complete_residual(sample, valid))
report = dict(body='io', sourceGridMeters=1000, sourceSupportedFraction=preparation['sourceSupportedFraction'],
              completed=True, controls=controls, maxErrorMeters=max(c['errorMeters'] for c in controls))
(ROOT / '.terrain-cache/io/source-validation.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
