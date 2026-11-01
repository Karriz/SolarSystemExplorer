#!/usr/bin/env python3
"""Build a versioned geographic WebP pyramid from the LROC WAC 643 nm PDS rasters.

RG stores unsigned 10-bit reflectance (0..1); alpha is measured coverage.
Tiles include 0.18 degree gutters, so local contrast sampling across an edge
uses the same physical source pixels on either side. At 58..60 degrees the
equatorial and polar products are blended where both contain valid data.
"""
import argparse
import concurrent.futures
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.windows import from_bounds as window_from_bounds
from rasterio.warp import reproject

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / '.terrain-cache/wac-global/sources'
DEST = ROOT / 'public/terrain/moon/wac643-304ppd-v1'
SIZE = 384
PAD = .18
RADIANS_TO_METERS = 1737400 * math.pi / 180
GEO = CRS.from_proj4('+proj=longlat +R=1737400 +no_defs')
NODATA = -3.4028226550889045e+38


def runs(indices):
    if not len(indices):
        return
    start = previous = int(indices[0])
    for value in indices[1:]:
        value = int(value)
        if value != previous + 1:
            yield start, previous + 1
            start = value
        previous = value
    yield start, previous + 1


class Sources:
    def __init__(self, check_hash=False):
        records = json.loads((SOURCE / 'sources.json').read_text())
        self.digest = hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest()[:12]
        self.equatorial = {}
        self.polar = {}
        for record in records:
            path = SOURCE / record['file']
            if path.stat().st_size != record['bytes']:
                raise ValueError(f'Invalid source length: {path}')
            if check_hash:
                with path.open('rb') as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != record['sha256']:
                        raise ValueError(f'Source checksum mismatch: {path}')
            region = record['file'].split('_')[3]
            ds = rasterio.open(path)
            if ds.count != 1 or ds.dtypes[0] != 'float32' or ds.nodata != NODATA:
                raise ValueError(f'Unexpected WAC product: {path}')
            if region[0] == 'P':
                self.polar[region[4]] = ds
            else:
                self.equatorial[(region[4], int(region[5:]) // 900)] = ds
        if len(self.equatorial) != 8 or len(self.polar) != 2:
            raise ValueError('Incomplete WAC source set')

    def close(self):
        for ds in list(self.equatorial.values()) + list(self.polar.values()):
            ds.close()

    def sample(self, west, south, east, north):
        result = np.zeros((SIZE, SIZE), np.float32)
        longitude = west + (np.arange(SIZE) + .5) * (east - west) / SIZE
        latitude = north - (np.arange(SIZE) + .5) * (north - south) / SIZE
        mapped = longitude % 360
        for hem, rowmask in [('N', (latitude >= 0) & (latitude <= 60)),
                             ('S', (latitude < 0) & (latitude >= -60))]:
            for first_row, last_row in runs(np.flatnonzero(rowmask)):
                for quadrant in range(4):
                    columns = np.flatnonzero((mapped >= quadrant * 90) & (mapped < (quadrant + 1) * 90))
                    for first_col, last_col in runs(columns):
                        ds = self.equatorial.get((hem, quadrant))
                        if ds is None:
                            continue
                        dx = (east - west) / SIZE
                        dy = (north - south) / SIZE
                        # A longitude run can cross 0/360 at the gutter.
                        shift = round((quadrant * 90 - longitude[first_col]) / 360) * 360
                        left = (west + first_col * dx + shift) * RADIANS_TO_METERS
                        right = (west + last_col * dx + shift) * RADIANS_TO_METERS
                        top = north - first_row * dy
                        bottom = north - last_row * dy
                        window = window_from_bounds(left, bottom * RADIANS_TO_METERS,
                                                    right, top * RADIANS_TO_METERS, ds.transform)
                        part = ds.read(1, window=window, out_shape=(last_row-first_row, last_col-first_col),
                                       boundless=True, fill_value=ds.nodata, resampling=Resampling.bilinear)
                        valid = np.isfinite(part) & (part > 0) & (part <= 1)
                        target = result[first_row:last_row, first_col:last_col]
                        target[valid] = part[valid]
        for hem, selected in [('N', north >= 58), ('S', south <= -58)]:
            if not selected:
                continue
            polar = np.full_like(result, -1)
            ds = self.polar[hem]
            reproject(rasterio.band(ds, 1), polar, src_nodata=ds.nodata,
                      dst_transform=from_bounds(west, south, east, north, SIZE, SIZE),
                      dst_crs=GEO, dst_nodata=-1, resampling=Resampling.bilinear, num_threads=2)
            valid = np.isfinite(polar) & (polar > 0) & (polar <= 1)
            if hem == 'N':
                blend = np.clip((latitude - 58) / 2, 0, 1)[:, None]
            else:
                blend = np.clip((-latitude - 58) / 2, 0, 1)[:, None]
            weight = np.where(valid, blend, 0)
            # When an equatorial sample is absent, use polar coverage alone.
            weight = np.where((result <= 0) & valid, 1, weight)
            result = result * (1 - weight) + np.where(valid, polar, 0) * weight
        return result


def build_tile(sources, z, x, y, output):
    span = 180 / 2**z
    west, east = -180 + x * span - PAD, -180 + (x+1) * span + PAD
    north, south = min(90, 90 - y * span + PAD), max(-90, 90 - (y+1) * span - PAD)
    data = sources.sample(west, south, east, north)
    valid = np.isfinite(data) & (data > 0) & (data <= 1)
    value = np.rint(np.clip(data, 0, 1) * 1023).astype(np.uint16)
    channels = np.empty((4, SIZE, SIZE), np.uint8)
    channels[0] = value >> 2
    channels[1] = (value & 3) * 85
    channels[2] = 0
    channels[3] = valid.astype(np.uint8) * 255
    output.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(output, 'w', driver='WEBP', width=SIZE, height=SIZE, count=4,
                       dtype='uint8', LOSSLESS='YES') as dst:
        dst.write(channels)
    return int(np.count_nonzero(valid))


WORKER_SOURCES = None


def init_worker():
    global WORKER_SOURCES
    WORKER_SOURCES = Sources()


def build_one(item):
    z, x, y, root = item
    target = root / f'{z}/{x}/{y}.webp'
    if target.exists():
        try:
            with rasterio.open(target) as ds:
                if ds.driver == 'WEBP' and ds.width == SIZE and ds.height == SIZE and ds.count in (3, 4):
                    ds.read(1, window=((0, 1), (0, 1)))
                    return 0
        except Exception:
            pass
    return build_tile(WORKER_SOURCES, z, x, y, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--min-zoom', type=int, default=4)
    parser.add_argument('--max-zoom', type=int, default=8)
    parser.add_argument('--tile', nargs=3, type=int, metavar=('Z', 'X', 'Y'))
    parser.add_argument('--output', type=Path, default=DEST)
    parser.add_argument('--workers', type=int, default=6)
    args = parser.parse_args()
    sources = Sources(check_hash=True)
    try:
        if args.min_zoom != 4 or args.max_zoom != 8:
            raise ValueError('The published WAC contract requires levels 4 through 8')
        manifest_path = args.output / 'manifest.json'
        if manifest_path.exists() and json.loads(manifest_path.read_text()).get('sourceDigest') != sources.digest:
            raise ValueError('Published WAC release source changed; choose a new version directory')
        total = 0
        if args.tile:
            z, x, y = args.tile
            total = build_tile(sources, z, x, y, args.output / f'{z}/{x}/{y}.webp')
        else:
            with concurrent.futures.ProcessPoolExecutor(max_workers=args.workers, initializer=init_worker) as pool:
                for z in range(args.min_zoom, args.max_zoom+1):
                    tiles = ((z, x, y, args.output) for y in range(2**z) for x in range(2**(z+1)))
                    total += sum(pool.map(build_one, tiles, chunksize=32))
                    print(f'Built level {z}', flush=True)
        if not args.tile:
            manifest = {
                'schema': 1, 'source': 'LROC WAC empirical 643 nm 304 ppd',
                'sourceDigest': sources.digest, 'minZoom': args.min_zoom,
                'maxZoom': args.max_zoom, 'size': SIZE, 'padDegrees': PAD,
                'encoding': 'webp-rg10-alpha-coverage', 'tileCount': sum(2 * 4**z for z in range(4, 9)),
                'sourceFiles': 10}
            temporary = manifest_path.with_suffix('.json.writing')
            temporary.write_text(json.dumps(manifest, indent=2) + '\n')
            temporary.replace(manifest_path)
            print('Complete:', args.output, flush=True)
    finally:
        sources.close()


if __name__ == '__main__':
    main()
