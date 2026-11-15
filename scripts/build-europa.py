#!/usr/bin/env python3
"""Bake Europa's measured regional relief into a reconstructed global surface."""
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import sys
import zipfile

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.shutil import copy as raster_copy
from rasterio.transform import from_bounds
from rasterio.warp import reproject
from rasterio.windows import Window
import shapefile
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT/'.terrain-cache/europa'
OUT = ROOT/'public/textures'
RADIUS = 1560800
AXES = (1562600, 1560300, 1559500)
WIDTH, HEIGHT = 32768, 16384
SITES = ['Cilix_Crater', 'Pwyll_Crater', 'Rhadamanthys', 'Yelland_Ridges', 'Agenor']
UNITS = ['nd', 'pr', 'cpr', 'cpre', 'b', 'chm', 'chl', 'chh', 'chM', 'c', 'ce']


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_png(path, array):
    if array.ndim == 2: array = array[None]
    with rasterio.Env(GDAL_PAM_ENABLED='NO'):
        with rasterio.open(path, 'w', driver='PNG', width=array.shape[2], height=array.shape[1], count=array.shape[0], dtype='uint8') as out:
            out.write(array.astype('uint8'))


def geology():
    """Only explicitly mapped ridges/cycloids receive inferred ridge heights."""
    archive = zipfile.ZipFile(CACHE/'sources/geology.zip')
    prefix = 'sim3513_Europa_GIS/shapefiles/'
    def reader(name):
        return shapefile.Reader(**{ext:io.BytesIO(archive.read(prefix+name+'.'+ext)) for ext in ['shp','shx','dbf']})
    polygons = [(s.shape.__geo_interface__, UNITS.index(s.record['Geounits'])+1) for s in reader('GeoUnits_FINAL').shapeRecords()]
    lines = []
    counts = {}
    for feature in reader('LinearFeatures_FINAL').shapeRecords():
        kind = feature.record['Type']; counts[kind] = counts.get(kind, 0)+1
        if kind not in ['ridges', 'cycloid']: continue
        shape = feature.shape
        breaks = list(shape.parts)+[len(shape.points)]
        for a,b in zip(breaks[:-1],breaks[1:]):
            points = np.asarray(shape.points[a:b])
            points[:,0] = np.rad2deg(np.unwrap(np.deg2rad(points[:,0])))
            for shift in [-360,0,360]:
                coordinates = points.copy(); coordinates[:,0] += shift
                lines.append((dict(type='LineString',coordinates=coordinates.tolist()),1))
    units = rasterize(polygons,out_shape=(4096,8192),transform=from_bounds(-180,-90,180,90,8192,4096),dtype='uint8')
    mask = rasterize(lines,out_shape=(8192,16384),transform=from_bounds(-180,-90,180,90,16384,8192),dtype='uint8',all_touched=True)
    padded = np.pad(mask,((0,0),(64,64)),mode='wrap')
    distance = distance_transform_edt(padded == 0)[:,64:-64].astype('float32')
    np.save(CACHE/'ridge-distance.npy',distance)
    np.save(CACHE/'geologic-units.npy',units)
    (CACHE/'geology.json').write_text(json.dumps(dict(source='Leonard et al. 2024, SIM3513',lineCounts=counts,units=UNITS),indent=2)+'\n')
    return units, distance


def sample_small(array, rows, cols, output_width=WIDTH, output_height=HEIGHT):
    yy = (rows+.5)/output_height*array.shape[0]-.5
    xx = (cols+.5)/output_width*array.shape[1]-.5
    return map_coordinates(array,np.broadcast_arrays(yy[:,None],xx[None,:]),order=1,mode='nearest')


