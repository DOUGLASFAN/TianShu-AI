"""Validate phase-7 evidence, live persisted sources, schema and public artifacts."""
import hashlib,json,re,subprocess,sys
import xml.etree.ElementTree as ET
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT));out=ROOT/'docs/evidence'
from sqlalchemy import select,func
from backend.app.db import SessionLocal
from backend.app.models import WeatherEvent
from backend.app.services.weather import SOURCES,source_state

browser=json.loads((out/'phase7-browser-2026-11-15.json').read_text(encoding='utf-8'))
assert browser['allPassed'] and len(browser['checks'])==8 and not browser['errors']
assert browser['notification']['acceptanceFixture'] and browser['restart']['futureDeliveredAt']
tests={}
for stage,minimum in [(6,15),(7,14)]:
    suite=ET.parse(out/f'phase{stage}-backend-2026-11-15.xml').getroot().find('testsuite')
    assert int(suite.attrib['failures'])==int(suite.attrib['errors'])==0 and int(suite.attrib['tests'])>=minimum
    tests[str(stage)]=int(suite.attrib['tests'])
sources=[]
with SessionLocal() as db:
    for id in SOURCES:
        state,last=source_state(id,db)
        if last:
            path=(ROOT/last.raw_path).resolve();assert path.is_relative_to((ROOT/'.local/data/environment').resolve())
            assert hashlib.sha256(path.read_bytes()).hexdigest()==last.content_hash
            assert last.payload['transport'] in ['urllib','curl']
            state.update(rawHashVerified=True,records=len(last.payload['points'])+len(last.payload['events']),sha256=last.content_hash)
        sources.append(state)
    event_count=db.scalar(select(func.count()).select_from(WeatherEvent).where(WeatherEvent.source_id=='noaa-alerts'))
assert any(x['state']=='available' for x in sources if x['id'] in ['noaa-kp','gfz-kp'])
assert any(x.get('rawHashVerified') for x in sources if x['id']=='noaa-forecast') and event_count>0
checklist=(ROOT/'docs/阶段验收清单.md').read_text(encoding='utf-8')
items=re.findall(r'^- \[(x| )\] \*\*(S\d\d-\d\d)',checklist,re.M)
done=sum(mark=='x' for mark,_ in items)
assert len(items)==85 and done>=62 and all(mark=='x' for mark,id in items if id.startswith('S07-'))
assert subprocess.run([sys.executable,'-m','alembic','check'],cwd=ROOT).returncode==0
assert (ROOT/'frontend/dist/index.html').is_file()
known=[]
for line in (ROOT/'.env').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line and any(x in line.split('=',1)[0] for x in ['PASSWORD','SECRET']):known.append(line.split('=',1)[1].strip().strip('"\''))
known.extend(v['password'] for v in json.loads((ROOT/'.local/config/demo-accounts.json').read_text(encoding='utf-8')).values())
known.extend(v for k,v in json.loads((ROOT/'.local/config/local-services.json').read_text(encoding='utf-8')).items() if 'password' in k and isinstance(v,str))
files=[p for folder in ['frontend/dist','docs/evidence'] for p in (ROOT/folder).rglob('*') if p.suffix in ['.js','.css','.html','.json','.xml']]
assert not any(secret and secret in p.read_text(encoding='utf-8') for secret in known for p in files)
report={'stage':7,'checkedAt':datetime.now(timezone.utc).isoformat(),'allPassed':True,'backendTests':tests,'browserChecks':len(browser['checks']),
        'sources':sources,'persistedNoaaEvents':event_count,'realWorkerNotification':browser['notification'],'restart':browser['restart'],
        'migrationCheckPassed':True,'knownSecretScanPassed':True,'productionBuildPresent':True,'requiredCompleted':done,'requiredTotal':85,
        'limits':['Notifications are in-app durable records, not OS/email/SMS delivery; service shutdown does not guarantee delivery',
                  'Normal dispatch grace 60 seconds; restart marks all elapsed pending thresholds missed',
                  'NASA DONKI is an unavailable optional supplement on this machine; NOAA events and NOAA/GFZ indicators are real successful sources',
                  'No global indicator diagnoses local device failures; no missing official severity or timestamps are invented',
                  'Browser timing fixtures use dedicated generated accounts and wall clock, not astronomical events or accelerated system time']}
(out/'phase7-acceptance-2026-11-15.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':True,'backendTests':tests,'browserChecks':len(browser['checks']),'persistedNoaaEvents':event_count,'requiredCompleted':done,'requiredTotal':85}))
