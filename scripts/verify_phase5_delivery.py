"""Aggregate stage-5 checks without copying credentials or runtime data to evidence."""
import hashlib,json,subprocess,sys
import xml.etree.ElementTree as ET
from datetime import datetime,timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1];out=ROOT/'docs/evidence'
browser=json.loads((out/'phase5-browser-2026-11-15.json').read_text(encoding='utf-8'))
assert browser.get('allPassed') and len(browser['checks'])==9 and not browser['errors']
chart=json.loads((out/'phase5-chart-responsive-2026-11-15.json').read_text(encoding='utf-8'))
assert chart['allPassed'] and all(row['renderedFontPixels']>=10 for row in chart['checks'])
ui=json.loads((out/'observation-ui-review-2026-11-15.json').read_text(encoding='utf-8'))
assert ui['allPassed'] and len(ui['checks'])==7 and not ui['errors']
shell=json.loads((out/'shell-layout-2026-11-15.json').read_text(encoding='utf-8'))
assert shell['allPassed'] and len(shell['headers'])==15 and not shell['errors']
tests={}
for stage,count in [(2,20),(4,13),(5,17)]:
    suite=ET.parse(out/f'phase{stage}-backend-2026-11-15.xml').getroot().find('testsuite')
    assert int(suite.attrib['failures'])==int(suite.attrib['errors'])==0
    assert int(suite.attrib['tests'])>=count;tests[str(stage)]=int(suite.attrib['tests'])
assert subprocess.run([sys.executable,'-m','alembic','check'],cwd=ROOT).returncode==0
assert (ROOT/'frontend/dist/index.html').is_file()
known=[]
for line in (ROOT/'.env').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line and any(x in line.split('=',1)[0] for x in ('PASSWORD','SECRET')):known.append(line.split('=',1)[1].strip().strip('"\''))
known.extend(x['password'] for x in json.loads((ROOT/'.local/config/demo-accounts.json').read_text(encoding='utf-8')).values())
files=[p for parent in ['frontend/dist','docs/evidence'] for p in (ROOT/parent).rglob('*') if p.suffix in ['.js','.css','.html','.json','.xml']]
assert not any(secret and secret in p.read_text(encoding='utf-8') for secret in known for p in files)
numerical=json.loads((out/'phase5-numerical-2026-11-15.json').read_text(encoding='utf-8'))
assert numerical['sevenDaySeconds']<5 and numerical['passes']==40
report={'stage':5,'checkedAt':datetime.now(timezone.utc).isoformat(),'allPassed':True,'backendTests':tests,
        'browserChecks':len(browser['checks']),'realTask':browser['realTask'],'numerical':numerical,
        'migrationCheckPassed':True,'knownSecretScanPassed':True,'mapCleanup':browser['mapLifecycle'],'chartResponsive':chart,'uiReviewChecks':len(ui['checks']),'stableHeaderComparisons':len(shell['headers']),
        'limits':['Potential optical windows do not guarantee naked-eye visibility','Five-second sampling can miss shorter optical intervals',
                  'Same SGP4 theory in independent coordinate reference; no independent observation truth',
                  'Software WebGL only; no new hardware FPS acceptance','Group prediction, replay and saved plans remain stage 6']}
(out/'phase5-acceptance-2026-11-15.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':True,'backendTests':tests,'browserChecks':len(browser['checks']),'sevenDaySeconds':numerical['sevenDaySeconds']},ensure_ascii=False))
