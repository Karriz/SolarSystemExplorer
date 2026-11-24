#!/usr/bin/env python3
"""Prepare Ganymede's geologically constrained global terrain and visible color.

No global measured numeric DEM is publicly distributed for Ganymede. This script
combines the USGS SIM 3237 global geologic map (Collins et al., 2013/2014) with
published Ganymede morphometry to construct a deterministic, body-fixed global
height field on the IAU 2015 2,631.2 km reference sphere. Image brightness is
never interpreted as elevation. Visible color reconstructs a natural brownish-
gray / bright-ice appearance from the 1 km monochrome mosaic, visible-band
chroma from the 1.435 km mosaic, and Galileo PIA00716 as an appearance constraint.
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
CACHE = ROOT / '.terrain-cache/ganymede'
OUT = ROOT / 'public/textures'
RADIUS = 2631200
SOURCE_RADIUS = 2632345.0
WIDTH, HEIGHT = 16384, 8192
UNITS = [
    'd', 'dc', 'dl',
    'l', 'lg1', 'lg2', 'lg3', 'li1', 'li2', 'li3', 'ls1', 'ls2', 'ls3', 'r',
    'c1', 'c2', 'c3', 'cu',
    'p', 'pi',
    'bi', 'br', 'bs',
]
DARK_IDS = [UNITS.index(u) + 1 for u in ['d', 'dc', 'dl']]
GROOVED_IDS = [UNITS.index(u) + 1 for u in ['lg1', 'lg2', 'lg3', 'r']]
BRIGHT_SUBDUED_IDS = [UNITS.index(u) + 1 for u in ['ls1', 'ls2', 'ls3', 'l']]
PALIMPSEST_IDS = [UNITS.index(u) + 1 for u in ['p', 'pi']]
BASIN_INTERIOR_ID = UNITS.index('bi') + 1
BASIN_RUGGED_ID = UNITS.index('br') + 1
BASIN_SMOOTH_ID = UNITS.index('bs') + 1


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


def unwrap_lines(reader):
    lines = []
    for feature in reader.shapeRecords():
        shape = feature.shape
        breaks = list(shape.parts) + [len(shape.points)]
        for a, b in zip(breaks[:-1], breaks[1:]):
            pts = np.asarray(shape.points[a:b], dtype='float64')
            if len(pts) < 2:
                continue
            pts[:, 0] = np.rad2deg(np.unwrap(np.deg2rad(pts[:, 0])))
            for shift in (-360.0, 0.0, 360.0):
                coords = pts.copy()
                coords[:, 0] += shift
                lines.append((dict(type='LineString', coordinates=coords.tolist()), 1))
    return lines


def raster_distance(lines, h=4096, w=8192):
    mask = rasterize(lines, out_shape=(h, w), transform=from_bounds(-180, -90, 180, 90, w, h),
                     dtype='uint8', all_touched=True)
    pad = 64
    padded = np.pad(mask, ((0, 0), (pad, pad)), mode='wrap')
    return distance_transform_edt(padded == 0)[:, pad:-pad].astype('float32')


def polygon_centroid(shape):
    pts = np.asarray(shape.points, dtype='float64')
    if len(pts) == 0:
        return None
    lons = np.deg2rad(pts[:, 0])
    lats = np.deg2rad(pts[:, 1])
    x = np.cos(lats) * np.cos(lons)
    y = np.cos(lats) * np.sin(lons)
    z = np.sin(lats)
    mx, my, mz = float(x.mean()), float(y.mean()), float(z.mean())
    norm = math.sqrt(mx * mx + my * my + mz * mz)
    if norm < 1e-12:
        return None
    mx, my, mz = mx / norm, my / norm, mz / norm
    return math.degrees(math.atan2(my, mx)), math.degrees(math.asin(max(-1.0, min(1.0, mz))))


def geology():
    """Extract SIM 3237 units, tectonic traces, craters, domes, depressions."""
    print('Extracting USGS SIM 3237 geologic constraints', flush=True)
    archive = zipfile.ZipFile(CACHE / 'sources/geology.zip')
    prefix = 'Ganymede_SIM3237_Database/Ganymede_Geology_SIM3237_Shapefiles/'

    def reader(rel):
        return shapefile.Reader(**{ext: io.BytesIO(archive.read(prefix + rel + '.' + ext))
                                   for ext in ['shp', 'shx', 'dbf']})

    units_r = reader('Ganymede_GlobalGeology_15M/GeologyUnits')
    polygons = []
    unit_counts = {}
    for rec in units_r.shapeRecords():
        code = rec.record['Unit']
        if code not in UNITS:
            continue
        unit_counts[code] = unit_counts.get(code, 0) + 1
        uid = UNITS.index(code) + 1
        try:
            polygons.append((rec.shape.__geo_interface__, uid))
        except Exception:
            pts = rec.shape.points
            breaks = list(rec.shape.parts) + [len(pts)]
            rings = [pts[a:b] for a, b in zip(breaks[:-1], breaks[1:]) if b - a >= 4]
            for ring in rings:
                if ring[0] != ring[-1]:
                    ring = list(ring) + [ring[0]]
                polygons.append((dict(type='Polygon', coordinates=[ring]), uid))
    units = rasterize(polygons, out_shape=(4096, 8192),
                      transform=from_bounds(-180, -90, 180, 90, 8192, 4096), dtype='uint8')

    grooves_r = reader('Ganymede_GlobalGeology_15M/GroovesRepresentative')
    furrows_r = reader('Ganymede_GlobalGeology_15M/Furrows')
    rims_r = reader('Ganymede_GlobalGeology_15M/CraterRims')
    groove_dist = raster_distance(unwrap_lines(grooves_r))
    furrow_dist = raster_distance(unwrap_lines(furrows_r))
    rim_dist = raster_distance(unwrap_lines(rims_r))

    craters = []
    for rec in reader('Ganymede_Mapped_Separates/mapped_crater_materials').shapeRecords():
        center = polygon_centroid(rec.shape)
        if center is None:
            continue
        diam_km = float(rec.record['Diameter'] or 0.0)
        if diam_km <= 0:
            area_km2 = float(rec.record['area'] or 0.0)
            diam_km = 2.0 * math.sqrt(max(area_km2, 100.0) / math.pi)
        craters.append(dict(
            lon=center[0], lat=center[1],
            diameterKm=diam_km,
            craterClass=str(rec.record['Class'] or '').strip(),
            age=str(rec.record['Global_map'] or 'UC').strip(),
            name=str(rec.record['Crater_nam'] or '').strip(),
        ))

    domes = [dict(lon=normalize_lon(s.shape.points[0][0]), lat=float(s.shape.points[0][1]))
             for s in reader('Ganymede_GlobalGeology_15M/Domes').shapeRecords() if s.shape.points]
    depressions = [dict(lon=normalize_lon(s.shape.points[0][0]), lat=float(s.shape.points[0][1]))
                   for s in reader('Ganymede_GlobalGeology_15M/Depressions').shapeRecords() if s.shape.points]

    palimpsests = []
    for rec in reader('Ganymede_Mapped_Separates/mapped_palimpsests').shapeRecords():
        center = polygon_centroid(rec.shape)
        if center is None:
            continue
        area_m2 = float(rec.record['Sph_Area'] or 0.0)
        diam_km = 2.0 * math.sqrt(max(area_m2, 1e9) / math.pi) / 1000.0
        palimpsests.append(dict(lon=center[0], lat=center[1], diameterKm=diam_km,
                                feature=str(rec.record['Feature'] or '').strip()))

    np.save(CACHE / 'geologic-units.npy', units)
    np.save(CACHE / 'groove-distance.npy', groove_dist)
    np.save(CACHE / 'furrow-distance.npy', furrow_dist)
    np.save(CACHE / 'rim-distance.npy', rim_dist)
    features = dict(
        source='Collins et al. (2013/2014), USGS SIM 3237',
        units=UNITS,
        unitPolygonCounts=unit_counts,
        grooveTraceCount=len(grooves_r),
        furrowTraceCount=len(furrows_r),
        craterRimTraceCount=len(rims_r),
        craters=craters,
        domes=domes,
        depressions=depressions,
        palimpsests=palimpsests,
    )
    (CACHE / 'geology.json').write_text(json.dumps(features, indent=2) + '\n')
    print(f'SIM 3237 extracted: {len(craters)} craters, {len(grooves_r)} grooves, {len(furrows_r)} furrows, {len(domes)} domes, {len(depressions)} depressions', flush=True)
    return units, groove_dist, furrow_dist, rim_dist, features


def sample_small(array, rows, cols, output_width=WIDTH, output_height=HEIGHT):
    yy = (rows + 0.5) / output_height * array.shape[0] - 0.5
    xx = (cols + 0.5) / output_width * array.shape[1] - 0.5
    return map_coordinates(array, np.broadcast_arrays(yy[:, None], xx[None, :]), order=1, mode='nearest')


def stamp_crater_layer(units, features):
    """Build deterministic spherical-distance relief for mapped craters, domes,
    depressions, Gilgamesh basin, and terrain-weighted background small craters."""
    h, w = 4096, 8192
    layer = np.zeros((h, w), dtype='float32')
    constraint_mask = np.zeros((h, w), dtype='float32')

    def stamp_disk(lon_deg, lat_deg, max_km, fn, mark_constraint=True):
        if max_km <= 0:
            return
        max_rad = max_km * 1000.0 / RADIUS
        lat_rad = math.radians(lat_deg)
        lon_rad = math.radians(lon_deg)
        cx, cy, cz = math.cos(lat_rad) * math.cos(lon_rad), math.cos(lat_rad) * math.sin(lon_rad), math.sin(lat_rad)
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
            if c1 - c0 >= w:
                col_indices = np.arange(w)
            else:
                col_indices = np.arange(c0, c1) % w
        rows = np.arange(r0, r1)
        lat_g = np.deg2rad(90.0 - (rows + 0.5) / h * 180.0)[:, None]
        lon_g = np.deg2rad(-180.0 + (col_indices + 0.5) / w * 360.0)[None, :]
        dot = np.cos(lat_g) * np.cos(lon_g) * cx + np.cos(lat_g) * np.sin(lon_g) * cy + np.sin(lat_g) * cz
        dist_km = np.arccos(np.clip(dot, -1.0, 1.0)) * (RADIUS / 1000.0)
        inside = dist_km <= max_km
        if not inside.any():
            return
        delta = fn(dist_km)
        patch = layer[np.ix_(rows, col_indices)]
        patch[inside] += delta[inside].astype('float32')
        layer[np.ix_(rows, col_indices)] = patch
        if mark_constraint:
            cm = constraint_mask[np.ix_(rows, col_indices)]
            cm[inside] = np.maximum(cm[inside], np.clip(1.0 - dist_km[inside] / max_km, 0.0, 1.0))
            constraint_mask[np.ix_(rows, col_indices)] = cm

    # 1. Gilgamesh multi-ring basin (centered ~62.8S, 125.0W = -125.0E)
    def gilgamesh_profile(r_km):
        # Inner smooth basin (~160 km radius), main rim/ring (~290 km), outer rugged rings (~450 km)
        basin = -1350.0 * np.exp(-((r_km / 185.0) ** 4))
        main_ring = 440.0 * np.exp(-(((r_km - 290.0) / 48.0) ** 2))
        outer_ring = 210.0 * np.exp(-(((r_km - 425.0) / 55.0) ** 2))
        inner_ring = 180.0 * np.exp(-(((r_km - 155.0) / 28.0) ** 2))
        return basin + main_ring + outer_ring + inner_ring
    stamp_disk(-125.0, -62.8, 620.0, gilgamesh_profile, mark_constraint=True)

    # 2. 869 mapped impact craters (Schenk 2002 icy crater morphometry)
    age_scale = {'C3': 1.0, 'C2': 0.72, 'C1': 0.45, 'UC': 0.55}
    for c in features['craters']:
        diam = max(18.0, min(c['diameterKm'], 240.0))
        rad = diam * 0.5
        af = age_scale.get(c['age'], 0.55)
        # Ganymede complex craters are shallower than lunar craters due to ice relaxation:
        # ~0.7 km at D=30 km, saturating near ~1.25 km at D=120-200 km for fresh C3.
        depth = (520.0 + 620.0 * (1.0 - math.exp(-diam / 65.0))) * af
        rim_h = depth * 0.34
        cls = c['craterClass']

        def crater_fn(r_km, rad=rad, depth=depth, rim_h=rim_h, cls=cls):
            u = r_km / rad
            # Flat-floored complex icy crater bowl
            bowl = -depth * np.exp(-(u / 0.84) ** 4.2)
            # Crisp rim crest with exponential ejecta taper
            rim = rim_h * np.exp(-((u - 1.02) / 0.19) ** 2)
            ejecta = (rim_h * 0.32) * np.where(u > 1.0, np.exp(-((u - 1.0) / 0.55)), 0.0)
            center = np.zeros_like(u)
            if cls == 'Peak':
                center = (depth * 0.36) * np.exp(-(u / 0.22) ** 2)
            elif cls in ('CD', 'AD'):
                center = (depth * 0.32) * np.exp(-(u / 0.30) ** 2)
            elif cls == 'CP':
                # Central pit surrounded by low pit rim
                center = (depth * 0.16) * np.exp(-((u - 0.22) / 0.10) ** 2) - (depth * 0.22) * np.exp(-(u / 0.13) ** 2)
            else:
                center = (depth * 0.14) * np.exp(-(u / 0.24) ** 2)
            taper = np.clip((2.4 - u) / 0.6, 0.0, 1.0)
            taper = taper * taper * (3.0 - 2.0 * taper)
            return (bowl + rim + ejecta + center) * taper

        stamp_disk(c['lon'], c['lat'], rad * 2.4, crater_fn, mark_constraint=True)

    # 3. 119 mapped central crater domes
    for d in features['domes']:
        stamp_disk(d['lon'], d['lat'], 24.0, lambda r: 190.0 * np.exp(-(r / 9.0) ** 2), mark_constraint=True)

    # 4. 33 mapped depressions / paterae
    for d in features['depressions']:
        stamp_disk(d['lon'], d['lat'], 32.0,
                   lambda r: -260.0 * np.exp(-(r / 11.0) ** 3) + 55.0 * np.exp(-((r - 14.0) / 4.5) ** 2),
                   mark_constraint=True)

    # 5. 54 mapped palimpsests (viscously relaxed, low-relief ancient scars)
    for p in features['palimpsests']:
        rad = max(35.0, min(p['diameterKm'] * 0.5, 220.0))
        stamp_disk(p['lon'], p['lat'], rad * 1.4,
                   lambda r, rad=rad: -95.0 * np.exp(-(r / (rad * 0.7)) ** 3) + 55.0 * np.exp(-((r - rad) / (rad * 0.22)) ** 2),
                   mark_constraint=True)

    # 6. Seeded sub-30 km background craters (density weighted by dark vs bright terrain)
    rng = np.random.default_rng(50301)
    dark_lookup = np.isin(units, DARK_IDS)
    n_candidates = 6500
    u_rand = rng.uniform(-1.0, 1.0, size=n_candidates)
    lats_bg = np.rad2deg(np.arcsin(u_rand))
    lons_bg = rng.uniform(-180.0, 180.0, size=n_candidates)
    # Power-law diameters 7..27 km
    diams_bg = 7.0 * (rng.uniform(0.0, 1.0, size=n_candidates) ** (-0.36))
    diams_bg = np.clip(diams_bg, 7.0, 27.0)
    keep_rand = rng.uniform(0.0, 1.0, size=n_candidates)
    bg_count = 0
    for lon_b, lat_b, diam_b, kr in zip(lons_bg, lats_bg, diams_bg, keep_rand):
        if abs(lat_b) > 84.0:
            continue
        ri = min(h - 1, max(0, int((90.0 - lat_b) / 180.0 * h)))
        ci = min(w - 1, max(0, int((lon_b + 180.0) / 360.0 * w)))
        is_dark = bool(dark_lookup[ri, ci])
        if not is_dark and kr > 0.32:
            continue
        bg_count += 1
        rad = diam_b * 0.5
        depth = (180.0 + 18.0 * diam_b) * (0.95 if is_dark else 0.85)
        rim_h = depth * 0.28
        stamp_disk(float(lon_b), float(lat_b), rad * 2.1,
                   lambda r, rad=rad, depth=depth, rim_h=rim_h: (
                       -depth * np.exp(-((r / (rad * 0.82)) ** 3.2))
                       + rim_h * np.exp(-(((r / rad) - 1.02) / 0.22) ** 2)
                   ) * np.clip((2.1 - r / rad) / 0.5, 0.0, 1.0),
                   mark_constraint=False)

    print(f'Crater/basin relief stamped ({len(features["craters"])} mapped + {bg_count} background craters)', flush=True)
    return layer, constraint_mask


def terrain(units, groove_dist, furrow_dist, rim_dist, features):
    print('Building Ganymede geologically constrained global terrain', flush=True)
    crater_layer, crater_mask = stamp_crater_layer(units, features)

    # Broad terrain elevation contrast: ancient dark terrain sits ~220 m higher
    # on average than younger tectonically resurfaced bright grooved terrain.
    dark_smooth = gaussian_filter(np.isin(units, DARK_IDS).astype('float32'), 5.0, mode=('nearest', 'wrap'))
    grooved_smooth = gaussian_filter(np.isin(units, GROOVED_IDS).astype('float32'), 2.5, mode=('nearest', 'wrap'))
    subdued_smooth = gaussian_filter(np.isin(units, BRIGHT_SUBDUED_IDS).astype('float32'), 2.5, mode=('nearest', 'wrap'))
    basin_rugged = gaussian_filter((units == BASIN_RUGGED_ID).astype('float32'), 2.0, mode=('nearest', 'wrap'))
    basin_interior = gaussian_filter((units == BASIN_INTERIOR_ID).astype('float32'), 2.0, mode=('nearest', 'wrap'))
    palimpsest_smooth = gaussian_filter(np.isin(units, PALIMPSEST_IDS).astype('float32'), 2.0, mode=('nearest', 'wrap'))

    # Seeded seamless 3D harmonic waves (body-fixed, continuous at poles & dateline)
    rng = np.random.default_rng(503)
    broad_waves = [(f, a, rng.normal(size=3), rng.uniform(0, 2 * np.pi))
                   for f, a in [(4, 240), (9, 175), (20, 110), (48, 65)]]
    rough_waves = [(f, a, rng.normal(size=3), rng.uniform(0, 2 * np.pi))
                   for f, a in [(110, 48), (240, 28), (520, 14), (1050, 7)]]
    sulcus_waves = [(f, a, rng.normal(size=3), rng.uniform(0, 2 * np.pi))
                    for f, a in [(190, 55), (340, 38), (620, 20)]]
    for lst in (broad_waves, rough_waves, sulcus_waves):
        for i in range(len(lst)):
            f, a, d, p = lst[i]
            lst[i] = (f, a, d / np.linalg.norm(d), p)

    meters_per_geol_px = 2.0 * math.pi * RADIUS / 8192.0
    cols = np.arange(WIDTH)
    lon = np.deg2rad(-180.0 + (cols + 0.5) / WIDTH * 360.0)[None, :]
    path = CACHE / 'ganymede-radial.tif'
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

            # Fade non-isotropic angular features cleanly toward the poles
            polar = np.clip((85.0 - np.abs(lat_deg)) / 10.0, 0.0, 1.0)[:, None]
            polar = (polar * polar * (3.0 - 2.0 * polar)).astype('float32')
            cos_lat = np.maximum(np.cos(lat), 0.12).astype('float32')

            # 1. Broad seamless planetary undulations
            height = np.zeros(x.shape, dtype='float32')
            for f, a, d, p in broad_waves:
                height += a * np.sin(f * (d[0] * x + d[1] * y + d[2] * z) + p)

            # 2. Unit-level regional relief offset (dark ancient crust higher than rifted bright bands)
            dark_w = sample_small(dark_smooth, rows, cols)
            grooved_w = sample_small(grooved_smooth, rows, cols)
            subdued_w = sample_small(subdued_smooth, rows, cols)
            rugged_w = sample_small(basin_rugged, rows, cols)
            b_int_w = sample_small(basin_interior, rows, cols)
            pal_w = sample_small(palimpsest_smooth, rows, cols)

            height += (210.0 * dark_w - 65.0 * grooved_w - 40.0 * subdued_w) * polar

            # 3. Mapped SIM 3237 tectonic grooves (bright grooved sulci ridges & troughs)
            # Scale angular pixel distance by sqrt(cos_lat) compromise so high-lat widths stay realistic
            gd_m = sample_small(groove_dist, rows, cols) * meters_per_geol_px * np.sqrt(cos_lat)
            groove_profile = (
                210.0 * np.exp(-((gd_m - 2600.0) / 1400.0) ** 2)
                - 170.0 * np.exp(-(gd_m / 1500.0) ** 2)
                + 85.0 * np.exp(-((gd_m - 6200.0) / 1800.0) ** 2)
            )
            height += groove_profile * (0.45 + 0.55 * grooved_w) * polar

            # 4. Mapped SIM 3237 furrows in ancient dark terrain (troughs + raised rims)
            fd_m = sample_small(furrow_dist, rows, cols) * meters_per_geol_px * np.sqrt(cos_lat)
            furrow_profile = (
                -175.0 * np.exp(-(fd_m / 2400.0) ** 2)
                + 70.0 * np.exp(-((fd_m - 5200.0) / 1800.0) ** 2)
            )
            height += furrow_profile * polar

            # 5. Mapped crater rim sharpness reinforcement from CraterRims.shp
            rd_m = sample_small(rim_dist, rows, cols) * meters_per_geol_px * np.sqrt(cos_lat)
            rim_boost = 115.0 * np.exp(-(rd_m / 2200.0) ** 2)
            height += rim_boost * polar

            # 6. Spherical-distance craters, domes, depressions, palimpsests & Gilgamesh
            craters_h = sample_small(crater_layer, rows, cols)
            height += craters_h * (0.25 + 0.75 * polar)

            # 7. Terrain-specific fine/medium 3D seamless relief
            rough = np.zeros(x.shape, dtype='float32')
            for f, a, d, p in rough_waves:
                rough += a * np.sin(f * (d[0] * x + d[1] * y + d[2] * z) + p)
            sulcus = np.zeros(x.shape, dtype='float32')
            for f, a, d, p in sulcus_waves:
                sulcus += a * np.cos(f * (d[0] * x + d[1] * y + d[2] * z) + p)
            # Ancient dark cratered & Gilgamesh rugged ring are rougher; bright subdued & basin interior smoother
            rough_scale = np.clip(0.55 + 0.75 * dark_w + 1.15 * rugged_w - 0.35 * subdued_w - 0.35 * b_int_w - 0.25 * pal_w, 0.22, 1.8)
            height += rough * rough_scale
            height += sulcus * grooved_w * (0.4 + 0.6 * polar)

            # Smoothly converge polar rows (>86 deg) to single polar elevation
            pole_blend = np.clip((np.abs(lat_deg) - 86.0) / 4.0, 0.0, 1.0)[:, None]
            if (pole_blend > 0).any():
                pole_blend = (pole_blend * pole_blend * (3.0 - 2.0 * pole_blend)).astype('float32')
                row_means = height.mean(axis=1, keepdims=True)
                height = height * (1.0 - pole_blend) + row_means * pole_blend

            assert np.isfinite(height).all()
            minimum = min(minimum, float(height.min()))
            maximum = max(maximum, float(height.max()))
            out.write(height, 1, window=Window(0, row, WIDTH, len(rows)))

            # Record SIM 3237 geologic feature-constraint density (NOT measured stereo DEM!)
            feat_support = np.maximum.reduce([
                sample_small(crater_mask, rows, cols),
                np.exp(-(gd_m / 6500.0) ** 2),
                np.exp(-(fd_m / 6500.0) ** 2),
                np.exp(-(rd_m / 5000.0) ** 2),
            ])
            coverage[row // 8:(row + len(rows)) // 8] = feat_support.reshape(len(rows) // 8, 8, 2048, 8).mean(axis=(1, 3))
            if row % 2048 == 0:
                print(f'Terrain rows {row} / {HEIGHT}', flush=True)

    # Guarantee exact constant single elevation at outermost polar rows
    with rasterio.open(path, 'r+') as out:
        for prow in (0, HEIGHT - 1):
            line = out.read(1, window=Window(0, prow, WIDTH, 1))
            line[:] = float(line.mean())
            out.write(line, 1, window=Window(0, prow, WIDTH, 1))

    write_png(OUT / 'ganymede-terrain-coverage.png', np.clip(coverage * 255.0, 0, 255))
    area_w = np.cos(np.deg2rad(90.0 - (np.arange(1024) + 0.5) / 1024.0 * 180.0))[:, None]
    constrained_frac = float(((coverage > 0.15) * area_w).sum() / (area_w.sum() * 2048))

    report = dict(
        schema=1,
        body='ganymede',
        referenceRadiusMeters=RADIUS,
        referenceFigure='IAU 2015 sphere (2,631.2 km; NAIF pck00011 BODY503_RADII)',
        width=WIDTH,
        height=HEIGHT,
        minHeightMeters=minimum,
        maxHeightMeters=maximum,
        measuredElevationFraction=0.0,
        geologicFeatureConstrainedFraction=constrained_frac,
        coverageMeaning='USGS SIM 3237 mapped feature constraint density (craters, grooves, furrows, Gilgamesh, palimpsests); 0% measured global stereo DEM',
        preparedSha256=sha(path),
        gapFill='Seed 503 global reconstruction constrained by USGS SIM 3237 geologic units, 869 mapped craters, 2283 groove traces, 909 furrow traces, 119 domes, 33 depressions, 54 palimpsests, and Gilgamesh basin; calibrated to Schenk icy-moon morphometry',
        seed=503,
        sourceFiles=json.load(open(CACHE / 'sources/sources.json')),
    )
    (OUT / 'ganymede-terrain.json').write_text(json.dumps(report, indent=2) + '\n')
    (CACHE / 'preparation.json').write_text(json.dumps(report, indent=2) + '\n')

    config_path = ROOT / 'scripts/terrain-sources.json'
    config = json.load(open(config_path))
    config['ganymede'] = dict(
        product='sim3237-reconstructed-v1',
        file=path.name,
        url='offline-prepared:build-ganymede.py',
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
        frame='IAU_GANYMEDE / SIM 3237 constrained',
        verticalDatum='Reconstructed meters above 2631200 m IAU sphere (no global measured DEM)',
        credit='USGS / NASA; Collins et al. (2013) SIM 3237; reconstructed global terrain',
        sourceUrl='https://pubs.usgs.gov/sim/3237/',
        cacheSubdirectory='ganymede',
        coverageNotes='No global measured numeric DEM exists; terrain is geologically constrained by USGS SIM 3237 mapped units, craters, grooves, furrows and basins.',
        license='USGS SIM 3237 public-domain geologic map',
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
    # Smoothly relax only missing pixels (e.g. polar imaging gaps) so EDT fill has no vertical streaks.
    for _ in range(48):
        smooth = gaussian_filter(out, 2.5, mode=('nearest', 'wrap'))
        out[missing] = smooth[missing]
    return out


def color():
    """Reconstruct natural brownish-gray / icy visible color for Ganymede."""
    print('Building Ganymede visible color reconstruction', flush=True)
    width, height = 4096, 2048
    dst_t = from_bounds(-180, -90, 180, 90, width, height)
    dst_crs = f'+proj=longlat +R={SOURCE_RADIUS} +no_defs'

    # 1. Reproject calibrated 1 km global monochrome mosaic for sharp geography
    mono = np.full((height, width), np.nan, dtype='float32')
    with rasterio.open(CACHE / 'sources/global-mono.tif') as src:
        reproject(rasterio.band(src, 1), mono, src_transform=src.transform, src_crs=src.crs,
                  src_nodata=src.nodata, dst_transform=dst_t, dst_crs=dst_crs,
                  dst_nodata=np.nan, resampling=Resampling.bilinear, num_threads=4)
        mono = mono * src.scales[0] + src.offsets[0]
    mono = fill_missing_wrap(mono)
    mono = np.clip(mono, 0.14, 0.92)

    # 2. Reproject 1.435 km 3-band mosaic (991 nm NIR, 559 nm G, 413 nm V)
    #    Extract smooth visible G/V chromatic variation away from monochrome polar fill.
    ms = np.full((3, height, width), np.nan, dtype='float32')
    with rasterio.open(CACHE / 'sources/global-color.tif') as src:
        for b in range(3):
            reproject(rasterio.band(src, b + 1), ms[b], src_transform=src.transform, src_crs=src.crs,
                      src_nodata=src.nodata, dst_transform=dst_t, dst_crs=dst_crs,
                      dst_nodata=np.nan, resampling=Resampling.bilinear, num_threads=4)
    has_chroma = np.isfinite(ms).all(axis=0) & ((np.nanmax(ms, axis=0) - np.nanmin(ms, axis=0)) > 2.5)
    # Visible G/V ratio (559 nm / 413 nm) measures real brownish-dust vs neutral-ice hue
    gv = np.where(has_chroma, (ms[1] + 4.0) / (ms[2] + 4.0), np.nan)
    gv_med = float(np.nanmedian(gv))
    gv_dev = np.where(has_chroma, np.clip((gv - gv_med) / 0.18, -1.0, 1.0), 0.0).astype('float32')
    gv_dev = gaussian_filter(gv_dev, 2.5, mode=('nearest', 'wrap'))

    lats = (90.0 - (np.arange(height) + 0.5) / height * 180.0)[:, None]
    # Smoothly fade multispectral cue before the ~60-70 deg monochrome polar fill boundary
    ms_lat_weight = np.clip((64.0 - np.abs(lats)) / 14.0, 0.0, 1.0)
    ms_lat_weight = (ms_lat_weight * ms_lat_weight * (3.0 - 2.0 * ms_lat_weight)).astype('float32')
    gv_dev *= ms_lat_weight

    # 3. Map calibrated reflectance into physically restrained linear albedo anchored
    #    to Ganymede's geometric albedo (~0.43) and Galileo PIA00716 natural color.
    #    Compress extreme baked shadows/highlights slightly while preserving clear
    #    dark Regio (Galileo/Marius) vs bright Sulci & fresh ray craters (Osiris/Tros).
    p5, p50, p95 = [float(x) for x in np.percentile(mono, [5, 50, 95])]
    albedo = np.clip(0.42 * ((mono / p50) ** 0.92), 0.14, 0.78)

    # Dark silicate-rich terrain is warm brownish-gray; bright grooved terrain is
    # pale tan/ivory; fresh icy craters and high-latitude frost caps are cooler/neutral.
    darkness = np.clip((0.56 - albedo) / 0.34, 0.0, 1.0)
    polar_frost = np.clip((np.abs(lats) - 42.0) / 28.0, 0.0, 1.0)
    polar_frost = (polar_frost * polar_frost * (3.0 - 2.0 * polar_frost)).astype('float32')

    # Warmth index constrained by PIA00716 (restrained natural brownish-gray, not orange)
    warmth = np.clip(0.24 + 0.56 * darkness + 0.16 * gv_dev - 0.34 * polar_frost, 0.02, 0.92)
    # Neutral reflectance (albedo) modulated by warm brownish-gray chromaticity ratios:
    # at warmth=0 (fresh frost/polar cap): [1.03, 1.00, 0.96]
    # at warmth=0.45 (grooved terrain):    [1.15, 1.00, 0.80]
    # at warmth=0.80 (dark Galileo Regio): [1.25, 0.99, 0.67]
    r_mul = 1.03 + 0.27 * warmth
    g_mul = 1.00 - 0.01 * warmth
    b_mul = 0.96 - 0.36 * warmth
    # Normalize channel weights so mean luminance matches calibrated albedo
    norm_mul = (r_mul + g_mul + b_mul) / 3.0
    rgb = np.stack([
        albedo * (r_mul / norm_mul),
        albedo * (g_mul / norm_mul),
        albedo * (b_mul / norm_mul),
    ])

    # Subtle brightness lift in polar frost caps (matching observed Galileo polar frost)
    rgb *= (1.0 + 0.06 * polar_frost)[None]

    # Smooth polar convergence above 85 deg to eliminate polar pinching
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

    write_png(OUT / 'ganymede-color-reference.png', srgb)
    with rasterio.Env(GDAL_PAM_ENABLED='NO'):
        raster_copy(OUT / 'ganymede-color-reference.png', OUT / 'ganymede-color.webp',
                    driver='WEBP', LOSSLESS='YES')

    report = dict(
        schema=1,
        body='ganymede',
        width=width,
        height=height,
        source='USGS 1 km Voyager/Galileo monochrome mosaic plus 559/413 nm visible chroma cue from 1.435 km mosaic',
        naturalColorReference='NASA/JPL PIA00716 Galileo natural-color global view; appearance constraint, not a calibrated global RGB product',
        colorModel='Calibrated monochrome albedo mapped to brownish-gray dark regolith, pale ivory grooved ice, cool bright ray craters and subtle polar frost caps, modulated by smooth G/V spectral variation away from monochrome polar fill',
        monoPercentiles=[p5, p50, p95],
        linearLuminanceRange=[float(linear.min()), float(linear.max())],
        limitations='Reconstructed visible color, not calibrated global three-band RGB. Source lighting remains partly baked into Voyager/Galileo mosaics. Polar chroma above ~60 deg is inferred due to monochrome polar fill in the USGS color mosaic.',
        deliveredSha256=sha(OUT / 'ganymede-color.webp'),
        bytes=(OUT / 'ganymede-color.webp').stat().st_size,
    )
    (OUT / 'ganymede-color.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f'Color complete: {(OUT / "ganymede-color.webp").stat().st_size} bytes', flush=True)


def detail():
    """Seeded periodic rocky-ice regolith detail (shading-only, body-fixed)."""
    size = 512
    for medium in (False, True):
        rng = np.random.default_rng(5030 + int(medium))
        freqs = np.fft.fftfreq(size) * size
        k = np.hypot(freqs[:, None], freqs[None, :])
        spectrum = np.fft.fft2(rng.normal(size=(size, size)))
        # Mix icy ridges with slightly rougher silicate-lag regolith pitting
        spectrum *= np.exp(-(k / (52 if medium else 135)) ** 2) / np.maximum(k, 2.0) ** 0.85
        h = np.fft.ifft2(spectrum).real
        h = h / h.std()
        # Add subtle periodic micro-pits (craters in regolith)
        n_pits = 28 if medium else 64
        yy, xx = np.mgrid[0:size, 0:size]
        for _ in range(n_pits):
            cy, cx = rng.uniform(0, size), rng.uniform(0, size)
            rad = rng.uniform(6.0, 22.0) if medium else rng.uniform(3.0, 11.0)
            dy = ((yy - cy + size / 2) % size) - size / 2
            dx = ((xx - cx + size / 2) % size) - size / 2
            u = np.hypot(dx, dy) / rad
            h += (-0.55 * np.exp(-(u / 0.85) ** 3.2) + 0.16 * np.exp(-((u - 1.05) / 0.22) ** 2))
        h = (h - h.mean()) / h.std()
        height = h * (0.42 if medium else 0.045)
        spacing = (256.0 if medium else 64.0) / size
        sx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) / (2.0 * spacing)
        sy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) / (2.0 * spacing)
        norm = np.sqrt(1.0 + sx * sx + sy * sy)
        packed = np.stack([
            0.5 - sx / norm * 0.5,
            0.5 - sy / norm * 0.5,
            np.clip(0.5 + h * 0.075, 0.0, 1.0),
            np.clip(0.92 + h * 0.02, 0.80, 0.99),
        ])
        name = 'ganymede-medium-detail.png' if medium else 'ganymede-detail.png'
        write_png(OUT / name, np.rint(packed * 255.0))
    print('Detail textures complete', flush=True)


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(exist_ok=True)
    spec = importlib.util.spec_from_file_location('ganymede_fetch', ROOT / 'scripts/fetch-ganymede.py')
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
        units = np.load(CACHE / 'geologic-units.npy')
        groove_dist = np.load(CACHE / 'groove-distance.npy')
        furrow_dist = np.load(CACHE / 'furrow-distance.npy')
        rim_dist = np.load(CACHE / 'rim-distance.npy')
        features = json.load(open(CACHE / 'geology.json'))
        terrain(units, groove_dist, furrow_dist, rim_dist, features)
        return
    units, groove_dist, furrow_dist, rim_dist, features = geology()
    color()
    detail()
    terrain(units, groove_dist, furrow_dist, rim_dist, features)


if __name__ == '__main__':
    main()
