"""Verify the stage-6 evidence bundle and public build without leaking credentials."""
import json,re,subprocess,sys
import xml.etree.ElementTree as ET
from datetime import datetime,timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];out=ROOT/'docs/evidence'
def read(name):return json.loads((out/name).read_text(encoding='utf-8'))
browser=read('phase6-browser-2026-11-15.json');recovery=read('phase6-worker-recovery-2026-11-15.json');performance=read('phase6-performance-2026-11-15.json')
multi=read('phase6-multi-replay-browser-2026-11-15.json');multi_performance=read('phase6-multi-replay-performance-2026-11-15.json')
assert multi['allPassed'] and len(multi['checks'])==8 and not multi['errors']
assert multi['batch']['loaded']==multi['batch']['total'] and multi['largeBatch']['loaded']==500
assert multi['zeroPass']['events']==0 and multi['zeroPass']['rendered']>0
assert multi_performance['passed'] and multi_performance['targetCount']==500 and multi_performance['cacheMaxWindows']==4
assert browser['allPassed'] and len(browser['checks'])==6 and not browser['errors']
assert recovery['allPassed'] and recovery['noOrphanMathProcesses'] and recovery['errorCode']=='WORKER_INTERRUPTED'
assert performance['allPassed'] and performance['targetCount']==500 and performance['coldTarget60SecondsMet']
assert all(x['execution']['completedSatellites']==500 for x in performance['runs'])
checklist=(ROOT/'docs/阶段验收清单.md').read_text(encoding='utf-8')
items=re.findall(r'^- \[(x| )\] \*\*(S\d\d-\d\d)',checklist,re.M)
assert len(items)==85 and sum(mark=='x' for mark,_ in items)==55
assert all(mark=='x' for mark,id in items if id.startswith('S06-'))
tests={}
for stage,count in [(5,17),(6,15)]:
    suite=ET.parse(out/f'phase{stage}-backend-2026-11-15.xml').getroot().find('testsuite')
    assert int(suite.attrib['failures'])==int(suite.attrib['errors'])==0 and int(suite.attrib['tests'])>=count
    tests[str(stage)]=int(suite.attrib['tests'])
assert subprocess.run([sys.executable,'-m','alembic','check'],cwd=ROOT).returncode==0
known=[]
for line in (ROOT/'.env').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line and any(x in line.split('=',1)[0] for x in ('PASSWORD','SECRET')):known.append(line.split('=',1)[1].strip().strip('"\''))
known.extend(v['password'] for v in json.loads((ROOT/'.local/config/demo-accounts.json').read_text(encoding='utf-8')).values())
known.extend(v for k,v in json.loads((ROOT/'.local/config/local-services.json').read_text(encoding='utf-8')).items() if 'password' in k and isinstance(v,str))
files=[p for directory in ['frontend/dist','docs/evidence'] for p in (ROOT/directory).rglob('*') if p.suffix in ['.js','.css','.html','.json','.xml']]
assert (ROOT/'frontend/dist/index.html').is_file()
assert not any(secret and secret in p.read_text(encoding='utf-8') for secret in known for p in files)
report={'stage':6,'checkedAt':datetime.now(timezone.utc).isoformat(),'allPassed':True,'backendTests':tests,'browserChecks':len(browser['checks']),
        'multiReplay':multi,'multiReplayPerformance':multi_performance,
        'replaySynchronization':browser['replaySync'],'workerRecovery':recovery,'performance':performance,
        'migrationCheckPassed':True,'knownSecretScanPassed':True,'requiredCompleted':55,'requiredTotal':85,
        'limits':['Reminder intents persist; notification delivery is stage 7','Cold/warm performance is one 500-star 24h measurement, not P95',
                  'Single replay max 2001 samples; group max 61 samples/star per 20-minute window, 4 cached windows; bounded linear interpolation, no extrapolation','Potential optical windows do not guarantee naked-eye visibility',
                  'Browser screenshots use software WebGL; hardware FPS and long-running acceptance remain stage 9']}
(out/'phase6-acceptance-2026-11-15.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':True,'backendTests':tests,'browserChecks':len(browser['checks']),'coldSeconds':performance['runs'][0]['seconds'],'warmSeconds':performance['runs'][1]['seconds']}))
