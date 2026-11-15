#!/usr/bin/env python3
"""Independent published source to delivered Europa height checks."""
import gzip
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from scipy.ndimage import distance_transform_edt

ROOT=Path(__file__).resolve().parents[1]
CACHE=ROOT/'.terrain-cache/europa'
metadata=json.load(open(ROOT/'public/textures/europa-terrain.json'))
catalog=json.load(open(ROOT/'public/terrain/catalog.json'))
manifest_path=ROOT/'public/terrain'/catalog['bodies']['europa']
manifest=json.load(open(manifest_path))
assert manifest['sourceSha256']==metadata['preparedSha256']
assert manifest['missingPixels']==0 and manifest['maxZoom']==7
assert 0 < metadata['regionalFootprintAreaFraction'] < .01
controls=[]
for region in metadata['regions']:
    with rasterio.open(CACHE/f"sources/{region['name']}.tif") as src:
        values=src.read(1,masked=True).filled(np.nan)
        valid=np.isfinite(values)
        median=float(np.nanmedian(values))
        assert median==region['sourceMedianMeters']
        interior=distance_transform_edt(np.pad(valid,1))[1:-1,1:-1]*src.transform.a>2300
        candidates=np.argwhere(interior)
        assert len(candidates)>0,region['name']
        samples=[]
        for r,c in candidates[::max(1,len(candidates)//100)]:
            # Published source affine is EQC with 180E central meridian.
            px,py=src.xy(int(r),int(c))
            lon=180+math.degrees(px/1560800);lat=math.degrees(py/1560800)
            z=7;step=180/(2**z*128)
            lat=round(lat/step)*step;lon=round(lon/step)*step
            col=(1560800*math.radians(lon-180)-src.transform.c)/src.transform.a-.5
            row=(src.transform.f-1560800*math.radians(lat))/-src.transform.e-.5
            x,y=math.floor(col),math.floor(row);u,v=col-x,row-y
            block=values[y:y+2,x:x+2]
            if block.shape!=(2,2) or not np.isfinite(block).all() or not interior[y:y+2,x:x+2].all():continue
            residual=float(block[0,0]*(1-u)*(1-v)+block[0,1]*u*(1-v)+block[1,0]*(1-u)*v+block[1,1]*u*v)-median
            phi,lam=math.radians(lat),math.radians(lon)
            figure=1/math.sqrt((math.cos(phi)*math.cos(lam)/1562600)**2+(math.cos(phi)*math.sin(lam)/1560300)**2+(math.sin(phi)/1559500)**2)
            expected=residual+figure-1560800
            span=180/2**z;tx=int((lon+180)/span);ty=int((90-lat)/span)
            grid=np.frombuffer(gzip.decompress((manifest_path.parent/f'tiles/{z}/{tx}/{ty}.bin').read_bytes()),dtype='<i2').reshape(129,129)
            actual=float(grid[round((90-ty*span-lat)/span*128),round((lon+180-tx*span)/span*128)])
            error=abs(expected-actual)
            samples.append(dict(site=region['name'],latitude=lat,longitude=lon,sourceRelativeMeters=residual,expectedMeters=expected,deliveredMeters=actual,errorMeters=error))
            if len(samples)>=4:break
        assert len(samples)>=2,region['name']
        controls+=samples
# Double interpolation at the 299 m delivery grid may smooth steep local posts;
# this tolerance checks units/datum/registration rather than stereo accuracy.
assert max(c['errorMeters'] for c in controls)<50,controls
with rasterio.open(CACHE/'europa-radial.tif') as prepared:
    for row in [0,prepared.height-1]:
        pole=prepared.read(1,window=rasterio.windows.Window(0,row,prepared.width,1))
        assert float(np.ptp(pole))<4, 'Inferred detail must converge at the pole'
# Delivered extrema remain within the documented conservative figure/relief.
assert -4000<manifest['minHeightMeters']<0 and 1000<manifest['maxHeightMeters']<4000
report=dict(completed=True,body='europa',controls=controls,maxErrorMeters=max(c['errorMeters'] for c in controls),regionalFootprintAreaFraction=metadata['regionalFootprintAreaFraction'])
(CACHE/'source-validation.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
