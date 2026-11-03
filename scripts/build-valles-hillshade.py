"""Bake the current multidirectional relief formula independently of mesh LOD.

Uses the existing normalized, measured MOLA-HRSC cache. Output rows run south
to north for direct R8 DataTexture upload; no image/canvas decoding is involved.
"""
import gzip
import hashlib
import json
from pathlib import Path
import numpy as np

source = json.loads(Path('scripts/terrain-sources.json').read_text())['mars']
data = np.load(Path('.terrain-cache') / f"{source['product']}-{source['sha256'][:12]}-normalized-v1.npy", mmap_mode='r')
assert data.shape == (source['height'], source['width'])
radius = source['referenceRadiusMeters']
west, south, east, north = -100, -28, -42, 8
width, height = 3072, 2048
derivative_meters = 300
low, high = .55, 1.30

def sample(lons, lats):
    step = source['sourcePixelDegrees']
    x = ((lons-source['sourceWest']) % 360) / step - .5
    y = np.clip((90-lats) / step - .5, 0, data.shape[0]-1)
    ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x-ix, y-iy
    values = sum(data[np.minimum(iy+dy, data.shape[0]-1), (ix+dx) % data.shape[1]] * weight
                 for dx,dy,weight in [(0,0,(1-fx)*(1-fy)),(1,0,fx*(1-fy)),(0,1,(1-fx)*fy),(1,1,fx*fy)])
    assert np.isfinite(values).all(), 'Missing measured elevation in pilot'
    return values

def factor(east_gradient, north_gradient):
    norm = np.sqrt(1+east_gradient**2+north_gradient**2)
    e, n, radial = -east_gradient/norm, -north_gradient/norm, 1/norm
    light_sum, weight_sum = np.zeros_like(e), np.zeros_like(e)
    for sine, cosine in [(-2**-.5,-2**-.5),(-1,0),(-2**-.5,2**-.5),(0,1)]:
        weight = (e*cosine-n*sine)**2+.0001
        light_sum += np.maximum(radial+e*sine+n*cosine,0)*weight
        weight_sum += weight
    t = np.clip((np.hypot(e,n)-.03)/(.65-.03),0,1)
    return np.clip(1+.65*(light_sum/weight_sum-1)-.18*t*t*(3-2*t),low,high)

assert factor(np.array([0.]),np.array([0.]))[0] == 1
pixels = np.zeros((height,width),dtype='uint8')
for first in range(0,height,64):
    last = min(height,first+64)
    mean = np.zeros((last-first,width))
    # Average four shading samples per output texel before quantization, rather
    # than averaging normals and losing opposing slopes at the delivery scale.
    for ox,oy in [(.25,.25),(.75,.25),(.25,.75),(.75,.75)]:
        lon,lat = np.meshgrid(west+(np.arange(width)+ox)/width*(east-west),
                              south+(np.arange(first,last)+oy)/height*(north-south))
        dy = np.rad2deg(derivative_meters/radius)
        dx = dy/np.cos(np.deg2rad(lat))
        e = (sample(lon+dx,lat)-sample(lon-dx,lat))/(2*derivative_meters)
        n = (sample(lon,lat+dy)-sample(lon,lat-dy))/(2*derivative_meters)
        mean += factor(e,n)/4
    pixels[first:last] = np.round((mean-low)/(high-low)*255).astype('uint8')
    if first % 512 == 0: print(f'Baking rows {first}/{height}',flush=True)
raw = pixels.tobytes()
payload = gzip.compress(raw,compresslevel=9,mtime=0)
output = Path('public/textures/valles-hillshade.bin.gz')
output.write_bytes(payload)
metadata = dict(schema=1,width=width,height=height,bounds=[west,south,east,north],range=[low,high],
    rowOrder='south-to-north',rawBytes=len(raw),compressedBytes=len(payload),sha256=hashlib.sha256(raw).hexdigest(),
    sourceProduct=source['product'],sourceSha256=source['sha256'],credit=source['credit'],sourceUrl=source['sourceUrl'],
    licenseUrl=source.get('licenseUrl'),derivativeMeters=derivative_meters,samplesPerTexel=4,
    spacingMeters=[np.deg2rad((east-west)/width)*radius*np.cos(np.deg2rad((south+north)/2)),np.deg2rad((north-south)/height)*radius],
    meaning='True-scale measured DEM multidirectional hillshade; visualization multiplier, independent of rendered geometry')
output.with_name('valles-hillshade.json').write_text(json.dumps(metadata,indent=2)+'\n')
print(json.dumps(metadata))
