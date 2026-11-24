#!/usr/bin/env python3
"""Independent Corlies (2017) source-to-delivered height and color checks for Titan."""
import gzip
import json
import math
from pathlib import Path
import warnings

import numpy as np
import rasterio
from rasterio.windows import Window
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/titan'
metadata = json.load(open(ROOT / 'public/textures/titan-terrain.json'))
color_meta = json.load(open(ROOT / 'public/textures/titan-color.json'))
catalog = json.load(open(ROOT / 'public/terrain/catalog.json'))
manifest_path = ROOT / 'public/terrain' / catalog['bodies']['titan']
manifest = json.load(open(manifest_path))

assert manifest['sourceSha256'] == metadata['preparedSha256']
assert manifest['missingPixels'] == 0 and manifest['maxZoom'] == 6
assert 0.07 < metadata['measuredElevationFraction'] < 0.12

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


# 1. Independently verify delivered tiles against authoritative Corlies 32 PPD DTM/altimetry interiors!
zip_path = (CACHE / 'sources/corlies2017.zip').resolve()
controls = []
with rasterio.open(f'/vsizip/{zip_path}/dtm_32PPD.cub') as dtm_src, \
     rasterio.open(f'/vsizip/{zip_path}/alt_32PPD.cub') as alt_src:
    dtm = dtm_src.read(1).astype('float32')
    alt = alt_src.read(1).astype('float32')
    v_dtm = np.isfinite(dtm) & (np.abs(dtm) < 1e6)
    v_alt = np.isfinite(alt) & (np.abs(alt) < 1e6)
    # Interior of DTM-only (no alt override) at least 5 pixels from edge
    pure_dtm = v_dtm & (~v_alt)
    interior = distance_transform_edt(np.pad(pure_dtm, 1))[1:-1, 1:-1] > 5.0
    candidates = np.argwhere(interior)
    assert len(candidates) > 50
    for r, c in candidates[::max(1, len(candidates) // 16)]:
        lat = 90.0 - (r + 0.5) / 5760.0 * 180.0
        lon = -180.0 + (c + 0.5) / 11520.0 * 360.0
        if abs(lat) > 84.0:
            continue
        slat = round(lat / step) * step
        slon = round(lon / step) * step
        if slon >= 180.0:
            slon -= 360.0
        fr = (90.0 - slat) / 180.0 * 5760.0 - 0.5
        fc = (slon + 180.0) / 360.0 * 11520.0 - 0.5
        y0, x0 = math.floor(fr), math.floor(fc) % 11520
        x1 = (x0 + 1) % 11520
        if y0 < 0 or y0 >= 5759:
            continue
        block = np.array([[dtm[y0, x0], dtm[y0, x1]], [dtm[y0 + 1, x0], dtm[y0 + 1, x1]]])
        if not (np.isfinite(block).all() and (np.abs(block) < 1e6).all()):
            continue
        if not (interior[y0, x0] and interior[y0, x1] and interior[y0 + 1, x0] and interior[y0 + 1, x1]):
            continue
        u, v = fc - math.floor(fc), fr - y0
        expected = float(block[0, 0] * (1 - u) * (1 - v) + block[0, 1] * u * (1 - v)
                         + block[1, 0] * (1 - u) * v + block[1, 1] * u * v)
        actual = delivered_height(slat, slon)
        controls.append(dict(source='corlies-dtm-32ppd', latitude=slat, longitude=slon,
                             expectedMeters=expected, deliveredMeters=actual, errorMeters=abs(expected - actual)))
        if len(controls) >= 12:
            break

assert len(controls) >= 8, len(controls)
# Double interpolation at the delivery grid can smooth steep local cliff posts;
# this checks units, datum and registration (median < 10 m, max < 50 m).
assert float(np.median([c['errorMeters'] for c in controls])) < 10.0, controls
assert max(c['errorMeters'] for c in controls) < 50.0, controls

# 2. Polar convergence & extrema check
with rasterio.open(CACHE / 'titan-radial.tif') as prepared:
    for prow in (0, prepared.height - 1):
        pole = prepared.read(1, window=Window(0, prow, prepared.width, 1))
        assert float(np.ptp(pole)) < 4.0, f'Polar row {prow} failed convergence: ptp={np.ptp(pole)}'
assert -3000 < manifest['minHeightMeters'] < -1000 and 500 < manifest['maxHeightMeters'] < 3000

# 3. Color registration check: Xanadu bright vs Shangri-La dunes vs Kraken Mare dark hydrocarbon sea
with warnings.catch_warnings():
    warnings.simplefilter('ignore', rasterio.errors.NotGeoreferencedWarning)
    with rasterio.open(ROOT / 'public/textures/titan-color-reference.png') as img:
        rgb = img.read().astype('float32')
        assert rgb.shape == (3, 2048, 4096)
        for prow in (0, 2047):
            assert float(np.ptp(rgb[:, prow, :], axis=1).max()) <= 1.0

        def mean_rgb(lat, lon):
            r = int((90.0 - lat) / 180.0 * 2048)
            c = int((lon + 180.0) / 360.0 * 4096) % 4096
            patch = rgb[:, max(0, r - 6):min(2048, r + 7), max(0, c - 6):min(4096, c + 7)]
            return [float(patch[i].mean()) for i in range(3)]

        xanadu_rgb = mean_rgb(-15.0, -100.0)
        belet_rgb = mean_rgb(-5.0, 105.0)
        ligeia_rgb = mean_rgb(79.7, 112.1)
        assert sum(xanadu_rgb) > sum(belet_rgb) + 120.0, (xanadu_rgb, belet_rgb)
        assert sum(xanadu_rgb) > sum(ligeia_rgb) + 120.0, (xanadu_rgb, ligeia_rgb)

report = dict(
    completed=True,
    body='titan',
    controls=controls,
    maxErrorMeters=max(c['errorMeters'] for c in controls),
    medianErrorMeters=float(np.median([c['errorMeters'] for c in controls])),
    measuredElevationFraction=metadata['measuredElevationFraction'],
    colorChecks=dict(xanaduRgb=xanadu_rgb, beletDunesRgb=belet_rgb, ligeiaMareRgb=ligeia_rgb),
    colorBytes=color_meta['bytes'],
)
(CACHE / 'source-validation.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
