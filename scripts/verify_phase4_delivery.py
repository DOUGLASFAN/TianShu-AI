"""Collect stage-4 evidence without publishing private configuration or tickets."""
import json,hashlib,subprocess,sys
import xml.etree.ElementTree as ET
from datetime import datetime,timezone
from pathlib import Path
from sqlalchemy import inspect
from backend.app.db import engine,SessionLocal
from backend.app.services.scheduling import read
from backend.app.api.catalog import facets

ROOT=Path(__file__).resolve().parents[1];out=ROOT/'docs/evidence'
browser=json.loads((out/'phase4-browser-2026-11-12.json').read_text())
assert browser['allPassed'] and len(browser['checks'])==7
tests={}
for stage,minimum in [(2,20),(3,8),(4,13)]:
    suite=ET.parse(out/f'phase{stage}-backend-2026-11-12.xml').getroot().find('testsuite')
    assert int(suite.attrib['failures'])==0 and int(suite.attrib['errors'])==0 and int(suite.attrib['tests'])>=minimum
    tests[str(stage)]=int(suite.attrib['tests'])
assert subprocess.run([sys.executable,'-m','alembic','check'],cwd=ROOT).returncode==0
jobs={name:read('job:'+name) for name in ('orbit','iss','statistics')}
assert all(row and row.get('lastSuccessAt') for row in jobs.values())
history={name:read('history:'+name) for name in jobs}
with SessionLocal() as db:coverage=facets(db=db)
known=[]
for line in (ROOT/'.env').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line and any(x in line.split('=',1)[0] for x in ('PASSWORD','SECRET')):known.append(line.split('=',1)[1].strip().strip('"\''))
known.extend(x['password'] for x in json.loads((ROOT/'.local/config/demo-accounts.json').read_text()).values())
files=[p for p in (ROOT/'frontend/dist').rglob('*') if p.suffix in ('.js','.css','.html')]
assert files and not any(secret and secret in p.read_text(encoding='utf-8') for secret in known for p in files)
report={'stage':4,'checkedAt':datetime.now(timezone.utc).isoformat(),'backendTests':tests,'browserChecks':len(browser['checks']),
        'jobs':jobs,'recentJobHistory':history,'facets':coverage,'performance':browser['performance'],
        'resourceCleanup':browser['finalDiagnostics'],'businessTables':len(inspect(engine).get_table_names())-1,
        'knownSecretScanPassed':True,'allPassed':True,
        'limits':['Software WebGL only; RTX 4060 hardware FPS not measured','Purpose uses source PURPOSE only; missing remains unknown',
                  'Global overview limited to 20000 candidates; truncation explicit','No anonymous access during authentication database outage',
                  'Docker/Compose runtime unverified','Job history retains latest 100 records per job']}
(out/'phase4-acceptance-2026-11-12.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':True,'backendTests':tests,'browserChecks':len(browser['checks']),'jobStatus':{name:value['status'] for name,value in jobs.items()},'performance':browser['performance']},ensure_ascii=False,indent=2))
