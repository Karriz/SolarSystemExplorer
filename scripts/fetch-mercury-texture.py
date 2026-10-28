#!/usr/bin/env python3
"""Assemble NASA Trek's documented geographic WMTS level 2 as a local fallback."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import urllib.request
import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.errors import NotGeoreferencedWarning
import warnings
warnings.filterwarnings('ignore', category=NotGeoreferencedWarning)
BASE = 'https://trek.nasa.gov/tiles/Mercury/EQ/Mercury_MESSENGER_MDIS_Basemap_EnhancedColor_Mosaic_Global_665m/1.0.0/default/default028mm'
ROOT = Path(__file__).resolve().parents[1]
cache = ROOT / '.terrain-cache/mercury-images'
cache.mkdir(parents=True, exist_ok=True)
image = np.zeros((3, 1024, 2048), dtype='uint8')

def load(address):
    x, y = address
    path = cache / f'2-{x}-{y}.jpg'
    if not path.exists():
        with urllib.request.urlopen(f'{BASE}/2/{y}/{x}.jpg', timeout=30) as response:
            path.write_bytes(response.read())
    with MemoryFile(path.read_bytes()) as memory:
        with memory.open() as dataset:
            tile = dataset.read()
    assert tile.shape == (3, 256, 256)
    return x, y, tile

with ThreadPoolExecutor(max_workers=4) as executor:
    for x, y, tile in executor.map(load, [(x, y) for x in range(8) for y in range(4)]):
        image[:, y * 256:(y + 1) * 256, x * 256:(x + 1) * 256] = tile
with rasterio.open(ROOT / 'public/textures/mercury.jpg', 'w', driver='JPEG', width=2048, height=1024, count=3, dtype='uint8', quality=92) as dataset:
    dataset.write(image)
print('Saved Mercury MESSENGER enhanced-color fallback (2048x1024)')