def regional_grids():
    """Retain published residual shapes; choose an explicit zero median datum."""
    regions = []
    for name in SITES:
        with rasterio.open(CACHE/f'sources/{name}.tif') as src:
            raw = src.read(1,masked=True).filled(np.nan)
            finite = np.isfinite(raw)
            datum = float(np.nanmedian(raw))
            radius = src.crs.to_dict()['R']
            # All five supplied products use EQC, central meridian 180, with
            # planetocentric east longitude. Do not use the older mosaic radius.
            assert abs(radius-RADIUS)<1 and src.crs.to_dict()['lon_0']==180
            west,east = np.rad2deg(np.asarray([src.bounds.left,src.bounds.right])/radius)+180
            south,north = np.rad2deg(np.asarray([src.bounds.bottom,src.bounds.top])/radius)
            left=max(0,int((west+180)/360*WIDTH)-4); right=min(WIDTH,math.ceil((east+180)/360*WIDTH)+4)
            top=max(0,int((90-north)/180*HEIGHT)-4); bottom=min(HEIGHT,math.ceil((90-south)/180*HEIGHT)+4)
            transform = from_bounds(-180+left/WIDTH*360,90-bottom/HEIGHT*180,-180+right/WIDTH*360,90-top/HEIGHT*180,right-left,bottom-top)
            # Blend only the outer 1.5 km of the DTM, including its irregular
            # valid footprint. The observed interior is never procedurally edited.
            d = distance_transform_edt(np.pad(finite,1))[1:-1,1:-1]*src.transform.a
            weight = np.clip(d/1500,0,1); weight = weight*weight*(3-2*weight)
            values = np.full((bottom-top,right-left),np.nan,dtype='float32')
            weights = np.zeros_like(values)
            for source,dest,nodata,method in [(raw-datum,values,np.nan,Resampling.bilinear),(weight.astype('float32'),weights,None,Resampling.bilinear)]:
                reproject(source,dest,src_transform=src.transform,src_crs=src.crs,src_nodata=nodata,dst_transform=transform,dst_crs=f'+proj=longlat +R={RADIUS}',dst_nodata=np.nan if dest is values else 0,resampling=method)
            weights[~np.isfinite(values)] = 0
            values = np.nan_to_num(values)
            with rasterio.open(CACHE/f'sources/{name}-fom.tif') as fom:
                flags = fom.read(1)
                # The released FOM was cubic-warped: retain its numeric values
                # as provenance, without pretending interpolated codes are exact categories.
                fom_counts = dict(zip(*[a.tolist() for a in np.unique(flags,return_counts=True)]))
            regions.append(dict(name=name,box=[left,top,right,bottom],values=values,weights=weights,metadata=dict(name=name,sourceMedianMeters=datum,placement='Subtract local source median; add IAU reference ellipsoid; no global absolute-height claim',sourceStepMeters=src.transform.a,sourceValidPixels=int(finite.sum()),sourcePixelAreaMeters2=src.transform.a**2,sourceMinMeters=float(np.nanmin(raw)),sourceMaxMeters=float(np.nanmax(raw)),fomHistogram=fom_counts,boundsDegrees=[west,south,east,north])))
    return regions


def stabilize_poles(path,chaos_field):
    # A geologic raster's partial polar edge row must not give different
    # heights to one physical pole. Fade inferred chaos detail above 75 deg.
    cols=np.arange(WIDTH);lon=np.deg2rad(-180+(cols+.5)/WIDTH*360)[None]
    cap=math.ceil(HEIGHT/12)
    with rasterio.open(path,'r+') as out:
        for begin,end in [(0,cap),(HEIGHT-cap,HEIGHT)]:
            for row in range(begin,end,64):
                rows=np.arange(row,min(row+64,end));lat=np.deg2rad(90-(rows+.5)/HEIGHT*180)[:,None]
                x,y,z=np.cos(lat)*np.cos(lon),np.cos(lat)*np.sin(lon),np.sin(lat)
                chaos=sample_small(chaos_field,rows,cols)
                polar=np.clip((85-np.abs(np.rad2deg(lat)))/10,0,1);polar=polar*polar*(3-2*polar)
                correction=chaos*(45*np.abs(np.sin(650*x+230*y-370*z))-22.5)*(1-polar)
                window=Window(0,row,WIDTH,len(rows));block=out.read(1,window=window)
                block-=correction.astype('float32');out.write(block,1,window=window)
    minimum,maximum=np.inf,-np.inf
    with rasterio.open(path) as src:
        for row in range(0,HEIGHT,128):
            block=src.read(1,window=Window(0,row,WIDTH,min(128,HEIGHT-row)))
            minimum=min(minimum,float(block.min()));maximum=max(maximum,float(block.max()))
    return minimum,maximum


