#!/usr/bin/env python3
"""Prepare Titan's Corlies (2017) topography + constrained gap fill and inferred
neutral-light visible ground color (atmosphere orange stays in the atmosphere).

Authoritative 32 PPD Cassini RADAR altimetry, stereo DTM, and SARTopo pixels
(~8.67% of spherical area) are preserved over Corlies et al.'s (2017) global
4 PPD interpolated topography. Unmeasured gaps receive conservative Titan
landforms constrained by IAU/USGS nomenclature (hydrocarbon seas/lakes, icy
highland ridges, eroded craters, subtle equatorial dunes). Ground color is an
explicit neutral-light material reconstruction from Cassini ISS 938 nm geography
and mapped hydrocarbon seas/lakes; orange haze illumination is rendered
separately by the dense-atmosphere transport model.
"""
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import sys
import warnings
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
CACHE = ROOT / '.terrain-cache/titan'
OUT = ROOT / 'public/textures'
RADIUS = 2575000
WIDTH, HEIGHT = 16384, 8192


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write_png(path, array):
    if array.ndim == 2:
        array = array[None]
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', rasterio.errors.NotGeoreferencedWarning)
        with rasterio.Env(GDAL_PAM_ENABLED='NO'):
            with rasterio.open(path, 'w', driver='PNG', width=array.shape[2], height=array.shape[1],
                               count=array.shape[0], dtype='uint8') as out:
                out.write(array.astype('uint8'))


def normalize_lon(lon):
    return ((lon + 180.0) % 360.0) - 180.0


def shift_poly_to_180(shape):
    """Convert real multi-vertex (>10 pts) nomenclature polygon rings into -180..180 E GeoJSON.
    Skips 5-vertex rectangular bounding-box placeholders used by IAU/USGS."""
    pts = np.asarray(shape.points, dtype='float64')
    if len(pts) < 12:
        return []
    breaks = list(shape.parts) + [len(pts)]
    polys = []
    for a, b in zip(breaks[:-1], breaks[1:]):
        if b - a < 12:
            continue
        ring = pts[a:b].copy()
        ring[:, 0] = np.rad2deg(np.unwrap(np.deg2rad(ring[:, 0])))
        mean_lon = float(ring[:, 0].mean())
        base_shift = -360.0 if mean_lon > 180.0 else 0.0
        for extra in (-360.0, 0.0, 360.0):
            r = ring.copy()
            r[:, 0] += base_shift + extra
            if r[:, 0].max() < -180.0 or r[:, 0].min() > 180.0:
                continue
            coords = r.tolist()
            if coords[0] != coords[-1]:
                coords.append(coords[0])
            polys.append(dict(type='Polygon', coordinates=[coords]))
    return polys


def stamp_gaussian_mask(mask, lon_deg, lat_deg, rad_km):
    h, w = mask.shape
    max_km = rad_km * 2.2
    max_rad = max_km * 1000.0 / RADIUS
    lat_r, lon_r = math.radians(lat_deg), math.radians(lon_deg)
    cx, cy, cz = math.cos(lat_r) * math.cos(lon_r), math.cos(lat_r) * math.sin(lon_r), math.sin(lat_r)
    dlat = math.degrees(max_rad)
    r0 = max(0, int((90.0 - (lat_deg + dlat)) / 180.0 * h) - 1)
    r1 = min(h, math.ceil((90.0 - (lat_deg - dlat)) / 180.0 * h) + 1)
    if r1 <= r0:
        return
    rows = np.arange(r0, r1)
    lat_g = np.deg2rad(90.0 - (rows + 0.5) / h * 180.0)[:, None]
    lon_g = np.deg2rad(-180.0 + (np.arange(w) + 0.5) / w * 360.0)[None, :]
    dot = np.cos(lat_g) * np.cos(lon_g) * cx + np.cos(lat_g) * np.sin(lon_g) * cy + np.sin(lat_g) * cz
    dist_km = np.arccos(np.clip(dot, -1.0, 1.0)) * (RADIUS / 1000.0)
    g = np.exp(-((dist_km / max(rad_km, 10.0)) ** 2)).astype('float32')
    mask[r0:r1] = np.maximum(mask[r0:r1], g)


