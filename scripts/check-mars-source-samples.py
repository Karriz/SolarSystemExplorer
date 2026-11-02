#!/usr/bin/env python3
"""Compare delivered native vertices against independent GeoTIFF interpolation."""
import gzip
import json
import math
import sys
from pathlib import Path
import numpy as np
import rasterio
from rasterio.windows import Window

root = Path(__file__).resolve().parents[1]
source = json.loads((root/'scripts/terrain-sources.json').read_text())['mars']
catalog = json.loads((root/'public/terrain/catalog.json').read_text())
manifest_path = Path(sys.argv[1]) if len(sys.argv) > 1 else root/'public/terrain'/catalog['bodies']['mars']
manifest = json.loads(manifest_path.read_text())
assert manifest['sourceSha256'] == source['sha256']
assert manifest['sourceResolutionMeters'] == 200 and manifest['sampleSize'] == 129 and manifest['maxZoom'] == 9
checks = []
with rasterio.open(root/'.terrain-cache'/source['file']) as dataset:
    for lat, lon in [(-12,-70),(-9.38671875,-78.93359375),(18.65,-133.8),(-42,70),(20,130),(89.5,0),(-89.5,0),(10,179.95),(10,-179.95)]:
        z, cells = manifest['maxZoom'], manifest['sampleSize']-1
        span = 180 / 2**z
        x, y = math.floor((lon+180)/span), math.floor((90-lat)/span)
        c, r = round(((lon+180)/span-x)*cells), round(((90-lat)/span-y)*cells)
        vertex_lon, vertex_lat = -180+(x+c/cells)*span, 90-(y+r/cells)*span
        px, py = ~dataset.transform * (vertex_lon, vertex_lat)
        px, py = px-.5, py-.5
        ix, iy = math.floor(px), math.floor(py)
        fx, fy = px-ix, py-iy
        pixels = dataset.read(1, window=Window(ix,iy,2,2)).astype('float64')
        assert pixels.shape == (2,2) and np.all(pixels != dataset.nodata)
        expected = float(pixels[0,0]*(1-fx)*(1-fy)+pixels[0,1]*fx*(1-fy)+pixels[1,0]*(1-fx)*fy+pixels[1,1]*fx*fy)
        blob = (manifest_path.parent/f'tiles/{z}/{x}/{y}.bin').read_bytes()
        values = np.frombuffer(gzip.decompress(blob), dtype='<i2').reshape(manifest['sampleSize'],manifest['sampleSize'])
        actual = float(values[r,c]*manifest['scaleMeters'])
        error = abs(actual-expected)
        assert error <= .500001, (lat,lon,expected,actual)
        checks.append({'lat':vertex_lat,'lon':vertex_lon,'sourceMeters':expected,'tileMeters':actual,'errorMeters':error})
output = root/'.terrain-cache/mars-upgrade/source-samples.json'
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps({'release':manifest['version'],'checks':checks},indent=2)+'\n')
print(f'Confirmed {len(checks)} native vertices against independent GeoTIFF reads; maximum rounding error {max(c["errorMeters"] for c in checks):.3f} m')
