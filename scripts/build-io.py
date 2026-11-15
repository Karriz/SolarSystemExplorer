#!/usr/bin/env python3
"""Complete the published Io stereo terrain and reconstruct visible color.

Measured samples remain authoritative. Missing terrain uses smooth constrained
interpolation and seeded volcanic-plains variation, stored offline. Global RGB
is an explicit spectral reconstruction, not a calibrated true-color product.
"""
import hashlib
import importlib.util
import json
import math
import sys
from pathlib import Path
import warnings

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.shutil import copy as raster_copy
from rasterio.transform import from_bounds
from rasterio.warp import reproject
from scipy.ndimage import distance_transform_edt, gaussian_filter, zoom

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/io'
OUT = ROOT / 'public/textures'
RADIUS = 1821600
# Thomas et al. (1998) limb-equilibrium figure. The exact unpublished updated
# limb figure is unavailable; this documented datum approximation is <~0.3 km.
AXES = (1829700, 1819200, 1815800)
WIDTH, HEIGHT = 16384, 8192


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_png(path, values):
    if values.ndim == 2:
        values = values[None]
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', rasterio.errors.NotGeoreferencedWarning)
        with rasterio.open(path, 'w', driver='PNG', width=values.shape[2], height=values.shape[1], count=values.shape[0], dtype='uint8') as out:
            out.write(values.astype('uint8'))


def resize(array, shape):
    longitudinal = zoom(array, (1, shape[1]/array.shape[1]), order=1, mode='grid-wrap', grid_mode=True)
    return zoom(longitudinal, (shape[0]/array.shape[0], 1), order=1, mode='nearest', grid_mode=True)


