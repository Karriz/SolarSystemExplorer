#!/usr/bin/env python3
"""Validate source-independent tile integrity, coverage, seams and nested samples."""
from functools import lru_cache
import gzip
import hashlib
import json
from pathlib import Path
import sys
import numpy as np

ROOT = Path(__file__).resolve().parents[1] / "public/terrain"


def validate(path):
    manifest = json.loads(path.read_text())
    size, scale = manifest["sampleSize"], manifest["scaleMeters"]
    index = dict(manifest["tiles"])
    for info in manifest.get("indexPages", {}).get("pages", {}).values():
        payload = (path.parent / info["url"]).read_bytes()
        assert len(payload) == info["bytes"] and hashlib.sha256(payload).hexdigest() == info["sha256"]
        page = json.loads(payload)
        assert not index.keys() & page.keys(), "Overlapping metadata pages"
        index.update(page)
    expected = sum(2 * 4 ** z for z in range(manifest["maxZoom"] + 1))
    assert len(index) == expected, "Incomplete tile pyramid"
    checked, total = set(), 0

    @lru_cache(maxsize=512)
    def tile_at(key):
        nonlocal total
        info = index[key]
        blob = (path.parent / "tiles" / (key + ".bin")).read_bytes()
        assert len(blob) == info["bytes"] and hashlib.sha256(blob).hexdigest() == info["sha256"], key
        raw = gzip.decompress(blob)
        assert len(raw) == size * size * 2, key
        values = np.frombuffer(raw, dtype="<i2").reshape(size, size)
        physical = np.where(values == manifest.get("noData"), 0, values).astype(float) * scale
        assert physical.min() == info["min"] and physical.max() == info["max"], key
        assert manifest["minHeightMeters"] <= info["min"] <= info["max"] <= manifest["maxHeightMeters"], key
        if key not in checked:
            total += len(blob)
            checked.add(key)
        return values

    for z in range(manifest["maxZoom"] + 1):
        columns, rows = 2 ** (z + 1), 2 ** z
        north, south = tile_at(f"{z}/0/0")[0, 0], tile_at(f"{z}/0/{rows - 1}")[-1, -1]
        for x in range(columns):
            for y in range(rows):
                key = f"{z}/{x}/{y}"
                tile = tile_at(key)
                assert np.array_equal(tile[:, -1], tile_at(f"{z}/{(x + 1) % columns}/{y}")[:, 0]), f"E/W seam: {key}"
                if y < rows - 1:
                    assert np.array_equal(tile[-1], tile_at(f"{z}/{x}/{y + 1}")[0]), f"N/S seam: {key}"
                if y == 0:
                    assert np.all(tile[0] == north), f"North pole: {key}"
                if y == rows - 1:
                    assert np.all(tile[-1] == south), f"South pole: {key}"
                if z:
                    parent = tile_at(f"{z - 1}/{x // 2}/{y // 2}")
                    r, c = (y % 2) * (size - 1) // 2, (x % 2) * (size - 1) // 2
                    assert np.array_equal(tile[::2, ::2], parent[r:r + size // 2 + 1, c:c + size // 2 + 1]), f"Parent alignment: {key}"
    assert len(checked) == expected
    print(f"Validated {manifest['body']}: {len(checked)} tiles ({total / 1e6:.1f} MB), hashes, bounds, all seams, poles, parent alignment", flush=True)


if __name__ == "__main__":
    paths = [Path(sys.argv[1])] if len(sys.argv) > 1 else [ROOT / p for p in json.loads((ROOT / "catalog.json").read_text())["bodies"].values()]
    for path in paths:
        validate(path)
