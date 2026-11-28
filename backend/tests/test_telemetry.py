from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit
import pytest
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.api import telemetry as api
from backend.app.core.security import current_user
from backend.app.services.telemetry import analyze,digest

@pytest.fixture
def client(tmp_path,monkeypatch):
    monkeypatch.setattr(api,'STORE',tmp_path/'runs.db')
    user=SimpleNamespace(id='owner',is_guest=False)
    app.dependency_overrides[current_user]=lambda:user
    try:
        with TestClient(app) as client:yield client,user
    finally:app.dependency_overrides.pop(current_user)

def test_real_archive(client):
    c,user=client
    asset=c.get('/api/telemetry/assets/opssat-v2').json()
    assert len(asset['segments'])==3
    for segment in asset['segments']:
        window=dict(asset='opssat-v2',**segment)
        report=c.post('/api/telemetry/runs',json=window).json()
        assert report['stats']['verified'] and report['stats']['count']>20
        key=report['id']
        assert c.post(f'/api/telemetry/runs/{key}/replay').json()['id']==key
        assert c.put(f'/api/telemetry/runs/{key}/review',json={'note':'checked'}).status_code==200
        assert c.get(f'/api/telemetry/runs/{key}').json()['review']=='checked'
        user.id='other'
        assert c.get(f'/api/telemetry/runs/{key}').status_code==404
        user.id='owner'

def test_import_quality_and_access(client):
    c,user=client
    contents='timestamp,channel,segment,value\n'+''.join(f'2022-06-01T00:00:0{t}Z,a,b,{v}\n' for t,v in [(1,'0'),(3,'2'),(2,''),(3,'2'),(5,'10')])
    body=dict(mission='fixture',norad=1,version='1',source='test',unit='V',sha256=digest(contents.encode()),content=contents)
    assert c.post('/api/telemetry/assets',json=dict(body,sha256='0'*64)).status_code==422
    key=c.post('/api/telemetry/assets',json=body).json()['id']
    assert c.post('/api/telemetry/assets',json=body).json()['id']==key
    window=dict(asset=key,channel='a',segment='b')
    result=c.post('/api/telemetry/runs',json=window).json()
    assert result['used']==[1,5] and result['missing']==[3] and result['outOfOrder']==[3] and result['stats']['mean']==5
    assert c.post('/api/telemetry/runs',json=dict(window,start='2022-06-01')).status_code==422
    user.id='other'
    assert c.get('/api/telemetry/assets/'+key).status_code==404
    user.is_guest=True
    assert c.post('/api/telemetry/assets',json=body).status_code==403

def test_historical_identity_and_epoch(client):
    c,user=client
    asset=c.get('/api/telemetry/assets/opssat-v2').json()
    seg=asset['segments'][-1]
    endpoint='/api/telemetry/assets/opssat-v2/position'
    start=c.get(endpoint,params={'time':seg['start']}).json()
    end=c.get(endpoint,params={'time':seg['end']}).json()
    assert start['noradId']==44878 and start['ecef_m']!=end['ecef_m'] and start['epoch']==end['epoch']
    assert 'reason' in c.get(endpoint,params={'time':'2026-01-01T00:00:00Z'}).json()
    meta=asset['meta']
    raw='timestamp,segment,channel,value\n2020-01-01T00:00:00Z,a,b,3\n'
    body=dict(mission='test',norad=1,version='1',source='test',unit='V',sha256=digest(raw.encode()),content=raw,tle=meta['tle'],orbitSource=meta['orbitSource'])
    assert c.post('/api/telemetry/assets',json=body).status_code==422
    body['norad']=44878
    key=c.post('/api/telemetry/assets',json=body).json()['id']
    assert '历元' in c.get('/api/telemetry/assets/'+key+'/position',params={'time':'2020-01-01T00:00:00Z'}).json()['reason']

def test_units_identity_and_gaps():
    raw='timestamp,channel,segment,value,unit,norad,sampling\n2022-01-01T00:00:00Z,a,b,0,V,1,1\n2022-01-01T00:00:03Z,a,b,2000,mV,1,1\n'
    meta={'sha256':digest(raw.encode()),'unit':'V','norad':1,'cadenceSeconds':True}
    r=analyze(raw,meta,'a','b')
    assert r['stats']['mean']==r['stats']['independentMean']==1 and len(r['gaps'])==1
    with pytest.raises(ValueError,match='NORAD'):analyze(raw,dict(meta,norad=2),'a','b')
    with pytest.raises(ValueError,match='单位'):analyze(raw,dict(meta,unit='s'),'a','b')

