#!/usr/bin/env python3
"""Bounded, reproducible Hadley elevation + Finnish land-cover pilot.

No global normalization or pyramid generation. Source files are cached; a
completed release is reused, and interruption resumes at individual tiles.
"""
import argparse
import gzip
import hashlib
import json
import math
import shutil
import time
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window, from_bounds

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'SLDEM2015_512_00N_30N_000_045.JP2'
URL = 'https://imbrium.mit.edu/DATA/SLDEM2015/TILES/JP2/' + SOURCE
SHA = '8d6e9bb9687bd19dbc9de57c8044932540bb934e5ef557b473660f5056484a73'
WC_FILE = 'ESA_WorldCover_10m_2021_v200_N60E024_Map.tif'
WC_SHA = '8d2aae1bcb416cbf58c80c29ee6fbb72d276e0c6fb7f904cb777346368077e8b'
WC_URL = 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/' + WC_FILE
SIZE, RADIUS = 65, 1737400


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, separators=(',', ':')) + '\n')
    temporary.replace(path)


def source_file(cache, name, url, offline, expected=None):
    path = cache / name
    if not path.exists():
        if offline:
            raise ValueError(f'Missing pilot source: {path}')
        print(f'Downloading one source granule: {url}', flush=True)
        temporary = path.with_suffix('.download')
        with urllib.request.urlopen(url, timeout=45) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        temporary.replace(path)
    if expected and digest(path) != expected:
        raise ValueError(f'Pilot source checksum mismatch: {path}')
    return path


def bilinear(data, x, y):
    x, y = np.broadcast_arrays(x, y)
    x = np.clip(x, 0, data.shape[1] - 1); y = np.clip(y, 0, data.shape[0] - 1)
    ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - ix, y - iy
    jx, jy = np.minimum(ix + 1, data.shape[1] - 1), np.minimum(iy + 1, data.shape[0] - 1)
    return ((1-fy)*((1-fx)*data[iy, ix]+fx*data[iy, jx]) + fy*((1-fx)*data[jy, ix]+fx*data[jy, jx]))


