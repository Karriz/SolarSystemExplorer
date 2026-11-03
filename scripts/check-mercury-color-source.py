"""Check delivery hashes and independently average raw PDS visible-band pixels."""
import hashlib
import json
import math
import re
from pathlib import Path

import numpy as np
import rasterio

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/mercury-color'
report = json.loads((ROOT / 'public/textures/mercury-color.json').read_text())


def value(label, name):
    return float(re.search(r'^\s*' + name + r'\s*=\s*([-+\d.eE]+)', label, re.M)[1])


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


assert len(report['sources']) == 55
assert report['surfaceCoverageFraction'] > .99
assert sha(ROOT / 'public/textures/mercury-color.webp') == report['deliveredSha256']
sources = []
for source in report['sources']:
    raw = next(CACHE.rglob(source['product'] + '.visible.f32'))
    label = raw.with_name(source['product'] + '.original.lbl')
    assert sha(raw) == source['sha256'] and sha(label) == source['labelSha256']
    sources.append((label.read_text(), raw))

checks = []
for control in report['controlSamples']:
    if abs(control['lat']) > 65:
        continue  # Independent rectangular-area fixture covers cylindrical tiles.
    x, y = control['pixel']
    west, east = x * 360 / report['width'] - 180, (x + 1) * 360 / report['width'] - 180
    north, south = 90 - y * 180 / report['height'], 90 - (y + 1) * 180 / report['height']
    verified = False
    for label, raw in sources:
        if '"EQUIRECTANGULAR"' not in label:
            continue
        radius = value(label, 'A_AXIS_RADIUS') * 1000
        scale = value(label, 'MAP_SCALE')
        center = value(label, 'CENTER_LONGITUDE')
        offset_x = value(label, 'SAMPLE_PROJECTION_OFFSET') + .5
        offset_y = value(label, 'LINE_PROJECTION_OFFSET') + .5
        lon_delta = (west - center + 180) % 360 - 180
        left = radius * math.radians(lon_delta) / scale + offset_x
        right = left + radius * math.radians(east - west) / scale
        top = offset_y - radius * math.radians(north) / scale
        bottom = offset_y - radius * math.radians(south) / scale
        width, height = int(value(label, 'LINE_SAMPLES')), int(value(label, 'LINES'))
        if not (0 <= left < right < width and 0 <= top < bottom < height):
            continue
        # PDS float32 little-endian bands are B,G,R. No GDAL coordinate or
        # resampling code is used for this independent numeric comparison.
        data = np.memmap(raw, dtype='<f4', mode='r', shape=(3, height, width))
        average = np.zeros(3)
        for row in range(math.floor(top), math.ceil(bottom)):
            wy = max(0, min(row + 1, bottom) - max(row, top))
            for col in range(math.floor(left), math.ceil(right)):
                wx = max(0, min(col + 1, right) - max(col, left))
                average += data[::-1, row, col].astype('float64') * wx * wy
        average /= (bottom - top) * (right - left)
        if not np.all(np.isfinite(average) & (average > 0)):
            continue
        error = float(np.max(np.abs(average - control['linearReflectance'])))
        assert error < 2e-5, (control['lat'], control['lon'], raw.name, average, control['linearReflectance'], error)
        checks.append(dict(pixel=control['pixel'], product=raw.stem, maximumReflectanceError=error))
        verified = True
        break
    assert verified, f'No native source check for {control}'

with rasterio.open(ROOT / 'public/textures/mercury-color-reference.png') as dataset:
    rgb = dataset.read()
    assert dataset.shape == (2048, 4096) and dataset.count == 3
    for control in report['controlSamples']:
        x, y = control['pixel']
        assert rgb[:, y, x].tolist() == control['srgb']
result = dict(sourcesVerified=len(sources), nativeColorSamples=checks,
              surfaceCoverageFraction=report['surfaceCoverageFraction'],
              geographicPixelCoverageFraction=report['validCoverageFraction'])
(CACHE / 'independent-validation.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
