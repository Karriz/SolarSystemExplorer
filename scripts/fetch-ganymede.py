#!/usr/bin/env python3
"""Retain and checksum-pin NASA/USGS Ganymede terrain and color inputs."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/ganymede/sources'
PRODUCTS = [
    ('global-mono.tif',
     'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Ganymede_Voyager_GalileoSSI_global_mosaic_1km.tif',
     136844537,
     'c2c8d9506b8cf8f7a0a90d823d9052e91c8d9885cf7267fdce8de8216f4df888'),
    ('global-mono.lbl',
     'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Ganymede_Voyager_GalileoSSI_global_mosaic_1km_pds3.lbl',
     2181,
     '6a6c0e5430a2fc5c1330e866add82b42294024c8a046b72cd565c2fd4e12ff08'),
    ('global-color.tif',
     'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif',
     199204541,
     'da47087e75bc530456d8206d5100ad3c687706353700b0cb44a8400957005a33'),
    ('global-color.lbl',
     'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m_pds3.lbl',
     2557,
     'd1a2d221f025e18e4cba756c3187c44447e65ff3fb00537dff009cd5011698c7'),
    ('geology.zip',
     'https://pubs.usgs.gov/sim/3237/downloads/Ganymede_SIM3237_Database.zip',
     107290967,
     '2dce3f3e45e72cbfc12ba852308273a481982470c0cb21fb349c020a7c66fd50'),
    ('natural-color.jpg',
     'https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia00/pia00716/PIA00716.jpg',
     46445,
     '40485fbf3fb3a73ed5a8b3592066f2174c87ce64478b606bb2761bcb77fe9497'),
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