def test_observations_and_corrupt_archives(client):
    c,user=client
    data='timestamp,segment,channel,value\n2022-01-01T00:00:00Z,a,b,0\n'
    body=dict(kind='observation',mission='example',norad=1,version='1',source='authorized fixture',
              unit='m',sha256=digest(data.encode()),content=data)
    assert c.post('/api/telemetry/assets',json=body).status_code==422
    key=c.post('/api/telemetry/assets',json=dict(body,station='test station')).json()['id']
    assert '缺少' in c.get('/api/telemetry/assets/'+key+'/position',params={'time':'2022-01-01T00:00:00Z'}).json()['reason']
    window=dict(asset=key,channel='b',segment='a')
    assert c.post('/api/telemetry/runs',json=dict(window,end='2030-01-01T00:00:00Z')).status_code==422
    failures=c.get('/api/telemetry/failures').json()
    assert failures[0]['parameters']['asset']==key
    with api.database() as db:db.execute('UPDATE assets SET content=? WHERE id=?',('broken',key))
    assert c.post('/api/telemetry/runs',json=window).status_code==409

def test_first_batch_import_quality_and_event_archive(client):
    c,user=client
    raw='timestamp,channel,segment,value,quality\n'+''.join(
        f'2022-01-01T00:00:0{t}Z,a,b,{v},{q}\n' for t,v,q in
        [(1,0,'good'),(3,90,'interpolated'),(2,60,'bad'),(4,2,'good'),(4,2,'good')])
    body=dict(mission='fixture',norad=1,version='1',source='test',unit='V',sha256=digest(raw.encode()),content=raw)
    result=c.post('/api/telemetry/assets',json=body).json()
    assert result['quality'][0]['flagged']==[2,3] and result['quality'][0]['outOfOrder']==[3]
    report=c.post('/api/telemetry/runs',json=dict(asset=result['id'],channel='a',segment='b')).json()
    assert report['used']==[1] and report['stats']['mean']==0 and report['stats']['verified']
    report=c.post('/api/telemetry/runs',json=dict(asset='opssat-v2',channel='CADC0872',segment='8')).json()
    url='/api/telemetry/runs/'+report['id']
    assert c.put(url+'/events/716/review',json={'note':'待复查原始测量'}).status_code==200
    assert c.get(url).json()['eventReviews']['716']=='待复查原始测量'
    assert c.put(url+'/events/1/review',json={'note':'wrong'}).status_code==404
    user.id='other'
    assert c.put(url+'/events/716/review',json={'note':'private'}).status_code==404

def test_reuse_explore_playback_contract(client):
    c,user=client
    r=c.post('/api/telemetry/runs',json=dict(asset='opssat-v2',channel='CADC0872',segment='8')).json()
    scene=c.get('/api/telemetry/runs/'+r['id']+'/scene').json()
    t=scene['satellites'][0]
    assert t['noradId']==44878 and t['dataQuality']['source']==r['asset']['orbitSource']
    assert t['samples'][0][0]==0 and len(t['samples'][0])==5 and t['samples'][-1][0]==399
    assert scene['start']==r['start'] and scene['end']==r['end']

def test_investigation_uses_frozen_report_and_owner(client):
    c,user=client
    saved=c.post('/api/telemetry/runs',json=dict(asset='opssat-v2',channel='CADC0872',segment='8')).json()
    path='/api/investigation/runs/'+saved['id']
    window=dict(start=saved['start'],end=saved['end'],target=716)
    result=c.post(path,json=window).json()
    assert result['included']==400 and result['rules'][0]['targetHit']
    assert result['source']==saved['asset']['sha256']
    assert {h['id'] for h in result['hypotheses']}=={'quality','signal','sensitivity'}
    target=next(i for i,p in enumerate(saved['points']) if p['record']==716)
    smaller=dict(start=saved['points'][target-1]['utc'],end=saved['points'][target+1]['utc'],target=716)
    changed=c.post(path,json=smaller).json()
    assert changed['included']==3 and changed['rules'][0]['threshold']!=result['rules'][0]['threshold']
    assert changed['windowChanged']==(result['baselineHit']!=changed['rules'][0]['targetHit'])
    assert c.get('/api/investigation/bookmarks').json()[0]['record']==716
    assert c.post(path,json=dict(window,start='2020-01-01T00:00:00Z')).status_code==422
    user.id='other'
    assert c.post(path,json=window).status_code==404
    assert c.get('/api/investigation/bookmarks').json()==[]

