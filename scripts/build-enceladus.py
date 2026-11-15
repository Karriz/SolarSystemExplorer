#!/usr/bin/env python3
"""Prepare a global radial DEM and explicitly reconstructed visible ice color.

The Cassini DEM is kilometer-valued radial relief above the Thomas triaxial
figure. The color is an inferred visible appearance, NOT measured global RGB:
monochrome Cassini geography plus restrained chromatic variation from PIA18435.
"""
import hashlib
import json
import math
from pathlib import Path
import warnings

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.shutil import copy as raster_copy
from rasterio.transform import from_bounds
from rasterio.warp import reproject

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/enceladus'
OUT = ROOT / 'public/textures'
RADIUS = 252100
AXES = (256200, 251400, 248600)
WIDTH, HEIGHT = 8192, 4096
SOURCE_HASHES = {
    'dem.tif': '7c08c46238cde6528c9143f0c667d42cd3bc6ac60c572595a7e6cad2d6775f91',
    'mosaic.tif': '1738c5cf8e856c7ae262d858261af0fbb32503a68a524884d36194afb23afcc5',
    'color.jpg': '5b60d0161efd659f6d95281559ad4b30826fd02ee72944dbb3f8b7679f65ed4d',
}


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fill_gaps(a):
    """Only fill missing pixels, from valid adjacent residuals; longitude wraps."""
    a = a.copy()
    for _ in range(512):
        missing = ~np.isfinite(a)
        if not missing.any():
            return a
        total = np.zeros_like(a)
        count = np.zeros(a.shape, dtype='uint8')
        for axis, shift in [(0, 1), (0, -1), (1, 1), (1, -1)]:
            neighbor = np.roll(a, shift, axis=axis)
            if axis == 0:
                neighbor[0 if shift == 1 else -1] = np.nan
            good = np.isfinite(neighbor)
            total += np.where(good, neighbor, 0)
            count += good
        take = missing & (count > 0)
        if not take.any():
            raise ValueError('Source has unsupported unbounded gaps')
        a[take] = total[take] / count[take]
    raise ValueError('Source gaps exceed bounded interpolation')


def geographic(path, width, height, west=0):
    result = np.full((height, width), np.nan, dtype='float32')
    with rasterio.open(path) as source:
        reproject(rasterio.band(source, 1), result, src_transform=source.transform,
                  src_crs=source.crs, src_nodata=source.nodata,
                  dst_transform=from_bounds(west, -90, west + 360, 90, width, height),
                  dst_crs='+proj=longlat +R=256200 +no_defs', dst_nodata=np.nan,
                  resampling=Resampling.bilinear, num_threads=4)
    return result


def write_png(path, array):
    if array.ndim == 2:
        array = array[None]
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', rasterio.errors.NotGeoreferencedWarning)
        with rasterio.open(path, 'w', driver='PNG', width=array.shape[2], height=array.shape[1],
                           count=array.shape[0], dtype='uint8') as out:
            out.write(array.astype('uint8'))


def ice_detail(medium=False):
    """Seeded periodic frost/ice shading only; does not alter measured relief."""
    size = 512
    rng = np.random.default_rng(602 + int(medium))
    frequencies = np.fft.fftfreq(size) * size
    k = np.hypot(frequencies[:, None], frequencies[None, :])
    spectrum = np.fft.fft2(rng.normal(size=(size, size)))
    spectrum *= np.exp(-(k / (56 if medium else 140)) ** 2) / np.maximum(k, 2) ** .8
    h = np.fft.ifft2(spectrum).real
    h = h / h.std()
    height = h * (.3 if medium else .03)
    spacing = (256 if medium else 64) / size
    sx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / (2 * spacing)
    sy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / (2 * spacing)
    norm = np.sqrt(1 + sx * sx + sy * sy)
    packed = np.stack([.5 - sx / norm * .5, .5 - sy / norm * .5,
                       np.clip(.5 + h * .055, 0, 1), np.clip(.91 + h * .015, .82, .98)])
    write_png(OUT / ('enceladus-medium-detail.png' if medium else 'enceladus-detail.png'), np.rint(packed * 255))