def terrain(units,distance):
    regions = regional_grids()
    chaos_field=gaussian_filter(np.isin(units,[6,7,8,9]).astype('float32'),2,mode=('nearest','wrap'))
    rng = np.random.default_rng(502)
    waves=[(f,a,rng.normal(size=3),rng.uniform(0,2*np.pi)) for f,a in [(12,55),(40,28),(120,12),(450,8),(1400,4)]]
    cols=np.arange(WIDTH);lon=np.deg2rad(-180+(cols+.5)/WIDTH*360)[None]
    path=CACHE/'europa-radial.tif'
    coverage=np.zeros((1024,2048),dtype='float32')
    minimum,maximum=np.inf,-np.inf
    with rasterio.open(path,'w',driver='GTiff',width=WIDTH,height=HEIGHT,count=1,dtype='float32',crs=f'+proj=longlat +R={RADIUS}',transform=from_bounds(-180,-90,180,90,WIDTH,HEIGHT),compress='deflate',tiled=True,nodata=-32768) as out:
        for row in range(0,HEIGHT,64):
            rows=np.arange(row,min(row+64,HEIGHT));lat=np.deg2rad(90-(rows+.5)/HEIGHT*180)[:,None]
            x,y,z=np.cos(lat)*np.cos(lon),np.cos(lat)*np.sin(lon),np.sin(lat)
            height=np.zeros(x.shape,dtype='float32')
            for frequency,amplitude,direction,phase in waves:
                direction=direction/np.linalg.norm(direction)
                height += amplitude*np.sin(frequency*(direction[0]*x+direction[1]*y+direction[2]*z)+phase)
            chaos=sample_small(chaos_field,rows,cols)
            # Smoothly bounded block-like variation in mapped chaos; this is
            # inferred relief, not a height interpretation of image brightness.
            height += chaos*(45*np.abs(np.sin(650*x+230*y-370*z))-22.5)
            d=sample_small(distance,rows,cols)*(2*np.pi*RADIUS/16384)
            ridge=180*np.exp(-((d-1100)/650)**2)-30*np.exp(-(d/450)**2)
            polar=np.clip((85-np.abs(np.rad2deg(lat)))/10,0,1);polar=polar*polar*(3-2*polar)
            height += ridge*polar
            support=np.zeros_like(height)
            for region in regions:
                l,t,r,b=region['box'];a=max(row,t);end=min(row+len(rows),b)
                if end<=a:continue
                weights=region['weights'][a-t:end-t]
                target=height[a-row:end-row,l:r]
                target[:]=target*(1-weights)+region['values'][a-t:end-t]*weights
                support[a-row:end-row,l:r]=np.maximum(support[a-row:end-row,l:r],weights)
            figure=1/np.sqrt((x/AXES[0])**2+(y/AXES[1])**2+(z/AXES[2])**2)
            height += (figure-RADIUS).astype('float32')
            assert np.isfinite(height).all()
            minimum=min(minimum,float(height.min()));maximum=max(maximum,float(height.max()))
            out.write(height,1,window=Window(0,row,WIDTH,len(rows)))
            coverage[row//16:(row+len(rows))//16] = support.reshape(len(rows)//16,16,2048,16).mean(axis=(1,3))
            if row%2048==0:print('Terrain rows',row,'/',HEIGHT,flush=True)
    minimum,maximum=stabilize_poles(path,chaos_field)
    write_png(OUT/'europa-terrain-coverage.png',coverage*255)
    report=dict(schema=1,body='europa',referenceRadiusMeters=RADIUS,referenceEllipsoidMeters=AXES,width=WIDTH,height=HEIGHT,minHeightMeters=minimum,maxHeightMeters=maximum,preparedSha256=sha(path),regions=[r['metadata'] for r in regions],gapFill='Seed 502 broad ice plains, mapped SIM3513 ridges/cycloids with inferred heights, mapped chaos block variation; regional stereo interiors authoritative',ridgePeakAmplitudeMeters=180,ridgeTypicalHalfWidthMeters=1100,edgeBlendMeters=1500,seed=502,sourceFiles=json.load(open(CACHE/'sources/sources.json')))
    report['regionalFootprintAreaFraction']=sum(r['metadata']['sourceValidPixels']*r['metadata']['sourcePixelAreaMeters2']*math.cos(math.radians(sum(r['metadata']['boundsDegrees'][i] for i in [1,3])/2)) for r in regions)/(4*np.pi*RADIUS**2)
    (OUT/'europa-terrain.json').write_text(json.dumps(report,indent=2)+'\n')
    (CACHE/'preparation.json').write_text(json.dumps(report,indent=2)+'\n')
    config_path=ROOT/'scripts/terrain-sources.json';config=json.load(open(config_path))
    config['europa']=dict(product='bland2021-sim3513-completed-v1',file=path.name,url='offline-prepared:build-europa.py',sha256=report['preparedSha256'],width=WIDTH,height=HEIGHT,sourceWest=-180,sourceScale=1,scaleMeters=1,referenceRadiusMeters=RADIUS,sourceRadiusMeters=RADIUS,sourceProjection='longlat',sourcePixelDegrees=360/WIDTH,sourceResolutionMeters=1000,maxZoom=7,sampleSize=129,frame='IAU_EUROPA / USGS controlled 2021',verticalDatum='Radial meters above 1560800 m sphere; IAU triaxial figure plus locally zero-median regional relief',credit='NASA / USGS; Bland et al. (2021), Leonard et al. (2024); reconstructed global gaps',sourceUrl='https://stac.astrogeology.usgs.gov/docs/data/jupiter/europa/europa_controlled_usgs_dtms/',cacheSubdirectory='europa',coverageNotes=f"Five stereo footprints cover approximately {report['regionalFootprintAreaFraction']:.4%}; outer 1.5 km blends to reconstructed terrain. Local absolute heights are unknown.",license='CC0-1.0 regional DTMs; USGS SIM3513 public-domain geology',licenseUrl='https://creativecommons.org/publicdomain/zero/1.0/')
    config_path.write_text(json.dumps(config,indent=2)+'\n')
    print('Terrain complete',report['preparedSha256'],flush=True)


def color(units):
    width,height=4096,2048;transform=from_bounds(-180,-90,180,90,width,height)
    gray=np.full((height,width),np.nan,dtype='float32')
    with rasterio.open(CACHE/'sources/global.tif') as src:
        reproject(rasterio.band(src,1),gray,src_transform=src.transform,src_crs=src.crs,src_nodata=src.nodata,dst_transform=transform,dst_crs='+proj=longlat +R=1562089.9658',dst_nodata=np.nan,resampling=Resampling.bilinear)
        gray=gray*src.scales[0]+src.offsets[0]
    missing=~np.isfinite(gray)
    if missing.any():
        _,indices=distance_transform_edt(np.pad(missing,((0,0),(32,32)),mode='wrap'),return_indices=True)
        filled=np.pad(gray,((0,0),(32,32)),mode='wrap')[tuple(indices)][:,32:-32]
        gray[missing]=filled[missing]
    # Match local controlled imagery in its own radiometric scale, retaining
    # geographic detail while feathering only its footprint boundary.
    ortho_records=[]
    for name in sorted(r['file'] for r in json.load(open(CACHE/'sources/sources.json')) if r['file'].startswith('ortho-')):
        if 'CRATER02' in name or 'CRATER01' in name:continue
        local=np.full_like(gray,np.nan)
        with rasterio.open(CACHE/'sources'/name) as src:
            reproject(rasterio.band(src,1),local,src_transform=src.transform,src_crs=src.crs,src_nodata=src.nodata,dst_transform=transform,dst_crs='+proj=longlat +R=1560800',dst_nodata=np.nan,resampling=Resampling.bilinear)
        valid=np.isfinite(local)&(local>0)
        if valid.sum()<3:continue
        a,b=np.percentile(local[valid],[10,90]);c,d=np.percentile(gray[valid],[10,90])
        matched=(local-a)/max(b-a,1e-9)*(d-c)+c
        weight=np.clip(distance_transform_edt(valid)/2,0,1);weight=weight*weight*(3-2*weight)
        gray[valid]=gray[valid]*(1-weight[valid])+matched[valid]*weight[valid]
        ortho_records.append(name)
    gray=np.clip(gray,.03,1.4)
    # Display-level albedo reconstruction: reduce baked lighting contrast, then
    # apply restrained natural-color endmembers, never image-derived heights.
    white=float(np.percentile(gray,95))
    normalized=np.clip(gray/white,.05,1.1)
    light=np.clip(normalized**1.25,.12,1.08)
    # Dark mapped image features get a restrained brown endmember. Unit colors
    # from a geologic map are never painted onto the surface as reflectance.
    local=gaussian_filter(normalized,1.4,mode=('nearest','wrap'))
    line_dark=np.clip((local-normalized)/.12,0,1)
    dark=np.clip((.90-normalized)/.55,0,1)
    warm=np.clip(.75*dark+.25*line_dark,0,.85)
    rgb=np.stack([.73*light,.74*light,.72*light])
    rgb[0]*=1+.16*warm;rgb[1]*=1-.20*warm;rgb[2]*=1-.52*warm
    # Polar color is inferred and must converge to a single physical pole.
    for row in range(height):
        lat=abs(90-(row+.5)/height*180)
        if lat>85:
            pole=0 if row<height/2 else -1;t=(lat-85)/5;w=t*t*(3-2*t)
            rgb[:,row]=rgb[:,row]*(1-w)+rgb[:,pole].mean(axis=1)[:,None]*w
    linear=np.clip(rgb,0,1)
    pixels=np.rint(np.where(linear<=.0031308,linear*12.92,1.055*linear**(1/2.4)-.055)*255).astype('uint8')
    for row in [0,-1]:pixels[:,row]=np.rint(pixels[:,row].mean(axis=1))[:,None]
    write_png(OUT/'europa-color-reference.png',pixels)
    with rasterio.Env(GDAL_PAM_ENABLED='NO'):raster_copy(OUT/'europa-color-reference.png',OUT/'europa-color.webp',driver='WEBP',LOSSLESS='YES')
    report=dict(schema=1,body='europa',width=width,height=height,source='USGS global and controlled Galileo monochrome imagery with inferred visible ice/non-ice color',naturalColorReference='NASA/JPL/DLR PIA00502 left natural-color hemisphere; appearance constraint, not a georeferenced global RGB source',colorModel='Near-neutral ice and restrained brown endmember on dark image features; local contrast moderates chroma. Inferred chroma, no geologic unit-color painting', whiteReference=white,controlledImagery=ortho_records,limitations='No measured global RGB. Source illumination remains partly baked. Image brightness constrains inferred appearance, not measured material identification. Regional/global control networks differ. Polar color is inferred.',deliveredSha256=sha(OUT/'europa-color.webp'),bytes=(OUT/'europa-color.webp').stat().st_size)
    (OUT/'europa-color.json').write_text(json.dumps(report,indent=2)+'\n')
    print('Color complete',flush=True)


def detail():
    # Reuse the deterministic ice baker with a Europa-specific output identity.
    spec=importlib.util.spec_from_file_location('ice_builder',ROOT/'scripts/build-enceladus.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    # The two moons share the frost microstructure model, not geographic relief.
    for medium in [False,True]:
        original=module.write_png
        def write(path,array):
            return original(OUT/path.name.replace('enceladus','europa'),array)
        module.write_png=write;module.ice_detail(medium);module.write_png=original


def main():
    CACHE.mkdir(parents=True,exist_ok=True);OUT.mkdir(exist_ok=True)
    spec=importlib.util.spec_from_file_location('europa_fetch',ROOT/'scripts/fetch-europa.py');fetcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(fetcher)
    for name,_,length,expected in fetcher.PRODUCTS:
        path=CACHE/'sources'/name
        assert path.stat().st_size==length and sha(path)==expected,name
    if '--color-only' in sys.argv:
        color(np.load(CACHE/'geologic-units.npy'));return
    if '--terrain-only' in sys.argv:
        terrain(np.load(CACHE/'geologic-units.npy'),np.load(CACHE/'ridge-distance.npy',mmap_mode='r'));return
    units,distance=geology()
    color(units);detail();terrain(units,distance)


if __name__=='__main__':main()