def extract_nomenclature():
    """Extract real multi-vertex Titan lakes/labyrinths and smooth mountain/crater footprints."""
    print('Extracting USGS/IAU Titan nomenclature features (excluding bbox placeholders)', flush=True)
    h, w = 2048, 4096
    transform = from_bounds(-180, -90, 180, 90, w, h)
    lake_polys, island_polys, mount_polys, laby_polys, dune_polys = [], [], [], [], []
    with zipfile.ZipFile(CACHE / 'sources/nomenclature-geoms.zip') as zf:
        r = shapefile.Reader(**{ext: io.BytesIO(zf.read('TITAN_nomenclature_poly.' + ext))
                                for ext in ['shp', 'shx', 'dbf']})
        for sr in r.shapeRecords():
            ftype = str(sr.record['type'])
            polys = shift_poly_to_180(sr.shape)
            if not polys:
                continue
            if ftype in ('Lacus, lacūs', 'Sinus, sinūs', 'Fretum, freta'):
                lake_polys.extend((p, 1) for p in polys)
            elif ftype == 'Insula, insulae':
                island_polys.extend((p, 1) for p in polys)
            elif ftype in ('Mons, montes', 'Collis, colles'):
                mount_polys.extend((p, 1) for p in polys)
            elif ftype == 'Labyrinthus, labyrinthi':
                laby_polys.extend((p, 1) for p in polys)
            elif ftype == 'Unda, undae':
                dune_polys.extend((p, 1) for p in polys)

    def rast(items):
        if not items:
            return np.zeros((h, w), dtype='float32')
        return rasterize(items, out_shape=(h, w), transform=transform, dtype='uint8').astype('float32')

    liquid = np.clip(rast(lake_polys) * (1.0 - rast(island_polys)), 0.0, 1.0)
    islands = rast(island_polys)
    mounts = rast(mount_polys)
    labys = rast(laby_polys)
    dunes = rast(dune_polys)

    craters = []
    with zipfile.ZipFile(CACHE / 'sources/nomenclature.zip') as zf:
        r = shapefile.Reader(**{ext: io.BytesIO(zf.read('TITAN_nomenclature_center_pts.' + ext))
                                for ext in ['shp', 'shx', 'dbf']})
        for rec in r.records():
            ftype = str(rec['type'])
            lon = normalize_lon(float(rec['center_lon']))
            lat = float(rec['center_lat'])
            diam = float(rec['diameter'] or 40.0)
            if ftype in ('Crater, craters', 'Large ringed feature'):
                craters.append(dict(name=str(rec['name']), lon=lon, lat=lat,
                                    diameterKm=max(20.0, diam), type=ftype))
            elif ftype in ('Mons, montes', 'Collis, colles'):
                stamp_gaussian_mask(mounts, lon, lat, max(25.0, min(diam * 0.4, 140.0)))
            elif ftype == 'Insula, insulae':
                stamp_gaussian_mask(islands, lon, lat, max(15.0, min(diam * 0.35, 80.0)))

    np.save(CACHE / 'liquid-mask.npy', liquid)
    np.save(CACHE / 'island-mask.npy', islands)
    np.save(CACHE / 'mount-mask.npy', mounts)
    np.save(CACHE / 'laby-mask.npy', labys)
    np.save(CACHE / 'dune-mask.npy', dunes)
    meta = dict(
        source='IAU / USGS Gazetteer of Planetary Nomenclature (Titan)',
        lakePolygonParts=len(lake_polys),
        islandPolygonParts=len(island_polys),
        mountPolygonParts=len(mount_polys),
        labyrinthPolygonParts=len(laby_polys),
        craters=craters,
    )
    (CACHE / 'nomenclature.json').write_text(json.dumps(meta, indent=2) + '\n')
    print(f'Extracted Titan nomenclature: {len(lake_polys)} true lake parts, {len(mount_polys)} true mount parts, {len(craters)} craters', flush=True)
    return liquid, islands, mounts, labys, dunes, meta


def sample_small(array, rows, cols, output_width=WIDTH, output_height=HEIGHT):
    yy = (rows + 0.5) / output_height * array.shape[0] - 0.5
    xx = (cols + 0.5) / output_width * array.shape[1] - 0.5
    return map_coordinates(array, np.broadcast_arrays(yy[:, None], xx[None, :]), order=1, mode='nearest')


