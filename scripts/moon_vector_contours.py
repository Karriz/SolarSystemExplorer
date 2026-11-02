"""Simplify a complete color coverage before cutting it into display tiles."""
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import Polygon, shape
from rasterio.features import shapes


def validate_coverage(polygons, width, height):
    assert bool(np.all(shapely.is_valid(polygons))), 'Invalid individual contour'
    assert tuple(shapely.total_bounds(polygons)) == (0, 0, width, height), 'Coverage moved outside the image'
    assert shapely.coverage_is_valid(polygons), 'Contours overlap or shared edges disagree'
    assert abs(float(np.sum(shapely.area(polygons))) - width * height) < 1e-4, 'Coverage has gaps'


def smooth_coverage(polygons, width, height):
    """Move shared degree-two vertices together; keep junctions/exterior fixed.

    A conservative simultaneous relaxation removes small angular kinks. Retry
    with a smaller movement if any thin region would cross or lose coverage.
    """
    neighbors = {}
    for polygon in polygons:
        for ring in [polygon.exterior, *polygon.interiors]:
            points = [tuple(p) for p in ring.coords[:-1]]
            for a, b in zip(points, points[1:] + points[:1]):
                neighbors.setdefault(a, set()).add(b)
                neighbors.setdefault(b, set()).add(a)
    frozen = set()
    weight = .20
    for attempt in range(8):
        moved = {}
        for p, adjacent in neighbors.items():
            if p in frozen or len(adjacent) != 2 or p[0] in (0, width) or p[1] in (0, height):
                moved[p] = p
            else:
                a, b = sorted(adjacent)
                moved[p] = ((1 - 2 * weight) * p[0] + weight * (a[0] + b[0]),
                            (1 - 2 * weight) * p[1] + weight * (a[1] + b[1]))
        result = np.array([Polygon([moved[tuple(p)] for p in poly.exterior.coords],
                                   [[moved[tuple(p)] for p in ring.coords] for ring in poly.interiors])
                           for poly in polygons], dtype=object)
        try:
            validate_coverage(result, width, height)
            return result, weight
        except AssertionError:
            # Some narrow/near-touching regions cannot safely be relaxed. Pin
            # their shared vertices on BOTH sides, then smooth the rest again.
            invalid = ~shapely.is_valid(result)
            if not np.any(invalid):
                invalid = ~shapely.is_empty(shapely.coverage_invalid_edges(result))
            if not np.any(invalid):
                raise ValueError('Smoothing changed total coverage area')
            for poly in polygons[invalid]:
                frozen.update(tuple(p) for p in shapely.get_coordinates(poly))
            print(f'Smoothing: pinning {int(np.sum(invalid))} sensitive regions (pass {attempt+1})', flush=True)
    raise ValueError('Smoothing could not preserve coverage')


def polygon_path(polygon, x, y):
    def ring_path(ring):
        points = np.asarray(ring.coords[:-1]) - [x, y]
        return 'M' + 'L'.join(f'{a:.6f},{b:.6f}'.replace('.000000', '') for a, b in points) + 'Z'
    return ''.join(ring_path(ring) for ring in [polygon.exterior, *polygon.interiors])


def prepare_coverage(labels):
    height, width = labels.shape
    polygons, classes = [], []
    for geometry, value in shapes(labels, connectivity=4):
        # Raster corners can touch themselves. Split these into valid polygon
        # components before treating them as a shared planar coverage.
        polygon = shapely.make_valid(shape(geometry))
        parts = shapely.get_parts(polygon)
        for part in parts:
            if part.geom_type == 'Polygon':
                polygons.append(part)
                classes.append(int(value))
    polygons = np.array(polygons, dtype=object)
    # Polygon tracing omits collinear T-junction vertices on one side of some
    # shared edges. Node and polygonize the linework once for the whole globe.
    print('Noding global shared boundaries…', flush=True)
    linework = shapely.union_all(shapely.boundary(polygons))
    polygons = shapely.get_parts(shapely.polygonize(shapely.get_parts(linework)))
    points = shapely.get_coordinates(shapely.point_on_surface(polygons))
    classes = labels[np.clip(points[:, 1].astype(int), 0, height-1),
                     np.clip(points[:, 0].astype(int), 0, width-1)].astype(int)
    validate_coverage(polygons, width, height)
    print('Simplifying shared coverage…', flush=True)
    diagonal = shapely.coverage_simplify(polygons, .85, simplify_boundary=False)
    validate_coverage(diagonal, width, height)
    smooth, weight = smooth_coverage(diagonal, width, height)
    changes = [float(np.sum(shapely.area(shapely.symmetric_difference(polygons, coverage)))) / 2
               for coverage in [diagonal, smooth]]
    return diagonal, smooth, classes, weight, changes


