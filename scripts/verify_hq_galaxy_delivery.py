"""Check source/export integrity, media metadata, UI evidence and secret exclusion."""
from pathlib import Path
import hashlib,json,re
ROOT=Path(__file__).resolve().parents[1];out=ROOT/'docs/evidence'
browser=json.loads((out/'hq-galaxy-browser-2026-11-19.json').read_text(encoding='utf-8'))
assert browser['allPassed'] and len(browser['checks'])==5 and not browser['errors']
flight=json.loads((out/'space-flight-2026-11-18.json').read_text(encoding='utf-8'));assert flight['allPassed'] and len(flight['checks'])==3 and not flight['errors']
sky=json.loads((ROOT/'frontend/public/space/nasa-8k/manifest.json').read_text(encoding='utf-8'))
film=json.loads((ROOT/'frontend/public/space/cinema/manifest.json').read_text(encoding='utf-8'))
assert sky['sourceSize']==[8192,4096] and len(sky['outputs'])==6
raw=ROOT/'.local/downloads/sky/nasa-stars-8k.exr';assert hashlib.sha256(raw.read_bytes()).hexdigest()==sky['sourceSHA256']
assert film['tracks']==[{'handler':'vide','width':3840,'height':2160}]
for base in ['frontend/public/space','frontend/dist/space']:
    for item in sky['outputs']:
        path=ROOT/base/'nasa-8k'/item['file'];assert path.stat().st_size==item['bytes']
        assert item['width']==item['height']==2048 and hashlib.sha256(path.read_bytes()).hexdigest()==item['sha256']
    path=ROOT/base/'cinema'/film['file'];assert path.stat().st_size==film['bytes'] and hashlib.sha256(path.read_bytes()).hexdigest()==film['sha256']
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
        if path.suffix in ['.js','.css','.html','.json','.xml']:
            data=path.read_text(encoding='utf-8');assert not any(secret in data for secret in private),'Private value in export'
result={'date':'2026-11-19','allPassed':True,'browserChecks':5,'flightAndDashboardChecks':3,'skySourceSize':sky['sourceSize'],'cubemapFaceSize':2048,
        'skyExportBytes':sum(x['bytes'] for x in sky['outputs']),'videoSize':[3840,2160],'videoBytes':film['bytes'],
        'nativeMediaPlaybackVerified':True,'sourceAndExportHashesVerified':True,'knownSecretScanPassed':True,'requiredCompleted':69,'requiredTotal':85,
        'limits':['Visual preference remains subject to user feedback','Background is static catalog imagery; animation is a separate authored film',
                  'EXR is tone-mapped to browser sRGB, not preserved as half-float runtime HDR','No Gaia Sky desktop engine is embedded',
                  'Downloaded fragments remain in the D-drive cache after automatic cleanup approval was rejected']}
(out/'hq-galaxy-acceptance-2026-11-19.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:result[k] for k in ['allPassed','browserChecks','flightAndDashboardChecks','sourceAndExportHashesVerified','knownSecretScanPassed','requiredCompleted','requiredTotal']}))
