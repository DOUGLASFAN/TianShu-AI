"""Audit map evidence and exported assets without changing application data."""
import hashlib,json,re,sys,xml.etree.ElementTree as ET
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from backend.app.api.maps import public_config
evidence=ROOT/'docs/evidence'
browser=json.loads((evidence/'maps-browser-2026-11-15.json').read_text(encoding='utf-8'))
assert browser['allPassed'] and len(browser['checks'])==6 and not browser['errors']
detail=next(x for x in browser['checks'] if x['name']=='beijing-high-detail-and-wgs84-pick')
assert any(x['levels'].get('imagery',0)>=16 for x in detail['diagnostic'].values())
assert any(x['tile'].startswith('esri/imagery/19/') and x['status']==200 for x in browser['tiles'])
suite=ET.parse(evidence/'maps-backend-2026-11-15.xml').getroot().find('testsuite')
assert int(suite.attrib['tests'])>=15 and int(suite.attrib['failures'])==int(suite.attrib['errors'])==0
for name in ['maps-space-1440.png','maps-streets-1440.png','maps-beijing-detail-1440.png','maps-offline-fallback-1440.png']:
    assert (evidence/name).stat().st_size>10000
checklist=(ROOT/'docs/阶段验收清单.md').read_text(encoding='utf-8')
items=re.findall(r'^- \[(x| )\] \*\*(S\d\d-\d\d)',checklist,re.M)
assert len(items)==85 and sum(mark=='x' for mark,_ in items)==69
private=[]
for line in (ROOT/'.env').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line:
        name,value=line.split('=',1)
        if any(word in name for word in ['PASSWORD','SECRET','TIANDITU_KEY','ARCGIS_TOKEN']):
            value=value.strip().strip('"\'')
            if value:private.append(value)
private.extend(x['password'] for x in json.loads((ROOT/'.local/config/demo-accounts.json').read_text(encoding='utf-8')).values())
for folder in ['frontend/dist','docs/evidence']:
    for path in (ROOT/folder).rglob('*'):
        if path.suffix in ['.json','.xml','.js','.css','.html']:
            value=path.read_text(encoding='utf-8')
            assert not any(key in value for key in private),'Private credential in export'
sources=[]
for name in ['0.json','2.json']:
    path=ROOT/'.local/data/map-source-validation'/name;raw=path.read_bytes();metadata=json.loads(raw)
    sources.append({'sha256':hashlib.sha256(raw).hexdigest(),'copyright':metadata['copyrightText'],
        'spatialReference':metadata['tileInfo']['spatialReference'],'lodCount':len(metadata['tileInfo']['lods']),
        'exportTilesAllowed':metadata.get('exportTilesAllowed')})
report={'date':'2026-11-15','allPassed':True,'backendTests':int(suite.attrib['tests']),'browserChecks':6,
    'realImageryLevel':19,'pickedWGS84':browser['picked'],'publicMapConfig':public_config(),'sourceMetadata':sources,
    'knownSecretScanPassed':True,'requiredCompleted':69,'requiredTotal':85,
    'limits':['Some upstream tile requests failed; retained parents/local image may remain blurry in those areas',
              'Resolution and imagery date vary; no live imagery, offline streets or 3D buildings',
              'Tianditu adapter needs a private key and remains unverified','Software WebGL does not establish hardware performance']}
(evidence/'maps-acceptance-2026-11-15.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':True,'backendTests':15,'browserChecks':6,'required':'69/85','secretScanPassed':True}))
