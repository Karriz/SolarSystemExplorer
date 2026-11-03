"""Independent native GeoTIFF samples, including missing Venus polar data."""
import gzip
import hashlib
import json
import math
from pathlib import Path
import numpy as np
import rasterio
from rasterio.windows import Window

root = Path(__file__).resolve().parents[1]
source = json.loads((root / 'scripts/terrain-sources.json').read_text())['venus']
path = root / '.terrain-cache' / source['file']
with path.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == source['sha256']
catalog = json.loads((root / 'public/terrain/catalog.json').read_text())
release = root / 'public/terrain' / catalog['bodies']['venus']
manifest = json.loads(release.read_text())
size, z = manifest['sampleSize'], manifest['maxZoom']
assert manifest['referenceRadiusMeters'] == source['referenceRadiusMeters'] == 6051000
results = []
with rasterio.open(path) as dataset:
    assert dataset.shape == (4096, 8192) and dataset.scales == (1.,)
    for lat, lon in [(65, 3), (.5, -165.4), (10, 179.9), (10, -179.9), (80, 45), (-80, -45), (0, 0), (89.9, 0), (-89.9, 0)]:
        span = 180 / 2 ** z
        x, y = int((lon + 180) / span), int((90 - lat) / span)
        key = f'{z}/{x}/{y}'
        values = np.frombuffer(gzip.decompress((release.parent / 'tiles' / f'{key}.bin').read_bytes()), dtype='<i2').reshape(size, size)
        for r, c in [(8, 16), (32, 32), (56, 48)]:
            latitude = 90 - y * span - r * span / (size - 1)
            longitude = -180 + x * span + c * span / (size - 1)
            projected_x = source['sourceRadiusMeters'] * math.radians(longitude)
            projected_y = source['sourceRadiusMeters'] * math.radians(latitude)
            col, row = ~dataset.transform * (projected_x, projected_y)
            col -= .5
            row = min(dataset.height - 1, max(0, row - .5))
            ix, iy = math.floor(col), math.floor(row)
            u, v = col - ix, row - iy
            native, valid = 0, 0
            for dx, dy, weight in [(0, 0, (1-u)*(1-v)), (1, 0, u*(1-v)), (0, 1, (1-u)*v), (1, 1, u*v)]:
                raw = dataset.read(1, window=Window((ix + dx) % dataset.width, min(iy + dy, dataset.height - 1), 1, 1))[0, 0]
                if raw != dataset.nodata:
                    native += float(raw) * weight
                    valid += weight
            missing = valid < .99999
            if missing:
                assert values[r,c] == manifest['noData']
                error = None
            else:
                error = abs(float(values[r, c]) * manifest['scaleMeters'] - native)
                assert error <= .51, (latitude, longitude, values[r,c], native, error)
            results.append(dict(lat=latitude, lon=longitude, sourceMeters=None if missing else native,
                tileMeters=None if missing else int(values[r,c]), missing=missing, errorMeters=error))
assert any(p['missing'] for p in results) and any(not p['missing'] for p in results)
report = dict(body='venus', sourceSha256=source['sha256'], samples=results,
    maximumErrorMeters=max(p['errorMeters'] for p in results if not p['missing']))
(root / '.terrain-cache/venus-source-samples.json').write_text(json.dumps(report, indent=2) + '\n')
print(f"Verified {len(results)} Venus samples and polar NoData against native GeoTIFF; maximum error {report['maximumErrorMeters']:.3f} m")
