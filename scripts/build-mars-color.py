"""Compare continuous-color encodings against the same measured MOC composite.

No palette substitution, gain, saturation adjustment, or local contrast stretch.
The delivered image preserves the source's red/blue and estimated-green color.
"""
import hashlib
import json
import shutil
import time
from pathlib import Path
import numpy as np
import rasterio
from rasterio.shutil import copy
from importlib.util import spec_from_file_location, module_from_spec

spec = spec_from_file_location('vectors', Path(__file__).with_name('build-moon-vectors.py'))
vectors = module_from_spec(spec); spec.loader.exec_module(vectors)
root = Path(__file__).resolve().parents[1]
source = root / '.terrain-cache/mars-moc-wa/mocwa-multiseason.png'
provenance = json.loads(source.with_suffix('.json').read_text())
digest = hashlib.sha256(source.read_bytes()).hexdigest()
assert digest == provenance['outputSha256']
old = root / 'public/mars-vectors/10-smooth'
manifest = json.loads((old/'manifest.json').read_text())
assert digest == manifest['sourceSha256'], 'Compare against the same source as the old palette'
cache = root / '.terrain-cache/mars-color-review'; cache.mkdir(exist_ok=True)
output = root / 'public/textures'
with rasterio.open(source) as dataset:
    reference = dataset.read().transpose(1,2,0)
    height,width = reference.shape[:2]
source_lab = vectors.lab(reference[::4,::4].astype(np.float32))
results = []
for name,options in [('q80',dict(QUALITY=80)),('q90',dict(QUALITY=90)),('q95',dict(QUALITY=95)),('lossless',dict(LOSSLESS=True))]:
    path = cache / f'{name}.webp'
    start = time.perf_counter()
    with rasterio.Env(GDAL_PAM_ENABLED='NO'):
        copy(source,path,driver='WEBP',**options)
    encode_seconds = time.perf_counter()-start
    start = time.perf_counter()
    with rasterio.open(path) as dataset: decoded = dataset.read().transpose(1,2,0)
    decode_seconds = time.perf_counter()-start
    error = np.abs(reference.astype(np.float32)-decoded.astype(np.float32))
    delta = np.linalg.norm(vectors.lab(decoded[::4,::4].astype(np.float32))-source_lab,axis=-1)
    result = dict(name=name,bytes=path.stat().st_size,encodeSeconds=encode_seconds,decodeSeconds=decode_seconds,
        meanChannelError=float(error.mean()),p99ChannelError=float(np.percentile(error,99)),maxChannelError=float(error.max()),
        meanDeltaE76=float(delta.mean()),p99DeltaE76=float(np.percentile(delta,99)))
    results.append(result); print(json.dumps(result),flush=True)
chosen = next(r for r in results if r['name']=='q95')
assert chosen['meanChannelError'] < 1 and chosen['p99ChannelError'] <= 4
assert chosen['p99DeltaE76'] < 3
assert results[-1]['maxChannelError'] == 0
shutil.copyfile(cache/'q95.webp',output/'mars-color.webp')
shutil.copyfile(source,output/'mars-color-reference.png')
def control(lat,lon):
    x=(lon/360+.5)*width-.5; y=np.clip((.5-lat/180)*height-.5,0,height-1)
    ix,iy=int(np.floor(x)),int(np.floor(y));u,v=x-ix,y-iy
    linear=np.zeros(3)
    for dx,dy,weight in [(0,0,(1-u)*(1-v)),(1,0,u*(1-v)),(0,1,(1-u)*v),(1,1,u*v)]:
        rgb=reference[min(iy+dy,height-1),(ix+dx)%width]/255
        linear+=np.where(rgb<=.04045,rgb/12.92,((rgb+.055)/1.055)**2.4)*weight
    rgb=np.where(linear<=.0031308,linear*12.92,1.055*linear**(1/2.4)-.055)*255
    return dict(lat=lat,lon=lon,srgb=rgb.tolist())
report = dict(schema=1,width=width,height=height,sourceSha256=digest,source=provenance['source'],
    doi=provenance['doi'],credit='USGS / NASA / SwRI · MGS MOC-WA · Stuart Robbins (2023)',
    channels=provenance['channels'],marsYears=provenance['marsYears'],solarLongitudeDegrees=provenance['solarLongitudeDegrees'],
    validCoverageFraction=provenance['validCoverageFraction'],colorTreatment='Source sRGB, no additional gain or palette remapping; estimated green',
    selected='q95',candidates=results,sourcePngBytes=source.stat().st_size,
    previousVectorBytes=sum((old/t['file']).stat().st_size for t in manifest['tiles']),
    sourceMedianSrgb=np.median(reference,axis=(0,1)).tolist(),
    sourceRebuildSeconds=provenance.get('buildSeconds'),
    sourceInputBytes=sum((root/entry['path']).stat().st_size for entry in provenance['redSources']+provenance['blueSources']),
    controlSamples=[control(lat,lon) for lat,lon in [(-12,-70),(20,20),(10,70),(10,179.9),(85,0)]],
    deliveredSha256=hashlib.sha256((output/'mars-color.webp').read_bytes()).hexdigest())
(output/'mars-color.json').write_text(json.dumps(report,indent=2)+'\n')
print('Published',chosen['bytes'],'bytes; previous vectors',report['previousVectorBytes'],'bytes')
