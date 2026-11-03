"""Analytic source fixtures for pole-safe shading and world boundary handling."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
import numpy as np

spec=importlib.util.spec_from_file_location('global_shade',Path(__file__).with_name('build-global-hillshade.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Source:
    def __init__(self,flat=False):self.flat=flat
    def sample(self,lon,lat):
        assert np.isfinite(lon).all() and np.isfinite(lat).all() and (np.abs(lat)<=90.000001).all()
        return np.zeros_like(lon)+1000 if self.flat else 1000+m.radius*.2*np.cos(np.deg2rad(lat))*np.cos(np.deg2rad(lon))

class HillshadeTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory();m.STAGE=Path(self.directory.name);m.W=11264;m.H=5632;m.radius=1737400;m.raster=Source()
    def tearDown(self):self.directory.cleanup()
    def test_flat_world_is_neutral_at_both_poles_and_dateline(self):
        m.raster=Source(flat=True)
        for address in [(0,0),(43,0),(0,21),(43,21),(43,10)]:
            a=m.bake_tile(address)[2];self.assertTrue((a==153).all())
    def test_longitude_wrap_gutters_match(self):
        left=m.bake_tile((0,10))[2];right=m.bake_tile((43,10))[2]
        self.assertLessEqual(int(np.abs(left[:,:4].astype(int)-right[:,-4:].astype(int)).max()),1)
    def test_neighbor_latitude_gutters_match(self):
        a=m.bake_tile((10,10))[2];b=m.bake_tile((10,11))[2]
        self.assertTrue(np.array_equal(a[-4:],b[:4]))
    def test_polar_direction_does_not_depend_on_longitude(self):
        values=[]
        for x in [0,11,22,33]:values.extend(m.bake_tile((x,21))[2][257,2:258].tolist())
        self.assertLessEqual(max(values)-min(values),1)
    def test_resume_does_not_resample_valid_cached_page(self):
        first=m.bake_tile((1,1))
        m.raster.sample=lambda *_:self.fail('Cached page was resampled')
        again=m.bake_tile((1,1));self.assertTrue(np.array_equal(first[2],again[2]));self.assertEqual(first[3],again[3])
    def test_pyramid_pole_gutters_reflect_and_rotate_longitude(self):
        a=np.arange(352*176,dtype='uint16').reshape(176,352)
        page=m.extract(a,0,0)
        self.assertEqual(page[0,2],a[1,176])
        self.assertEqual(page[2,0],a[0,350])
        self.assertEqual(page[178,2],a[175,176])

if __name__=='__main__':unittest.main()
