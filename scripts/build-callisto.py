#!/usr/bin/env python3
"""Prepare Callisto's nomenclature-constrained global terrain and visible color.

No global measured numeric DEM is publicly distributed for Callisto. This script
combines the official USGS/IAU Callisto planetary nomenclature (4 giant multi-ring
basins, 141 named craters, 8 crater chains) with published Callisto icy-crater
morphometry (Schenk 2002; Bray & Schenk 2024) and seeded ancient cratered plains
on the IAU 2015 2,410.3 km reference sphere. Image brightness is never interpreted
as elevation. Visible color reconstructs Callisto's characteristic dark brownish-
gray surface studded with bright excavated water-ice craters, anchored to Galileo
PIA03456.
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
from rasterio.shutil import copy as raster_copy
from rasterio.transform import from_bounds
from rasterio.warp import reproject
from rasterio.windows import Window
import shapefile
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/callisto'
OUT = ROOT / 'public/textures'
RADIUS = 2410300
SOURCE_RADIUS = 2409300.0488
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


def extract_features():
    """Load official USGS/IAU Callisto multi-ring basins, craters, and catenae."""
    print('Extracting USGS/IAU Callisto nomenclature features', flush=True)
    basins, craters, catenae = [], [], []
    with zipfile.ZipFile(CACHE / 'sources/nomenclature.zip') as zf:
        base = 'CALLISTO_nomenclature_center_pts'
        r = shapefile.Reader(**{ext: io.BytesIO(zf.read(base + '.' + ext)) for ext in ['shp', 'shx', 'dbf']})
        for rec in r.records():
            ftype = str(rec['type'])
            entry = dict(
                name=str(rec['name']),
                lon=normalize_lon(float(rec['center_lon'])),
                lat=float(rec['center_lat']),
                diameterKm=float(rec['diameter']),
                type=ftype,
            )
            if ftype == 'Large ringed feature':
                basins.append(entry)
            elif ftype == 'Crater, craters':
                craters.append(entry)

    # Extract exact polyline/polygon axes for all 8 crater chains (catenae)
    catena_geoms = {}
    with zipfile.ZipFile(CACHE / 'sources/nomenclature-geoms.zip') as zf:
        for base in ['CALLISTO_nomenclature_line_internal', 'CALLISTO_nomenclature_poly_internal']:
            r = shapefile.Reader(**{ext: io.BytesIO(zf.read(base + '.' + ext)) for ext in ['shp', 'shx', 'dbf']})
            for sr in r.shapeRecords():
                if str(sr.record['type']) != 'Catena, catenae':
                    continue
                name = str(sr.record['name'])
                pts = np.asarray(sr.shape.points, dtype='float64')
                if len(pts) < 2:
                    continue
                lons = np.rad2deg(np.unwrap(np.deg2rad(pts[:, 0])))
                lats = pts[:, 1]
                # Principal axis endpoints of the catena geometry
                pts_2d = np.column_stack([lons, lats])
                mean = pts_2d.mean(axis=0)
                centered = pts_2d - mean
                cov = np.cov(centered.T) if len(pts_2d) > 2 else np.eye(2)
                eigvals, eigvecs = np.linalg.eigh(cov)
                axis = eigvecs[:, -1]
                proj = centered @ axis
                p0 = pts_2d[int(np.argmin(proj))]
                p1 = pts_2d[int(np.argmax(proj))]
                catena_geoms[name] = dict(
                    name=name,
                    diameterKm=float(sr.record['diameter']),
                    start=[normalize_lon(float(p0[0])), float(p0[1])],
                    end=[normalize_lon(float(p1[0])), float(p1[1])],
                    center=[normalize_lon(float(sr.record['center_lon'])), float(sr.record['center_lat'])],
                )
    catenae = sorted(catena_geoms.values(), key=lambda c: c['name'])
    features = dict(
        source='IAU / USGS Gazetteer of Planetary Nomenclature (Callisto)',
        basins=sorted(basins, key=lambda b: -b['diameterKm']),
        craters=sorted(craters, key=lambda c: -c['diameterKm']),
        catenae=catenae,
    )
    (CACHE / 'nomenclature.json').write_text(json.dumps(features, indent=2) + '\n')
    print(f'Extracted {len(basins)} multi-ring basins, {len(craters)} named craters, {len(catenae)} catenae', flush=True)
    return features


def sample_small(array, rows, cols, output_width=WIDTH, output_height=HEIGHT):
    yy = (rows + 0.5) / output_height * array.shape[0] - 0.5
    xx = (cols + 0.5) / output_width * array.shape[1] - 0.5
    return map_coordinates(array, np.broadcast_arrays(yy[:, None], xx[None, :]), order=1, mode='nearest')


def build_feature_layer(features):
    """Build spherical-distance relief for Callisto's multi-ring basins, named
    craters, crater chains, and heavily cratered ancient icy plains."""
    h, w = 4096, 8192
    layer = np.zeros((h, w), dtype='float32')
    constraint_mask = np.zeros((h, w), dtype='float32')
    smooth_basin_mask = np.zeros((h, w), dtype='float32')

    def stamp_disk(lon_deg, lat_deg, max_km, fn, mark_constraint=True, mark_smooth=False):
        if max_km <= 0:
            return
        max_rad = max_km * 1000.0 / RADIUS
        lat_rad = math.radians(lat_deg)
        lon_rad = math.radians(lon_deg)
        cx = math.cos(lat_rad) * math.cos(lon_rad)
        cy = math.cos(lat_rad) * math.sin(lon_rad)
        cz = math.sin(lat_rad)
        dlat = math.degrees(max_rad)
        r0 = max(0, int((90.0 - (lat_deg + dlat)) / 180.0 * h) - 1)
        r1 = min(h, math.ceil((90.0 - (lat_deg - dlat)) / 180.0 * h) + 1)
        if r1 <= r0:
            return
        cos_min_lat = math.cos(math.radians(min(89.0, max(abs(lat_deg) + dlat, 0.0))))
        if abs(lat_deg) + dlat >= 85.0:
            col_indices = np.arange(w)
        else:
            dlon = math.degrees(max_rad) / max(cos_min_lat, 0.08)
            c0 = int(math.floor((lon_deg - dlon + 180.0) / 360.0 * w)) - 1
            c1 = int(math.ceil((lon_deg + dlon + 180.0) / 360.0 * w)) + 1
            col_indices = np.arange(w) if (c1 - c0 >= w) else (np.arange(c0, c1) % w)
        rows = np.arange(r0, r1)
        lat_g = np.deg2rad(90.0 - (rows + 0.5) / h * 180.0)[:, None]
        lon_g = np.deg2rad(-180.0 + (col_indices + 0.5) / w * 360.0)[None, :]
        px = np.cos(lat_g) * np.cos(lon_g)
        py = np.cos(lat_g) * np.sin(lon_g)
        pz = np.sin(lat_g)
        dot = px * cx + py * cy + pz * cz
        dist_km = np.arccos(np.clip(dot, -1.0, 1.0)) * (RADIUS / 1000.0)
        inside = dist_km <= max_km
        if not inside.any():
            return
        # Pass azimuth angle around center for subtle arcuate break-up in multi-ring basins
        az = np.arctan2(py * cx - px * cy, pz - cz * dot)
        delta = fn(dist_km, az)
        patch = layer[np.ix_(rows, col_indices)]
        patch[inside] += delta[inside].astype('float32')
        layer[np.ix_(rows, col_indices)] = patch
        if mark_constraint:
            cm = constraint_mask[np.ix_(rows, col_indices)]
            cm[inside] = np.maximum(cm[inside], np.clip(1.0 - dist_km[inside] / max_km, 0.0, 1.0))
            constraint_mask[np.ix_(rows, col_indices)] = cm
        if mark_smooth:
            sm = smooth_basin_mask[np.ix_(rows, col_indices)]
            sm[inside] = np.maximum(sm[inside], np.clip(1.0 - dist_km[inside] / (max_km * 0.25), 0.0, 1.0))
            smooth_basin_mask[np.ix_(rows, col_indices)] = sm

    # 1. Giant Multi-Ring Impact Basins (Valhalla, Asgard, Adlinda, Utgard)
    #    Callisto's multi-ring structures have viscously relaxed flat central
    #    palimpsests surrounded by broken concentric tectonic graben troughs & scarps.
    ring_configs = {
        'Valhalla': dict(pal_r=310.0, depth=430.0, rings=[380, 465, 560, 665, 780, 910, 1055, 1215, 1390], amp=185.0, width=22.0),
        'Asgard': dict(pal_r=175.0, depth=340.0, rings=[230, 310, 405, 515, 635], amp=165.0, width=18.0),
        'Adlinda': dict(pal_r=120.0, depth=290.0, rings=[165, 235, 315, 400], amp=145.0, width=16.0),
        'Utgard': dict(pal_r=95.0, depth=240.0, rings=[135, 195, 265], amp=125.0, width=14.0),
    }
    for b in features['basins']:
        cfg = ring_configs.get(b['name'])
        if not cfg:
            continue
        max_r = b['diameterKm'] * 0.56

        def basin_fn(r_km, az, cfg=cfg, max_r=max_r):
            out = -cfg['depth'] * np.exp(-((r_km / cfg['pal_r']) ** 4))
            # Subtle inner palimpsest rim
            out += (cfg['depth'] * 0.22) * np.exp(-(((r_km - cfg['pal_r'] * 1.05) / (cfg['pal_r'] * 0.16)) ** 2))
            for idx, rr in enumerate(cfg['rings']):
                # Arcuate modulation makes concentric rings look like fractured scarps/graben
                arc = 0.65 + 0.35 * np.sin(3.0 * az + idx * 1.9) * np.cos(5.0 * az - idx * 1.1)
                fade = math.exp(-0.65 * idx / max(len(cfg['rings']), 1))
                w_ring = cfg['width'] * (1.0 + 0.08 * idx)
                # Trough + raised outward-facing scarp shoulder
                out += arc * fade * cfg['amp'] * (
                    -np.exp(-(((r_km - rr) / w_ring) ** 2))
                    + 0.72 * np.exp(-(((r_km - (rr + w_ring * 1.45)) / (w_ring * 1.15)) ** 2))
                )
            taper = np.clip((max_r - r_km) / (max_r * 0.12), 0.0, 1.0)
            taper = taper * taper * (3.0 - 2.0 * taper)
            return out * taper

        stamp_disk(b['lon'], b['lat'], max_r, basin_fn, mark_constraint=True, mark_smooth=True)

    # 2. Seeded Heavily Cratered Ancient Plains (Callisto's defining morphology)
    #    ~8,500 craters spanning 6..85 km, attenuated inside smooth palimpsest centers.
    rng = np.random.default_rng(50401)
    n_bg = 8500
    u_rand = rng.uniform(-1.0, 1.0, size=n_bg)
    lats_bg = np.rad2deg(np.arcsin(u_rand))
    lons_bg = rng.uniform(-180.0, 180.0, size=n_bg)
    diams_bg = 6.5 * (rng.uniform(0.0, 1.0, size=n_bg) ** (-0.42))
    diams_bg = np.clip(diams_bg, 6.5, 85.0)
    age_bg = rng.uniform(0.35, 0.95, size=n_bg)
    bg_stamped = 0
    for lon_b, lat_b, diam_b, af in zip(lons_bg, lats_bg, diams_bg, age_bg):
        if abs(lat_b) > 84.5:
            continue
        ri = min(h - 1, max(0, int((90.0 - lat_b) / 180.0 * h)))
        ci = min(w - 1, max(0, int((lon_b + 180.0) / 360.0 * w)))
        pal_w = float(smooth_basin_mask[ri, ci])
        if pal_w > 0.45 and diam_b > 22.0:
            continue
        bg_stamped += 1
        rad = diam_b * 0.5
        # Bray & Schenk (2024): Callisto icy craters are shallower than lunar craters
        depth = (170.0 + 420.0 * (1.0 - math.exp(-diam_b / 48.0))) * float(af) * (1.0 - 0.55 * pal_w)
        rim_h = depth * 0.30
        has_dome = diam_b >= 45.0

        def bg_fn(r_km, az, rad=rad, depth=depth, rim_h=rim_h, has_dome=has_dome):
            u = r_km / rad
            bowl = -depth * np.exp(-(u / 0.84) ** 3.6)
            rim = rim_h * np.exp(-((u - 1.02) / 0.21) ** 2)
            center = (depth * 0.24) * np.exp(-(u / 0.27) ** 2) if has_dome else (depth * 0.14) * np.exp(-(u / 0.19) ** 2)
            taper = np.clip((2.1 - u) / 0.5, 0.0, 1.0)
            taper = taper * taper * (3.0 - 2.0 * taper)
            return (bowl + rim + center) * taper

        stamp_disk(float(lon_b), float(lat_b), rad * 2.1, bg_fn, mark_constraint=False)

    # 3. 141 IAU-Named Impact Craters (stamped atop background so prominent named
    #    craters like Heimdall, Lofn, Burr, Bran, Tindr, Doh, Har stay crisp)
    fresh_named = {'Heimdall', 'Lofn', 'Burr', 'Bran', 'Tindr', 'Doh', 'Har', 'Buri', 'Grimr', 'Oski', 'Reginn', 'Nidi'}
    for c in features['craters']:
        diam = max(14.0, min(c['diameterKm'], 230.0))
        rad = diam * 0.5
        is_fresh = c['name'] in fresh_named
        af = 1.0 if is_fresh else 0.78
        depth = (340.0 + 680.0 * (1.0 - math.exp(-diam / 60.0))) * af
        rim_h = depth * 0.34
        is_dome = diam >= 58.0

        def crater_fn(r_km, az, rad=rad, depth=depth, rim_h=rim_h, is_dome=is_dome, diam=diam):
            u = r_km / rad
            bowl = -depth * np.exp(-(u / 0.85) ** 4.2)
            rim = rim_h * np.exp(-((u - 1.02) / 0.18) ** 2)
            ejecta = (rim_h * 0.30) * np.where(u > 1.0, np.exp(-((u - 1.0) / 0.52)), 0.0)
            if diam >= 160.0:
                # Large central-ring / dome basin (Lofn, Heimdall)
                center = (depth * 0.25) * np.exp(-((u - 0.36) / 0.12) ** 2) + (depth * 0.18) * np.exp(-(u / 0.16) ** 2)
            elif is_dome:
                center = (depth * 0.34) * np.exp(-(u / 0.28) ** 2)
            else:
                center = (depth * 0.18) * np.exp(-((u - 0.19) / 0.09) ** 2) - (depth * 0.18) * np.exp(-(u / 0.11) ** 2)
            taper = np.clip((2.3 - u) / 0.55, 0.0, 1.0)
            taper = taper * taper * (3.0 - 2.0 * taper)
            return (bowl + rim + ejecta + center) * taper

        stamp_disk(c['lon'], c['lat'], rad * 2.3, crater_fn, mark_constraint=True)

    # 4. 8 Mapped Crater Chains (Catenae, e.g. Gipul Catena 641 km, Gomul Catena 343 km)
    for cat in features['catenae']:
        lon0, lat0 = cat['start']
        lon1, lat1 = cat['end']
        dlon = ((lon1 - lon0 + 180.0) % 360.0) - 180.0
        n_craters = max(6, min(18, int(round(cat['diameterKm'] / 32.0))))
        crater_diam = max(14.0, min(28.0, cat['diameterKm'] / max(n_craters * 0.85, 1.0)))
        rad = crater_diam * 0.5
        depth = 380.0 + 8.0 * crater_diam
        rim_h = depth * 0.30
        for i in range(n_craters):
            t = i / max(n_craters - 1, 1)
            clon = normalize_lon(lon0 + dlon * t)
            clat = lat0 + (lat1 - lat0) * t
            stamp_disk(clon, clat, rad * 2.0,
                       lambda r_km, az, rad=rad, depth=depth, rim_h=rim_h: (
                           -depth * np.exp(-((r_km / (rad * 0.82)) ** 3.4))
                           + rim_h * np.exp(-(((r_km / rad) - 1.02) / 0.22) ** 2)
                       ) * np.clip((2.0 - r_km / rad) / 0.45, 0.0, 1.0),
                       mark_constraint=True)

    print(f'Stamped {len(features["basins"])} basins, {len(features["craters"])} named craters, {len(features["catenae"])} catenae, {bg_stamped} background craters', flush=True)
    return layer, constraint_mask


def terrain(features):
    print('Building Callisto nomenclature-constrained global terrain', flush=True)
    feat_layer, feat_mask = build_feature_layer(features)

    rng = np.random.default_rng(504)
    broad_waves = [(f, a, rng.normal(size=3), rng.uniform(0, 2 * np.pi))
                   for f, a in [(4, 195), (9, 145), (20, 95), (46, 55)]]
    rough_waves = [(f, a, rng.normal(size=3), rng.uniform(0, 2 * np.pi))
                   for f, a in [(115, 52), (260, 32), (560, 16), (1100, 8)]]
    for lst in (broad_waves, rough_waves):
        for i in range(len(lst)):
            f, a, d, p = lst[i]
            lst[i] = (f, a, d / np.linalg.norm(d), p)

    cols = np.arange(WIDTH)
    lon = np.deg2rad(-180.0 + (cols + 0.5) / WIDTH * 360.0)[None, :]
    path = CACHE / 'callisto-radial.tif'
    coverage = np.zeros((1024, 2048), dtype='float32')
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

            height = np.zeros(x.shape, dtype='float32')
            for f, a, d, p in broad_waves:
                height += a * np.sin(f * (d[0] * x + d[1] * y + d[2] * z) + p)
            for f, a, d, p in rough_waves:
                height += a * np.sin(f * (d[0] * x + d[1] * y + d[2] * z) + p)

            height += sample_small(feat_layer, rows, cols) * (0.2 + 0.8 * polar)

            # Smooth polar convergence above 86 deg
            pole_blend = np.clip((np.abs(lat_deg) - 86.0) / 4.0, 0.0, 1.0)[:, None]
            if (pole_blend > 0).any():
                pole_blend = (pole_blend * pole_blend * (3.0 - 2.0 * pole_blend)).astype('float32')
                row_means = height.mean(axis=1, keepdims=True)
                height = height * (1.0 - pole_blend) + row_means * pole_blend

            assert np.isfinite(height).all()
            minimum = min(minimum, float(height.min()))
            maximum = max(maximum, float(height.max()))
            out.write(height, 1, window=Window(0, row, WIDTH, len(rows)))

            support = sample_small(feat_mask, rows, cols)
            coverage[row // 8:(row + len(rows)) // 8] = support.reshape(len(rows) // 8, 8, 2048, 8).mean(axis=(1, 3))
            if row % 2048 == 0:
                print(f'Terrain rows {row} / {HEIGHT}', flush=True)

    with rasterio.open(path, 'r+') as out:
        for prow in (0, HEIGHT - 1):
            line = out.read(1, window=Window(0, prow, WIDTH, 1))
            line[:] = float(line.mean())
            out.write(line, 1, window=Window(0, prow, WIDTH, 1))

    write_png(OUT / 'callisto-terrain-coverage.png', np.clip(coverage * 255.0, 0, 255))
    area_w = np.cos(np.deg2rad(90.0 - (np.arange(1024) + 0.5) / 1024.0 * 180.0))[:, None]
    constrained_frac = float(((coverage > 0.15) * area_w).sum() / (area_w.sum() * 2048))

    report = dict(
        schema=1,
        body='callisto',
        referenceRadiusMeters=RADIUS,
        referenceFigure='IAU 2015 sphere (2,410.3 km; NAIF pck00011 BODY504_RADII)',
        width=WIDTH,
        height=HEIGHT,
        minHeightMeters=minimum,
        maxHeightMeters=maximum,
        measuredElevationFraction=0.0,
        namedFeatureConstrainedFraction=constrained_frac,
        coverageMeaning='IAU/USGS named feature constraint footprints (Valhalla, Asgard, Adlinda, Utgard, 141 named craters, 8 catenae); 0% measured global stereo DEM',
        preparedSha256=sha(path),
        gapFill='Seed 504 global reconstruction constrained by IAU/USGS Callisto nomenclature (4 multi-ring basins, 141 craters, 8 catenae) plus heavily cratered ancient plains calibrated to Bray & Schenk (2024) icy-crater morphometry',
        seed=504,
        sourceFiles=json.load(open(CACHE / 'sources/sources.json')),
    )
    (OUT / 'callisto-terrain.json').write_text(json.dumps(report, indent=2) + '\n')
    (CACHE / 'preparation.json').write_text(json.dumps(report, indent=2) + '\n')

    config_path = ROOT / 'scripts/terrain-sources.json'
    config = json.load(open(config_path))
    config['callisto'] = dict(
        product='iau-nomenclature-reconstructed-v1',
        file=path.name,
        url='offline-prepared:build-callisto.py',
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
        sourceResolutionMeters=1000,
        maxZoom=6,
        sampleSize=129,
        frame='IAU_CALLISTO / Nomenclature constrained',
        verticalDatum='Reconstructed meters above 2410300 m IAU sphere (no global measured DEM)',
        credit='USGS / NASA / IAU; reconstructed heavily cratered terrain and multi-ring basins',
        sourceUrl='https://astrogeology.usgs.gov/search/map/callisto_galileo_voyager_global_mosaic_1km',
        cacheSubdirectory='callisto',
        coverageNotes='No global measured numeric DEM exists; terrain is constrained by IAU/USGS named multi-ring basins, craters and catenae plus seeded ancient cratered plains.',
        license='USGS public-domain mosaic and IAU/USGS planetary nomenclature',
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
    for _ in range(48):
        smooth = gaussian_filter(out, 2.5, mode=('nearest', 'wrap'))
        out[missing] = smooth[missing]
    return out


def color():
    """Reconstruct Callisto's dark brownish-gray surface and bright icy craters,
    anchored to Galileo PIA03456 natural color and ~0.22 geometric albedo."""
    print('Building Callisto visible color reconstruction', flush=True)
    width, height = 4096, 2048
    dst_t = from_bounds(-180, -90, 180, 90, width, height)
    dst_crs = f'+proj=longlat +R={SOURCE_RADIUS} +no_defs'

    mono = np.full((height, width), np.nan, dtype='float32')
    with rasterio.open(CACHE / 'sources/global-mono.tif') as src:
        reproject(rasterio.band(src, 1), mono, src_transform=src.transform, src_crs=src.crs,
                  src_nodata=src.nodata, dst_transform=dst_t, dst_crs=dst_crs,
                  dst_nodata=np.nan, resampling=Resampling.bilinear, num_threads=4)
    mono = fill_missing_wrap(mono)
    p5, p50, p95, p99 = [float(x) for x in np.percentile(mono, [5, 50, 95, 99])]

    # Map DN (median ~56, fresh icy craters up to ~220) to physically restrained
    # linear albedo: dark plains ~0.16-0.23, Valhalla/Asgard ~0.34-0.46, fresh
    # ice rays/craters (Burr, Lofn, Heimdall) ~0.55-0.76 (anchored to PIA03456).
    norm = np.clip(mono / p50, 0.35, 4.4)
    albedo = np.clip(0.215 * (norm ** 0.88), 0.11, 0.78)

    # Chromaticity directly informed by Galileo PIA03456 linear channel ratios:
    # dark/mid lag: [1.26, 0.98, 0.75] (deep charcoal brownish-gray)
    # bright ice scars: [1.05, 1.01, 0.94] (clean cool-neutral water ice)
    ice_mix = np.clip((albedo - 0.24) / 0.42, 0.0, 1.0)
    ice_mix = ice_mix * ice_mix * (3.0 - 2.0 * ice_mix)
    r_mul = 1.26 * (1.0 - ice_mix) + 1.05 * ice_mix
    g_mul = 0.98 * (1.0 - ice_mix) + 1.01 * ice_mix
    b_mul = 0.75 * (1.0 - ice_mix) + 0.94 * ice_mix
    norm_mul = (r_mul + g_mul + b_mul) / 3.0

    rgb = np.stack([
        albedo * (r_mul / norm_mul),
        albedo * (g_mul / norm_mul),
        albedo * (b_mul / norm_mul),
    ])

    # Smooth polar convergence above 85 deg
    for row in range(height):
        lat = abs(90.0 - (row + 0.5) / height * 180.0)
        if lat > 85.0:
            pole_row = 0 if row < height // 2 else -1
            t = (lat - 85.0) / 5.0
            w = t * t * (3.0 - 2.0 * t)
            pole_mean = rgb[:, pole_row].mean(axis=1)[:, None]
            rgb[:, row] = rgb[:, row] * (1.0 - w) + pole_mean * w

    linear = np.clip(rgb, 0.0, 1.0)
    srgb = np.rint(np.where(linear <= 0.0031308, linear * 12.92,
                            1.055 * (linear ** (1.0 / 2.4)) - 0.055) * 255.0).astype('uint8')
    for row in (0, -1):
        srgb[:, row] = np.rint(srgb[:, row].mean(axis=1))[:, None]

    write_png(OUT / 'callisto-color-reference.png', srgb)
    with rasterio.Env(GDAL_PAM_ENABLED='NO'):
        raster_copy(OUT / 'callisto-color-reference.png', OUT / 'callisto-color.webp',
                    driver='WEBP', LOSSLESS='YES')

    report = dict(
        schema=1,
        body='callisto',
        width=width,
        height=height,
        source='USGS 1 km Voyager/Galileo monochrome mosaic with Galileo PIA03456-informed visible color reconstruction',
        naturalColorReference='NASA/JPL PIA03456 Galileo natural-color global mosaic; appearance constraint, not a georeferenced global RGB source',
        colorModel='Dark brownish-gray non-ice lag transitioning to bright cool-neutral water-ice ejecta on bright impact scars, anchored to Callisto ~0.22 geometric albedo and PIA03456 chromaticity',
        monoPercentiles=[p5, p50, p95, p99],
        linearLuminanceRange=[float(linear.min()), float(linear.max())],
        limitations='No measured global RGB. Source illumination remains partly baked into Voyager/Galileo mosaic. Polar imaging gaps (~3.9%) use smooth diffusion fill.',
        deliveredSha256=sha(OUT / 'callisto-color.webp'),
        bytes=(OUT / 'callisto-color.webp').stat().st_size,
    )
    (OUT / 'callisto-color.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'Color complete: {(OUT / "callisto-color.webp").stat().st_size} bytes', flush=True)


def detail():
    """Seeded periodic dark dust-mantled icy knob & micro-crater detail (shading-only)."""
    size = 512
    for medium in (False, True):
        rng = np.random.default_rng(5040 + int(medium))
        freqs = np.fft.fftfreq(size) * size
        k = np.hypot(freqs[:, None], freqs[None, :])
        spectrum = np.fft.fft2(rng.normal(size=(size, size)))
        spectrum *= np.exp(-(k / (48 if medium else 128)) ** 2) / np.maximum(k, 2.0) ** 0.85
        h = np.fft.ifft2(spectrum).real
        h = h / h.std()
        # Heavily cratered sublimation-pitted icy regolith
        n_pits = 45 if medium else 96
        yy, xx = np.mgrid[0:size, 0:size]
        for _ in range(n_pits):
            cy, cx = rng.uniform(0, size), rng.uniform(0, size)
            rad = rng.uniform(6.0, 24.0) if medium else rng.uniform(3.0, 12.0)
            dy = ((yy - cy + size / 2) % size) - size / 2
            dx = ((xx - cx + size / 2) % size) - size / 2
            u = np.hypot(dx, dy) / rad
            h += (-0.62 * np.exp(-(u / 0.84) ** 3.2) + 0.20 * np.exp(-((u - 1.05) / 0.22) ** 2))
        h = (h - h.mean()) / h.std()
        height = h * (0.48 if medium else 0.05)
        spacing = (256.0 if medium else 64.0) / size
        sx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / (2.0 * spacing)
        sy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / (2.0 * spacing)
        norm = np.sqrt(1.0 + sx * sx + sy * sy)
        packed = np.stack([
            0.5 - sx / norm * 0.5,
            0.5 - sy / norm * 0.5,
            np.clip(0.5 + h * 0.085, 0.0, 1.0),
            np.clip(0.93 + h * 0.02, 0.82, 0.99),
        ])
        name = 'callisto-medium-detail.png' if medium else 'callisto-detail.png'
        write_png(OUT / name, np.rint(packed * 255.0))
    print('Detail textures complete', flush=True)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(exist_ok=True)
    spec = importlib.util.spec_from_file_location('callisto_fetch', ROOT / 'scripts/fetch-callisto.py')
    fetcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fetcher)
    for name, _, length, expected in fetcher.PRODUCTS:
        path = CACHE / 'sources' / name
        assert path.stat().st_size == length and sha(path) == expected, name
    if '--color-only' in sys.argv:
        color()
        return
    if '--detail-only' in sys.argv:
        detail()
        return
    if '--terrain-only' in sys.argv:
        features = json.load(open(CACHE / 'nomenclature.json'))
        terrain(features)
        return
    features = extract_features()
    color()
    detail()
    terrain(features)


if __name__ == '__main__':
    main()