def complete_residual(measured, valid):
    """Preserve valid pixels and constrain missing plains from their neighbors.

Coarse nearest support includes wrapped longitude copies. The generated field
is a seamless 3D function and tapers to zero toward measured boundaries.
"""
    h, w = measured.shape
    coarse = measured[::8, ::8].copy()
    known = valid[::8, ::8]
    extended_missing = np.tile(~known, (1, 3))
    distances, indices = distance_transform_edt(extended_missing, return_indices=True)
    extended = np.tile(coarse, (1, 3))
    filled = extended[tuple(indices)][:, w//8:w//4].copy()
    # Isolated measured mountain peaks must not extend as broad unobserved
    # plateaus through a nearest-neighbor initialization of a large gap.
    filled = np.clip(filled, -2000, 2000)
    distance = distances[:, w//8:w//4].copy()
    del extended, indices, distances, extended_missing
    filled = gaussian_filter(filled, 4, mode=('nearest', 'wrap'))
    for _ in range(60):
        smooth = gaussian_filter(filled, 1, mode=('nearest', 'wrap'))
        filled = np.where(known, coarse, smooth)
    guide = resize(filled, measured.shape).astype('float32')
    taper = np.clip(distance / 8, 0, 1)
    taper = taper * taper * (3 - 2 * taper)
    taper = resize(taper, measured.shape).astype('float32')
    rng = np.random.default_rng(501)
    waves = [(frequency, amplitude, rng.normal(size=3), rng.uniform(0, 2*np.pi))
             for frequency, amplitude in [(18, 140), (55, 65), (160, 25), (460, 8)]]
    longitude = np.deg2rad(-180 + (np.arange(w)+.5)/w*360)[None]
    for row in range(0, h, 64):
        stop = min(h, row+64)
        latitude = np.deg2rad(90-(np.arange(row, stop)+.5)/h*180)[:, None]
        x, y, z = np.cos(latitude)*np.cos(longitude), np.cos(latitude)*np.sin(longitude), np.sin(latitude)
        variation = np.zeros((stop-row, w), dtype='float32')
        for frequency, amplitude, direction, phase in waves:
            direction = direction / np.linalg.norm(direction)
            variation += amplitude * np.sin(frequency*(direction[0]*x+direction[1]*y+direction[2]*z)+phase)
        guide[row:stop] += variation * taper[row:stop]
    del taper
    guide[valid] = measured[valid]
    # Resolve the last few pixels around source boundaries at the actual output
    # resolution; never smooth or procedurally modify the measured interior.
    for _ in range(8):
        smooth = gaussian_filter(guide, 1, mode=('nearest', 'wrap'))
        guide[~valid] = smooth[~valid]
    for pole, rows in [(0, range(h//36)), (-1, range(h-h//36, h))]:
        pole_value = float(guide[pole].mean())
        for row in rows:
            if not valid[row].any():
                latitude = abs(90-(row+.5)/h*180)
                t = np.clip((latitude-85)/5, 0, 1)
                weight = t*t*(3-2*t)
                guide[row] = guide[row]*(1-weight)+pole_value*weight
    assert np.array_equal(guide[valid], measured[valid])
    return guide


def prepare_color(fetcher):
    print('Preparing reconstructed visible color', flush=True)
    with rasterio.open(CACHE/'sources/color.tif') as image:
        color = np.full((3, 2048, 4096), np.nan, dtype='float32')
        for band in range(3):
            reproject(rasterio.band(image, band+1), color[band], src_transform=image.transform,
                      src_crs=image.crs, src_nodata=image.nodata,
                      dst_transform=from_bounds(-180, -90, 180, 90, 4096, 2048),
                      dst_crs='+proj=longlat +R=1821460 +no_defs', dst_nodata=np.nan,
                      resampling=Resampling.bilinear, num_threads=4)
            color[band] = color[band]*image.scales[band]+image.offsets[band]
    missing = ~np.isfinite(color).all(axis=0)
    if missing.any():
        _, indices = distance_transform_edt(np.tile(missing, (1, 3)), return_indices=True)
        for band in range(3):
            values = np.tile(color[band], (1, 3))[tuple(indices)][:, 4096:8192]
            color[band, missing] = values[missing]
    infrared, green, violet = color
    # Interpolate 671 nm red between 559 nm green and 756 nm near-IR. Synthesized
    # 455 nm blue uses the published Io-specific .55 G + .45 V approximation.
    red = green+(infrared-green)*(671-559)/(756-559)
    blue = .55*green+.45*violet
    linear = np.stack([red, green, blue]) * .8
    linear = np.clip(linear, 0, 1)
    # A geographic mosaic cannot assign different colors to one physical pole.
    # Feather the inferred polar cap to its mean, avoiding radial image seams.
    for row in range(linear.shape[1]):
        latitude = abs(90-(row+.5)/linear.shape[1]*180)
        if latitude > 85:
            pole = 0 if row < linear.shape[1]/2 else -1
            mean = linear[:, pole].mean(axis=1)
            t = (latitude-85)/5
            weight = t*t*(3-2*t)
            linear[:, row] = linear[:, row]*(1-weight)+mean[:, None]*weight
    pixels = np.rint(np.where(linear <= .0031308, linear*12.92, 1.055*linear**(1/2.4)-.055)*255).astype('uint8')
    for row in [0, -1]:
        pixels[:, row, :] = np.rint(pixels[:, row, :].mean(axis=1))[:, None]
    with rasterio.Env(GDAL_PAM_ENABLED='NO'):
        write_png(OUT/'io-color-reference.png', pixels)
        raster_copy(OUT/'io-color-reference.png', OUT/'io-color.webp', driver='WEBP', LOSSLESS='YES')
    color_report = dict(schema=1, body='io', width=4096, height=2048,
                        source='USGS Galileo global color merge; reconstructed visible RGB',
                        sourceSha256=fetcher.PRODUCTS[1][3], red='G + (IR756-G)*(671-559)/(756-559)',
                        blue='.55*G559 + .45*V404', commonLinearScale=.8,
                        limitations='Approximate visible spectral reconstruction, not measured RGB. Source is an empirically processed multispectral mosaic, with variable spatial resolution and retained image illumination. Polar gaps use neighboring color; colors above 85 degrees blend smoothly to one pole mean.',
                        polarBlendLatitudeDegrees=85, longitude='east-positive-minus180-to180', deliveredSha256=sha(OUT/'io-color.webp'),
                        bytes=(OUT/'io-color.webp').stat().st_size,
                        controlSamples=[dict(lat=lat, lon=lon, srgb=pixels[:, round((90-lat)/180*2048-.5), round((lon+180)/360*4096-.5)].tolist())
                                        for lat, lon in [(-18.71, 104.72), (-9.88, 88.83), (18.4, -58.5), (55, -130)]])
    (OUT/'io-color.json').write_text(json.dumps(color_report, indent=2)+'\n')
    print(json.dumps(color_report, indent=2), flush=True)


def main():
    OUT.mkdir(exist_ok=True)
    spec = importlib.util.spec_from_file_location('io_fetch', ROOT / 'scripts/fetch-io.py')
    fetcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fetcher)
    for name, _, length, expected in fetcher.PRODUCTS:
        path = CACHE / 'sources' / name
        if path.stat().st_size != length or sha(path) != expected:
            raise ValueError(f'Changed source: {name}')
    if '--color-only' in sys.argv:
        prepare_color(fetcher)
        return
    print('Reprojecting source terrain', flush=True)
    with rasterio.open(CACHE / 'sources/dem.tif') as source:
        assert source.shape == (5750, 11500) and source.count == 1 and source.dtypes == ('float32',)
        raw = np.full((HEIGHT, WIDTH), np.nan, dtype='float32')
        transform = from_bounds(-180, -90, 180, 90, WIDTH, HEIGHT)
        reproject(rasterio.band(source, 1), raw, src_transform=source.transform, src_crs=source.crs,
                  src_nodata=source.nodata, dst_transform=transform, dst_crs=source.crs,
                  dst_nodata=np.nan, resampling=Resampling.bilinear, num_threads=4)
        mask = np.zeros((HEIGHT, WIDTH), dtype='uint8')
        reproject(source.read_masks(1), mask, src_transform=source.transform, src_crs=source.crs,
                  dst_transform=transform, dst_crs=source.crs, resampling=Resampling.nearest)
    valid = (mask > 0) & np.isfinite(raw)
    raw[~valid] = np.nan
    del mask
    latitude = np.deg2rad(90-(np.arange(HEIGHT)+.5)/HEIGHT*180)
    area = np.cos(latitude)
    coverage = float((valid*area[:, None]).sum()/(area.sum()*WIDTH))
    print(f'Source-supported surface area: {coverage:.6%}; completing gaps', flush=True)
    completed = complete_residual(raw, valid)
    write_png(OUT / 'io-terrain-coverage.png', valid.reshape(512, 16, 1024, 16).mean(axis=(1, 3))*255)
    del raw
    longitude = np.deg2rad(-180+(np.arange(WIDTH)+.5)/WIDTH*360)[None]
    for row in range(0, HEIGHT, 64):
        stop = min(HEIGHT, row+64)
        lat = latitude[row:stop, None]
        figure = 1/np.sqrt((np.cos(lat)*np.cos(longitude)/AXES[0])**2
                           + (np.cos(lat)*np.sin(longitude)/AXES[1])**2 + (np.sin(lat)/AXES[2])**2)
        completed[row:stop] += (figure-RADIUS).astype('float32')
    prepared = CACHE / 'io-radial.tif'
    print('Writing completed radial terrain', flush=True)
    with rasterio.open(prepared, 'w', driver='GTiff', width=WIDTH, height=HEIGHT, count=1,
                       dtype='float32', crs=f'+proj=longlat +R={RADIUS} +no_defs', transform=transform,
                       compress='deflate', tiled=True, nodata=-32768) as out:
        out.write(completed, 1)
    report = dict(schema=1, body='io', referenceRadiusMeters=RADIUS, referenceEllipsoidMeters=AXES,
                  datumApproximation='Thomas et al. 1998 equilibrium figure; exact updated limb figure not supplied by Trek',
                  sourceHeightUnits='meters', sourceSupportedFraction=coverage,
                  gapFill='Constrained neighboring relief plus seeded volcanic-plains waves; measured resampled pixels preserved exactly',
                  proceduralWaveAmplitudesMeters=[140, 65, 25, 8], seed=501,
                  sourceFiles=json.loads((CACHE/'sources/sources.json').read_text()),
                  minHeightMeters=float(completed.min()), maxHeightMeters=float(completed.max()),
                  preparedSha256=sha(prepared), width=WIDTH, height=HEIGHT)
    del completed, valid
    source = dict(product='white2014-trek-completed-v1', file=prepared.name,
                  url='offline-prepared:build-io.py', sha256=report['preparedSha256'],
                  width=WIDTH, height=HEIGHT, sourceWest=-180, sourceScale=1, scaleMeters=1,
                  referenceRadiusMeters=RADIUS, sourceRadiusMeters=RADIUS, sourceProjection='longlat',
                  sourcePixelDegrees=360/WIDTH, sourceResolutionMeters=1000, maxZoom=6, sampleSize=129,
                  frame='IAU_IO / White 2014', verticalDatum='Radial meters above 1821600 m sphere; approximate Thomas 1998 triaxial figure restored',
                  credit='White et al. (2014) / NASA / LPI / Io Trek; reconstructed gaps',
                  sourceUrl='https://doi.org/10.1002/2013JE004591', cacheSubdirectory='io',
                  coverageNotes=f'NASA Trek numeric stereo terrain supports {coverage:.3%} of spherical area; remaining terrain reconstructed.',
                  license='Cite White et al. (2014), doi:10.1002/2013JE004591')
    config_path = ROOT / 'scripts/terrain-sources.json'
    config = json.loads(config_path.read_text()); config['io'] = source
    config_path.write_text(json.dumps(config, indent=2)+'\n')
    (OUT/'io-terrain.json').write_text(json.dumps(report, indent=2)+'\n')
    (CACHE/'preparation.json').write_text(json.dumps(report, indent=2)+'\n')
    prepare_color(fetcher)
    print(json.dumps(report, indent=2), flush=True)


if __name__ == '__main__':
    main()
