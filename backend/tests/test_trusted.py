from copy import deepcopy
from types import SimpleNamespace
import pytest
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.api import telemetry
from backend.app.core.security import current_user
from backend.app.services.trusted_analysis import compare,check_claim


def test_claim_cases_and_owner(tmp_path,monkeypatch):
    monkeypatch.setattr(telemetry,'STORE',tmp_path/'research.db')
    user=SimpleNamespace(id='researcher',is_guest=False)
    app.dependency_overrides[current_user]=lambda:user
    try:
        with TestClient(app) as c:
            r=c.post('/api/telemetry/runs',json=dict(asset='opssat-v2',channel='CADC0872',segment='8')).json()
            base=dict(report=r['id'],norad=44878,channel=r['channel'],start=r['start'],end=r['end'],
                      metric='count',value=400,unit='个',citation=r['id']+'#stats.count')
            for changes,status in [({},'已核验'),({'value':401},'已修正'),({'start':'2001'},'来源冲突'),
                                   ({'norad':1},'来源冲突'),({'unit':'V'},'证据不足'),({'citation':'fake'},'证据不足')]:
                out=c.post('/api/trusted/check',json=dict(base,**changes)).json()
                assert out['status']==status and out['original']==dict(base,**changes)
            assert c.post('/api/trusted/compare',json={'left':r['id'],'right':r['id']}).json()['status']=='证据不足'
            user.id='other'
            assert c.post('/api/trusted/check',json=base).status_code==404
    finally:app.dependency_overrides.pop(current_user)


def test_comparison_keeps_provenance():
    left=dict(id='one',asset=dict(norad=42,source='archive-a',unit='V',sha256='a'),channel='voltage',
              used=[1],points=[dict(record=1,utc='t',value=2,raw={'value':'2'})])
    right=deepcopy(left);right['id']='two';right['asset'].update(source='archive-b',unit='mV',sha256='b')
    right['points'][0].update(value=2000,raw={'value':'2000'})
    equal=compare(left,right)
    assert equal['aligned']==1 and equal['different']==0 and equal['pairs'][0]['rightRaw']=={'value':'2000'}
    right['points'][0].update(value=1900,raw={'value':'1900'})
    assert compare(left,right)['status']=='来源冲突'
    right['used']=[]
    assert compare(left,right)['status']=='证据不足'

def test_task_pipeline_and_model_handoff(tmp_path,monkeypatch):
    monkeypatch.setattr(telemetry,'STORE',tmp_path/'jobs.db')
    user=SimpleNamespace(id='owner',is_guest=False)
    app.dependency_overrides[current_user]=lambda:user
    try:
        with TestClient(app) as c:
            r=c.post('/api/telemetry/runs',json=dict(asset='opssat-v2',channel='CADC0872',segment='8')).json()
            task=dict(report=r['id'],request='核验后总结',provider='form')
            key=c.post('/api/research/jobs',json=task).json()['id']
            job=c.get('/api/research/jobs/'+key).json()
            assert job['state']=='completed' and job['steps'][-1]['result']['citation']==r['id']+'#stats.count'
            monkeypatch.setenv('STAR_QWEN_URL','')
            key=c.post('/api/research/jobs',json=dict(task,provider='qwen')).json()['id']
            url='/api/research/jobs/'+key
            assert c.get(url).json()['state']=='review'
            for attempt in [2,3]:
                assert c.post(url+'/retry').status_code==200 and c.get(url).json()['attempt']==attempt
            assert c.post(url+'/retry').status_code==409
            user.id='other'
            assert c.get(url).status_code==404
    finally:app.dependency_overrides.pop(current_user)

def test_cancel_and_restart_state(tmp_path,monkeypatch):
    import time
    from types import SimpleNamespace
    from fastapi import BackgroundTasks
    from backend.app.api import research
    user=SimpleNamespace(id='u',is_guest=True)
    monkeypatch.setattr(telemetry,'STORE',tmp_path/'recover.db')
    with telemetry.database() as db:
        research.schema(db)
        for key,state,t in [('old','running',0),('pending','queued',time.time())]:
            db.execute('INSERT INTO research_jobs VALUES(?,?,?,?,?,?,?,?)',(key,'u','{}',state,1,t,'[]',''))
    assert research.get('old',user)['state']=='interrupted'
    research.control('pending','cancel',BackgroundTasks(),user)
    research.execute('pending','u',1)
    assert research.get('pending',user)['state']=='cancelled'
    research.control('old','retry',BackgroundTasks(),user)
    assert research.get('old',user)['previous'][0]['state']=='interrupted'


def test_model_plan_and_summary_contract(monkeypatch):
    from backend.app.api import research
    from types import SimpleNamespace
    import json
    monkeypatch.setenv('STAR_QWEN_URL','http://localhost:9999/v1')
    monkeypatch.setenv('STAR_QWEN_MODEL','contract-fixture')
    responses=iter([dict(steps=['detect','verify','summary']),dict(sections=['candidate','coverage'])])
    def fake(url,**kwargs):
        assert url=='http://localhost:9999/v1/chat/completions'
        assert 'schema' in kwargs['json']['response_format']
        text=json.dumps(next(responses))
        return SimpleNamespace(raise_for_status=lambda:None,json=lambda:{'model':'contract-fixture','choices':[{'message':{'content':text}}]})
    monkeypatch.setattr(research.httpx,'post',fake)
    t=research.Task(report='abc',provider='qwen',request='核验异常并总结')
    steps,model=research.make_plan(t)
    assert steps==['detect','verify','summary'] and model=='contract-fixture'
    result=research.selected_summary('qwen',t.request,dict(id='abc',used=[1,2],candidates=[2],limitations='人工复核'),
                                     {'detect':{},'verify':{'status':'已核验'}})
    assert [s['citation'] for s in result['statements']]==['abc#candidates','abc#stats.count','abc#limitations']