def lunar(cache, output, offline):
    started = time.perf_counter()
    path = source_file(cache, SOURCE, URL, offline, SHA)
    root = {'z': 6, 'x': 65, 'y': 22}
    release = output / 'moon-hadley-v2'
    staging = cache / 'hadley-g65-z10-sldem120-v2'
    staging.mkdir(parents=True, exist_ok=True)
    if (release / 'manifest.json').exists():
        manifest = json.loads((release / 'manifest.json').read_text())
        if manifest.get('sourceSha256') != SHA:
            raise ValueError('Existing pilot has a different source; publish a new version')
        valid = manifest.get('components') == 3 and manifest.get('sampleSize') == SIZE and len(manifest.get('tiles', {})) == 341
        for key, info in manifest.get('tiles', {}).items():
            tile = release / 'tiles' / (key + '.bin')
            if not tile.is_file() or tile.stat().st_size != info['bytes'] or digest(tile) != info['sha256']:
                valid = False
                break
            raw_payload = gzip.decompress(tile.read_bytes())
            if len(raw_payload) != SIZE*SIZE*3*2:
                valid = False
                break
        if valid:
            return {'reused': True, 'tiles': len(manifest['tiles']), 'tileBytes': manifest['tileBytes']}
        print('Repairing an incomplete pilot release from cached source/checkpoints', flush=True)
    # Only a ~3-degree region plus a halo is decoded, not the full raster.
    west, north, span = 65 * 180/64 - 180, 90 - 22 * 180/64, 180/64
    with rasterio.open(path) as dataset:
        if dataset.shape != (15360, 23040) or dataset.dtypes != ('int16',):
            raise ValueError('Unexpected SLDEM source dimensions/type')
        if abs(dataset.transform.a - 1/512) > 1e-10 or abs(dataset.transform.e + 1/512) > 1e-10:
            raise ValueError('Unexpected SLDEM sampling')
        x0 = math.floor(west*512)-4; y0 = math.floor((30-north)*512)-4
        window = Window(x0, y0, math.ceil(span*512)+8, math.ceil(span*512)+8)
        raw = dataset.read(1, window=window)
    if np.any(raw == -32768):
        raise ValueError('Hadley pilot contains unsupported missing elevations')
    # PDS auxiliary metadata specifies 0.5 meter Int16 sampling. Downsample by
    # two with an area average to make a ~118 m source tier, then sample patches.
    raw = raw[:raw.shape[0]//2*2, :raw.shape[1]//2*2]
    measured = raw.astype('float32').reshape(raw.shape[0]//2,2,raw.shape[1]//2,2).mean(axis=(1,3)) * .5

    def sample(lon, lat):
        return bilinear(measured, ((lon*512-.5)-x0-.5)/2, (((30-lat)*512-.5)-y0-.5)/2)

    tiles, total = {}, 0
    minimum, maximum = float(measured.min())-1, float(measured.max())+1
    for z in range(6, 11):
        factor = 2**(z-6); step = 180/2**z
        for x in range(root['x']*factor, (root['x']+1)*factor):
            for y in range(root['y']*factor, (root['y']+1)*factor):
                w, n = -180+x*step, 90-y*step
                lon = w+np.arange(SIZE)[None,:]*step/64
                lat = n-np.arange(SIZE)[:,None]*step/64
                heights = sample(lon, lat)
                encoded = np.rint(heights/.5).astype('<i2')
                tile = staging / 'tiles' / str(z) / str(x) / f'{y}.bin'
                # Common physical stencil at every LOD avoids visible normal seams.
                delta = 1/256
                grad_e = (sample(lon+delta,lat)-sample(lon-delta,lat))/(2*math.radians(delta)*RADIUS*np.cos(np.radians(lat)))
                grad_n = (sample(lon,lat+delta)-sample(lon,lat-delta))/(2*math.radians(delta)*RADIUS)
                ge = np.rint(np.clip(grad_e,-7.9,7.9)*4096).astype('<i2')
                gn = np.rint(np.clip(grad_n,-7.9,7.9)*4096).astype('<i2')
                payload = gzip.compress(encoded.tobytes()+ge.tobytes()+gn.tobytes(), compresslevel=6, mtime=0)
                if not tile.exists() or tile.read_bytes() != payload:
                    tile.parent.mkdir(parents=True, exist_ok=True)
                    temp = tile.with_suffix('.tmp'); temp.write_bytes(payload); temp.replace(tile)
                # Bound residuals at every sample of the downsampled measured
                # raster in this patch, including the source-to-mesh variation.
                cols = np.arange(max(0, math.ceil((w*512-x0-.5)/2)), min(measured.shape[1], math.floor(((w+step)*512-x0-.5)/2)+1))
                rows = np.arange(max(0, math.ceil(((30-n)*512-y0-.5)/2)), min(measured.shape[0], math.floor(((30-n+step)*512-y0-.5)/2)+1))
                ll = (x0+.5+2*cols+.5)/512
                la = 30-(y0+.5+2*rows+.5)/512
                approx = bilinear(encoded.astype('float32')*.5, (ll[None,:]-w)/step*64, (n-la[:,None])/step*64)
                residual = np.max(np.abs(measured[np.ix_(rows,cols)]-approx)) if len(rows) and len(cols) else 0
                chord = RADIUS*(1-math.cos(math.radians(step/64)/math.sqrt(2)))
                info = {'min': float(encoded.min())*.5, 'max': float(encoded.max())*.5,
                        'error': round(float(residual)+chord+.5, 3), 'bytes': len(payload),
                        'sha256': hashlib.sha256(payload).hexdigest()}
                tiles[f'{z}/{x}/{y}'] = info; total += len(payload)
        print(f'Hadley: level {z}, {len(tiles)} cumulative tiles, {total} bytes', flush=True)
    manifest = {'schema':1, 'id':'hadley', 'body':'moon', 'root':root, 'maxZoom':10, 'sampleSize':65, 'components':3,
        'referenceRadiusMeters':RADIUS, 'scaleMeters':.5, 'offsetMeters':0, 'noData':-32768,
        'minHeightMeters':minimum, 'maxHeightMeters':maximum, 'sourceResolutionMeters':118.4505876,
        'credit':'NASA/GSFC/MIT/JAXA · SLDEM2015 (~118 m pilot sampling)',
        'sourceUrl':'https://pgda.gsfc.nasa.gov/products/54', 'license':'NASA PDS; cite Barker et al. (2016) and source teams',
        'frame':'MEAN EARTH/POLAR AXIS OF DE421', 'verticalDatum':'Height above 1737400 m sphere',
        'sourceSha256':SHA, 'sourceFile':URL, 'tileBytes':total, 'tiles':tiles,
        'errorMetric':'maximum sampled residual against 118m raster + spherical chord + quantization allowance'}
    write_json(staging/'manifest.json', manifest)
    release.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(staging / 'tiles', release / 'tiles', dirs_exist_ok=True)
    # Publish the manifest last, atomically, after every payload exists.
    write_json(release / 'manifest.json', manifest)
    return {'tiles':len(tiles), 'tileBytes':total, 'sourceBytes':path.stat().st_size,
            'workingRasterBytes':measured.nbytes, 'seconds':time.perf_counter()-started, 'sourceSha256':SHA}


def landcover(cache, output, offline):
    started = time.perf_counter()
    path = source_file(cache, WC_FILE, WC_URL, offline, WC_SHA)
    bounds = [24.9,60.1,25.4,60.4]
    with rasterio.open(path) as dataset:
        if str(dataset.crs) != 'EPSG:4326' or dataset.count != 1:
            raise ValueError('Unexpected WorldCover source')
        mask = dataset.read(1, window=from_bounds(*bounds, dataset.transform), out_shape=(256,256), resampling=Resampling.mode)
    if not set(np.unique(mask)).issubset({0,10,20,30,40,50,60,70,80,90,95,100}):
        raise ValueError('Unexpected WorldCover classes')
    release = output/'finland-cover'; release.mkdir(parents=True,exist_ok=True)
    (release/'classes.bin').write_bytes(mask.astype('uint8').tobytes())
    metadata = {'schema':1,'width':256,'height':256,'bounds':bounds, 'sourceYear':2021,'sourceUrl':WC_URL,
        'sourceSha256':digest(path),'sha256':digest(release/'classes.bin'),'license':'CC BY 4.0',
        'credit':'© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
        'sampling':'256x256 modal regional control; source labels at ~10m; not an observed rock or tree-placement map'}
    write_json(release/'manifest.json',metadata)
    return {'sourceBytes':path.stat().st_size,'controlBytes':mask.nbytes,'classes':[int(x) for x in np.unique(mask)],'seconds':time.perf_counter()-started}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--skip-landcover', action='store_true')
    args = parser.parse_args()
    cache = ROOT/'.terrain-cache/pilot'; cache.mkdir(parents=True,exist_ok=True)
    output = ROOT/'public/terrain/pilot'
    report = {'moon':lunar(cache,output,args.offline)}
    if not args.skip_landcover: report['landcover']=landcover(cache,output,args.offline)
    write_json(output/'build-report.json',report)
    print(json.dumps(report,indent=2))
