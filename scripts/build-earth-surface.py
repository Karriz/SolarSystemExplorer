"""Compact Earth color and mapped global water fallback. No runtime satellite stream.

Use --ocean for a Natural Earth 1:10m ocean GeoJSON (build input only).
Land material classes are deliberately unknown here: local OpenFreeMap supplies
observed classifications; no RGB threshold is presented as measured land cover.
"""
import argparse
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_bounds

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/textures'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ocean', type=Path, required=True)
    args = parser.parse_args()
    source = OUT / 'earth-base.jpg'
    with rasterio.open(source) as dataset:
        assert (dataset.width, dataset.height) == (5400, 2700)
        rgb = dataset.read(out_shape=(3, 2048, 4096), resampling=Resampling.lanczos)
    with rasterio.open(OUT / 'earth-color.webp', 'w', driver='WEBP', width=4096,
                       height=2048, count=3, dtype='uint8', quality=92) as dataset:
        dataset.write(rgb)
    ocean = json.loads(args.ocean.read_text())
    classes = rasterize([(feature['geometry'], 9) for feature in ocean['features']],
                        out_shape=(1024, 2048), transform=from_bounds(-180, -90, 180, 90, 2048, 1024),
                        fill=0, dtype='uint8')
    raw = classes.tobytes()
    (OUT / 'earth-surface-base.bin.gz').write_bytes(gzip.compress(raw, mtime=0))
    metadata = {
        'schema': 1, 'body': 'earth', 'width': 4096, 'height': 2048,
        'source': 'NASA BMNG October 2004 base map without added relief shading',
        'sourceUrl': 'https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/',
        'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'colorSha256': hashlib.sha256((OUT / 'earth-color.webp').read_bytes()).hexdigest(),
        'globalMask': {'width': 2048, 'height': 1024, 'source': 'Natural Earth 1:10m ocean',
                       'sourceUrl': 'https://www.naturalearthdata.com/downloads/10m-physical-vectors/10m-ocean/',
                       'inputSha256': hashlib.sha256(args.ocean.read_bytes()).hexdigest(),
                       'sha256': hashlib.sha256(raw).hexdigest(),
                       'classes': {'0': 'unclassified land', '9': 'mapped ocean'},
                       'note': 'Generalized overview, not ground-level shorelines. Inland water comes from local vector tiles.'},
        'detail': 'Generated packed normal/roughness detail; mapped local classes from OpenFreeMap. No generated displacement.',
        'note': 'Appearance composite, not calibrated albedo. Global WorldCover overview is not installed.'
    }
    (OUT / 'earth-color.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps({'colorBytes': (OUT / 'earth-color.webp').stat().st_size,
                      'maskBytes': (OUT / 'earth-surface-base.bin.gz').stat().st_size}))


if __name__ == '__main__':
    main()
