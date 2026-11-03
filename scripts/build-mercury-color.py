"""Build approximate visible RGB from final MESSENGER MDR measured bands.

Download only bands 2-4 (480, 560, 630 nm) with checked HTTP byte ranges.
No infrared, PCA color, display hillshade or per-channel contrast stretch.
The result is a visible-band approximation, not calibrated human-eye color.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import re
import time
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.shutil import copy as raster_copy
from rasterio.transform import from_bounds
from rasterio.warp import reproject

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://planetarydata.jpl.nasa.gov/img/data/messenger/msgrmds_5001/'
CACHE = ROOT / '.terrain-cache/mercury-color'
OUT = ROOT / 'public/textures'
WIDTH, HEIGHT = 4096, 2048


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch(url):
    with urllib.request.urlopen(url, timeout=90) as response:
        return response.read()


def number(label, name):
    return float(re.search(r'^\s*' + re.escape(name) + r'\s*=\s*([-+\d.eE]+)', label, re.M)[1])


def prepare(relative):
    directory = CACHE / relative.split('/')[1]
    directory.mkdir(parents=True, exist_ok=True)
    name = Path(relative).stem
    original = directory / f'{name}.original.lbl'
    if not original.exists():
        original.write_bytes(fetch(BASE + relative))
    label = original.read_text()
    assert 'PRODUCT_VERSION_ID             = "4"' in label
    assert 'BAND_SEQUENTIAL' in label and 'PC_REAL' in label
    assert number(label, 'SAMPLE_BITS') == 32 and number(label, 'A_AXIS_RADIUS') == 2439.4
    names = re.search(r'BAND_NAME\s*=\s*\((.*?)\)', label, re.S)[1]
    assert re.findall(r'"([^"]+)"', names)[:4] == [
        'WAC FILTER 6 430 BP 40', 'WAC FILTER 3 480 BP 10',
        'WAC FILTER 4 560 BP 5', 'WAC FILTER 5 630 BP 5']
    lines, samples = int(number(label, 'LINES')), int(number(label, 'LINE_SAMPLES'))
    plane = lines * samples * 4
    start, end = plane, plane * 4 - 1
    expected = int(number(label, 'RECORD_BYTES') * number(label, 'FILE_RECORDS'))
    raw = directory / f'{name}.visible.f32'
    metadata = raw.with_suffix('.json')
    valid = False
    if raw.exists() and metadata.exists():
        info = json.loads(metadata.read_text())
        valid = raw.stat().st_size == plane * 3 and sha(raw) == info['sha256'] and info['labelSha256'] == sha(original)
    if not valid:
        url = BASE + relative.replace('.LBL', '.IMG')
        request = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}'})
        temp = raw.with_suffix('.downloading')
        with urllib.request.urlopen(request, timeout=180) as response:
            assert response.status == 206, 'Server must honor partial requests'
            assert response.headers.get('Content-Range') == f'bytes {start}-{end}/{expected}'
            with temp.open('wb') as stream:
                count = 0
                while block := response.read(1024 * 1024):
                    count += len(block)
                    if count > plane * 3:
                        raise ValueError('Oversized PDS band response')
                    stream.write(block)
            assert count == plane * 3, 'Truncated PDS visible bands'
            info = dict(url=url, byteRange=[start, end], sourceBytes=expected,
                        etag=response.headers.get('ETag'), lastModified=response.headers.get('Last-Modified'),
                        labelSha256=sha(original), sha256=sha(temp), bytes=count)
        temp.replace(raw)
        metadata.write_text(json.dumps(info, indent=2) + '\n')
    # A derived detached label keeps the original projection and numeric NoData.
    derived = label.replace(f'"{name}.IMG"', f'"{raw.name}"')
    derived = re.sub(r'(BANDS\s*=\s*)17', r'\g<1>3', derived)
    derived = re.sub(r'BAND_NAME\s*=\s*\(.*?\)', 'BAND_NAME = ("480 nm", "560 nm", "630 nm")', derived, flags=re.S)
    derived = re.sub(r'(FILE_RECORDS\s*=\s*)\d+', lambda m: m[1] + str(lines * 3), derived)
    path = directory / f'{name}.visible.lbl'
    path.write_text(derived)
    print(name, raw.stat().st_size, 'bytes verified', flush=True)
    return path, info


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--fetch-only', action='store_true')
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    index = CACHE / 'index.json'
    if not index.exists():
        labels = []
        for chart in range(1, 16):
            directory = f'MDR/H{chart:02}/'
            listing = fetch(BASE + directory).decode()
            labels.extend(directory + name for name in sorted(set(re.findall(r'href="(MDIS_MDR_064PPD_H[0-9]{2}[A-Z]{2}4\.LBL)"', listing))))
        assert len(labels) == 54, 'Expected the standard final 64 ppd archive'
        labels.append('MDR/H15/MDIS_MDR_064PPD_2700_H15SP4.LBL')
        index.write_text(json.dumps(labels, indent=2) + '\n')
    labels = json.loads(index.read_text())
    assert len(labels) == 55 and len(set(labels)) == 55
    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        sources = list(pool.map(prepare, labels))
    if args.fetch_only:
        return
    # All sources are projected directly into the same planetocentric global grid.
    # Polar MDRs are stereographic; GDAL uses their original PDS projection labels.
    crs = '+proj=longlat +R=2439400 +no_defs'
    transform = from_bounds(-180, -90, 180, 90, WIDTH, HEIGHT)
    mosaic = np.full((3, HEIGHT, WIDTH), np.nan, dtype='float32')
    source_records = []
    # The documented 2700 m/px south-polar variant fills gaps first; valid
    # standard 665 m/px pixels then replace it wherever they exist.
    sources.sort(key=lambda item: '_2700_' not in item[0].name)
    resolution = np.zeros((HEIGHT, WIDTH), dtype='uint16')
    for path, info in sources:
        with rasterio.open(path) as dataset:
            assert dataset.count == 3 and dataset.crs is not None
            projected = np.full_like(mosaic, np.nan)
            reproject(rasterio.band(dataset, [3, 2, 1]), projected,
                      src_transform=dataset.transform, src_crs=dataset.crs, src_nodata=dataset.nodata,
                      dst_transform=transform, dst_crs=crs, dst_nodata=np.nan,
                      resampling=Resampling.average, num_threads=2)
            # Exclude polar disk corners beyond their intended chart, and don't
            # allow overlaps to replace valid measured color with missing data.
            lat = 90 - (np.arange(HEIGHT) + .5) * 180 / HEIGHT
            if 'H01' in path.name:
                projected[:, lat < 65, :] = np.nan
            elif 'H15' in path.name:
                projected[:, lat > -65, :] = np.nan
            valid = np.all(np.isfinite(projected) & (projected > 0) & (projected < 2), axis=0)
            mosaic[:, valid] = projected[:, valid]
            resolution[valid] = 2700 if '_2700_' in path.name else 665
        source_records.append(dict(product=path.name.replace('.visible.lbl', ''), **info))
    valid = np.all(np.isfinite(mosaic), axis=0)
    coverage = float(valid.mean())
    weights = np.cos(np.deg2rad(90 - (np.arange(HEIGHT) + .5) * 180 / HEIGHT))[:, None]
    np.save(CACHE / 'visible-linear.npy', mosaic)
    np.save(CACHE / 'source-resolution.npy', resolution)
    print('Coverage by 10-degree latitude band (north to south):', [round(float(valid[i:i+HEIGHT//18].mean()),3) for i in range(0,HEIGHT,HEIGHT//18)], flush=True)
    surface_coverage = float((valid * weights).sum() / (WIDTH * weights.sum()))
    assert coverage > .9 and surface_coverage > .99, f'Incomplete visible mosaic: {surface_coverage:.3%} of surface area' 
    # Keep gaps identifiable: neutral gray fill, never invented spectral color.
    fill = float(np.nanmedian(mosaic[1]))
    mosaic[:, ~valid] = fill
    # I/F at the archive's standard geometry is treated as linear display
    # reflectance. One fixed gain for all channels; no white balance or stretch.
    linear = np.clip(mosaic, 0, 1)
    encoded = np.where(linear <= .0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - .055)
    rgb = np.rint(encoded * 255).astype('uint8')
    reference = CACHE / 'mercury-color-reference.png'
    with rasterio.open(reference, 'w', driver='PNG', width=WIDTH, height=HEIGHT, count=3, dtype='uint8') as dataset:
        dataset.write(rgb)
    compact = CACHE / 'mercury-color.webp'
    with rasterio.Env(GDAL_PAM_ENABLED='NO'):
        raster_copy(reference, compact, driver='WEBP', QUALITY=95)
    with rasterio.open(compact) as dataset:
        error = np.abs(rgb.astype('int16') - dataset.read().astype('int16'))
    # Retain coverage and measured linear samples independently of delivery RGB.
    with rasterio.open(CACHE / 'coverage.png', 'w', driver='PNG', width=WIDTH, height=HEIGHT, count=1, dtype='uint8') as dataset:
        dataset.write((valid * 255).astype('uint8'), 1)
    controls = []
    for lat, lon in [(20, 160), (-20, -70), (0, 0), (10, 179.9), (85, 45), (-85, 45)]:
        x = int((lon + 180) / 360 * WIDTH) % WIDTH
        y = min(HEIGHT - 1, int((90 - lat) / 180 * HEIGHT))
        controls.append(dict(lat=lat, lon=lon, pixel=[x, y], linearReflectance=mosaic[:, y, x].tolist(), srgb=rgb[:, y, x].tolist(), measured=bool(valid[y, x])))
    report = dict(schema=1, body='mercury', width=WIDTH, height=HEIGHT,
                  source='MESSENGER MDIS MDR final version 4, 64 ppd', sourceUrl=BASE,
                  doi='10.17189/1520178', archiveErrataUrl=BASE+'ERRATA.TXT',
                  license='NASA PDS data; cite MESSENGER MDIS team and dataset DOI', credit='NASA / JHUAPL / Carnegie / ACT · MESSENGER MDIS',
                  channels={'red': '630 nm measured I/F', 'green': '560 nm measured I/F', 'blue': '480 nm measured I/F'},
                  treatment='Approximate visible RGB, fixed gain 1, standard sRGB encoding; no per-channel stretch or added hillshade',
                  limitations='Narrow-band visible approximation, not a colorimetric human-eye reconstruction; photometric seams remain; south-polar fill uses images up to 2700 m/px; missing pixels neutral gray',
                  validCoverageFraction=coverage, surfaceCoverageFraction=surface_coverage,
                  coarseSouthPolarPixelFraction=float((resolution==2700).mean()), missingFillLinear=fill, controlSamples=controls,
                  sourceResolutionPixelsPerDegree=64, sources=source_records,
                  sourceSha256=hashlib.sha256(json.dumps(source_records, sort_keys=True).encode()).hexdigest(),
                  deliveredSha256=sha(compact), meanChannelError=float(error.mean()), p99ChannelError=float(np.percentile(error, 99)),
                  bytes=compact.stat().st_size, buildSeconds=time.perf_counter() - start)
    OUT.mkdir(parents=True, exist_ok=True)
    coverage_output = CACHE / 'mercury-color-coverage.png'
    coverage_output.write_bytes((CACHE / 'coverage.png').read_bytes())
    for path in [compact, reference, coverage_output]:
        temp = OUT / (path.name + '.writing')
        temp.write_bytes(path.read_bytes())
        temp.replace(OUT / path.name)
    (OUT / 'mercury-color.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k not in ['sources', 'controlSamples']}, indent=2))


if __name__ == '__main__':
    main()
