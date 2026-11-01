#!/usr/bin/env python3
"""Build two bounded WAC brightness-detail textures from prepared float samples.

Input NPZ files contain reflectance (2048x2048 float32) and bounds; see the
pilot results for PDS sources and extraction. Output RGB stores a linear detail
multiplier in [0, 2], alpha fades at the boundary or invalid samples.
"""
from pathlib import Path
import argparse
import numpy as np
import rasterio

EXPECTED = {'hadley': (1.63, 24.13, 5.63, 28.13), 'tycho': (-13.36, -45.31, -9.36, -41.31)}

def box(a, radius):
    a = np.pad(a, ((0, 0), (radius, radius)), mode='edge')
    a = np.pad(np.cumsum(a, axis=1, dtype=np.float64), ((0, 0), (1, 0)))
    return (a[:, 2 * radius + 1:] - a[:, :-(2 * radius + 1)]) / (2 * radius + 1)

def build(source, out):
    for name, expected in EXPECTED.items():
        with np.load(source / f'{name}-numeric.npz') as data:
            image = data['reflectance'].astype(np.float32)
            if image.shape != (2048, 2048) or not np.allclose(data['bounds'], expected, atol=1e-8):
                raise ValueError(f'Unexpected {name} image geometry')
        valid = np.isfinite(image) & (image > 0) & (image <= 1)
        if not valid.all():
            raise ValueError(f'{name} pilot requires a fully valid source window')
        image = image.reshape(1024, 2, 1024, 2).mean(axis=(1, 3))
        # Approximately 9.5 km window. This retains local measured variation
        # while the existing global map supplies broad color and brightness.
        mean = box(box(image, 40).T, 40).T
        ratio = np.clip(image / np.maximum(mean, 1e-6), .65, 1.35)
        y, x = np.indices(image.shape); edge = np.minimum.reduce([x, y, 1023-x, 1023-y])
        alpha = np.clip(edge / 80, 0, 1); alpha = alpha * alpha * (3 - 2 * alpha)
        pixels = np.empty((4, 1024, 1024), dtype=np.uint8)
        pixels[:3] = np.rint(ratio * 127.5).astype(np.uint8)
        pixels[3] = np.rint(alpha * 255).astype(np.uint8)
        out.mkdir(parents=True, exist_ok=True)
        with rasterio.open(out / f'wac-{name}-detail.png', 'w', driver='PNG', width=1024, height=1024, count=4, dtype='uint8') as dst:
            dst.write(pixels)
        print(name, 'ratio range', float(ratio.min()), float(ratio.max()))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=Path('.terrain-cache/wac-pilot'))
    parser.add_argument('--output', type=Path, default=Path('public/textures'))
    args = parser.parse_args(); build(args.source, args.output)
