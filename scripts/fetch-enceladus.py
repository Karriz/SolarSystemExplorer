#!/usr/bin/env python3
"""Fetch retained Cassini source products; range-checked, resumable downloads."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/enceladus/sources'
BASE = 'https://asc-astropedia.s3.us-west-2.amazonaws.com/Enceladus/Cassini/'
PRODUCTS = [
    ('dem.tif', BASE + 'Enceladus_Cassini_DEM_global_200m_schenk2024.tif', 129613723),
    ('mosaic.tif', BASE + 'Enceladus_Cassini_mosaic_global_100m_schenk2024.tif', 518340175),
    ('color.jpg', 'https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/pia18/pia18435/PIA18435.jpg', None),
]
HASHES = {
    'dem.tif': '7c08c46238cde6528c9143f0c667d42cd3bc6ac60c572595a7e6cad2d6775f91',
    'mosaic.tif': '1738c5cf8e856c7ae262d858261af0fbb32503a68a524884d36194afb23afcc5',
    'color.jpg': '5b60d0161efd659f6d95281559ad4b30826fd02ee72944dbb3f8b7679f65ed4d',
}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    records = []
    for name, url, size in PRODUCTS:
        target = CACHE / name
        if not target.exists():
            if size is None:
                temporary = target.with_suffix('.download')
                with urllib.request.urlopen(url, timeout=90) as response, temporary.open('wb') as out:
                    while block := response.read(1048576):
                        out.write(block)
                temporary.replace(target)
            else:
                parts = CACHE / (name + '.parts')
                parts.mkdir(exist_ok=True)
                chunk = 8 * 1048576

                def fetch(start):
                    end = min(size, start + chunk) - 1
                    part = parts / str(start)
                    if part.exists() and part.stat().st_size == end - start + 1:
                        return part
                    for attempt in range(4):
                        try:
                            request = urllib.request.Request(url + f'?chunk={start}', headers={'Range': f'bytes={start}-{end}'})
                            with urllib.request.urlopen(request, timeout=90) as response:
                                if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{size}':
                                    raise ValueError('Unexpected range response')
                                block = response.read(end - start + 2)
                            if len(block) != end - start + 1:
                                raise ValueError('Truncated source range')
                            temporary = part.with_suffix('.download')
                            temporary.write_bytes(block)
                            temporary.replace(part)
                            return part
                        except Exception:
                            if attempt == 3:
                                raise
                            time.sleep(1 + attempt)

                with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
                    downloaded = list(pool.map(fetch, range(0, size, chunk)))
                temporary = target.with_suffix('.download')
                with temporary.open('wb') as out:
                    for part in downloaded:
                        out.write(part.read_bytes())
                temporary.replace(target)
                for part in downloaded:
                    part.unlink()
                parts.rmdir()
        if size is not None and target.stat().st_size != size:
            raise ValueError(f'Wrong source length: {target}')
        record = dict(file=name, url=url, bytes=target.stat().st_size, sha256=digest(target))
        if record['sha256'] != HASHES[name]:
            raise ValueError(f'Source checksum changed: {name}; review before adoption')
        print(json.dumps(record), flush=True)
        records.append(record)
    (CACHE / 'sources.json').write_text(json.dumps(records, indent=2) + '\n')


if __name__ == '__main__':
    main()
