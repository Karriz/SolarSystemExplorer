#!/usr/bin/env python3
"""Retain and checksum-pin NASA/USGS Io terrain and color inputs."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/io/sources'
PRODUCTS = [
    ('dem.tif', 'https://trek.nasa.gov/io/TrekWS/rest/cat/data/stream?label=IoDEM', 265587956,
     '9b9159c64337c32ba203fad629ed0d1d344a8482546e277c3b984c01b417d61d'),
    ('color.tif', 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Io_Galileo_SSI_Global_Mosaic_ClrMerge_1km.tif', 196637696,
     '524dcabd247c889a4e7c2a1bfd9e5fcc545c6a039b2c765da9b741befdfd00bd'),
    ('color.lbl', 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Io_Galileo_SSI_Global_Mosaic_ClrMerge_1km_pds3.lbl', 2134,
     '47a4b493743672efed5c4a634daa631e45379fe9110b4b6d350dc751d02b52e3'),
]


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch(product):
    name, url, length, expected = product
    path = CACHE / name
    if not path.exists():
        temporary = path.with_suffix('.download')
        # Trek's original-file service streams a whole TIFF, not display tiles.
        with urllib.request.urlopen(url + ('&' if '?' in url else '?') + 'source=io-implementation', timeout=180) as response, temporary.open('wb') as out:
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
