#!/usr/bin/env python3
"""Retain and checksum-pin NASA/USGS Europa terrain and color inputs."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / '.terrain-cache/europa/sources'
PRODUCTS = [('Yelland_Ridges.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Yelland_Ridges/Yelland_Ridges.tif',
  54052,
  '608ed235e9c62abff00fec2da68d4b6c74ddb3e0dfcac039d4a9d0bb74ce8f37'),
 ('Yelland_Ridges-fom.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Yelland_Ridges/Yelland_Ridges_FOM.tif',
  16998,
  'e8d8601312da89877ca714a43551d899bb56dbbfb182a9200298b374077070e4'),
 ('Yelland_Ridges-provenance.txt',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Yelland_Ridges/provenance.txt',
  1019,
  '054f51ad0af834e13c06f8b31431c2c41ddfdc13135b3b1d9f944ac29594ae4a'),
 ('Rhadamanthys.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Rhadamanthys/Rhadamanthys.tif',
  271306,
  '846064aa32ac0323caf6245fed1f91e981f41aaa5330bb4b7d8991ca368c4251'),
 ('Rhadamanthys-fom.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Rhadamanthys/Rhadamanthys_FOM.tif',
  34270,
  'c3014cbfcaee0f8984d8cd2073616da94ef5da204a730d338b0dc1c3c9dda3f3'),
 ('Rhadamanthys-provenance.txt',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Rhadamanthys/provenance.txt',
  1962,
  'f25a466aef7c88ccd6e2f0a11876c61892b6bd3203d31ed1a5122c1cc40ab470'),
 ('Pwyll_Crater.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Pwyll_Crater/Pwyll_Crater.tif',
  50720,
  '20ca7a54d9906a4edaec8f12963b55b678b4711041be61ddca450771849b537c'),
 ('Pwyll_Crater-fom.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Pwyll_Crater/Pwyll_Crater_FOM.tif',
  13094,
  'f80c7ba9f75250a98b5a2adc8dd88ca19a93d2de4d676e76f476132d6e0ffcba'),
 ('Pwyll_Crater-provenance.txt',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Pwyll_Crater/provenance.txt',
  981,
  '3127d4301431869ce22fb9d311733eab04e818b6295e7030d173c6d96dabd6cf'),
 ('Cilix_Crater.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Cilix_Crater/Cilix_Crater.tif',
  39708,
  'c85ea869ab415150f5280de15107d19279e6236376b38dd3a471af27cdad11d8'),
 ('Cilix_Crater-fom.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Cilix_Crater/Cilix_Crater_FOM.tif',
  9656,
  '29850012170639a14f26a03363044fb2330859e8ea03fade89f731c468507df6'),
 ('Cilix_Crater-provenance.txt',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Cilix_Crater/provenance.txt',
  981,
  '3f35dad60ce48bbf2079073e33737ef40059aa4cf9270305ef0823a27214b9b4'),
 ('Agenor.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Agenor/Agenor.tif',
  168472,
  '335c16fcb53c5e278f5660f3df5f42f58cd65d0ce78722c9a055ee2e7a053d62'),
 ('Agenor-fom.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Agenor/Agenor_FOM.tif',
  29461,
  'c16870068b5a60cfbd5fe6a8113233ab806221bfdcb1d2b7dfda6bfb179d9e0c'),
 ('Agenor-provenance.txt',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_dtms/Agenor/provenance.txt',
  867,
  'cec5d5607a2cdeb5d953252ab20c728c3b1f35dc32d839da8fa157ce131d47b9'),
 ('global.tif',
  'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif',
  192777263,
  'a323f0c9ccb47d5af9902ea8297fe81f9a9708795645b80801f103c3f7c9a624'),
 ('global.lbl',
  'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Europa_Voyager_GalileoSSI_global_mosaic_500m_pds3.lbl',
  2189,
  '6da4c97d7d38659b4998e22d2b962d0f3eed23920380415429d6694b41822e34'),
 ('geology.zip',
  'https://pubs.usgs.gov/sim/3513/sim3513_gis.zip',
  148227036,
  '6f9212b670d36ae94d76fd6f0e655cfab7c65bde54fe27655474e4a6c4caa63a'),
 ('natural-color.jpg',
  'https://assets.science.nasa.gov/content/dam/science/missions/europa-clipper/images/PIA00502.jpg',
  264240,
  'ebb83c565eb53a98f9486a66fa57c2944b5bda9adaab79535008fab32db3b541'),
 ('ortho-E6ESCRATER02_GalileoSSI_Equi.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_mosaics/E6ESCRATER02/E6ESCRATER02_GalileoSSI_Equi.tif',
  2792107,
  'c943172f4622a149cc0158b0642f5be07db9e444ca9036d56c8c73d203816538'),
 ('ortho-E6ESCRATER01_GalileoSSI_Equi.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_mosaics/E6ESCRATER01/E6ESCRATER01_GalileoSSI_Equi.tif',
  1837239,
  '0d05119e5f01e4874d4f46a058e9a8e3d607759fce91e3b58f9fb9c6d81426b9'),
 ('ortho-19ESRHADAM01_GalileoSSI_Equi.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_mosaics/19ESRHADAM01/19ESRHADAM01_GalileoSSI_Equi.tif',
  18803449,
  'c882c6f2ef3ea6f1d558b385ecd3fd2db664f1550ac13a55641d696b81e71fd8'),
 ('ortho-17ESAGENOR03_GalileoSSI_Equi_1.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_mosaics/17ESAGENOR03/17ESAGENOR03_GalileoSSI_Equi_1.tif',
  30923467,
  '71e17255f03b8f2f8c65d8fff3b4f664c8ca3a0460af3ea1099427aa88e26454'),
 ('ortho-15ESCILIXS01_GalileoSSI_Equi.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_mosaics/15ESCILIXS01/15ESCILIXS01_GalileoSSI_Equi.tif',
  3024012,
  '4bcf09a5dec4bc73e568a6ef2b443190429500b811f157c7dbb45b057429b1f0'),
 ('ortho-12ESPWYCOL01_GalileoSSI_Equi.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_mosaics/12ESPWYCOL01/12ESPWYCOL01_GalileoSSI_Equi.tif',
  3714294,
  '9f228b2ccf4a74b6ee56763244f2a0e8ed4865372e615964ce6daf44112f7418'),
 ('ortho-12ESWEDGE_01_GalileoSSI_Equi.tif',
  'https://astrogeo-ard.s3-us-west-2.amazonaws.com/jupiter/europa/galileo_voyager/usgs_controlled_mosaics/12ESWEDGE_01/12ESWEDGE_01_GalileoSSI_Equi.tif',
  14378377,
  'dfac7e2c781df450ada7faa77e647fa33f693e39277f9544757cedfe5cee954f')]



def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch(product):
    name, url, length, expected = product
    path = CACHE / name
    if not path.exists():
        temporary = path.with_suffix('.download')
        # Trek's original-file service streams a whole TIFF, not display tiles.
        with urllib.request.urlopen(url + ('&' if '?' in url else '?') + 'source=europa-implementation', timeout=180) as response, temporary.open('wb') as out:
            shutil.copyfileobj(response, out)
        if temporary.stat().st_size != length or sha(temporary) != expected:
            raise ValueError(f'Incomplete or changed source: {name}')
        temporary.replace(path)
    if path.stat().st_size != length or sha(path) != expected:
        raise ValueError(f'Changed cached source: {name}')
    record = dict(file=name, url=url, bytes=length, sha256=expected)
    print(json.dumps(record), flush=True)
    return record


def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        records = list(pool.map(fetch, PRODUCTS))
    (CACHE / 'sources.json').write_text(json.dumps(records, indent=2) + '\n')


if __name__ == '__main__':
    main()
