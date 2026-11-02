#!/usr/bin/env python3
"""Resume parallel HTTP ranges from the official USGS global 200 m Mars DEM."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import urllib.request

URL = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/HRSC_MOLA_Blend/Mars_HRSC_MOLA_BlendDEM_Global_200mp_v2.tif'
SIZE = 11384463908
SHA256 = 'e8bfe4c3b9dee9d5fdb8c4d49798869654e552e7b154712c9e12d6d117464419'
CHUNK = 64 * 1024 * 1024
ROOT = Path(__file__).resolve().parents[1]


def verified_hash(path):
    assert path.stat().st_size == SIZE, 'Incomplete source'
    with path.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    assert digest == SHA256, 'USGS source checksum changed; review the upstream product'
    return digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=ROOT / '.terrain-cache')
    parser.add_argument('--workers', type=int, default=8)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    target = args.cache / 'mars-hrsc-mola-200m.tif'
    partial = target.with_suffix('.tif.download')
    checkpoint = target.with_suffix('.ranges.json')
    with urllib.request.urlopen(urllib.request.Request(URL, method='HEAD'), timeout=60) as response:
        assert int(response.headers['Content-Length']) == SIZE, 'Upstream size changed'
        etag = response.headers['ETag']
    if target.exists():
        print('SHA-256:', verified_hash(target), flush=True)
        return
    if checkpoint.exists():
        state = json.loads(checkpoint.read_text())
        assert state['etag'] == etag and state['size'] == SIZE and state['chunkBytes'] == CHUNK, 'Upstream or chunk size changed during resume'
        assert partial.exists() and partial.stat().st_size == SIZE, 'Missing partial source'
        complete = set(state['complete'])
    else:
        # Reuse complete chunks from an interrupted ordinary download.
        prefix = partial.stat().st_size if partial.exists() else 0
        assert prefix <= SIZE
        complete = set(range(prefix // CHUNK))
    fd = os.open(partial, os.O_CREAT | os.O_RDWR, 0o644)
    os.ftruncate(fd, SIZE)
    lock = threading.Lock()

    def save():
        temporary = checkpoint.with_suffix('.writing')
        temporary.write_text(json.dumps({'url': URL, 'etag': etag, 'size': SIZE, 'chunkBytes': CHUNK, 'complete': sorted(complete)}))
        temporary.replace(checkpoint)

    save()
    started = time.monotonic()
    initial = len(complete)

    def fetch(index):
        start, end = index * CHUNK, min(SIZE, (index + 1) * CHUNK) - 1
        for attempt in range(6):
            try:
                request = urllib.request.Request(URL, headers={'Range': f'bytes={start}-{end}', 'If-Match': etag})
                with urllib.request.urlopen(request, timeout=120) as response:
                    assert response.status == 206
                    assert response.headers['Content-Range'] == f'bytes {start}-{end}/{SIZE}'
                    assert response.headers['ETag'] == etag
                    offset = start
                    while block := response.read(1024 * 1024):
                        written = 0
                        while written < len(block):
                            written += os.pwrite(fd, block[written:], offset + written)
                        offset += len(block)
                    assert offset == end + 1, 'Incomplete HTTP range'
                with lock:
                    complete.add(index)
                    save()
                    if len(complete) % 8 == 0:
                        rate = (len(complete) - initial) * CHUNK / max(1, time.monotonic() - started) / 1e6
                        print(f'{len(complete)}/{(SIZE+CHUNK-1)//CHUNK} chunks, {rate:.1f} MB/s', flush=True)
                return
            except Exception:
                if attempt == 5:
                    raise
                time.sleep(min(30, 2 ** attempt))

    try:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = [pool.submit(fetch, i) for i in range((SIZE + CHUNK - 1) // CHUNK) if i not in complete]
            for future in as_completed(futures):
                future.result()
        os.fsync(fd)
    finally:
        os.close(fd)
    digest = verified_hash(partial)
    partial.replace(target)
    print(f'Complete: {target}\nSHA-256: {digest}', flush=True)


if __name__ == '__main__':
    main()
