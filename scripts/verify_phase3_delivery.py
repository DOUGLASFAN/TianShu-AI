"""Verify stage 3 execution evidence, local resources and build secret boundary."""
import hashlib,json
import xml.etree.ElementTree as ET
from datetime import datetime,timezone
from pathlib import Path
import httpx

ROOT=Path(__file__).resolve().parents[1]
evidence=ROOT/'docs/evidence'
browser=json.loads((evidence/'phase3-browser-2026-11-12.json').read_text())
assert browser['allPassed'], 'Browser verification incomplete'
suites={}
for stage in (2,3):
    suite=ET.parse(evidence/f'phase{stage}-backend-2026-11-12.xml').getroot().find('testsuite')
    assert int(suite.attrib['failures'])==0 and int(suite.attrib['errors'])==0
    suites[str(stage)]=int(suite.attrib['tests'])
manifest=json.loads((ROOT/'assets/earth/manifest.json').read_text())
for item in manifest['files']:
    for parent in ('assets/earth','frontend/public/earth','frontend/dist/earth'):
        assert hashlib.sha256((ROOT/parent/item['file']).read_bytes()).hexdigest()==item['sha256']
known=[]
for line in (ROOT/'.env').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line and any(word in line.split('=',1)[0] for word in ('PASSWORD','SECRET')):
        known.append(line.split('=',1)[1].strip().strip('"\''))
for account in json.loads((ROOT/'.local/config/demo-accounts.json').read_text()).values():known.append(account['password'])
files=[p for p in (ROOT/'frontend/dist').rglob('*') if p.suffix in ('.js','.css','.html')]
assert files
assert not any(secret and secret in p.read_text(encoding='utf-8') for secret in known for p in files)
with httpx.Client(timeout=10) as client:
    ready=client.get('http://127.0.0.1:8001/api/health/ready');ready.raise_for_status()
    page=client.get('http://127.0.0.1:5174/');page.raise_for_status()
    openapi=client.get('http://127.0.0.1:8001/openapi.json');openapi.raise_for_status()
    assert '/api/explore/scene' in openapi.json()['paths']
    (evidence/'phase3-openapi-2026-11-12.json').write_text(json.dumps(openapi.json(),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
report={'stage':3,'checkedAt':datetime.now(timezone.utc).isoformat(),'backendTests':suites,
        'browserChecks':len(browser['checks']),'browserAllPassed':True,
        'externalRequestsBlocked':True,'externalRequestsAttempted':browser['externalRequests'],
        'resourceDiagnostics':browser['resourceDiagnostics'],'textureHashesVerified':True,
        'buildKnownSecretScan':{'passed':True,'files':len(files)},'readiness':ready.json(),
        'screenshots':browser['screenshots'],'limitations':['Representative satellite scene, not full global point rendering',
        'Software WebGL validation; hardware performance not accepted','Historical composite textures, not real-time clouds',
        'Manual sample refresh, no indefinite extrapolation','Docker container execution not verified'], 'allPassed':True}
(evidence/'phase3-acceptance-2026-11-12.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
