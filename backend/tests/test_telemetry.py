from pathlib import Path
from types import SimpleNamespace
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
