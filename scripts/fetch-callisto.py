#!/usr/bin/env python3
"""Retain and checksum-pin NASA/USGS Callisto terrain and color inputs."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/callisto/sources'
PRODUCTS = [
    ('global-mono.tif',
     'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif',
     114640717,
     'e1f0bd2e0e05de605d067d6b5f5ededddaf31ca6c064562a1ca770f15a7dbaa3'),
    ('global-mono.lbl',
     'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Callisto_Voyager_GalileoSSI_global_mosaic_1km_pds3.lbl',
     2261,
     'c55d0ca71d29b669ac5451c2d065f5db83cddf738198d463f6c5296f2550ca1c'),
    ('nomenclature.zip',
     'https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/CALLISTO_nomenclature_center_pts.zip',
     440686,
     'ed09645787d2d2cc6eecf7d1179b2d263d4e524d89fd26639a84e12cd910e8b5'),
    ('nomenclature-geoms.zip',
     'https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/CALLISTO_nomenclature_geometries_internal.zip',
     529696,
     '4ef1526473cb0b0f9e99e1dbfd360377602868044be7d7611119cb9a8ea1b075'),
    ('natural-color.jpg',
     'https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia03/pia03456/PIA03456.jpg',
     73687,
     'a9e532314a8f1e5097c724ca2e29844087790124de349a1021ecb8f77c37398d'),
]


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch(product):
    name, url, length, expected = product
    path = CACHE / name
    if not path.exists():
        temporary = Path(str(path) + '.download')
        request = urllib.request.Request(url, headers={'User-Agent': 'SolarSystemExplorer/1.0'})
        with urllib.request.urlopen(request, timeout=300) as response, temporary.open('wb') as out:
            shutil.copyfileobj(response, out)
        if temporary.stat().st_size != length or sha(temporary) != expected:
            raise ValueError(f'Incomplete or changed source: {name}')
        temporary.replace(path)
    if path.stat().st_size != length or sha(path) != expected:
        raise ValueError(f'Changed cached source: {name}')
    record = dict(file=name, url=url, bytes=length, sha256=expected)
    print(json.dumps(record), flush=True)
    return record


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        records = list(pool.map(fetch, PRODUCTS))
    (CACHE / 'sources.json').write_text(json.dumps(records, indent=2) + '\n')


if __name__ == '__main__':
    main()