def terrain(liquid, islands, mounts, labys, dunes, nom_meta):
    print('Building Titan Corlies (2017) + nomenclature-constrained global terrain', flush=True)
    zip_path = (CACHE / 'sources/corlies2017.zip').resolve()

    # 1. Load Corlies et al. (2017) 4 PPD global interpolated topography (base field)
    with rasterio.open(f'/vsizip/{zip_path}/topo_4PPD_interp.cub') as src:
        base_4ppd = src.read(1).astype('float32')
        assert base_4ppd.shape == (720, 1440) and np.isfinite(base_4ppd).all()

    # 2. Load and merge measured 32 PPD Cassini RADAR tracks in precision priority:
    #    altimetry (alt_32PPD) -> stereo DTM (dtm_32PPD) -> SARTopo (sar_32PPD)
    measured = np.full((5760, 11520), np.nan, dtype='float32')
    counts = {}
    for key, cube in [('sar', 'sar_32PPD.cub'), ('dtm', 'dtm_32PPD.cub'), ('alt', 'alt_32PPD.cub')]:
        with rasterio.open(f'/vsizip/{zip_path}/{cube}') as src:
            arr = src.read(1).astype('float32')
            valid = np.isfinite(arr) & (np.abs(arr) < 1e6)
            counts[key] = int(valid.sum())
            measured[valid] = arr[valid]
    valid_32 = np.isfinite(measured)
    lats_32 = 90.0 - (np.arange(5760) + 0.5) / 5760.0 * 180.0
    area_32 = np.cos(np.deg2rad(lats_32))[:, None]
    measured_fraction = float((valid_32 * area_32).sum() / (area_32.sum() * 11520))
    print(f'Corlies 32 PPD measured area fraction: {measured_fraction:.4%}', flush=True)

    # Compute residual relative to base_4ppd ONLY at measured pixels, and smooth
    # distance-based transition weight so measured interiors remain authoritative
    # while track edges blend seamlessly into the interpolated + reconstructed field.
    yy_base = (np.arange(5760) + 0.5) / 5760.0 * 720.0 - 0.5
    xx_base = (np.arange(11520) + 0.5) / 11520.0 * 1440.0 - 0.5
    base_32 = map_coordinates(base_4ppd, np.broadcast_arrays(yy_base[:, None], xx_base[None, :]), order=1, mode='nearest').astype('float32')
    residual_32 = np.where(valid_32, measured - base_32, 0.0).astype('float32')
    # Distance inside measured footprints (pixels at 32 PPD ~ 1.4 km)
    pad = 16
    dist_in = distance_transform_edt(np.pad(valid_32, ((1, 1), (pad, pad)), mode='wrap'))[1:-1, pad:-pad].astype('float32')
    # Outer 3 pixels (~4.2 km) of each track taper cleanly; interior stays 100% authoritative
    meas_weight_32 = np.clip(dist_in / 3.0, 0.0, 1.0)
    meas_weight_32 = (meas_weight_32 * meas_weight_32 * (3.0 - 2.0 * meas_weight_32)).astype('float32')
    # Save measured coverage PNG (1024 x 2048)
    cov_small = valid_32.astype('float32')
    yy_c = (np.arange(1024) + 0.5) / 1024.0 * 5760.0 - 0.5
    xx_c = (np.arange(2048) + 0.5) / 2048.0 * 11520.0 - 0.5
    cov_png = map_coordinates(cov_small, np.broadcast_arrays(yy_c[:, None], xx_c[None, :]), order=1, mode='nearest')
    write_png(OUT / 'titan-terrain-coverage.png', np.clip(cov_png * 255.0, 0, 255))

    # 3. Precompute smooth nomenclature landform masks at 2048 x 4096
    #    Combine true multi-vertex lakes with low polar Corlies sea basins (no bboxes!)
    yy_l = (np.arange(2048) + 0.5) / 2048.0 * 720.0 - 0.5
    xx_l = (np.arange(4096) + 0.5) / 4096.0 * 1440.0 - 0.5
    base_2k = map_coordinates(base_4ppd, np.broadcast_arrays(yy_l[:, None], xx_l[None, :]), order=1, mode='nearest')
    lats_2k = (90.0 - (np.arange(2048) + 0.5) / 2048.0 * 180.0)[:, None]
    polar_basin = ((lats_2k > 58.0) | (lats_2k < -68.0)) & (base_2k < -750.0)
    liquid_combined = np.maximum(liquid, polar_basin.astype('float32')) * (1.0 - islands)
    liquid_smooth = gaussian_filter(liquid_combined.astype('float32'), 2.0, mode=('nearest', 'wrap'))
    coast_dist = distance_transform_edt(np.pad(liquid_combined < 0.3, ((0, 0), (24, 24)), mode='wrap'))[:, 24:-24].astype('float32')
    coast_bluff = (liquid_combined < 0.3).astype('float32') * np.exp(-((coast_dist - 4.0) / 3.5) ** 2)
    island_smooth = gaussian_filter(islands.astype('float32'), 1.5, mode=('nearest', 'wrap'))
    mount_smooth = gaussian_filter(mounts.astype('float32'), 2.5, mode=('nearest', 'wrap'))
    laby_smooth = gaussian_filter(labys.astype('float32'), 2.0, mode=('nearest', 'wrap'))
    dune_smooth = gaussian_filter(dunes.astype('float32'), 3.0, mode=('nearest', 'wrap'))

    # 4. Stamp eroded Titan impact craters onto a 2048 x 4096 delta grid
    crater_delta = np.zeros((2048, 4096), dtype='float32')
    for c in nom_meta['craters']:
        diam = max(25.0, min(c['diameterKm'], 420.0))
        rad = diam * 0.5
        max_km = rad * 2.1
        max_rad = max_km * 1000.0 / RADIUS
        lat_r, lon_r = math.radians(c['lat']), math.radians(c['lon'])
        cx, cy, cz = math.cos(lat_r) * math.cos(lon_r), math.cos(lat_r) * math.sin(lon_r), math.sin(lat_r)
        dlat = math.degrees(max_rad)
        r0 = max(0, int((90.0 - (c['lat'] + dlat)) / 180.0 * 2048) - 1)
        r1 = min(2048, math.ceil((90.0 - (c['lat'] - dlat)) / 180.0 * 2048) + 1)
        if r1 <= r0:
            continue
        rows_c = np.arange(r0, r1)
        lat_g = np.deg2rad(90.0 - (rows_c + 0.5) / 2048.0 * 180.0)[:, None]
        lon_g = np.deg2rad(-180.0 + (np.arange(4096) + 0.5) / 4096.0 * 360.0)[None, :]
        dot = np.cos(lat_g) * np.cos(lon_g) * cx + np.cos(lat_g) * np.sin(lon_g) * cy + np.sin(lat_g) * cz
        dist_km = np.arccos(np.clip(dot, -1.0, 1.0)) * (RADIUS / 1000.0)
        u = dist_km / rad
        inside = u <= 2.1
        if not inside.any():
            continue
        # Eroded, sediment-infilled Titan crater profile (much shallower than lunar/Callisto)
        depth = 200.0 + 260.0 * (1.0 - math.exp(-diam / 110.0))
        rim_h = depth * 0.36
        delta = (-depth * np.exp(-(u / 0.85) ** 3.8) + rim_h * np.exp(-((u - 1.04) / 0.22) ** 2))
        taper = np.clip((2.1 - u) / 0.5, 0.0, 1.0)
        taper = taper * taper * (3.0 - 2.0 * taper)
        patch = crater_delta[r0:r1]
        patch[inside] += (delta * taper)[inside].astype('float32')
        crater_delta[r0:r1] = patch

    # 5. Stream-write 16,384 x 8,192 global Titan elevation GeoTIFF
    rng = np.random.default_rng(606)
    plain_waves = [(f, a, rng.normal(size=3), rng.uniform(0, 2 * np.pi))
                   for f, a in [(35, 38), (95, 24), (240, 14), (580, 7)]]
    ridge_waves = [(f, a, rng.normal(size=3), rng.uniform(0, 2 * np.pi))
                   for f, a in [(75, 130), (175, 85), (390, 42)]]
    for lst in (plain_waves, ridge_waves):
        for i in range(len(lst)):
            f, a, d, p = lst[i]
            lst[i] = (f, a, d / np.linalg.norm(d), p)

    cols = np.arange(WIDTH)
    lon = np.deg2rad(-180.0 + (cols + 0.5) / WIDTH * 360.0)[None, :]
    path = CACHE / 'titan-radial.tif'
    minimum, maximum = np.inf, -np.inf

    with rasterio.open(path, 'w', driver='GTiff', width=WIDTH, height=HEIGHT, count=1, dtype='float32',
                       crs=f'+proj=longlat +R={RADIUS} +no_defs', transform=from_bounds(-180, -90, 180, 90, WIDTH, HEIGHT),
                       compress='deflate', tiled=True, nodata=-32768) as out:
        for row in range(0, HEIGHT, 64):
            rows = np.arange(row, min(row + 64, HEIGHT))
            lat_deg = 90.0 - (rows + 0.5) / HEIGHT * 180.0
            lat = np.deg2rad(lat_deg)[:, None]
            x = np.cos(lat) * np.cos(lon)
            y = np.cos(lat) * np.sin(lon)
            z = np.sin(lat)

            polar = np.clip((85.0 - np.abs(lat_deg)) / 10.0, 0.0, 1.0)[:, None]
            polar = (polar * polar * (3.0 - 2.0 * polar)).astype('float32')

            base_h = sample_small(base_4ppd, rows, cols).astype('float32')
            meas_res = sample_small(residual_32, rows, cols).astype('float32')
            meas_w = np.clip(sample_small(meas_weight_32, rows, cols), 0.0, 1.0).astype('float32')
            gap_w = 1.0 - meas_w

            liq_w = np.clip(sample_small(liquid_smooth, rows, cols), 0.0, 1.0).astype('float32')
            bluff_w = sample_small(coast_bluff, rows, cols).astype('float32')
            isl_w = sample_small(island_smooth, rows, cols).astype('float32')
            mnt_w = sample_small(mount_smooth, rows, cols).astype('float32')
            laby_w = sample_small(laby_smooth, rows, cols).astype('float32')
            dune_w = sample_small(dune_smooth, rows, cols).astype('float32')
            crat_h = sample_small(crater_delta, rows, cols).astype('float32')

            plain = np.zeros(x.shape, dtype='float32')
            for f, a, d, p in plain_waves:
                plain += a * np.sin(f * (d[0] * x + d[1] * y + d[2] * z) + p)
            ridge = np.zeros(x.shape, dtype='float32')
            for f, a, d, p in ridge_waves:
                ridge += a * np.abs(np.sin(f * (d[0] * x + d[1] * y + d[2] * z) + p))

            # Subtle E-W linear dune ripples in equatorial dark dune fields (~25 m amplitude)
            eq_band = np.exp(-((lat_deg / 28.0) ** 2))[:, None].astype('float32')
            dune_ripples = (22.0 * np.sin(950.0 * z + 18.0 * np.sin(35.0 * x)) * np.clip(0.35 * eq_band + 0.65 * dune_w, 0.0, 1.0)).astype('float32')

            # Unmeasured landform delta (strictly zero inside hydrocarbon seas, zero where Corlies 32PPD measured!)
            land_w = 1.0 - liq_w
            gap_delta = (
                plain * (0.85 * land_w)
                + dune_ripples * land_w
                + (140.0 + ridge) * mnt_w * land_w
                + (0.55 * ridge - 90.0) * laby_w * land_w
                + 95.0 * bluff_w * polar
                + 150.0 * isl_w
                + crat_h * land_w * (0.3 + 0.7 * polar)
            )
            height = base_h + meas_res * meas_w + gap_delta * gap_w

            # Smooth polar convergence above 86 deg (only where unmeasured!)
            pole_blend = np.clip((np.abs(lat_deg) - 86.0) / 4.0, 0.0, 1.0)[:, None]
            if (pole_blend > 0).any():
                pole_blend = (pole_blend * pole_blend * (3.0 - 2.0 * pole_blend)).astype('float32') * gap_w
                row_means = height.mean(axis=1, keepdims=True)
                height = height * (1.0 - pole_blend) + row_means * pole_blend

            assert np.isfinite(height).all()
            minimum = min(minimum, float(height.min()))
            maximum = max(maximum, float(height.max()))
            out.write(height, 1, window=Window(0, row, WIDTH, len(rows)))
            if row % 2048 == 0:
                print(f'Terrain rows {row} / {HEIGHT}', flush=True)

    with rasterio.open(path, 'r+') as out:
        for prow in (0, HEIGHT - 1):
            line = out.read(1, window=Window(0, prow, WIDTH, 1))
            line[:] = float(line.mean())
            out.write(line, 1, window=Window(0, prow, WIDTH, 1))

    report = dict(
        schema=1,
        body='titan',
        referenceRadiusMeters=RADIUS,
        referenceFigure='2,575.0 km Corlies (2017) spherical datum (Corlies heights include Titan physical flattening/geoid relief; NAIF pck00011 BODY606 radii 2575.15/2574.78/2574.47 km)',
        width=WIDTH,
        height=HEIGHT,
        minHeightMeters=minimum,
        maxHeightMeters=maximum,
        measuredElevationFraction=measured_fraction,
        measuredPixelCounts32PPD=counts,
        coverageMeaning='Combined Cassini RADAR altimetry, stereo DTM, and SARTopo 32 PPD measurements from Corlies et al. (2017) (~8.67% of spherical area)',
        preparedSha256=sha(path),
        gapFill='Corlies et al. (2017) 4 PPD global interpolated topography preserved globally; authoritative 32 PPD tracks preserved in interior; conservative seed 606 Titan dunes, icy ridges, eroded craters, and flat seas/lakes applied only in unmeasured gaps',
        seed=606,
        sourceFiles=json.load(open(CACHE / 'sources/sources.json')),
    )
    (OUT / 'titan-terrain.json').write_text(json.dumps(report, indent=2) + '\n')
    (CACHE / 'preparation.json').write_text(json.dumps(report, indent=2) + '\n')

    config_path = ROOT / 'scripts/terrain-sources.json'
    config = json.load(open(config_path))
    config['titan'] = dict(
        product='corlies2017-completed-v1',
        file=path.name,
        url='offline-prepared:build-titan.py',
        sha256=report['preparedSha256'],
        width=WIDTH,
        height=HEIGHT,
        sourceWest=-180,
        sourceScale=1,
        scaleMeters=1,
        referenceRadiusMeters=RADIUS,
        sourceRadiusMeters=RADIUS,
        sourceProjection='longlat',
        sourcePixelDegrees=360.0 / WIDTH,
        sourceResolutionMeters=1400,
        maxZoom=6,
        sampleSize=129,
        frame='IAU_TITAN / Corlies 2017',
        verticalDatum='Radial meters above 2575000 m sphere (Corlies et al., 2017)',
        credit='Corlies et al. (2017) / Cassini RADAR / Cornell / USGS; reconstructed gaps',
        sourceUrl='https://doi.org/10.1002/2017GL075518',
        cacheSubdirectory='titan',
        coverageNotes=f'Cassini 32 PPD altimetry/DTM/SARTopo measures {measured_fraction:.2%} of spherical area; remaining terrain uses Corlies 2017 global interpolation plus conservative nomenclature-constrained landforms.',
        license='Cite Corlies et al. (2017), doi:10.1002/2017GL075518',
    )
    config_path.write_text(json.dumps(config, indent=2) + '\n')
    print(f'Terrain complete: range [{minimum:.1f}, {maximum:.1f}] m, sha256={report["preparedSha256"]}', flush=True)


