#!/usr/bin/env python3
"""Independent source-to-delivered height, landmark, and color checks for Ganymede."""
import gzip
import json
import math
from pathlib import Path
import warnings

import numpy as np
import rasterio
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/ganymede'
metadata = json.load(open(ROOT / 'public/textures/ganymede-terrain.json'))
color_meta = json.load(open(ROOT / 'public/textures/ganymede-color.json'))
catalog = json.load(open(ROOT / 'public/terrain/catalog.json'))
manifest_path = ROOT / 'public/terrain' / catalog['bodies']['ganymede']
manifest = json.load(open(manifest_path))

assert manifest['sourceSha256'] == metadata['preparedSha256']
assert manifest['missingPixels'] == 0 and manifest['maxZoom'] == 6
assert metadata['measuredElevationFraction'] == 0.0
assert 0.10 < metadata['geologicFeatureConstrainedFraction'] < 0.5

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
with rasterio.open(CACHE / 'ganymede-radial.tif') as prepared:
    # 1. Exact polar convergence check
    for prow in (0, prepared.height - 1):
        pole = prepared.read(1, window=Window(0, prow, prepared.width, 1))
        assert float(np.ptp(pole)) < 4.0, f'Polar row {prow} failed convergence: ptp={np.ptp(pole)}'

    # 2. Sample prepared raster vs delivered tiles at 12 landmarks / global points
    landmarks = [
        ('Galileo Regio', 35.4, -118.6),
        ('Uruk Sulcus', 0.8, -160.3),
        ('Osiris crater floor', -38.1, -166.4),
        ('Tros crater floor', 11.1, -27.3),
        ('Gilgamesh basin interior', -62.8, -125.0),
        ('Gilgamesh main ring', -56.5, -125.0),
        ('Marius Regio dateline', 6.5, 179.5),
        ('Equatorial prime meridian', 0.0, 0.0),
        ('Cube corner NE', 35.26, 45.0),
        ('Cube corner SW', -35.26, -45.0),
        ('High north', 78.0, 90.0),
        ('High south', -78.0, -90.0),
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

# 3. Geologic morphology sanity checks: Gilgamesh interior lower than ring; Osiris depressed
by_name = {c['site']: c['deliveredMeters'] for c in controls}
assert by_name['Gilgamesh basin interior'] < by_name['Gilgamesh main ring'] - 700.0, by_name
assert by_name['Osiris crater floor'] < -200.0, by_name
assert -4000 < manifest['minHeightMeters'] < -800 and 500 < manifest['maxHeightMeters'] < 4000

# 4. Color map registration & polar continuity check
with warnings.catch_warnings():
    warnings.simplefilter('ignore', rasterio.errors.NotGeoreferencedWarning)
    with rasterio.open(ROOT / 'public/textures/ganymede-color-reference.png') as img:
        rgb = img.read().astype('float32')
        assert rgb.shape == (3, 2048, 4096)
        for prow in (0, 2047):
            assert float(np.ptp(rgb[:, prow, :], axis=1).max()) <= 1.0

        def mean_rgb(lat, lon):
            r = int((90.0 - lat) / 180.0 * 2048)
            c = int((lon + 180.0) / 360.0 * 4096) % 4096
            patch = rgb[:, max(0, r - 4):min(2048, r + 5), max(0, c - 4):min(4096, c + 5)]
            return [float(patch[i].mean()) for i in range(3)]

        galileo_rgb = mean_rgb(35.4, -118.6)
        osiris_rgb = mean_rgb(-38.1, -166.4)
        tros_rgb = mean_rgb(11.1, -27.3)
        assert sum(osiris_rgb) > sum(galileo_rgb) + 80.0, (galileo_rgb, osiris_rgb)
        assert sum(tros_rgb) > sum(galileo_rgb) + 80.0, (galileo_rgb, tros_rgb)
        # Galileo Regio should be warm brownish-gray (R > G > B)
        assert galileo_rgb[0] > galileo_rgb[1] > galileo_rgb[2], galileo_rgb

report = dict(
    completed=True,
    body='ganymede',
    controls=controls,
    maxErrorMeters=max(c['errorMeters'] for c in controls),
    measuredElevationFraction=metadata['measuredElevationFraction'],
    geologicFeatureConstrainedFraction=metadata['geologicFeatureConstrainedFraction'],
    colorChecks=dict(galileoRegioRgb=galileo_rgb, osirisRgb=osiris_rgb, trosRgb=tros_rgb),
    colorBytes=color_meta['bytes'],
)
(CACHE / 'source-validation.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
