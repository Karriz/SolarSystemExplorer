"""Continuous lunar color from the original NASA sRGB 16-bit TIFF."""
import hashlib,json,time,os
from pathlib import Path
import numpy as np
import rasterio
from rasterio.windows import Window
from rasterio.shutil import copy

source=Path('.terrain-cache/moon-color/lroc-color-8k.tif')
out=Path('public/textures');cache=Path('.terrain-cache/moon-color')
start=time.perf_counter()
with source.open('rb') as stream:source_sha=hashlib.file_digest(stream,'sha256').hexdigest()
assert source_sha=='db7808e878b6a55eb409bb231eab8deb477f84b5c9d7396d76ff73e5d54992d9','NASA source changed; review the input before rebuilding'
with rasterio.open(source) as s:
    assert s.width==8192 and s.height==4096 and s.count==3 and s.dtypes[0]=='uint16'
    ref=np.empty((3,2048,4096),dtype='uint8')
    for row in range(0,2048,64):
        v=s.read(window=Window(0,row*2,8192,128)).astype('float32')/65535
        linear=np.where(v<=.04045,v/12.92,((v+.055)/1.055)**2.4)
        linear=(linear[:,::2,::2]+linear[:,1::2,::2]+linear[:,::2,1::2]+linear[:,1::2,1::2])/4
        encoded=np.where(linear<=.0031308,linear*12.92,1.055*linear**(1/2.4)-.055)
        ref[:,row:row+64]=np.rint(np.clip(encoded,0,1)*255).astype('uint8')
reference=cache/'moon-color-reference.png'
with rasterio.open(reference,'w',driver='PNG',width=4096,height=2048,count=3,dtype='uint8') as s:s.write(ref)
results=[]
for quality in [90,95]:
    file=cache/f'moon-color-q{quality}.webp';t=time.perf_counter()
    with rasterio.Env(GDAL_PAM_ENABLED='NO'):copy(reference,file,driver='WEBP',QUALITY=quality)
    seconds=time.perf_counter()-t
    with rasterio.open(file) as s:error=np.abs(ref.astype('int16')-s.read().astype('int16'))
    results.append(dict(quality=quality,bytes=file.stat().st_size,encodeSeconds=seconds,meanChannelError=float(error.mean()),p99ChannelError=float(np.percentile(error,99))))
import shutil
def publish(source,destination):
    temporary=destination.with_name(destination.name+f'.{os.getpid()}.writing')
    shutil.copyfile(source,temporary);temporary.replace(destination)
publish(cache/'moon-color-q95.webp',out/'moon-color.webp')
publish(reference,out/'moon-color-reference.png')
def control(lat,lon):
    x=(lon/360+.5)*4096-.5;y=np.clip((.5-lat/180)*2048-.5,0,2047)
    ix,iy=int(np.floor(x)),int(np.floor(y));u,v=x-ix,y-iy;linear=np.zeros(3)
    for dx,dy,weight in [(0,0,(1-u)*(1-v)),(1,0,u*(1-v)),(0,1,(1-u)*v),(1,1,u*v)]:
        rgb=ref[:,min(iy+dy,2047),(ix+dx)%4096]/255
        linear+=np.where(rgb<=.04045,rgb/12.92,((rgb+.055)/1.055)**2.4)*weight
    rgb=np.where(linear<=.0031308,linear*12.92,1.055*linear**(1/2.4)-.055)*255
    return dict(lat=lat,lon=lon,srgb=rgb.tolist())
report=dict(controlSamples=[control(lat,lon) for lat,lon in [(26.13,3.63),(-43.31,-11.36),(-20,140),(10,179.9),(85,0)]],schema=1,source='NASA SVS CGI Moon Kit 2025, original sRGB 16-bit 8K TIFF',sourceUrl='https://svs.gsfc.nasa.gov/4720/',credit='NASA SVS / LRO LROC and LOLA teams',
    sourceSha256=source_sha,width=4096,height=2048,downsample='2x2 in linear light, then encode sRGB',selectedQuality=95,candidates=results,buildSeconds=time.perf_counter()-start,
    limitations='Exposure/white balance adjusted in NASA visual product; polar gaps use lower-resolution monochrome albedo',deliveredSha256=hashlib.sha256((out/'moon-color.webp').read_bytes()).hexdigest())
(out/'moon-color.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
