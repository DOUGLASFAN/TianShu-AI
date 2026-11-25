"""500-star cold/warm task benchmark in the retained isolated stage-6 database."""
import json,os,subprocess,sys,time,threading
from pathlib import Path
from urllib.parse import quote
ROOT=Path(__file__).resolve().parents[1]
def benchmark():
    from datetime import timedelta
    from fastapi.testclient import TestClient
    from backend.app.main import app
    from backend.app.models import now
    from backend.app.services.predictions import execute_next
    from backend.tests.test_phase2 import register,authorization
    result={'date':'2026-11-15','isolatedDatabase':True,'targetCount':500,'days':1,'workers':4,'runs':[]}
    with TestClient(app,headers={'Origin':'http://testserver'}) as client:
        headers=authorization(register(client)[0]);station=client.post('/api/stations',headers=headers,json={'name':'500 星验收站','latitude':39.9,'longitude':116.4,'elevation_m':0}).json()['data']
        preview=client.get('/api/predictions/groups/active/batch?size=500',headers=headers).json();assert len(preview['list'])==500
        body={'stationId':station['id'],'group':'active','size':500,'start':(now()+timedelta(minutes=10)).isoformat(),'days':1,'minElevation':10,'acceptStale':True,'expectedNoradIds':[x['noradId'] for x in preview['list']]}
        for mode in ['cold','warm']:
            response=client.post('/api/predictions/groups',headers=headers,json=body);assert response.status_code==202,response.text;task=response.json()['data'];start=time.perf_counter()
            thread=threading.Thread(target=execute_next);thread.start();last=-100
            while thread.is_alive():
                thread.join(.5)
                value=client.get('/api/predictions/'+task['id'],headers=headers).json()['data'];count=value['execution'].get('completedSatellites',0)
                if count-last>=100:print(mode,'completed',count,'/ 500',flush=True);last=count
            seconds=time.perf_counter()-start;value=client.get('/api/predictions/'+task['id'],headers=headers).json()['data'];assert value['status']=='completed' and value['execution']['completedSatellites']==500,value
            before=time.perf_counter();listing=client.get('/api/predictions/'+task['id']+'/results?size=8&sort=elevation',headers=headers);assert listing.status_code==200
            result['runs'].append({'mode':mode,'seconds':seconds,'execution':value['execution'],'listResponseMs':(time.perf_counter()-before)*1000,'listBytes':len(listing.content)})
            print(mode,'seconds',round(seconds,2),'events',value['total'],flush=True)
        result['coldTarget60SecondsMet']=result['runs'][0]['seconds']<=60
        result['allPassed']=True
    (ROOT/'docs/evidence/phase6-performance-2026-11-15.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'passed':True,'seconds':[x['seconds'] for x in result['runs']],'coldTargetMet':result['coldTarget60SecondsMet']}))


if __name__=='__main__':
    if '--run' not in sys.argv:
        environment=json.loads((ROOT/'docs/evidence/phase6-test-environment-2026-11-15.json').read_text())
        name=environment['test_database'];assert name.startswith('xingxu_phase6_test_')
        values=json.loads((ROOT/'.local/config/local-services.json').read_text());env=os.environ.copy()
        env['STAR_DATABASE_URL']='postgresql+psycopg://xingxu_app:'+quote(values['db_password'],safe='')+'@127.0.0.1:5432/'+name
        env['STAR_REDIS_URL']='redis://:'+quote(values['redis_password'],safe='')+'@127.0.0.1:6379/15'
        raise SystemExit(subprocess.run([sys.executable,'-m','scripts.benchmark_phase6','--run'],cwd=ROOT,env=env).returncode)
    benchmark()
