"""Validate every delivered R8 page, shared gutters, and pyramid samples."""
import gzip,hashlib,json
from pathlib import Path
import numpy as np

root=Path('public/hillshade');catalog=json.loads((root/'catalog.json').read_text())
reports=[]
for body,relative in catalog['bodies'].items():
    directory=(root/relative).parent;m=json.loads((root/relative).read_text());pages={};total=0;max_seam=0
    for key,entry in m['tiles'].items():
        file=directory/f'{key}.bin.gz';payload=file.read_bytes();raw=gzip.decompress(payload)
        assert len(payload)==entry['bytes'] and len(raw)==260*260
        assert hashlib.sha256(raw).hexdigest()==entry['sha256']
        pages[key]=np.frombuffer(raw,dtype='uint8').reshape(260,260);total+=len(payload)
    for z,l in enumerate(m['levels']):
        nx=(l['width']+255)//256;ny=(l['height']+255)//256
        for y in range(ny):
            for x in range(nx):
                a=pages[f'{z}/{x}/{y}'];w=min(256,l['width']-x*256);h=min(256,l['height']-y*256)
                b=pages[f'{z}/{(x+1)%nx}/{y}']
                error=int(np.abs(a[:,w:w+4].astype('int16')-b[:,:4].astype('int16')).max());max_seam=max(error,max_seam)
                assert error<=1,(body,z,x,y,'longitude seam',error)
                if y+1<ny:
                    b=pages[f'{z}/{x}/{y+1}'];error=int(np.abs(a[h:h+4].astype('int16')-b[:4].astype('int16')).max());max_seam=max(error,max_seam)
                    assert error<=1,(body,z,x,y,'latitude seam',error)
                if z<5:
                    # Independently read four finer texels from published pages.
                    for cy,cx in [(0,0),(h//2,w//2),(h-1,w-1)]:
                        gy=y*256+cy;gx=x*256+cx;values=[]
                        for dy in [0,1]:
                            for dx in [0,1]:
                                yy=gy*2+dy;xx=gx*2+dx
                                values.append(int(pages[f'{z+1}/{xx//256}/{yy//256}'][yy%256+2,xx%256+2]))
                        assert int(a[cy+2,cx+2])==(sum(values)+2)//4,(body,z,x,y,'pyramid')
    base=gzip.decompress((directory/'base.bin.gz').read_bytes())
    assert hashlib.sha256(base).hexdigest()==m['baseSha256']
    assert total==m['compressedBytes']
    # Bundle only a tiny complete-world fallback for lean app builds.
    out=Path('public/textures')
    (out/f'{body}-hillshade-base.bin.gz').write_bytes((directory/'base.bin.gz').read_bytes())
    coarse={**m,'tiles':{},'coarseOnly':True};(out/f'{body}-hillshade-base.json').write_text(json.dumps(coarse,separators=(',',':')))
    report=dict(body=body,tiles=len(pages),compressedBytes=total,maxSeamCodeError=max_seam,buildSeconds=m['buildSeconds'],baseBytes=len(base))
    reports.append(report);print(json.dumps(report),flush=True)
Path('.terrain-cache/hillshade-validation.json').write_text(json.dumps(reports,indent=2)+'\n')
