#!/usr/bin/env python3
"""Build verified, paged static terrain releases from explicit planetary adapters."""
import argparse
import errno
import gzip
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

try:
    import numpy as np
    import rasterio
    from rasterio.windows import Window
except ImportError:
    sys.exit("Install scripts/terrain-requirements.txt in .terrain-venv (see README).")

ROOT = Path(__file__).resolve().parents[1]
SOURCES = json.loads((ROOT / "scripts/terrain-sources.json").read_text())
CELLS, SIZE, PAGE_ZOOM = 64, 65, 3
NODATA = -32768


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".writing")
    temporary.write_text(json.dumps(value, separators=(",", ":")) + "\n")
    temporary.replace(path)


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class Raster:
    def __init__(self, source, cache, offline):
        self.source = source
        width, height = source["width"], source["height"]
        parts = source.get("files")
        if parts:
            for part in parts:
                path = cache / part["file"]
                if not path.exists() or path.stat().st_size != part["bytes"] or file_hash(path) != part["sha256"]:
                    raise ValueError(f"Missing or changed tiled source: {path}; run fetch-moon-global.py")
            fingerprint = hashlib.sha256(json.dumps(parts, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            if fingerprint != source["sha256"]:
                raise ValueError("Tiled-source fingerprint mismatch")
            path = cache / parts[0]["file"]
        else:
            path = cache / source["file"]
            if not path.exists():
                if offline:
                    raise ValueError(f"Missing cached source: {path}")
                print(f"Downloading {source['url']}", flush=True)
                temporary = path.with_suffix(path.suffix + ".download")
                with urllib.request.urlopen(source["url"], timeout=120) as response, temporary.open("wb") as target:
                    shutil.copyfileobj(response, target)
                temporary.replace(path)
            if file_hash(path) != source["sha256"]:
                raise ValueError(f"Source checksum changed: {path}; review the upstream product")
        normalized = cache / f"{source['product']}-{source['sha256'][:12]}-normalized-v1.npy"
        stats_path = normalized.with_suffix(".json")
        if not normalized.exists() or not stats_path.exists():
            temporary = normalized.with_suffix(".building.npy")
            output = np.lib.format.open_memmap(temporary, mode="w+", dtype="float32", shape=(height, width))
            minimum, maximum, missing = math.inf, -math.inf, 0
            dataset = None
            if path.suffix == ".IMG":
                if parts:
                    quadrants = [np.memmap(cache / p["file"], mode="r", dtype="<i2", shape=(height // 2, width // 2)) for p in parts]
                else:
                    if path.stat().st_size != width * height * 2:
                        raise ValueError("Incomplete lunar raster")
                    raw = np.memmap(path, mode="r", dtype="<i2", shape=(height, width))
            else:
                dataset = rasterio.open(path)
                projection = dataset.crs.to_dict()
                if dataset.shape != (height, width) or dataset.count != 1 or projection.get("proj") != "eqc":
                    raise ValueError("Unexpected source dimensions or projection")
                if abs(projection.get("lon_0", 0) - (source["sourceWest"] + 180)) > 1e-6:
                    raise ValueError("Unexpected source prime meridian")
                if abs(projection.get("R", projection.get("a", 0)) - source["sourceRadiusMeters"]) > 1:
                    raise ValueError("Unexpected source reference radius")
                if abs(dataset.scales[0] - source["sourceScale"]) > 1e-8 or dataset.offsets[0] != 0:
                    raise ValueError("Unexpected source scale/offset")
                if abs(dataset.bounds.top / source["sourceRadiusMeters"] - math.pi / 2) > 1e-4:
                    raise ValueError("Unexpected source geographic bounds")
            try:
                for row in range(0, height, 128):
                    count = min(128, height - row)
                    if parts:
                        # Rows are processed in aligned 128-row blocks; each
                        # approved 90-degree quadrant has 23,040 rows.
                        half = height // 2
                        if row % half + count > half:
                            raise ValueError("Normalization block crosses source quadrant")
                        pair = 0 if row < half else 2
                        block = np.concatenate([q[row % half:row % half + count] for q in quadrants[pair:pair+2]], axis=1)
                    else:
                        block = dataset.read(1, window=Window(0, row, width, count)) if dataset else raw[row:row + count]
                    block = block.astype("float32")
                    invalid = block == (dataset.nodata if dataset else NODATA)
                    block *= source["sourceScale"]
                    block[invalid] = np.nan
                    output[row:row + count] = block
                    if np.isfinite(block).any():
                        minimum = min(minimum, float(np.nanmin(block)))
                        maximum = max(maximum, float(np.nanmax(block)))
                    missing += int(invalid.sum())
            finally:
                if dataset:
                    dataset.close()
            output.flush()
            del output
            temporary.replace(normalized)
            write_json(stats_path, {"min": minimum, "max": maximum, "missingPixels": missing})
        self.data = np.load(normalized, mmap_mode="r")
        self.stats = json.loads(stats_path.read_text())
        # One physical pole, independent of longitude. Leave unobserved poles missing.
        self.poles = [float(np.nanmean(row)) if np.isfinite(row).any() else np.nan
                      for row in (self.data[0], self.data[-1])]

    def sample(self, lons, lats):
        height, width = self.data.shape
        x = ((lons - self.source["sourceWest"]) % 360) / 360 * width - .5
        y = np.clip((90 - lats) / 180 * height - .5, 0, height - 1)
        ix, iy = np.floor(x).astype(int), np.floor(y).astype(int)
        fx, fy = x - ix, y - iy
        result = np.zeros(np.broadcast_shapes(x.shape, y.shape))
        valid_weight = np.zeros_like(result)
        for dx, dy, weight in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)),
                               (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
            values = self.data[np.minimum(iy + dy, height - 1), (ix + dx) % width]
            valid = np.isfinite(values)
            result += np.where(valid, values, 0) * weight
            valid_weight += valid * weight
        result[valid_weight < .99999] = np.nan
        result = np.where(lats == 90, self.poles[0], result)
        result = np.where(lats == -90, self.poles[1], result)
        return result


def build(body, source, args):
    source_cache = args.cache
    if source.get("cacheSubdirectory") and source.get("files") and not (source_cache / source["files"][0]["file"]).exists():
        source_cache = source_cache / source["cacheSubdirectory"]
    raster = Raster(source, source_cache, args.offline)
    size = source.get("sampleSize", SIZE)
    cells = size - 1
    max_zoom = args.max_zoom if args.max_zoom is not None else source["maxZoom"]
    version = f"{source['product']}-{source['sha256'][:12]}-g{size}-z{max_zoom}-v3"
    if source.get("adapterRevision", 1) != 1:
        version += f"-r{source['adapterRevision']}"
    release = args.output / body / version
    if release.exists():
        previous = json.loads((release / "manifest.json").read_text())
        for key in ("frame", "verticalDatum", "referenceRadiusMeters", "scaleMeters", "sourceResolutionMeters", "credit", "sourceUrl"):
            if previous[key] != source[key]:
                raise ValueError("Adapter metadata changed; bump adapterRevision before publishing")
        print(f"Reusing immutable {body}/{version}", flush=True)
        return f"{body}/{version}/manifest.json"
    # Keep incomplete releases outside the web root and Vite's file watcher.
    staging = args.cache / "build" / f"{body}-{version}"
    staging.mkdir(parents=True, exist_ok=True)
    checkpoints = args.cache / "checkpoints" / version
    index, pages, total_bytes = {}, {}, 0
    units = source["scaleMeters"]
    for z in range(max_zoom + 1):
        span = 180 / 2 ** z
        chord = source["referenceRadiusMeters"] * (1 - math.cos(math.radians(span / cells) / math.sqrt(2)))
        for x in range(2 ** (z + 1)):
            directory = staging / "tiles" / str(z) / str(x)
            directory.mkdir(parents=True, exist_ok=True)
            lons = -180 + x * span + np.arange(size)[None, :] / cells * span
            checkpoint = checkpoints / str(z) / f"{x}.json"
            previous = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
            reusable = len(previous) == 2 ** z and all(
                (directory / f"{y}.bin").is_file() and (directory / f"{y}.bin").stat().st_size == info["bytes"]
                and file_hash(directory / f"{y}.bin") == info["sha256"] for y, info in previous.items())
            column = {}
            for y in range(2 ** z):
                key = f"{z}/{x}/{y}"
                if reusable:
                    info = previous[str(y)]
                    total_bytes += info["bytes"]
                    if z <= PAGE_ZOOM:
                        index[key] = info
                    else:
                        page = f"{x // 2 ** (z - PAGE_ZOOM)}/{y // 2 ** (z - PAGE_ZOOM)}"
                        pages.setdefault(page, {})[key] = info
                    continue
                lats = 90 - y * span - np.arange(size)[:, None] / cells * span
                heights = raster.sample(lons, lats)
                valid = np.isfinite(heights)
                quantized = np.rint(np.where(valid, heights, 0) / units)
                if (quantized < -32767).any() or (quantized > 32767).any():
                    raise ValueError("Height exceeds tile encoding range")
                values = quantized.astype("<i2")
                values[~valid] = NODATA
                decoded = np.where(valid, values.astype(float) * units, 0)
                actual = raster.sample((lons[:, :-1] + lons[:, 1:]) / 2, (lats[:-1] + lats[1:]) / 2)
                actual = np.nan_to_num(actual)
                predicted = (decoded[:-1, :-1] + decoded[1:, :-1] + decoded[:-1, 1:] + decoded[1:, 1:]) / 4
                error = float(np.max(np.abs(actual - predicted))) + chord + units
                payload = gzip.compress(values.tobytes(), compresslevel=3, mtime=0)
                (directory / f"{y}.bin").write_bytes(payload)
                total_bytes += len(payload)
                info = {"min": float(decoded.min()), "max": float(decoded.max()), "error": round(error, 2),
                        "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
                column[str(y)] = info
                if z <= PAGE_ZOOM:
                    index[key] = info
                else:
                    page = f"{x // 2 ** (z - PAGE_ZOOM)}/{y // 2 ** (z - PAGE_ZOOM)}"
                    pages.setdefault(page, {})[key] = info
            if not reusable:
                write_json(checkpoint, column)
        print(f"{body}: built level {z}, {total_bytes / 1e6:.1f} MB", flush=True)
    page_info = {}
    for key, tiles in pages.items():
        path = staging / "indices" / f"{key}.json"
        write_json(path, tiles)
        page_info[key] = {"url": f"indices/{key}.json", "bytes": path.stat().st_size, "sha256": file_hash(path)}
    manifest = {"schema": 2, "body": body, "version": version, "grid": "geographic-2x1", "sampleSize": size,
        "maxZoom": max_zoom, "encoding": "gzip-int16-le", "scaleMeters": units, "offsetMeters": 0, "noData": NODATA,
        "longitude": "east-positive-minus180-to180", "rowOrder": "north-to-south",
        "minHeightMeters": min(0, raster.stats["min"] - units), "maxHeightMeters": max(0, raster.stats["max"] + units),
        "missingPixels": raster.stats["missingPixels"], "gapRendering": "neutral reference sphere",
        "errorMetric": "estimated-midpoint-plus-chord", "license": "Public domain; cite source authors",
        "sourceSha256": source["sha256"], "tileUrl": "tiles/{z}/{x}/{y}.bin", "tiles": index,
        "indexPages": {"rootZoom": PAGE_ZOOM, "pages": page_info}, "tileBytes": total_bytes,
        **{key: source[key] for key in ("frame", "verticalDatum", "referenceRadiusMeters", "sourceResolutionMeters", "credit", "sourceUrl")}}
    if source.get("files"):
        manifest["sourceFiles"] = source["files"]
    if source.get("referenceSurfaceApproximation"):
        manifest["referenceSurfaceApproximation"] = True
    write_json(staging / "manifest.json", manifest)
    subprocess.run([sys.executable, str(ROOT / "scripts/validate-terrain.py"), str(staging / "manifest.json")], check=True)
    release.parent.mkdir(parents=True, exist_ok=True)
    try:
        staging.rename(release)
    except OSError as error:
        if error.errno != errno.EXDEV:
            raise
        # Custom output directories may be on another filesystem. Copy into an
        # unpublished name there, then expose the complete release atomically.
        copied = release.with_name(f".{version}.copying")
        if copied.exists():
            shutil.rmtree(copied)
        shutil.copytree(staging, copied)
        copied.rename(release)
        shutil.rmtree(staging)
    return f"{body}/{version}/manifest.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bodies", nargs="+", choices=SOURCES, default=list(SOURCES))
    parser.add_argument("--max-zoom", type=int, choices=range(0, 9))
    parser.add_argument("--cache", type=Path, default=ROOT / ".terrain-cache")
    parser.add_argument("--output", type=Path, default=ROOT / "public/terrain")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    catalog_path = args.output / "catalog.json"
    catalog = json.loads(catalog_path.read_text()) if catalog_path.exists() else {"schema": 1, "bodies": {}}
    for body in args.bodies:
        catalog["bodies"][body] = build(body, SOURCES[body], args)
        temporary = catalog_path.with_suffix(".json.tmp")
        write_json(temporary, catalog)
        temporary.replace(catalog_path)
        print(f"Published {body}", flush=True)


if __name__ == "__main__":
    main()