def main():
    OUT.mkdir(exist_ok=True)
    for name, expected in SOURCE_HASHES.items():
        if sha(CACHE / 'sources' / name) != expected:
            raise ValueError(f'Changed source: {name}')
    residual = geographic(CACHE / 'sources/dem.tif', WIDTH, HEIGHT) * 1000
    valid = np.isfinite(residual)
    residual = fill_gaps(residual)
    # Planetocentric radial distance to the triaxial figure, not a scalar offset.
    lon = np.deg2rad((np.arange(WIDTH) + .5) / WIDTH * 360)[None, :]
    lat = np.deg2rad(90 - (np.arange(HEIGHT) + .5) / HEIGHT * 180)[:, None]
    x, y, z = np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)
    figure = 1 / np.sqrt((x / AXES[0]) ** 2 + (y / AXES[1]) ** 2 + (z / AXES[2]) ** 2)
    heights = (residual + figure - RADIUS).astype('float32')
    path = CACHE / 'enceladus-radial.tif'
    with rasterio.open(path, 'w', driver='GTiff', width=WIDTH, height=HEIGHT, count=1,
                       dtype='float32', crs=f'+proj=longlat +R={RADIUS} +no_defs',
                       transform=from_bounds(0, -90, 360, 90, WIDTH, HEIGHT),
                       compress='deflate', tiled=True, nodata=-32768) as out:
        out.write(heights, 1)
    write_png(OUT / 'enceladus-terrain-coverage.png', (valid.reshape(512, 8, 1024, 8).mean(axis=(1, 3)) * 255))
    area = np.cos(lat)
    report = dict(schema=1, body='enceladus', sourceSha256=SOURCE_HASHES,
                  referenceRadiusMeters=RADIUS, referenceEllipsoidMeters=AXES,
                  sourceHeightUnits='kilometers', preparedHeightUnits='meters',
                  heightConversion='radial ellipsoid residual * 1000 + ellipsoid radius(direction) - 252100',
                  sourceSupportedFraction=float((valid * area).sum() / (area.sum() * WIDTH)),
                  coverageMeaning='Valid published stereo/shape-model coverage, not a per-pixel direct-measurement confidence map',
                  gapFill='bounded adjacent interpolation of residual only; measured samples unchanged',
                  minHeightMeters=float(heights.min()), maxHeightMeters=float(heights.max()),
                  preparedSha256=sha(path), width=WIDTH, height=HEIGHT,
                  sourceUrl='https://astrogeology.usgs.gov/search/map/enceladus-cassini-global-dem-200m-schenk')
    source = dict(product='cassini-schenk2024-radial-v1', file=path.name,
                  url='offline-prepared:build-enceladus.py', sha256=report['preparedSha256'],
                  width=WIDTH, height=HEIGHT, sourceWest=0, sourceScale=1, scaleMeters=1,
                  referenceRadiusMeters=RADIUS, sourceRadiusMeters=RADIUS,
                  sourceResolutionMeters=200, effectiveResolutionMeters=400,
                  hillshadeResolutionMeters=400,
                  sourceProjection='longlat', sourcePixelDegrees=360 / WIDTH,
                  maxZoom=5, sampleSize=129, frame='IAU_ENCELADUS / Schenk 2024',
                  verticalDatum='Radial meters above 252100 m sphere; Thomas 2016 triaxial figure restored',
                  credit='Schenk & McKinnon (2024) / LPI / NASA / JPL-Caltech / SSI; interpolated gaps',
                  sourceUrl=report['sourceUrl'], cacheSubdirectory='enceladus', adapterRevision=1,
                  coverageNotes='Global stereo/shape model; missing residuals interpolated. Geometry includes Thomas triaxial figure.',
                  license='Cite Schenk & McKinnon (2024), doi:10.1016/j.icarus.2023.115827')
    sources_path = ROOT / 'scripts/terrain-sources.json'
    sources = json.loads(sources_path.read_text())
    sources['enceladus'] = source
    sources_path.write_text(json.dumps(sources, indent=2) + '\n')

    # Reproject the high-resolution monochrome source; keep topographic image
    # contrast restrained rather than pretending its baked shadows are albedo.
    luminance = geographic(CACHE / 'sources/mosaic.tif', 4096, 2048, west=-180)
    luminance = fill_gaps(luminance)
    median = float(np.median(luminance))
    luminance = np.clip(.78 + .12 * np.log(np.maximum(luminance, median * .05) / median), .64, .88)
    with rasterio.open(CACHE / 'sources/color.jpg') as image:
        color = image.read(out_shape=(3, 2048, 4096), resampling=Resampling.bilinear).astype('float32') / 255
    # PIA18435 runs 0..360 E. The renderer's map runs -180..180 E.
    color = np.roll(color, 2048, axis=2)
    # The UV/IR composite is NOT converted to measured RGB. Its geography only
    # modulates an explicitly assumed near-neutral visible ice material by 2%.
    chroma = color / np.maximum(color.mean(axis=0), .03) - 1
    chroma = np.clip(chroma, -1, 1) * .02
    linear = np.clip(luminance[None] * (1 + chroma), 0, 1)
    srgb = np.rint(np.where(linear <= .0031308, linear * 12.92,
                           1.055 * linear ** (1 / 2.4) - .055) * 255).astype('uint8')
    # Longitude and poles are periodic in physical space; remove last-row noise.
    for row in [0, -1]:
        srgb[:, row, :] = np.rint(srgb[:, row, :].mean(axis=1))[:, None]
    with rasterio.Env(GDAL_PAM_ENABLED='NO'):
        write_png(OUT / 'enceladus-color-reference.png', srgb)
        raster_copy(OUT / 'enceladus-color-reference.png', OUT / 'enceladus-color.webp', driver='WEBP', LOSSLESS='YES')
    color_report = dict(schema=1, body='enceladus', width=4096, height=2048,
                        source='Cassini monochrome geography; inferred near-neutral visible ice with 2% composite-derived chroma',
                        sourceSha256=SOURCE_HASHES, longitude='east-positive-minus180-to180',
                        limitations='Reconstructed visible appearance, not calibrated global RGB. PIA18435 includes UV/IR. Monochrome image shading is compressed, not fully removed. No height inferred from brightness.',
                        linearLuminanceRange=[float(linear.min()), float(linear.max())],
                        deliveredSha256=sha(OUT / 'enceladus-color.webp'),
                        bytes=(OUT / 'enceladus-color.webp').stat().st_size)
    (OUT / 'enceladus-color.json').write_text(json.dumps(color_report, indent=2) + '\n')
    ice_detail()
    ice_detail(True)
    (CACHE / 'preparation.json').write_text(json.dumps(report, indent=2) + '\n')
    (OUT / 'enceladus-terrain.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2), flush=True)
    print(json.dumps(color_report, indent=2), flush=True)


if __name__ == '__main__':
    main()
