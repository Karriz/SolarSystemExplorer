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
path = ROOT / 'public/terrain' / catalog['bodies']['enceladus']
manifest = json.loads(path.read_text())
with rasterio.open(ROOT / '.terrain-cache/enceladus/sources/dem.tif') as source:
    assert source.shape == (4025, 8049) and source.dtypes == ('float32',)
    assert tuple(source.transform)[:6] == (200, 0, -805000, 0, -200, 402600)
    raw = source.read(1)
    nodata = source.nodata
    controls = []
    # Exact delivered level-5 grid vertices, not resampled screenshot pixels.
    for latitude, longitude in [(-80, 30), (75, 100), (0, 1), (0, 90), (25, 179), (-40, -100), (42, -35), (-67, 134)]:
        z = 5
        lat = round(latitude * 2**z * 128 / 180) * 180 / (2**z * 128)
        lon = round(longitude * 2**z * 128 / 180) * 180 / (2**z * 128)
        # Direct inverse of the published equirectangular source affine.
        east = lon % 360
        col = (256200 * math.radians(east - 180) + 805000) / 200 - .5
        row = (402600 - 256200 * math.radians(lat)) / 200 - .5
        c, r = math.floor(col), math.floor(row)
        u, v = col - c, row - r
        block = raw[r:r+2, c:c+2].astype('float64')
        assert block.shape == (2, 2) and np.all(block != nodata)
        residual = (block[0, 0]*(1-u)*(1-v) + block[0, 1]*u*(1-v)
                    + block[1, 0]*(1-u)*v + block[1, 1]*u*v) * 1000
        phi, lam = math.radians(lat), math.radians(lon)
        ellipsoid = 1 / math.sqrt((math.cos(phi)*math.cos(lam)/256200)**2
                                  + (math.cos(phi)*math.sin(lam)/251400)**2
                                  + (math.sin(phi)/248600)**2)
        expected = residual + ellipsoid - 252100
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
assert manifest['missingPixels'] == 0
report = dict(body='enceladus', sourceGridMeters=200, effectiveSourceResolutionMeters=400,
              completed=True, controls=controls, maxErrorMeters=max(c['errorMeters'] for c in controls))
(ROOT / '.terrain-cache/enceladus/source-validation.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