def fill_missing_wrap(array):
    missing = ~np.isfinite(array)
    if not missing.any():
        return array
    pad = 48
    _, indices = distance_transform_edt(np.pad(missing, ((0, 0), (pad, pad)), mode='wrap'), return_indices=True)
    filled = np.pad(array, ((0, 0), (pad, pad)), mode='wrap')[tuple(indices)][:, pad:-pad]
    out = array.copy()
    out[missing] = filled[missing]
    for _ in range(36):
        smooth = gaussian_filter(out, 2.5, mode=('nearest', 'wrap'))
        out[missing] = smooth[missing]
    return out


def color(liquid):
    """Build Titan's inferred neutral-light visible ground reflectance.

    Atmosphere orange illumination is NOT baked here — the dense layered-haze
    atmosphere shader naturally colors Titan golden-orange from orbit and amber
    at the surface. Under neutral white light, bright highlands (Xanadu) are
    muted dirty water-ice bedrock, equatorial dune fields (Shangri-La/Belet/
    Senkyo) are dark hydrocarbon/organic sand, and mapped polar seas/lakes
    (Kraken/Ligeia/Punga Mare, Ontario Lacus) are very dark liquid methane.
    """
    print('Building Titan inferred neutral-light ground color', flush=True)
    width, height = 4096, 2048
    dst_t = from_bounds(-180, -90, 180, 90, width, height)
    dst_crs = f'+proj=longlat +R={RADIUS} +no_defs'

    iss = np.full((height, width), np.nan, dtype='float32')
    with rasterio.open(CACHE / 'sources/global-iss-4km.tif') as src:
        reproject(rasterio.band(src, 1), iss, src_transform=src.transform, src_crs=src.crs,
                  src_nodata=src.nodata, dst_transform=dst_t, dst_crs=dst_crs,
                  dst_nodata=np.nan, resampling=Resampling.bilinear, num_threads=4)
    iss = fill_missing_wrap(iss)
    p5, p50, p95 = [float(x) for x in np.percentile(iss, [5, 50, 95])]

    # Normalize 938 nm brightness into a restrained neutral-light terrain index (0..1)
    # 0 = dark organic dune seas; 1 = bright dirty water-ice highlands (Xanadu)
    t = np.clip((iss - p5) / max(p95 - p5, 1.0), 0.0, 1.0)
    # Linear surface reflectance under white light (low albedo consistent with Huygens DISR: ~0.09..0.34)
    albedo = 0.095 + 0.245 * (t ** 1.05)

    # Muted neutral-to-earthy icy bedrock vs dark carbonaceous/organic dune sand
    r_mul = 1.13 * (1.0 - t) + 1.05 * t
    g_mul = 0.99 * (1.0 - t) + 1.00 * t
    b_mul = 0.87 * (1.0 - t) + 0.94 * t
    norm_mul = (r_mul + g_mul + b_mul) / 3.0
    rgb = np.stack([
        albedo * (r_mul / norm_mul),
        albedo * (g_mul / norm_mul),
        albedo * (b_mul / norm_mul),
    ])

    # Hydrocarbon seas and lakes:
    # - North polar sea province (lat > 55 N): follow real dark Cassini ISS shorelines
    #   for Kraken Mare, Ligeia Mare, Punga Mare, and Jingpo Lacus.
    # - South pole: Titan has NO giant southern ocean (most dark south-polar ISS terrain
    #   is dry), only Ontario Lacus (~72 S, 177 E) plus small mapped lakes — so gate
    #   southern ISS liquid extraction tightly around Ontario Lacus's basin.
    # - Always include true multi-vertex IAU lakes and exclude mapped islands (e.g. Mayda Insula).
    lats_c = (90.0 - (np.arange(height) + 0.5) / height * 180.0)[:, None]
    lons_c = (-180.0 + (np.arange(width) + 0.5) / width * 360.0)[None, :]
    north_province = np.clip((lats_c - 55.0) / 5.0, 0.0, 1.0).astype('float32')
    iss_dark_north = np.clip((94.0 - iss) / 34.0, 0.0, 1.0)
    iss_dark_north = iss_dark_north * iss_dark_north * (3.0 - 2.0 * iss_dark_north)

    # Ontario Lacus local basin mask (72.0 S, 177.0 E, ~235 km long)
    lat_r = np.deg2rad(lats_c)
    lon_r = np.deg2rad(lons_c)
    o_lat, o_lon = np.deg2rad(-72.0), np.deg2rad(177.0)
    o_dot = (np.cos(lat_r) * np.cos(lon_r) * np.cos(o_lat) * np.cos(o_lon)
             + np.cos(lat_r) * np.sin(lon_r) * np.cos(o_lat) * np.sin(o_lon)
             + np.sin(lat_r) * np.sin(o_lat))
    o_dist_km = np.arccos(np.clip(o_dot, -1.0, 1.0)) * (RADIUS / 1000.0)
    ontario_win = np.clip((195.0 - o_dist_km) / 55.0, 0.0, 1.0).astype('float32')
    iss_dark_ontario = np.clip((55.0 - iss) / 30.0, 0.0, 1.0)
    iss_dark_ontario = iss_dark_ontario * iss_dark_ontario * (3.0 - 2.0 * iss_dark_ontario)

    islands_mask = np.load(CACHE / 'island-mask.npy') if (CACHE / 'island-mask.npy').exists() else np.zeros((height, width), dtype='float32')
    liq_soft = np.clip(
        np.maximum.reduce([
            north_province * iss_dark_north,
            ontario_win * iss_dark_ontario,
            gaussian_filter(liquid.astype('float32'), 1.2, mode=('nearest', 'wrap')),
        ]) * (1.0 - np.clip(islands_mask, 0.0, 1.0)),
        0.0, 1.0,
    )
    # Export 2048x1024 liquid sea/lake mask for the runtime specular hydrocarbon sea shader
    liq_mask_out = liq_soft.reshape(1024, 2, 2048, 2).mean(axis=(1, 3))
    write_png(OUT / 'titan-liquid-mask.png', np.rint(np.clip(liq_mask_out, 0.0, 1.0) * 255.0))
    sea_rgb = np.array([0.036, 0.041, 0.048], dtype='float32')[:, None, None]
    rgb = rgb * (1.0 - liq_soft[None]) + sea_rgb * liq_soft[None]

    # Smooth polar convergence above 85 deg
    for row in range(height):
        lat = abs(90.0 - (row + 0.5) / height * 180.0)
        if lat > 85.0:
            pole_row = 0 if row < height // 2 else -1
            u = (lat - 85.0) / 5.0
            w = u * u * (3.0 - 2.0 * u)
            pole_mean = rgb[:, pole_row].mean(axis=1)[:, None]
            rgb[:, row] = rgb[:, row] * (1.0 - w) + pole_mean * w

    linear = np.clip(rgb, 0.0, 1.0)
    srgb = np.rint(np.where(linear <= 0.0031308, linear * 12.92,
                            1.055 * (linear ** (1.0 / 2.4)) - 0.055) * 255.0).astype('uint8')
    for row in (0, -1):
        srgb[:, row] = np.rint(srgb[:, row].mean(axis=1))[:, None]

    write_png(OUT / 'titan-color-reference.png', srgb)
    with rasterio.Env(GDAL_PAM_ENABLED='NO'):
        raster_copy(OUT / 'titan-color-reference.png', OUT / 'titan-color.webp',
                    driver='WEBP', LOSSLESS='YES')

    report = dict(
        schema=1,
        body='titan',
        width=width,
        height=height,
        source='Cassini ISS 938 nm global 4 km mosaic (PIA19658) plus IAU/USGS hydrocarbon sea/lake boundaries with inferred neutral-light ground colors',
        colorModel='Explicit inferred neutral-light albedo (dirty water-ice highlands, dark organic dune fields, dark liquid hydrocarbon seas). Titan orange illumination is computed dynamically by the layered-haze atmosphere, not baked into surface reflectance.',
        issPercentiles=[p5, p50, p95],
        linearLuminanceRange=[float(linear.min()), float(linear.max())],
        limitations='No global measured visible RGB exists for Titan ground. Cassini ISS mosaic is 938 nm methane-window brightness, not visible color; Huygens DISR constrains local material darkness only and is not claimed as measured global RGB.',
        deliveredSha256=sha(OUT / 'titan-color.webp'),
        bytes=(OUT / 'titan-color.webp').stat().st_size,
    )
    (OUT / 'titan-color.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'Color complete: {(OUT / "titan-color.webp").stat().st_size} bytes', flush=True)


def detail():
    """Seeded periodic fluvial-eroded icy cobble & organic sediment detail (shading-only)."""
    size = 512
    for medium in (False, True):
        rng = np.random.default_rng(6060 + int(medium))
        freqs = np.fft.fftfreq(size) * size
        k = np.hypot(freqs[:, None], freqs[None, :])
        spectrum = np.fft.fft2(rng.normal(size=(size, size)))
        # Rounded sedimentary/fluvial-eroded pebble & dune ripples (softer than jagged airless rock)
        spectrum *= np.exp(-(k / (46 if medium else 120)) ** 2) / np.maximum(k, 2.0) ** 0.95
        h = np.fft.ifft2(spectrum).real
        h = h / h.std()
        # Subtle rounded cobble / gravel bumps
        yy, xx = np.mgrid[0:size, 0:size]
        for _ in range(36 if medium else 72):
            cy, cx = rng.uniform(0, size), rng.uniform(0, size)
            rad = rng.uniform(5.0, 18.0) if medium else rng.uniform(2.5, 9.0)
            dy = ((yy - cy + size / 2) % size) - size / 2
            dx = ((xx - cx + size / 2) % size) - size / 2
            u = np.hypot(dx, dy) / rad
            h += 0.35 * np.exp(-(u ** 2))
        h = (h - h.mean()) / h.std()
        height = h * (0.34 if medium else 0.036)
        spacing = (256.0 if medium else 64.0) / size
        sx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / (2.0 * spacing)
        sy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / (2.0 * spacing)
        norm = np.sqrt(1.0 + sx * sx + sy * sy)
        packed = np.stack([
            0.5 - sx / norm * 0.5,
            0.5 - sy / norm * 0.5,
            np.clip(0.5 + h * 0.065, 0.0, 1.0),
            np.clip(0.89 + h * 0.025, 0.78, 0.97),
        ])
        name = 'titan-medium-detail.png' if medium else 'titan-detail.png'
        write_png(OUT / name, np.rint(packed * 255.0))
    print('Detail textures complete', flush=True)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(exist_ok=True)
    spec = importlib.util.spec_from_file_location('titan_fetch', ROOT / 'scripts/fetch-titan.py')
    fetcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fetcher)
    for name, _, length, expected in fetcher.PRODUCTS:
        path = CACHE / 'sources' / name
        assert path.stat().st_size == length and sha(path) == expected, name
    if '--color-only' in sys.argv:
        color(np.load(CACHE / 'liquid-mask.npy'))
        return
    if '--detail-only' in sys.argv:
        detail()
        return
    if '--terrain-only' in sys.argv:
        terrain(
            np.load(CACHE / 'liquid-mask.npy'),
            np.load(CACHE / 'island-mask.npy'),
            np.load(CACHE / 'mount-mask.npy'),
            np.load(CACHE / 'laby-mask.npy'),
            np.load(CACHE / 'dune-mask.npy'),
            json.load(open(CACHE / 'nomenclature.json')),
        )
        return
    liquid, islands, mounts, labys, dunes, nom_meta = extract_nomenclature()
    color(liquid)
    detail()
    terrain(liquid, islands, mounts, labys, dunes, nom_meta)


if __name__ == '__main__':
    main()
