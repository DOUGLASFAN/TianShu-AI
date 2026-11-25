"""Verify current map/space evidence, asset hash and private-value exclusion."""
import hashlib,json,re,xml.etree.ElementTree as ET
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];out=ROOT/'docs/evidence'
def report(name):
    data=json.loads((out/name).read_text(encoding='utf-8'))
    assert data.get('allPassed') and not data.get('errors')
    return data
browser=report('map-space-browser-2026-11-18.json');assert len(browser['checks'])==12
flight=report('space-flight-2026-11-18.json');assert len(flight['checks'])==3
status=report('status-dismiss-2026-11-18.json');assert len(status['checks'])==5
shell=report('shell-layout-2026-11-15.json');assert len(shell['headers'])==15 and len(shell['dialogs'])==3
suite=ET.parse(out/'maps-fast-backend-2026-11-18.xml').getroot().find('testsuite')
assert int(suite.attrib['tests'])==18 and int(suite.attrib['failures'])==int(suite.attrib['errors'])==0
manifest=json.loads((ROOT/'frontend/public/space/manifest.json').read_text(encoding='utf-8'))
for folder in ['frontend/public/space','frontend/dist/space']:
    asset=ROOT/folder/manifest['asset'];assert asset.stat().st_size==manifest['bytes']
    assert hashlib.sha256(asset.read_bytes()).hexdigest()==manifest['sha256']
items=re.findall(r'^- \[(x| )\] \*\*(S\d\d-\d\d)',(ROOT/'docs/阶段验收清单.md').read_text(encoding='utf-8'),re.M)
assert len(items)==85 and sum(mark=='x' for mark,_ in items)==69
private=[]
for line in (ROOT/'.env').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line:
        key,value=line.split('=',1)
        if any(word in key for word in ['PASSWORD','SECRET','TIANDITU_KEY','ARCGIS_TOKEN']):
            value=value.strip().strip('"\'')
            if value:private.append(value)
private.extend(v['password'] for v in json.loads((ROOT/'.local/config/demo-accounts.json').read_text(encoding='utf-8')).values())
for folder in ['frontend/dist','docs/evidence']:
    for path in (ROOT/folder).rglob('*'):
        if path.suffix in ['.js','.json','.html','.xml','.css']:
            value=path.read_text(encoding='utf-8')
            assert not any(secret in value for secret in private),'Private value in delivery'
result={'date':'2026-11-18','allPassed':True,'backendTests':18,'browserChecks':12,'flightChecks':3,'statusChecks':5,'headerComparisons':15,'dialogSizes':3,
    'assetSHA256':manifest['sha256'],'assetBytes':manifest['bytes'],'assetExportVerified':True,'knownSecretScanPassed':True,'requiredCompleted':69,'requiredTotal':85,
    'benchmark':next(x for x in browser['checks'] if '原站缓存' in x['name']),
    'limits':['Cold loading depends on upstream network and coverage; a tile timing is not full-screen completion',
              'Solar system geometry and planet textures are illustrative, not ephemerides',
              'Milky Way photograph is historical and reoriented for presentation, not a current astrometric sky',
              'Software WebGL does not establish hardware FPS or P95','No Tianditu key configured or verified']}
(out/'map-space-acceptance-2026-11-18.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:result[k] for k in ['allPassed','backendTests','browserChecks','flightChecks','statusChecks','knownSecretScanPassed','requiredCompleted','requiredTotal']}))
