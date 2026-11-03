"""Resumable, source-derived R8 hillshade pyramids; no runtime DEM shading work."""
import argparse
import gzip
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import time
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('terrain_builder',ROOT/'scripts/build-terrain.py')
terrain=importlib.util.module_from_spec(spec);spec.loader.exec_module(terrain)
SIZE=256;GUTTER=2;PAGE=SIZE+2*GUTTER
DERIVATIVE=300
PARAMETERS=dict(revision=1,range=[.55,1.30],derivativeMeters=300,samplesPerTexel=4,polarBlend=[78,88],tileSize=SIZE,gutter=GUTTER)

def setup(body,width,height,stage):
    global raster,radius,W,H,STAGE,DERIVATIVE
    source=terrain.SOURCES[body]
    DERIVATIVE=max(300,source['sourceResolutionMeters'])
    path=ROOT/'.terrain-cache'/source.get('cacheSubdirectory','')/f"{source['product']}-{source['sha256'][:12]}-normalized-v1.npy"
    raster=terrain.Raster.__new__(terrain.Raster);raster.source=source;raster.data=np.load(path,mmap_mode='r')
    assert raster.data.shape==(source['height'],source['width'])
    raster.poles=[float(np.nanmean(row)) if np.isfinite(row).any() else np.nan for row in (raster.data[0],raster.data[-1])]
    radius=source['referenceRadiusMeters'];W=width;H=height;STAGE=Path(stage)

def factor(e,n,lat):
    norm=np.sqrt(1+e*e+n*n);e=-e/norm;n=-n/norm;r=1/norm
    a=np.zeros_like(e);b=np.zeros_like(e)
    for sine,cosine in [(-2**-.5,-2**-.5),(-1,0),(-2**-.5,2**-.5),(0,1)]:
        weight=(e*cosine-n*sine)**2+.0001
        a+=np.maximum(r+e*sine+n*cosine,0)*weight;b+=weight
    t=np.clip((np.hypot(e,n)-.03)/.62,0,1);accent=.18*t*t*(3-2*t)
    directional=np.clip(1+.65*(a/b-1)-accent,.55,1.30)
    neutral=np.clip(1+.65*(r-1)-accent,.55,1.30)
    p=np.clip((np.abs(lat)-78)/10,0,1);p=p*p*(3-2*p)
    return directional*(1-p)+neutral*p

def read_page(path):
    raw=gzip.decompress(path.read_bytes())
    if len(raw)!=PAGE*PAGE:raise ValueError('Invalid cached page')
    return np.frombuffer(raw,dtype='uint8').reshape(PAGE,PAGE).copy()

def record(path,array):
    raw=array.tobytes();payload=gzip.compress(raw,compresslevel=6,mtime=0)
    path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_suffix('.writing');temp.write_bytes(payload);temp.replace(path)
    return dict(bytes=len(payload),sha256=hashlib.sha256(raw).hexdigest())

def bake_tile(address):
    x,y=address;path=STAGE/f'5/{x}/{y}.bin.gz'
    if path.exists():
        try:
            a=read_page(path);return x,y,a,dict(bytes=path.stat().st_size,sha256=hashlib.sha256(a.tobytes()).hexdigest())
        except Exception:pass
    shade=np.zeros((PAGE,PAGE));valid=np.ones_like(shade,dtype=bool)
    arc=DERIVATIVE/radius;cs=math.cos(arc);sn=math.sin(arc)
    for ox,oy in [(.25,.25),(.75,.25),(.25,.75),(.75,.75)]:
        lon,lat=np.meshgrid((x*SIZE+np.arange(-GUTTER,SIZE+GUTTER)+ox)/W*360-180,
                            (y*SIZE+np.arange(-GUTTER,SIZE+GUTTER)+oy)/H*180-90)
        reflected=np.abs(lat)>90
        lon=np.where(reflected,lon+180,lon)
        lat=np.where(lat>90,180-lat,np.where(lat< -90,-180-lat,lat))
        phi=np.deg2rad(lat);s=np.sin(phi);c=np.cos(phi)
        pe=np.arcsin(np.clip(s*cs,-1,1));de=np.arctan2(sn*c,cs-s*np.sin(pe))
        e=(raster.sample(lon+np.rad2deg(de),np.rad2deg(pe))-raster.sample(lon-np.rad2deg(de),np.rad2deg(pe)))/(2*DERIVATIVE)
        pn=np.arcsin(np.clip(s*cs+c*sn,-1,1));ps=np.arcsin(np.clip(s*cs-c*sn,-1,1))
        ln=lon+np.where(cs-s*np.sin(pn)<0,180,0);ls=lon+np.where(cs-s*np.sin(ps)<0,180,0)
        n=(raster.sample(ln,np.rad2deg(pn))-raster.sample(ls,np.rad2deg(ps)))/(2*DERIVATIVE)
        good=np.isfinite(e)&np.isfinite(n);valid&=good
        shade+=factor(np.where(good,e,0),np.where(good,n,0),lat)/4
    shade=np.where(valid,shade,1)
    a=np.rint((shade-.55)/.75*255).astype('uint8')
    return x,y,a,record(path,a)

