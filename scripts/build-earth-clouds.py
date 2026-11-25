"""Prepare compact NASA Blue Marble global cloud opacity texture and provenance.

Input: .terrain-cache/earth-source/cloud_combined_8192.tif (NASA Visible Earth 57747).
Output: public/textures/earth-clouds.webp (4096x2048) + public/textures/earth-clouds.json.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / '.terrain-cache/earth-source/earth-clouds-8k.jpg'
OUT = ROOT / 'public/textures'
SOURCE_URL = 'https://upload.wikimedia.org/wikipedia/commons/7/7a/Solarsystemscope_texture_8k_earth_clouds.jpg'
PAGE_URL = 'https://commons.wikimedia.org/wiki/File:Solarsystemscope_texture_8k_earth_clouds.jpg'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--width', type=int, default=4096)
    args = parser.parse_args()
    height = args.width // 2
    source = args.source
    if not source.exists():
        raise FileNotFoundError(f'Missing cloud source: {source}')

    with rasterio.open(source) as dataset:
        bands = dataset.count
        data = dataset.read(out_shape=(bands, height, args.width), resampling=Resampling.lanczos)
        if bands >= 3:
            # Grayscale luminance from RGB cloud mosaic.
            luma = np.rint(0.2126 * data[0] + 0.7152 * data[1] + 0.0722 * data[2]).clip(0, 255).astype('uint8')
        else:
            luma = data[0].clip(0, 255).astype('uint8')
        rgb = np.stack([luma, luma, luma], axis=0)
        src_dims = [dataset.width, dataset.height]

    out_webp = OUT / 'earth-clouds.webp'
    with rasterio.open(out_webp, 'w', driver='WEBP', width=args.width,
                       height=height, count=3, dtype='uint8', quality=88) as dataset:
        dataset.write(rgb)

    metadata = {
        'schema': 1,
        'body': 'earth',
        'width': args.width,
        'height': height,
        'sourceDimensions': src_dims,
        'source': 'NASA Visible Earth Blue Marble global cloud mosaic via Solar System Scope (CC BY 4.0)',
        'license': 'CC BY 4.0',
        'pageUrl': PAGE_URL,
        'sourceUrl': SOURCE_URL,
        'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'outputSha256': hashlib.sha256(out_webp.read_bytes()).hexdigest(),
        'bytes': out_webp.stat().st_size,
        'note': 'Fixed observed global cloud composite, not live weather. Linear cloud-opacity fraction.',
    }
    (OUT / 'earth-clouds.json').write_text(json.dumps(metadata, indent=2) + '\n')
    print(json.dumps({'cloudBytes': metadata['bytes'], 'width': args.width, 'height': height}))


if __name__ == '__main__':
    main()
