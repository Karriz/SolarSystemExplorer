#!/usr/bin/env python3
"""Resume verified HTTP ranges for the approved global lunar source rasters."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import threading
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CHUNK = 16 * 1024 * 1024


def fetch(url, path, size, workers=4, expected=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size == size:
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if expected and digest != expected:
            raise ValueError(f'Cached source checksum mismatch: {path}')
        return digest
    partial = path.with_suffix(path.suffix + '.download')
    checkpoint = partial.with_suffix(partial.suffix + '.json')
    state = json.loads(checkpoint.read_text()) if checkpoint.exists() else {'url': url, 'size': size, 'chunks': {}}
    if state['url'] != url or state['size'] != size:
        raise ValueError('Download checkpoint source changed')
    fd = os.open(partial, os.O_RDWR | os.O_CREAT, 0o600)
    lock = threading.Lock()

    def block(start):
        end = min(start + CHUNK, size) - 1
        key = str(start)
        expected = state['chunks'].get(key)
        if expected and hashlib.sha256(os.pread(fd, end-start+1, start)).hexdigest() == expected:
            return
        for attempt in range(5):
            try:
                request = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}'})
                with urllib.request.urlopen(request, timeout=120) as response:
                    if response.status != 206 or response.headers.get('Content-Range') != f'bytes {start}-{end}/{size}':
                        raise ValueError('Server did not honor exact byte range')
                    payload = response.read(end-start+2)
                if len(payload) != end-start+1:
                    raise ValueError('Incomplete HTTP range')
                offset = 0
                while offset < len(payload):
                    offset += os.pwrite(fd, payload[offset:], start + offset)
                with lock:
                    state['chunks'][key] = hashlib.sha256(payload).hexdigest()
                    tmp = checkpoint.with_suffix('.tmp')
                    tmp.write_text(json.dumps(state)); tmp.replace(checkpoint)
                    if len(state['chunks']) % 16 == 0:
                        print(f'{path.name}: {min(len(state["chunks"])*CHUNK,size)/1e6:.0f}/{size/1e6:.0f} MB', flush=True)
                return
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
            list(pool.map(block, range(0, size, CHUNK)))
        if os.fstat(fd).st_size != size:
            raise ValueError('Final raster length mismatch')
    finally:
        os.close(fd)
    with partial.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    if expected and digest != expected:
        raise ValueError(f'Downloaded source checksum mismatch: {path}')
    partial.replace(path)
    checkpoint.unlink(missing_ok=True)
    print(f'Verified {path.name}: {digest}', flush=True)
    return digest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kind', choices=['elevation','reflectance'], default='elevation')
    parser.add_argument('--url'); parser.add_argument('--name'); parser.add_argument('--bytes',type=int)
    parser.add_argument('--cache',type=Path,default=ROOT/'.terrain-cache/moon-global/sources')
    args=parser.parse_args()
    if args.kind == 'elevation':
        names=[f'LDEM_256_{lat}_{lon}.IMG' for lat in ['00N_90N','90S_00S'] for lon in ['000_180','180_360']]
        pinned={p['file']:p['sha256'] for p in json.loads((ROOT/'scripts/terrain-sources.json').read_text())['moon'].get('files',[])}
        def one(name):
            url='https://imbrium.mit.edu/DATA/LOLA_GDR/CYLINDRICAL/IMG/'+name
            label=urllib.request.urlopen(url[:-4]+'.LBL',timeout=30).read()
            text=label.decode()
            for required in ['LINE_SAMPLES          = 46080','LINES                 = 23040','SCALING_FACTOR        = 0.5','MEAN EARTH/POLAR AXIS OF DE421']:
                if required not in text:raise ValueError('LOLA label contract changed')
            args.cache.mkdir(parents=True,exist_ok=True)
            (args.cache/(name[:-4]+'.LBL')).write_bytes(label)
            return {'file':name,'url':url,'bytes':2123366400,'sha256':fetch(url,args.cache/name,2123366400,2,pinned.get(name))}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            records=list(pool.map(one,names))
    else:
        if not args.url or not args.name or not args.bytes:parser.error('reflectance requires --url, --name and --bytes')
        records=[{'file':args.name,'url':args.url,'bytes':args.bytes,'sha256':fetch(args.url,args.cache/args.name,args.bytes,8)}]
    output=args.cache/(args.kind+'-sources.json')
    output.write_text(json.dumps(records,indent=2)+'\n')
    print(f'Source record: {output}',flush=True)

if __name__=='__main__':main()
