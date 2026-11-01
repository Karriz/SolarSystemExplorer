#!/usr/bin/env python3
"""Offline integration checks for the four-quadrant lunar build and resume path."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import numpy as np

spec=importlib.util.spec_from_file_location('terrain_build',Path(__file__).with_name('build-terrain.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    root=Path(directory);cache=root/'cache';cache.mkdir()
    files=[]
    for i in range(4):
        path=cache/f'quadrant-{i}.IMG'
        path.write_bytes(np.full((128,128),100*(i+1),dtype='<i2').tobytes())
        files.append({'file':path.name,'bytes':path.stat().st_size,'sha256':module.file_hash(path),'url':'https://example.com/'+path.name})
    source=dict(module.SOURCES['moon'])
    source.update(product='test-lola256',width=256,height=256,files=files,
        sha256=hashlib.sha256(json.dumps(files,sort_keys=True,separators=(',',':')).encode()).hexdigest())
    raster=module.Raster(source,cache,True)
    result=raster.sample(np.array([90,270,90,270,90,90]),np.array([45,45,-45,-45,90,-90]))
    np.testing.assert_allclose(result,[50,100,150,200,75,175])
    np.testing.assert_allclose(raster.sample(np.array([0,360,180]),np.array([45,45,45])),[75,75,75])
    np.testing.assert_allclose(raster.sample(np.array([90]),np.array([0])),[100])
    args=SimpleNamespace(cache=cache,output=root/'public',offline=True,max_zoom=1)
    relative=module.build('moon',source,args)
    release=(args.output/relative).parent
    manifest=json.loads((release/'manifest.json').read_text())
    assert manifest['sampleSize']==129 and len(manifest['tiles'])==10
    payload=release/'tiles/1/0/0.bin';original_time=payload.stat().st_mtime_ns
    staging=cache/'build'/('moon-'+manifest['version'])
    release.rename(staging)
    assert module.build('moon',source,args)==relative
    assert payload.stat().st_mtime_ns==original_time,'Completed checkpoint column was rebuilt'
    (cache/files[0]['file']).write_bytes(b'corrupt')
    try:
        module.Raster(source,cache,True)
    except ValueError:
        pass
    else:
        raise AssertionError('Corrupt source was accepted')
print('Passed quadrant orientation, seam/pole sampling, full tiny release validation, resume reuse, and corrupt-source rejection')
