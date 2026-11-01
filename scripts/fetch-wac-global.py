#!/usr/bin/env python3
"""Download and checksum the ten official 304 ppd LROC WAC 643 nm products."""
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / '.terrain-cache/wac-global/sources'
BASE = ('https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/'
        'pds4/lroc/lro-l-lroc-5-rdr/LROLRC_2001/DATA/MDR/WAC_EMP/')
products = [(f'E300{hem}{lon}', 1996295040)
            for hem in ('N', 'S') for lon in ('0450', '1350', '2250', '3150')]
products += [(f'P900{hem}0000', 1394200920) for hem in ('N', 'S')]

def one(item):
    region, size = item
    name = f'WAC_EMP_643NM_{region}_304P.IMG'
    url = BASE + name
    target = SOURCE / name
    if target.exists() and target.stat().st_size == size:
        with target.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    else:
        partial = target.with_suffix('.stream')
        start = partial.stat().st_size if partial.exists() else 0
        if start > size:
            raise ValueError(f'Oversized partial source: {partial}')
        request = urllib.request.Request(url, headers={'Range': f'bytes={start}-'} if start else {})
        with urllib.request.urlopen(request, timeout=120) as response:
            if start and (response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{size-1}/{size}'):
                raise ValueError('Source did not honor resume range')
            if not start and (response.status != 200 or int(response.headers.get('Content-Length', -1)) != size):
                raise ValueError('Unexpected source response')
            with partial.open('ab') as output:
                shutil.copyfileobj(response, output, length=4 * 1024 * 1024)
        if partial.stat().st_size != size:
            raise ValueError(f'Incomplete source: {partial}')
        with partial.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        partial.replace(target)
    print(name, digest, flush=True)
    return {'file': name, 'url': url, 'bytes': size, 'sha256': digest}

if __name__ == '__main__':
    SOURCE.mkdir(parents=True, exist_ok=True)
    records = [one(item) for item in products]
    (SOURCE / 'sources.json').write_text(json.dumps(records, indent=2) + '\n')
    print('Verified', len(records), 'WAC sources', flush=True)
