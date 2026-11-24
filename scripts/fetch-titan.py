#!/usr/bin/env python3
"""Retain and checksum-pin NASA/USGS/Cornell Titan terrain and color inputs."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/titan/sources'
PRODUCTS = [
    ('corlies2017.zip',
     'https://data.astro.cornell.edu/titan_topo_corlies/titan_topo_corlies.zip',
     27504153,
     'b398841e75c879240d4aaeabf3156478fcc2ef1342d449b36975644380ad2659'),
    ('global-iss-4km.tif',
     'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Titan_ISS_P19658_Mosaic_Global_4km.tif',
     8169529,
     'ca0fe5f6f9bdba1b6d03245969a42336a010ddc17d636e5e06fffa939d10ca83'),
    ('global-iss-4km.lbl',
     'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Titan_ISS_P19658_Mosaic_Global_4km_pds3.lbl',
     2575,
     '20385defdfba31e6be29b279d663d7d6ea4584e4e073f072185f7bd96f3d5673'),
    ('nomenclature.zip',
     'https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/TITAN_nomenclature_center_pts.zip',
     833929,
     '1ce72a3872f48ffd19427aae11fde9f64e9a38049a4bb0792386a3208837a731'),
    ('nomenclature-geoms.zip',
     'https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/TITAN_nomenclature_geometries.zip',
     949874,
     '054a188f077dc1629cbe88c5f37841463dd45a1bbfb987441bbe4878473ac33c'),
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
