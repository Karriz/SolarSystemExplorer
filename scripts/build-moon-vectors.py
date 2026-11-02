#!/usr/bin/env python3
"""Trace appearance classes from moon.jpg; these are not geological units.

Uses the existing terrain Python environment (numpy/rasterio). Shared edges
retain exact pixel coordinates: removing collinear vertices is lossless and
avoids cracks from independently simplifying neighboring polygons.
"""
import argparse
import hashlib
import gzip
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import shapes, sieve


def lab(rgb):
    v = rgb / 255.0
    v = np.where(v <= .04045, v / 12.92, ((v + .055) / 1.055) ** 2.4)
    xyz = v @ np.array([[.4124564, .2126729, .0193339],
                        [.3575761, .7151522, .1191920],
                        [.1804375, .0721750, .9503041]], dtype=np.float32)
    xyz /= np.array([.95047, 1, 1.08883], dtype=np.float32)
    f = np.where(xyz > .008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]),
                     200 * (f[..., 1] - f[..., 2])], axis=-1)


def nearest(values, centers):
    return ((values[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2).argmin(axis=1)


def ring_path(ring):
    p = np.asarray(ring[:-1], dtype=np.int32)
    before, after = p - np.roll(p, 1, axis=0), np.roll(p, -1, axis=0) - p
    p = p[before[:, 0] * after[:, 1] != before[:, 1] * after[:, 0]]
    return 'M' + 'L'.join(f'{x},{y}' for x, y in p) + 'Z'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--width', type=int, default=4096)
    parser.add_argument('--tile-size', type=int, default=512)
    parser.add_argument('--min-region', type=int, default=12)
    parser.add_argument('--colors', type=int, nargs='+', default=[6, 10, 16])
    parser.add_argument('--contours', action='store_true', help='Also build shared diagonal/smooth 10-color contours')
    parser.add_argument('--output', type=Path, default=Path('public/moon-vectors'))
    args = parser.parse_args()
    width, height, tile = args.width, args.width // 2, args.tile_size
    if width % tile or height % tile:
        parser.error('width and half-width must be multiples of tile-size')
    source = Path('public/textures/moon.jpg')
    with rasterio.open(source) as src:
        rgb = src.read(out_shape=(3, height, width), resampling=Resampling.average).transpose(1, 2, 0)
    pixels = rgb.reshape(-1, 3).astype(np.float32)
    # Seeded stratified training sample keeps all three comparisons repeatable.
    rng = np.random.default_rng(20261102)
    sample_indices = rng.choice(len(pixels), min(65536, len(pixels)), replace=False)
    sample = lab(pixels[sample_indices])
    for count in args.colors:
        centers = [sample[np.argmin(sample[:, 0])]]
        for _ in range(count - 1):
            distance = ((sample[:, None] - np.array(centers)[None]) ** 2).sum(axis=2).min(axis=1)
            centers.append(sample[np.argmax(distance)])
        centers = np.array(centers)
        for _ in range(24):
            labels = nearest(sample, centers)
            updated = np.array([sample[labels == i].mean(axis=0) if np.any(labels == i) else centers[i]
                                for i in range(count)])
            if np.max(np.abs(updated - centers)) < .015:
                break
            centers = updated
        centers = centers[np.argsort(centers[:, 0])]
        labels = np.empty(len(pixels), dtype=np.uint8)
        sums, totals = np.zeros((count, 3)), np.zeros(count)
        for start in range(0, len(pixels), 65536):
            block = pixels[start:start + 65536]
            indices = nearest(lab(block), centers)
            labels[start:start + len(block)] = indices
            for i in range(count):
                sums[i] += block[indices == i].sum(axis=0)
                totals[i] += np.sum(indices == i)
        palette = ['#' + ''.join(f'{round(c):02x}' for c in color)
                   for color in sums / np.maximum(totals[:, None], 1)]
        # Include wrapped neighbors when removing speckles at the longitude seam.
        labels = labels.reshape(height, width)
        pad = max(16, args.min_region)
        padded = np.pad(labels, ((0, 0), (pad, pad)), mode='wrap')
        labels = sieve(padded, size=args.min_region, connectivity=4)[:, pad:-pad]
        folder = args.output / str(count)
        folder.mkdir(parents=True, exist_ok=True)
        entries, polygons, vertices, payload, compressed = [], 0, 0, 0, 0
        for y in range(height // tile):
            for x in range(width // tile):
                paths = [''] * count
                for geometry, value in shapes(labels[y*tile:(y+1)*tile, x*tile:(x+1)*tile], connectivity=4):
                    paths[int(value)] += ''.join(ring_path(ring) for ring in geometry['coordinates'])
                    polygons += 1
                vertices += sum(path.count('L') + path.count('M') for path in paths)
                filename = f'{x}-{y}.json.gz'
                data = json.dumps({'paths': paths}, separators=(',', ':'))
                packed = gzip.compress(data.encode(), mtime=0)
                (folder / filename).write_bytes(packed)
                (folder / f'{x}-{y}.json').unlink(missing_ok=True)
                payload += len(data)
                compressed += len(packed)
                entries.append({'x': x, 'y': y, 'file': filename})
        check_x = sorted(set([0, width-1] + [v for x in range(tile, width, tile) for v in [x-1, x]]))
        check_y = sorted(set([0, height-1] + [v for y in range(tile, height, tile) for v in [y-1, y]]))
        check_samples = [[x, y, int(labels[y, x])] for x in check_x for y in check_y]
        manifest = {'schema': 1, 'source': 'moon.jpg', 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
                    'description': 'Image-derived appearance classes, not measured geology or new surface detail',
                    'width': width, 'height': height, 'tileSize': tile, 'palette': palette, 'tiles': entries,
                    'minRegionPixels': args.min_region, 'polygons': polygons, 'vertices': vertices, 'payloadBytes': payload,
                    'compressedBytes': compressed,
                    'checkSamples': check_samples}
        (folder / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        print(f'{count} colors: {polygons:,} polygons, {vertices:,} vertices, {payload/1e6:.2f} MB paths / {compressed/1e6:.2f} MB gzip', flush=True)
        if count == 10 and args.contours:
            from moon_vector_contours import build_contours
            Path('.terrain-cache').mkdir(exist_ok=True)
            np.savez_compressed('.terrain-cache/moon-vector-labels-10.npz', labels=labels)
            build_contours(labels, palette, manifest, args.output)


if __name__ == '__main__':
    main()
