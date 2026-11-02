"""Shared quadratic fillets with disjoint, verified influence regions.

Each curve stays inside its corner triangle. That triangle must contain no
unrelated boundary and must not overlap another accepted corner triangle.
Consequently the replacement cannot cross another curve or existing edge.
"""
import numpy as np
import shapely


def fit_shared_corners(coverage, width, height, tile):
    rings = [np.asarray(ring.coords) for ring in shapely.get_rings(coverage)]
    a = np.concatenate([ring[:-1] for ring in rings])
    b = np.concatenate([ring[1:] for ring in rings])
    points, inverse = np.unique(np.concatenate([a, b]), axis=0, return_inverse=True)
    edges = np.unique(np.sort(np.column_stack([inverse[:len(a)], inverse[len(a):]]), axis=1), axis=0)
    degree = np.bincount(edges.ravel(), minlength=len(points))
    source = np.concatenate([edges[:, 0], edges[:, 1]])
    target = np.concatenate([edges[:, 1], edges[:, 0]])
    order = np.argsort(source, kind='stable')
    offsets = np.r_[0, np.cumsum(degree)]
    ids = np.flatnonzero((degree == 2) & (points[:, 0] > 0) & (points[:, 0] < width)
                        & (points[:, 1] > 0) & (points[:, 1] < height))
    p = points[ids]
    va = points[target[order[offsets[ids]]]] - p
    vb = points[target[order[offsets[ids] + 1]]] - p
    la, lb = np.linalg.norm(va, axis=1), np.linalg.norm(vb, axis=1)
    # Keep curve displacement within the source's sampling scale, including
    # long otherwise-straight boundaries. Never round an entire long feature.
    trim = np.minimum(.65, .35 * np.minimum(la, lb))
    start = p + va * (trim / la)[:, None]
    end = p + vb * (trim / lb)[:, None]
    triangles = shapely.polygons(np.stack([start, p, end, start], axis=1))
    bounds = shapely.bounds(triangles)
    valid = (shapely.area(triangles) > 1e-12)
    # A corner ON a tile cut can create a curved sliver in a neighboring tile
    # where the original face had zero area and therefore was not exported.
    # Pin these vertices too, even if the entire triangle lies on one side.
    valid &= np.all((np.mod(p, tile) > 1e-8) & (np.mod(p, tile) < tile - 1e-8), axis=1)
    # Tile cuts stay on straight sections. This avoids independently cutting
    # or fitting the same curve in adjacent tiles.
    valid &= np.all(np.floor((bounds[:, :2] + 1e-9) / tile)
                    == np.floor((bounds[:, 2:] - 1e-9) / tile), axis=1)
    candidates = int(np.sum(valid))
    edge_tree = shapely.STRtree(shapely.linestrings(points[edges]))
    for first in range(0, len(ids), 20000):
        indices = np.flatnonzero(valid[first:first + 20000]) + first
        if not len(indices):
            continue
        local, other = edge_tree.query(triangles[indices], predicate='intersects')
        corner = indices[local]
        unrelated = np.all(edges[other] != ids[corner, None], axis=1)
        valid[np.unique(corner[unrelated])] = False
    indices = np.flatnonzero(valid)
    tree = shapely.STRtree(triangles[indices])
    conflicts = set()
    for first in range(0, len(indices), 20000):
        local, other = tree.query(triangles[indices[first:first + 20000]], predicate='intersects')
        local += first
        keep = local < other
        local, other = local[keep], other[keep]
        if len(local):
            overlap = shapely.area(shapely.intersection(triangles[indices[local]], triangles[indices[other]])) > 1e-12
            conflicts.update(indices[np.r_[local[overlap], other[overlap]]].tolist())
    if conflicts:
        valid[list(conflicts)] = False
    result = {tuple(points[index]): (start[i], end[i]) for i, index in enumerate(ids) if valid[i]}
    stats = {'degreeTwoCorners': len(ids), 'tileSafeCandidates': candidates, 'curvedCorners': len(result),
             'maxTrimPixels': .65, 'trimFraction': .35, 'protectedOverlaps': len(conflicts)}
    return result, stats


def curved_ring_path(ring, x, y, corners):
    points = np.asarray(ring.coords[:-1])
    entries = []
    for i, p in enumerate(points):
        corner = corners.get(tuple(p))
        if corner is None:
            entries.append((p, None, p))
        else:
            a, b = corner
            incoming = points[i - 1] - p
            if np.dot(incoming, a - p) < np.dot(incoming, b - p):
                a, b = b, a
            entries.append((a, p, b))
    def fmt(p):
        return f'{p[0]-x:.6f},{p[1]-y:.6f}'.replace('.000000', '')
    path = 'M' + fmt(entries[0][0])
    for i, (a, control, b) in enumerate(entries):
        if i:
            path += 'L' + fmt(a)
        if control is not None:
            path += 'Q' + fmt(control) + ' ' + fmt(b)
    return path + 'Z'