def test_ai_tools_use_frozen_evidence_and_keep_original(client):
    c,user=client
    saved=c.post('/api/telemetry/runs',json=dict(asset='opssat-v2',channel='CADC0872',segment='8')).json()
    run=saved['id'];prefix='/api/investigation-tools/runs/'+run
    comparisons=c.get(prefix+'/similar').json()
    assert {'1','5'} <= {m['segment'] for m in comparisons['matches']}
    assert all(-1<=m['correlation']<=1 and len(m['curve'])==32 for m in comparisons['matches'])
    challenge=c.get(prefix+'/challenge').json()
    assert challenge['target']==716 and len(challenge['results'])==3
    assert challenge['results'][-1]['included']==399
    data={'raw':'采集时间,测点,读数\n2022-06-02T00:25:00Z,X,2\n','mapping':{'timestamp':'采集时间','channel':'测点','value':'读数'},
          'metadata':{'mission':'test','norad':44878,'source':'fixture','version':'1','unit':'V'}}
    preview=c.post('/api/investigation-tools/import/preview',json=data).json()
    assert preview['rows'][0]['value']=='2'
    asset=c.post('/api/investigation-tools/import/commit',json=data).json()['id']
    original='/api/investigation-tools/imports/'+asset+'/original'
    assert c.get(original).text==data['raw']
    assert c.get('/api/telemetry/assets/'+asset).json()['meta']['importProvenance']['mapping']==data['mapping']
    session={'path':'/telemetry','report':run,'query':'run='+run,'selection':[saved['start'],saved['end']]}
    key=c.post('/api/investigation-tools/sessions',json=session).json()['id']
    url='/api/investigation-tools/sessions/'+key
    assert c.get(url).json()['selection']==session['selection']
    user.id='another-owner'
    assert c.get(original).status_code==404 and c.get(url).status_code==404
    assert c.get(prefix+'/similar').status_code==404

def test_integrated_investigation_scopes_selected_point_and_keeps_archive_read_only(client):
    c,user=client
    saved=c.post('/api/telemetry/runs',json=dict(asset='opssat-v2',channel='CADC0872',segment='8')).json()
    before=c.get('/api/telemetry/runs').json()
    endpoint='/api/task-workflows/investigate'
    response=c.post(endpoint,json={'run':saved['id'],'record':716})
    assert response.status_code==200
    result=response.json()
    assert result['point']['record']==716 and result['window']['included']==400
    assert result['related'] and result['nextSteps']
    assert len(result['trials'])==3 and result['version']==saved['asset']['sha256']
    assert any(item['kind']=='orbit' for item in result['context']['entries'])
    selected=next(i for i,p in enumerate(saved['points']) if p['record']==716)
    end=saved['points'][selected+1]['utc']
    narrow=c.post(endpoint,json={'run':saved['id'],'record':716,'start':saved['points'][selected-1]['utc'],'end':end})
    assert narrow.status_code==200 and narrow.json()['window']['included']==3
    assert narrow.json()['context']['end']==end
    scope={'record':716,'start':saved['points'][selected-1]['utc'],'end':end}
    entries={item['kind']:item for item in narrow.json()['context']['entries']}
    orbit=parse_qs(urlsplit(entries['orbit']['link']).query)
    assert orbit['at']==[saved['points'][selected]['utc']] and orbit['record']==['716']
    original=parse_qs(urlsplit(entries['telemetry']['link']).query)
    assert original=={'run':[saved['id']],'record':['716'],'start':[scope['start']],'end':[end]}
    verify='/api/investigation-tools/runs/'+saved['id']+'/verification'
    brief=c.get(verify,params=scope).json()
    assert brief['point']=={'record':716,'utc':saved['points'][selected]['utc']}
    assert brief['start']==scope['start'] and brief['end']==end and brief['channel']==saved['channel']
    assert c.get(verify,params=dict(scope,start=end)).status_code==422
    assert c.get(verify,params=dict(scope,record=999999)).status_code==422
    assert c.get(verify).json()['point'] is None
    snapshot=narrow.json()['snapshot']
    save_url=endpoint+'/save'
    assert c.post(save_url,json=dict(snapshot,content=snapshot['content']+' ')).status_code==422
    created=c.post(save_url,json=snapshot)
    assert created.status_code==201
    session_url='/api/investigation-tools/sessions/'+created.json()['id']
    stored=c.get(session_url).json()
    assert stored['workflow']=={key:value for key,value in narrow.json().items() if key!='snapshot'}
    assert stored['selection']==[scope['start'],scope['end']]
    assert c.post(endpoint,json={'run':saved['id'],'record':716,'start':end}).status_code==422
    assert c.get('/api/telemetry/runs').json()==before
    user.id='different-user'
    assert c.post(endpoint,json={'run':saved['id'],'record':716}).status_code==404
    assert c.get(verify,params=scope).status_code==404
    assert c.post(save_url,json=snapshot).status_code==422
    assert c.get(session_url).status_code==404