def extract(a,x,y):
    h,w=a.shape;ys=y*SIZE+np.arange(-GUTTER,SIZE+GUTTER);xs=x*SIZE+np.arange(-GUTTER,SIZE+GUTTER)
    reflect=(ys<0)|(ys>=h);ys=np.where(ys<0,-ys-1,np.where(ys>=h,2*h-ys-1,ys))
    return a[np.clip(ys,0,h-1)[:,None],(xs[None,:]+reflect[:,None]*(w//2))%w]

def main():
    p=argparse.ArgumentParser();p.add_argument('--bodies',nargs='+',default=['moon','mars']);p.add_argument('--workers',type=int,default=4);p.add_argument('--limit',type=int)
    args=p.parse_args()
    for body in args.bodies:
        start=time.perf_counter();source=terrain.SOURCES[body]
        legacy_widths={'moon':11264,'mars':22016}
        spacing=max(1000,source['sourceResolutionMeters'])
        w=legacy_widths.get(body,math.ceil(2*math.pi*source['referenceRadiusMeters']/spacing/64)*64);h=w//2
        parameters={**PARAMETERS,'derivativeMeters':max(300,source['sourceResolutionMeters'])}
        version='global-1km-v1-'+hashlib.sha256(json.dumps([source['sha256'],parameters,w],sort_keys=True).encode()).hexdigest()[:12]
        stage=ROOT/'.terrain-cache/hillshade-build'/body/version;stage.mkdir(parents=True,exist_ok=True)
        fine_path=stage/'fine.npy'
        fine=np.lib.format.open_memmap(fine_path,mode='r+' if fine_path.exists() else 'w+',dtype='uint8',shape=(h,w))
        addresses=[(x,y) for y in range(math.ceil(h/SIZE)) for x in range(math.ceil(w/SIZE))]
        if args.limit:addresses=addresses[:args.limit]
        entries={};done=0
        with ProcessPoolExecutor(max_workers=args.workers,mp_context=get_context('fork'),initializer=setup,initargs=(body,w,h,str(stage))) as pool:
            for x,y,a,entry in pool.map(bake_tile,addresses,chunksize=1):
                sy=min(SIZE,h-y*SIZE);sx=min(SIZE,w-x*SIZE)
                fine[y*SIZE:y*SIZE+sy,x*SIZE:x*SIZE+sx]=a[GUTTER:GUTTER+sy,GUTTER:GUTTER+sx]
                entries[f'5/{x}/{y}']=entry;done+=1
                if done%64==0: print(body,done,'/',len(addresses),'tiles',round(time.perf_counter()-start,1),'s',flush=True)
        fine.flush()
        if args.limit: print('Limited prototype complete; not published',flush=True);continue
        arrays={5:fine}
        for z in range(4,-1,-1):
            parent=np.lib.format.open_memmap(stage/f'level-{z}.npy',mode='w+',dtype='uint8',shape=(h//2**(5-z),w//2**(5-z)))
            child=arrays[z+1]
            for row in range(0,parent.shape[0],64):
                stop=min(row+64,parent.shape[0]);block=child[row*2:stop*2].astype('uint16')
                parent[row:stop]=((block[::2,::2]+block[1::2,::2]+block[::2,1::2]+block[1::2,1::2]+2)//4).astype('uint8')
            parent.flush();arrays[z]=parent
            for y in range(math.ceil(parent.shape[0]/SIZE)):
                for x in range(math.ceil(parent.shape[1]/SIZE)):
                    entries[f'{z}/{x}/{y}']=record(stage/f'{z}/{x}/{y}.bin.gz',extract(parent,x,y))
        base=arrays[0];raw=base.tobytes();(stage/'base.bin.gz').write_bytes(gzip.compress(raw,mtime=0))
        manifest=dict(schema=1,body=body,version=version,**parameters,levels=[dict(width=arrays[z].shape[1],height=arrays[z].shape[0]) for z in range(6)],
            tiles=entries,baseSha256=hashlib.sha256(raw).hexdigest(),sourceSha256=source['sha256'],credit=source['credit'],sourceUrl=source['sourceUrl'],licenseUrl=source.get('licenseUrl'),
            compressedBytes=sum(e['bytes'] for e in entries.values()),buildSeconds=time.perf_counter()-start,sourceResolutionMeters=source['sourceResolutionMeters'])
        (stage/'manifest.json').write_text(json.dumps(manifest,separators=(',',':')))
        target=ROOT/'public/hillshade'/body/version
        if (target/'manifest.json').exists():
            existing=json.loads((target/'manifest.json').read_text())
            if existing['tiles']!=entries or existing['baseSha256']!=manifest['baseSha256']:
                raise ValueError('Immutable release conflict; increment the algorithm revision')
        else:
            publishing=target.with_name(version+f'.publishing-{os.getpid()}');publishing.mkdir(parents=True,exist_ok=True)
            for path in stage.rglob('*.bin.gz'):
                out=publishing/path.relative_to(stage);out.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(path,out)
            shutil.copyfile(stage/'manifest.json',publishing/'manifest.json')
            os.replace(publishing,target)
        catalog_path=ROOT/'public/hillshade/catalog.json';catalog=json.loads(catalog_path.read_text()) if catalog_path.exists() else dict(schema=1,bodies={})
        catalog['bodies'][body]=f'{body}/{version}/manifest.json'
        temp=catalog_path.with_suffix('.writing');temp.write_text(json.dumps(catalog,indent=2));temp.replace(catalog_path)
        print('Published',body,manifest['compressedBytes'],'bytes',round(manifest['buildSeconds'],1),'seconds',flush=True)

if __name__=='__main__':main()
