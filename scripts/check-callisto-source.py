#!/usr/bin/env python3
"""Independent source-to-delivered height, landmark, and color checks for Callisto."""
import gzip
import json
import math
from pathlib import Path
import warnings

import numpy as np
import rasterio
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/callisto'
metadata = json.load(open(ROOT / 'public/textures/callisto-terrain.json'))
color_meta = json.load(open(ROOT / 'public/textures/callisto-color.json'))
catalog = json.load(open(ROOT / 'public/terrain/catalog.json'))
manifest_path = ROOT / 'public/terrain' / catalog['bodies']['callisto']
manifest = json.load(open(manifest_path))

assert manifest['sourceSha256'] == metadata['preparedSha256']
assert manifest['missingPixels'] == 0 and manifest['maxZoom'] == 6
assert metadata['measuredElevationFraction'] == 0.0
assert 0.05 < metadata['namedFeatureConstrainedFraction'] < 0.7

z = manifest['maxZoom']
span = 180.0 / (2 ** z)
step = span / 128.0


def delivered_height(lat, lon):
    lon = ((lon + 180.0) % 360.0) - 180.0
    lat = max(-90.0, min(90.0, lat))
    tx = min(2 ** (z + 1) - 1, max(0, int((lon + 180.0) / span)))
    ty = min(2 ** z - 1, max(0, int((90.0 - lat) / span)))
    grid = np.frombuffer(
        gzip.decompress((manifest_path.parent / f'tiles/{z}/{tx}/{ty}.bin').read_bytes()),
        dtype='<i2',
    ).reshape(129, 129)
    r = min(128, max(0, round((90.0 - ty * span - lat) / span * 128)))
    c = min(128, max(0, round((lon + 180.0 - tx * span) / span * 128)))
    return float(grid[r, c])


controls = []
with rasterio.open(CACHE / 'callisto-radial.tif') as prepared:
    for prow in (0, prepared.height - 1):
        pole = prepared.read(1, window=Window(0, prow, prepared.width, 1))
        assert float(np.ptp(pole)) < 4.0, f'Polar row {prow} failed convergence: ptp={np.ptp(pole)}'

    landmarks = [
        ('Valhalla center', 14.7, -56.0),
        ('Asgard center', 32.2, -139.9),
        ('Adlinda center', -48.5, -35.6),
        ('Utgard center', 45.0, -134.0),
        ('Lofn crater floor', -56.5, -22.3),
        ('Heimdall crater floor', -63.5, 3.0),
        ('Burr crater', 42.7, -134.5),
        ('Tindr crater', -2.3, 4.5),
        ('Gipul Catena', 68.5, -54.2),
        ('Dark plains', 0.0, 120.0),
        ('Dateline', 10.0, 179.5),
        ('Cube corner', 35.26, 45.0),
    ]
    for name, lat, lon in landmarks:
        slat = round(lat / step) * step
        slon = round(lon / step) * step
        if slon >= 180.0:
            slon -= 360.0
        col = (slon + 180.0) / 360.0 * prepared.width - 0.5
        row = (90.0 - slat) / 180.0 * prepared.height - 0.5
        x0 = math.floor(col) % prepared.width
        x1 = (x0 + 1) % prepared.width
        y0 = max(0, min(prepared.height - 2, math.floor(row)))
        u = col - math.floor(col)
        v = max(0.0, min(1.0, row - y0))
        r0 = prepared.read(1, window=Window(0, y0, prepared.width, 2))
        expected = float(
            r0[0, x0] * (1 - u) * (1 - v) + r0[0, x1] * u * (1 - v)
            + r0[1, x0] * (1 - u) * v + r0[1, x1] * u * v
        )
        actual = delivered_height(slat, slon)
        err = abs(expected - actual)
        controls.append(dict(site=name, latitude=slat, longitude=slon,
                             expectedMeters=expected, deliveredMeters=actual, errorMeters=err))

assert max(c['errorMeters'] for c in controls) < 5.0, controls
by_name = {c['site']: c['deliveredMeters'] for c in controls}
assert by_name['Lofn crater floor'] < -250.0, by_name
assert by_name['Heimdall crater floor'] < -250.0, by_name
assert -4000 < manifest['minHeightMeters'] < -800 and 400 < manifest['maxHeightMeters'] < 4000

with warnings.catch_warnings():
    warnings.simplefilter('ignore', rasterio.errors.NotGeoreferencedWarning)
    with rasterio.open(ROOT / 'public/textures/callisto-color-reference.png') as img:
        rgb = img.read().astype('float32')
        assert rgb.shape == (3, 2048, 4096)
        for prow in (0, 2047):
            assert float(np.ptp(rgb[:, prow, :], axis=1).max()) <= 1.0

        def mean_rgb(lat, lon):
            r = int((90.0 - lat) / 180.0 * 2048)
            c = int((lon + 180.0) / 360.0 * 4096) % 4096
            patch = rgb[:, max(0, r - 4):min(2048, r + 5), max(0, c - 4):min(4096, c + 5)]
            return [float(patch[i].mean()) for i in range(3)]

        plains_rgb = mean_rgb(0.0, 120.0)
        valhalla_rgb = mean_rgb(14.7, -56.0)
        burr_rgb = mean_rgb(42.7, -134.5)
        heimdall_rgb = mean_rgb(-63.5, 3.0)
        assert sum(valhalla_rgb) > sum(plains_rgb) + 40.0, (plains_rgb, valhalla_rgb)
        assert sum(burr_rgb) > sum(plains_rgb) + 140.0, (plains_rgb, burr_rgb)
        assert sum(heimdall_rgb) > sum(plains_rgb) + 150.0, (plains_rgb, heimdall_rgb)
        # Dark plains should be warm brownish-gray (R > G > B)
        assert plains_rgb[0] > plains_rgb[1] > plains_rgb[2], plains_rgb

report = dict(
    completed=True,
    body='callisto',
    controls=controls,
    maxErrorMeters=max(c['errorMeters'] for c in controls),
    measuredElevationFraction=metadata['measuredElevationFraction'],
    namedFeatureConstrainedFraction=metadata['namedFeatureConstrainedFraction'],
    colorChecks=dict(plainsRgb=plains_rgb, valhallaRgb=valhalla_rgb, burrRgb=burr_rgb, heimdallRgb=heimdall_rgb),
    colorBytes=color_meta['bytes'],
)
(CACHE / 'source-validation.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