def build_contours(labels, palette, baseline, output):
    height, width = labels.shape
    signature = hashlib.sha256(labels.tobytes()).hexdigest()
    cache = Path('.terrain-cache/moon-contour-coverage.npz')
    if cache.exists() and str(np.load(cache, allow_pickle=True)['signature']) == signature:
        data = np.load(cache, allow_pickle=True)
        diagonal, smooth = shapely.from_wkb(data['diagonal']), shapely.from_wkb(data['smooth'])
        classes, weight, changes = data['classes'], float(data['weight']), data['changes']
        print('Reusing validated shared coverage', flush=True)
    else:
        diagonal, smooth, classes, weight, changes = prepare_coverage(labels)
        cache.parent.mkdir(exist_ok=True)
        # Variable-length WKB byte strings are stored as objects in this local
        # build cache. Never load external/untrusted cache files.
        np.savez_compressed(cache, signature=signature, diagonal=shapely.to_wkb(diagonal),
                            smooth=shapely.to_wkb(smooth), classes=classes, weight=weight, changes=changes)
    # A representative boundary near Hadley makes matched close-up reviews
    # repeatable. Both variants use the identical geographic viewpoint.
    target = np.array([(3.63 + 180) / 360 * width, (90 - 26.13) / 180 * height])
    candidates = []
    for polygon in diagonal:
        points = np.asarray(polygon.exterior.coords)
        for a, b in zip(points[:-1], points[1:]):
            if np.linalg.norm(a - b) >= 2:
                midpoint = (a + b) / 2
                candidates.append((float(np.linalg.norm(midpoint - target)), midpoint))
    point = min(candidates, key=lambda item: item[0])[1]
    preview = {'lat': float(90 - point[1] / height * 180), 'lon': float(point[0] / width * 360 - 180)}
    tile = baseline['tileSize']
    for name, coverage in [('10-diagonal', diagonal), ('10-smooth', smooth)]:
        folder = Path(output) / name
        folder.mkdir(parents=True, exist_ok=True)
        tree = shapely.STRtree(coverage)
        entries, vertices, payload, compressed = [], 0, 0, 0
        for y in range(height // tile):
            for x in range(width // tile):
                bounds = shapely.box(x * tile, y * tile, (x + 1) * tile, (y + 1) * tile)
                paths = [''] * len(palette)
                for index in sorted(tree.query(bounds)):
                    intersection = coverage[index].intersection(bounds)
                    for part in shapely.get_parts(intersection):
                        if part.geom_type == 'Polygon' and part.area > 1e-9:
                            paths[classes[index]] += polygon_path(part, x * tile, y * tile)
                vertices += sum(p.count('L') + p.count('M') for p in paths)
                data = json.dumps({'paths': paths}, separators=(',', ':')).encode()
                packed = gzip.compress(data, mtime=0)
                filename = f'{x}-{y}.json.gz'
                (folder / filename).write_bytes(packed)
                entries.append({'x': x, 'y': y, 'file': filename})
                payload += len(data)
                compressed += len(packed)
        # Safe interior samples are independent checks on exported/rendered
        # coverage; boundary samples intentionally change under simplification.
        samples = []
        for x in np.linspace(1, width - 2, 32).astype(int):
            for y in np.linspace(1, height - 2, 16).astype(int):
                point = shapely.Point(x + .5, y + .5)
                for index in tree.query(point):
                    if coverage[index].contains(point) and coverage[index].boundary.distance(point) > 1:
                        samples.append([int(x), int(y), int(classes[index])])
        manifest = {**baseline, 'variant': name, 'tiles': entries, 'vertices': vertices,
                    'payloadBytes': payload, 'compressedBytes': compressed,
                    'checkSamples': samples, 'coverageValid': True,
                    'simplificationAreaTolerance': .85,
                    'previewPoint': preview,
                    'smoothingWeight': weight if name == '10-smooth' else 0,
                    'changedAreaPixels': float(changes[0 if name == '10-diagonal' else 1])}
        (folder / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        print(f'{name}: {vertices:,} vertices, {compressed/1e6:.2f} MB gzip; valid complete coverage', flush=True)


if __name__ == '__main__':
    baseline = json.loads(Path('public/moon-vectors/10/manifest.json').read_text())
    build_contours(np.load('.terrain-cache/moon-vector-labels-10.npz')['labels'], baseline['palette'], baseline, 'public/moon-vectors')
