"""Reproducible inferred Venus basalt, deliberately independent of radar brightness.

Pieters et al. (1986) supports dark, nearly neutral rock under white light,
not a global RGB measurement or a unique numerical reflectance. The chosen
linear RGB is an illustrative material assumption, recorded with the assets.
"""
import hashlib
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.shutil import copy

out = Path(__file__).resolve().parents[1] / 'public/textures'
linear = np.array([.095, .090, .085])
srgb = np.rint((1.055 * linear ** (1 / 2.4) - .055) * 255).astype('uint8')
pixels = np.broadcast_to(srgb[:, None, None], (3, 2048, 4096)).copy()
with rasterio.Env(GDAL_PAM_ENABLED='NO'):
    with rasterio.open(out / 'venus-color-reference.png', 'w', driver='PNG', width=4096, height=2048, count=3, dtype='uint8') as dataset:
        dataset.write(pixels)
    copy(out / 'venus-color-reference.png', out / 'venus-color.webp', driver='WEBP', LOSSLESS='YES')
    with rasterio.open(out / 'venus-color.webp') as dataset:
        assert np.array_equal(dataset.read(), pixels)
report = dict(schema=1, body='venus', width=4096, height=2048,
    source='Inferred uniform basalt material; not measured global color',
    sourceUrl='https://ntrs.nasa.gov/citations/19870039592',
    credit='Pieters et al. (1986), qualitative Venera 13 color constraint; illustrative material by SolarSystemExplorer',
    linearReflectanceAssumption=linear.tolist(), srgb=srgb.tolist(),
    limitations='RGB values are artistic assumptions, not calibrated Venera measurements. White-light, cloud-free visualization; no atmospheric orange illumination. No radar brightness, elevation tint, baked shadow or invented geographic color variation.',
    controlSamples=[dict(lat=lat, lon=lon, srgb=srgb.tolist()) for lat,lon in [(0,0),(65,3),(0.5,-165.4),(90,0),(-90,0),(10,179.99)]],
    deliveredSha256=hashlib.sha256((out / 'venus-color.webp').read_bytes()).hexdigest(),
    bytes=(out / 'venus-color.webp').stat().st_size)
(out / 'venus-color.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
