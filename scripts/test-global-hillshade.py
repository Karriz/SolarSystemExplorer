"""Analytic source fixtures for pole-safe RG8 tangent-space normal maps and boundary handling."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
import numpy as np

spec = importlib.util.spec_from_file_location('global_shade', Path(__file__).with_name('build-global-hillshade.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Source:
    def __init__(self, flat=False):
        self.flat = flat

    def sample(self, lon, lat):
        assert np.isfinite(lon).all() and np.isfinite(lat).all() and (np.abs(lat) <= 90.000001).all()
        return np.zeros_like(lon) + 1000 if self.flat else 1000 + m.radius * 0.2 * np.cos(np.deg2rad(lat)) * np.cos(np.deg2rad(lon))


class NormalPyramidTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        m.STAGE = Path(self.directory.name)
        m.W = 11264
        m.H = 5632
        m.radius = 1737400
        m.raster = Source()

    def tearDown(self):
        self.directory.cleanup()

    def test_flat_world_is_exact_neutral_at_both_poles_and_dateline(self):
        m.raster = Source(flat=True)
        for address in [(0, 0), (43, 0), (0, 21), (43, 21), (43, 10)]:
            a = m.bake_tile(address)[2]
            self.assertEqual(a.shape, (260, 260, 2))
            self.assertTrue((a == m.NEUTRAL).all())

    def test_slope_sign_convention_matches_east_north_normal(self):
        # Rising eastward (e > 0) produces a west-tilted normal (N_east < 0 -> code < 127).
        ne, nn = m.tangent_normal(np.array([1.0]), np.array([0.0]), np.array([0.0]))
        self.assertLess(ne[0], -0.7)
        self.assertAlmostEqual(nn[0], 0.0, places=6)
        encoded = m.encode_normals(ne, nn)
        self.assertLess(int(encoded[0, 0]), m.NEUTRAL)
        self.assertEqual(int(encoded[0, 1]), m.NEUTRAL)

    def test_longitude_wrap_gutters_match(self):
        left = m.bake_tile((0, 10))[2]
        right = m.bake_tile((43, 10))[2]
        self.assertLessEqual(int(np.abs(left[:, :4].astype(int) - right[:, -4:].astype(int)).max()), 1)

    def test_neighbor_latitude_gutters_match(self):
        a = m.bake_tile((10, 10))[2]
        b = m.bake_tile((10, 11))[2]
        self.assertTrue(np.array_equal(a[-4:], b[:4]))

    def test_polar_normal_fades_neutrally_without_longitude_dependence(self):
        values = []
        for x in [0, 11, 22, 33]:
            values.extend(m.bake_tile((x, 21))[2][257, 2:258].reshape(-1).tolist())
        self.assertLessEqual(max(values) - min(values), 1)
        self.assertTrue(all(abs(v - m.NEUTRAL) <= 1 for v in values))

    def test_resume_does_not_resample_valid_cached_page(self):
        first = m.bake_tile((1, 1))
        m.raster.sample = lambda *_: self.fail('Cached page was resampled')
        again = m.bake_tile((1, 1))
        self.assertTrue(np.array_equal(first[2], again[2]))
        self.assertEqual(first[3], again[3])

    def test_pyramid_pole_gutters_reflect_rotate_and_invert_tangent_axes(self):
        a = np.full((176, 352, 2), m.NEUTRAL, dtype='uint8')
        a[1, 176] = [147, 107]  # +20 east, -20 north
        a[0, 350] = [157, 137]
        a[175, 176] = [100, 160]
        page = m.extract(a, 0, 0)
        # Reflected across south pole flips (ne, nn) around 127
        self.assertEqual(page[0, 2].tolist(), [107, 147])
        # Longitude wrap does not flip tangent axes
        self.assertEqual(page[2, 0].tolist(), [157, 137])
        # Reflected across north pole flips (ne, nn) around 127
        self.assertEqual(page[178, 2].tolist(), [154, 94])


if __name__ == '__main__':
    unittest.main()
