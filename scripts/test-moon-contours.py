import unittest
import numpy as np
import shapely
from shapely.geometry import Polygon
from moon_vector_contours import smooth_coverage, validate_coverage
from moon_vector_curves import fit_shared_corners, curved_ring_path


class SharedContours(unittest.TestCase):
    def corner_coverage(self):
        return np.array([Polygon([(0,0),(4,0),(4,4),(8,4),(8,8),(0,8)]),
                         Polygon([(4,0),(8,0),(8,4),(4,4)])], dtype=object)

    def test_shared_quadratics_and_tangents(self):
        coverage = self.corner_coverage()
        corners, stats = fit_shared_corners(coverage,8,8,8)
        self.assertEqual(stats['curvedCorners'],1)
        a,b = corners[(4.,4.)]
        p = np.array([4.,4.])
        self.assertAlmostEqual(np.linalg.norm(a-p),.65)
        self.assertAlmostEqual(np.linalg.norm(b-p),.65)
        paths=[curved_ring_path(poly.exterior,0,0,corners) for poly in coverage]
        self.assertTrue(all('Q4,4 ' in path for path in paths))
        # Canonical sampling keeps opposite faces bit-identical. This is an
        # independent flattened coverage check on the actual quadratic shape.
        t=np.linspace(0,1,33)[:,None]
        arc=(1-t)**2*a+2*(1-t)*t*p+t**2*b
        polygons=[]
        for poly in coverage:
            vertices=list(poly.exterior.coords[:-1]); flattened=[]
            for i,v in enumerate(vertices):
                if tuple(v)==(4.,4.):
                    before=np.asarray(vertices[i-1])-p
                    forward=np.dot(before,a-p)>np.dot(before,b-p)
                    flattened.extend(arc if forward else arc[::-1])
                else:
                    flattened.append(v)
            polygons.append(Polygon(flattened))
        validate_coverage(np.array(polygons,dtype=object),8,8)

    def test_curve_does_not_cut_across_tile_boundary(self):
        corners,_=fit_shared_corners(self.corner_coverage(),8,8,4)
        self.assertNotIn((4.,4.),corners)

    def test_curve_protects_unrelated_island(self):
        a,b=self.corner_coverage()
        island=shapely.box(4.15,3.8,4.25,3.9)
        coverage=np.array([a,b.difference(island),island],dtype=object)
        validate_coverage(coverage,8,8)
        corners,_=fit_shared_corners(coverage,8,8,8)
        self.assertNotIn((4.,4.),corners)

    def test_staircase_becomes_diagonal_without_gaps(self):
        edge = [(3, 0), (3, 1), (4, 1), (4, 2), (5, 2), (5, 3), (6, 3), (6, 8)]
        polygons = np.array([Polygon([(0, 0), *edge, (0, 8)]),
                             Polygon([*edge, (8, 8), (8, 0)])], dtype=object)
        validate_coverage(polygons, 8, 8)
        diagonal = shapely.coverage_simplify(polygons, .85, simplify_boundary=False)
        validate_coverage(diagonal, 8, 8)
        points = np.array(diagonal[0].exterior.coords)
        deltas = np.diff(points, axis=0)
        self.assertTrue(np.any((deltas[:, 0] != 0) & (deltas[:, 1] != 0)))
        smooth, _ = smooth_coverage(diagonal, 8, 8)
        validate_coverage(smooth, 8, 8)
        self.assertLess(float(np.sum(shapely.get_num_coordinates(diagonal))),
                        float(np.sum(shapely.get_num_coordinates(polygons))))

    def test_junction_and_exterior_are_fixed(self):
        polygons = np.array([Polygon([(0, 0), (4, 0), (4, 4), (4, 8), (0, 8)]),
                             Polygon([(4, 0), (8, 0), (8, 4), (4, 4)]),
                             Polygon([(4, 4), (8, 4), (8, 8), (4, 8)])], dtype=object)
        smooth, _ = smooth_coverage(polygons, 8, 8)
        validate_coverage(smooth, 8, 8)
        for polygon in smooth:
            self.assertIn((4., 4.), list(polygon.exterior.coords))
        self.assertEqual(tuple(shapely.total_bounds(smooth)), (0, 0, 8, 8))

    def test_holes_remain_filled_by_their_neighbor(self):
        hole = [(2, 2), (6, 2), (6, 6), (2, 6), (2, 2)]
        polygons = np.array([Polygon([(0, 0), (8, 0), (8, 8), (0, 8)], [hole]), Polygon(hole)], dtype=object)
        smooth, _ = smooth_coverage(polygons, 8, 8)
        validate_coverage(smooth, 8, 8)
        self.assertEqual(len(smooth[0].interiors), 1)
        self.assertTrue(smooth[1].contains(shapely.Point(4, 4)))

    def test_coverage_validation_rejects_missing_area(self):
        with self.assertRaises(AssertionError):
            validate_coverage(np.array([shapely.box(0, 0, 7, 8)]), 8, 8)

    def test_coverage_validation_rejects_overlap(self):
        with self.assertRaises(AssertionError):
            validate_coverage(np.array([shapely.box(0, 0, 5, 8), shapely.box(4, 0, 7, 8)]), 8, 8)

    def test_equal_area_does_not_hide_shifted_coverage(self):
        with self.assertRaises(AssertionError):
            validate_coverage(np.array([shapely.box(1, 0, 9, 8)]), 8, 8)


if __name__ == '__main__':
    unittest.main()
