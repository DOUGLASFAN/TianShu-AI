"""Verify live accounting, admin evidence, schema and shipped artifacts."""
import json,re,subprocess,sys,time
import xml.etree.ElementTree as ET
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT));out=ROOT/'docs/evidence'
from sqlalchemy import select,func
from backend.app.db import SessionLocal
from backend.app.models import JobRun,AdminAudit
from backend.app.services.statistics import aggregate
from backend.app.services.operations import demo_state

browser=json.loads((out/'phase8-browser-2026-11-15.json').read_text(encoding='utf-8'))
assert browser['allPassed'] and len(browser['checks'])==7 and not browser['errors']
assert len(browser['scales'])==4 and browser['fullscreenNative']
assert browser['demoFailures'] and len(browser['recovery']['checks'])==5
assert browser['recovery']['phase'] in ['normal','degraded']
preview=json.loads((out/'phase8-final-preview-2026-11-15.json').read_text(encoding='utf-8'))
assert preview['allPassed'] and len(preview['checks'])==2 and not preview['errors']
tests={}
for stage,minimum in [(4,13),(7,14),(8,15)]:
    suite=ET.parse(out/f'phase{stage}-backend-2026-11-15.xml').getroot().find('testsuite')
    assert int(suite.attrib['failures'])==int(suite.attrib['errors'])==0 and int(suite.attrib['tests'])>=minimum
    tests[str(stage)]=int(suite.attrib['tests'])
start=time.perf_counter();value=aggregate();seconds=time.perf_counter()-start
assert all(sum(x['count'] for x in value[key])==value['activeCount'] for key in ['orbits','owners','purposes'])
assert value['coverage']['launchDateKnown']+value['coverage']['launchDateUnknown']==value['activeCount']
assert len(value['launches'])==12 and any(x['key']=='unknown' for x in value['orbits'])
assert value['catalogCount']==value['ownerKnownCount']+value['ownerUnknownCount']
with SessionLocal() as db:
    manual=db.get(JobRun,browser['manualTask']);assert manual.status=='success' and manual.result.get('requestId')
    recovery=db.get(JobRun,browser['recovery']['taskId']);assert recovery.status==('success' if browser['recovery']['phase']=='normal' else 'failed')
    failures=db.scalar(select(func.count()).select_from(JobRun).where(JobRun.error_code=='DEMO_SOURCE_FAILURE'))
    audit=db.scalar(select(func.count()).select_from(AdminAudit));assert failures and audit
demo=demo_state();assert demo['phase'] in ['normal','degraded'] # injection must be off at delivery
checklist=(ROOT/'docs/阶段验收清单.md').read_text(encoding='utf-8');items=re.findall(r'^- \[(x| )\] \*\*(S\d\d-\d\d)',checklist,re.M);done=sum(m=='x' for m,_ in items)
assert len(items)==85 and done>=69 and all(m=='x' for m,id in items if id.startswith('S08-'))
assert subprocess.run([sys.executable,'-m','alembic','check'],cwd=ROOT).returncode==0
assert (ROOT/'frontend/dist/index.html').is_file()
known=[]
for line in (ROOT/'.env').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line and any(x in line.split('=',1)[0] for x in ['PASSWORD','SECRET']):known.append(line.split('=',1)[1].strip().strip('"\''))
known.extend(v['password'] for v in json.loads((ROOT/'.local/config/demo-accounts.json').read_text(encoding='utf-8')).values())
known.extend(v for k,v in json.loads((ROOT/'.local/config/local-services.json').read_text(encoding='utf-8')).items() if 'password' in k and isinstance(v,str))
files=[p for folder in ['frontend/dist','docs/evidence'] for p in (ROOT/folder).rglob('*') if p.suffix in ['.js','.css','.html','.json','.xml']]
assert not any(secret and secret in p.read_text(encoding='utf-8') for secret in known for p in files)
report={'stage':8,'checkedAt':datetime.now(timezone.utc).isoformat(),'allPassed':True,'backendTests':tests,'browserChecks':7,'finalPreviewChecks':2,'statistics':value,'aggregationSeconds':seconds,
        'manualTaskId':manual.id,'demoFailureRecords':failures,'adminAuditCount':audit,'finalDemoState':demo,'browserRecovery':browser['recovery'],
        'migrationCheckPassed':True,'knownSecretScanPassed':True,'productionBuildPresent':True,'requiredCompleted':done,'requiredTotal':85,
        'limits':['Active-directory statistics are not the entire real-world satellite population','Unknown purpose is retained, never inferred from name',
                  'Launch trends count current catalog satellites with known dates, not rocket launches','Selected-station ranking uses saved owned predictions, not invented live events',
                  'Recovery probes validate named endpoints and formats, not successful full-catalog re-collection','Software WebGL screenshots and one aggregation timing do not establish hardware FPS or P95']}
(out/'phase8-acceptance-2026-11-15.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':True,'backendTests':tests,'browserChecks':7,'activeCount':value['activeCount'],'aggregationSeconds':round(seconds,4),'demoPhase':demo['phase'],'requiredCompleted':done,'requiredTotal':85}))
