#!/usr/bin/env python3
"""Build a photometrically corrected Mars color preview from MOC-WA.

The source is the USGS Mars Year 24-28 MOC-WA red/blue reflectance archive.
This pass averages selected solar-longitude bins across years, reprojects its
equatorial and polar maps to a global equirectangular raster, and synthesizes
green as the mean of red and blue. Source files and previews stay in the local
terrain cache; this does not publish a runtime texture.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.warp import reproject

ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / ".terrain-cache/mars-moc-wa/source"
PRODUCT = "https://asc-pds-individual-investigations.s3.us-west-2.amazonaws.com/mars_mgs_moc-wa_photometric-controls_robbins_2023/data"
RADIUS = 3_396_190.0
REGIONS = (("equatorial", "eq"), ("polarnorth", "np"), ("polarsouth", "sp"))
OFFLINE = False
KNOWN_MISSING: set[Path] = set()


def source_path(year: int, band: str, longitude: int, region: str, suffix: str) -> Path:
    name = f"MY{year}_{band.upper()}_Ls02_{longitude:03d}_{suffix}_75.tif"
    return SOURCE_ROOT / f"MY{year}" / band / region / name


def fetch(path: Path, year: int, band: str, longitude: int, region: str, suffix: str) -> bool:
    if path.exists() and path.stat().st_size > 0:
        try:
            with rasterio.open(path) as dataset:
                if dataset.count == 1 and dataset.width >= 100 and dataset.height >= 100:
                    return True
        except Exception:
            path.unlink(missing_ok=True)
    if OFFLINE:
        if path in KNOWN_MISSING:
            return False
        raise ValueError(f'Missing cached source {path}; run once without --offline')
    relative = f"{band}/incidence_75/{region}/Ls02/{path.name}"
    url = f"{PRODUCT}/{relative}"
    path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "SolarSystemExplorer-MOCWA/1.0"})
    error: Exception | None = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                expected = int(response.headers.get("Content-Length", "0"))
                with path.open("wb") as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
            if expected and path.stat().st_size != expected:
                raise IOError(f"Short MOC-WA download: {path}")
            with rasterio.open(path) as dataset:
                if dataset.count != 1 or dataset.width < 100 or dataset.height < 100:
                    raise ValueError(f"Unexpected MOC-WA raster dimensions: {path}")
            return True
        except urllib.error.HTTPError as caught:
            if caught.code == 404:
                path.unlink(missing_ok=True)
                return False
            error = caught
            path.unlink(missing_ok=True)
            if attempt < 4:
                time.sleep(2 ** attempt)
        except Exception as caught:
            error = caught
            path.unlink(missing_ok=True)
            if attempt < 4:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"Unable to fetch MOC-WA source {url}") from error


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def collect_band(years: list[int], band: str, longitudes: list[int], width: int, height: int) -> tuple[np.ndarray, np.ndarray, list[dict[str, str]]]:
    target_crs = f"+proj=eqc +lat_ts=0 +lon_0=0 +a={RADIUS} +b={RADIUS} +units=m +no_defs"
    transform = rasterio.transform.from_origin(-math.pi * RADIUS, math.pi * RADIUS / 2,
                                               2 * math.pi * RADIUS / width,
                                               math.pi * RADIUS / height)
    total = np.zeros((height, width), dtype=np.float32)
    weight = np.zeros((height, width), dtype=np.float32)
    provenance: list[dict[str, str]] = []
    for year in years:
        for longitude in longitudes:
            for region, suffix in REGIONS:
                path = source_path(year, band, longitude, region, suffix)
                if not fetch(path, year, band, longitude, region, suffix):
                    continue
                with rasterio.open(path) as source:
                    values = source.read(1)
                    destination = np.full((height, width), np.nan, dtype=np.float32)
                    reproject(source=values.astype(np.float32), destination=destination,
                              src_transform=source.transform, src_crs=source.crs,
                              src_nodata=0, dst_transform=transform, dst_crs=target_crs,
                              dst_nodata=np.nan, resampling=Resampling.bilinear)
                    covered = np.isfinite(destination)
                    total[covered] += destination[covered]
                    weight[covered] += 1
                provenance.append({"path": str(path.relative_to(ROOT)), "sha256": sha256(path)})
    result = np.full((height, width), np.nan, dtype=np.float32)
    valid = weight > 0
    result[valid] = total[valid] / weight[valid]
    return result, weight, provenance


def srgb(linear: np.ndarray) -> np.ndarray:
    linear = np.clip(linear, 0, 1)
    encoded = np.where(linear <= 0.0031308, linear * 12.92,
                       1.055 * np.power(linear, 1 / 2.4) - 0.055)
    return np.clip(np.rint(encoded * 255), 0, 255).astype(np.uint8)


def main() -> None:
    global OFFLINE, KNOWN_MISSING
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--years", default="25,26,27,28", help="comma-separated Mars years")
    parser.add_argument("--longitudes", default="34,124,214,304", help="comma-separated seasonal bins (0-358)")
    parser.add_argument("--width", type=int, default=4096)
    parser.add_argument("--download-workers", type=int, default=4)
    parser.add_argument("--offline", action="store_true", help="Use checksum-verified source files and missing coverage from the previous successful report")
    parser.add_argument("--output", type=Path, default=ROOT / ".terrain-cache/mars-moc-wa/mocwa-ls034.png")
    args = parser.parse_args()
    years = [int(value) for value in args.years.split(",")]
    longitudes = [int(value) for value in args.longitudes.split(",")]
    if not years or any(year < 24 or year > 28 for year in years):
        parser.error("years must be selected from 24 through 28")
    if not longitudes or any(value < 0 or value > 358 or value % 2 for value in longitudes):
        parser.error("longitudes must be even values from 0 through 358")
    width = args.width
    if width < 512 or width % 2:
        parser.error("width must be an even value of at least 512")
    height = width // 2
    jobs = [(year,band,longitude,region,suffix) for year in years for band in ('red','blue')
            for longitude in longitudes for region,suffix in REGIONS]
    if args.offline:
        previous = json.loads(args.output.with_suffix('.json').read_text())
        if previous['marsYears'] != years or previous['solarLongitudeDegrees'] != longitudes:
            raise ValueError('Offline selections must match the previous successful report')
        available = previous['redSources'] + previous['blueSources']
        for entry in available:
            path = ROOT / entry['path']
            if not path.exists() or sha256(path) != entry['sha256']:
                raise ValueError(f'Changed cached source {path}')
        KNOWN_MISSING = {source_path(*job) for job in jobs} - {ROOT / entry['path'] for entry in available}
        OFFLINE = True
    def prefetch(job):
        year,band,longitude,region,suffix = job
        result = fetch(source_path(*job),year,band,longitude,region,suffix)
        return result
    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=max(1,min(8,args.download_workers))) as pool:
        for i,_ in enumerate(pool.map(prefetch,jobs),1):
            if i % 12 == 0: print(f'Source files checked: {i}/{len(jobs)}',flush=True)
    source_seconds = time.perf_counter()-started
    print(f'Source preparation: {source_seconds:.1f}s',flush=True)
    red, red_weight, red_sources = collect_band(years, "red", longitudes, width, height)
    blue, blue_weight, blue_sources = collect_band(years, "blue", longitudes, width, height)
    with rasterio.open(ROOT / "public/textures/mars.jpg") as source:
        fallback = source.read(out_shape=(3, height, width), resampling=Resampling.lanczos).transpose(1, 2, 0)
    rgb = fallback.copy()
    valid = np.isfinite(red) & np.isfinite(blue)
    # Archive values are physical reflectance scaled by 2^17. Red and blue are
    # measured; green is explicitly synthetic, interpolated between them.
    r = red / 131072.0
    b = blue / 131072.0
    rgb[..., 0][valid] = srgb(r[valid])
    rgb[..., 1][valid] = srgb((r[valid] + b[valid]) * 0.5)
    rgb[..., 2][valid] = srgb(b[valid])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    target_crs = f"+proj=eqc +lat_ts=0 +lon_0=0 +a={RADIUS} +b={RADIUS} +units=m +no_defs"
    transform = rasterio.transform.from_origin(-math.pi * RADIUS, math.pi * RADIUS / 2,
                                               2 * math.pi * RADIUS / width,
                                               math.pi * RADIUS / height)
    with rasterio.open(args.output, "w", driver="PNG", width=width, height=height,
                       count=3, dtype="uint8", crs=target_crs, transform=transform) as output:
        output.write(rgb.transpose(2, 0, 1))
    report = {
        "schema": 1, "product": "Mars Year 24-28 MOC-WA Red and Blue 2023",
        "source": "https://astrogeology.usgs.gov/search/map/mars_year_24_28_moc_wa_red_and_blue_2023",
        "doi": "10.17189/kxff-cs44", "marsYears": years, "solarLongitudeDegrees": longitudes,
        "incidenceClipDegrees": 75, "width": width, "height": height,
        "validCoverageFraction": float(valid.mean()), "fallback": "public/textures/mars.jpg",
        "channels": {"red": "MOC-WA red reflectance", "green": "mean(red, blue), synthetic", "blue": "MOC-WA blue reflectance"},
        "redSources": red_sources, "blueSources": blue_sources,
        "output": str(args.output.resolve().relative_to(ROOT)), "outputSha256": sha256(args.output),
        "buildSeconds": time.perf_counter()-started, "sourcePreparationSeconds": source_seconds,
    }
    report_path = args.output.with_suffix(".json")
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: report[key] for key in ("marsYears", "solarLongitudeDegrees", "validCoverageFraction", "output", "outputSha256")}, indent=2))


if __name__ == "__main__":
    main()
