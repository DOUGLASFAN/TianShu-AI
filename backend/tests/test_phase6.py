"""Real PostgreSQL group queue, replay, plans and versioned reminder-intent contracts."""
import copy,json,time,uuid,threading
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
import numpy as np
import pytest
from sqlalchemy import delete,select,func
from fastapi.testclient import TestClient
from backend.app.main import app
from backend.app.db import SessionLocal,engine
from backend.app.models import Prediction,PredictionEvent,PredictionCache,ObservationPlan,PlanVersion,PlanReminder,PlanProposal,Satellite,SatelliteGroup,GroupMember,now
from backend.app.services.predictions import execute_next,cache_key
from backend.app.services.prediction_math import Cancelled
from backend.phase1.orbits import state_at,from_omm,instant
from backend.tests.test_phase2 import register,authorization

@pytest.fixture(autouse=True)
def isolated():
    assert '_test_' in engine.url.database,'Use the isolated stage-6 runner'
    with SessionLocal() as db:
        for model in [ObservationPlan,Prediction,PredictionCache]:db.execute(delete(model))
        db.commit()

@pytest.fixture
def client():
    with TestClient(app,headers={'Origin':'http://testserver'}) as c:yield c

@pytest.fixture
def logged(client):return authorization(register(client)[0])

def station(client,h,**values):
    r=client.post('/api/stations',headers=h,json={'name':'北京','latitude':39.9,'longitude':116.4,**values});assert r.status_code==201,r.text
    return r.json()['data']

def group():
    slug='test_'+uuid.uuid4().hex[:10];ids=sorted(x['NORAD_CAT_ID'] for x in json.loads(Path('assets/data/orbits/representative-2026-11-12.json').read_text()))
    with SessionLocal() as db:
        db.add(SatelliteGroup(slug=slug,name='三种轨道验收'));db.flush()
        for id in ids:db.add(GroupMember(group_slug=slug,norad_id=id))
        db.commit()
    return slug,ids

def submit(client,h,**values):
    s=station(client,h)
    body={'stationId':s['id'],'noradId':25544,'start':(now()+timedelta(minutes=2)).isoformat(),'days':3,'minElevation':10,'acceptStale':True,**values}
    r=client.post('/api/predictions',headers=h,json=body);assert r.status_code==202,r.text
    return r.json()['data']

def completed(client,h):
    task=submit(client,h);assert execute_next()
    r=client.get('/api/predictions/'+task['id'],headers=h).json()['data'];assert r['status']=='completed',r
    return r

def event_body(client,h,task,index=0):
    events=client.get('/api/predictions/'+task['id']+'/results?size=50',headers=h).json()['list'];assert len(events)>index
    return {'predictionId':task['id'],'eventId':events[index]['id'],'reminderMinutes':10,'acceptStale':True}

def test_group_batch_limits_exact_scope_and_changed_preview(client,logged):
    slug,ids=group();s=station(client,logged)
    first=client.get(f'/api/predictions/groups/{slug}/batch?page=1&size=2',headers=logged).json()
    second=client.get(f'/api/predictions/groups/{slug}/batch?page=2&size=2',headers=logged).json()
    assert [x['noradId'] for x in first['list']]==ids[:2] and [x['noradId'] for x in second['list']]==ids[2:]
    assert first['total']==3 and first['limit']==500
    body={'stationId':s['id'],'group':slug,'batch':1,'size':2,'start':now().isoformat(),'acceptStale':True,'expectedNoradIds':ids[:2]}
    assert client.post('/api/predictions/groups',headers=logged,json={**body,'size':501}).status_code==422
    assert client.post('/api/predictions/groups',headers=logged,json={**body,'expectedNoradIds':ids[1:]}).status_code==409
    assert client.post('/api/predictions/groups',headers=logged,json={**body,'batch':99}).status_code==422
    r=client.post('/api/predictions/groups',headers=logged,json=body);assert r.status_code==202,r.text
    assert [x['satellite']['noradId'] for x in r.json()['data']['basis']['targets']]==ids[:2]

def test_group_execution_cache_failures_paging_and_visibility(client,logged):
    slug,ids=group();s=station(client,logged);body={'stationId':s['id'],'group':slug,'size':3,'start':(now()+timedelta(minutes=1)).isoformat(),'days':1,'acceptStale':True}
    task=client.post('/api/predictions/groups',headers=logged,json=body).json()['data'];assert execute_next()
    value=client.get('/api/predictions/'+task['id'],headers=logged).json()['data'];assert value['status']=='completed' and value['execution']['completedSatellites']==3
    assert value['execution']['eventCount']>0
    result=client.get('/api/predictions/'+task['id']+'/results?size=2&sort=elevation',headers=logged).json();assert len(result['list'])==2
    assert result['list'][0]['max_elevation']>=result['list'][1]['max_elevation'] and all('satellite' in x and 'curve' not in x for x in result['list'])
    visible=client.get('/api/predictions/'+task['id']+'/results?visual=true',headers=logged).json();assert all(x['visible_windows'] for x in visible['list'])
    item=result['list'][0];response=client.get(f"/api/predictions/{task['id']}/events/{item['id']}",headers=logged).json();original=response['data'];assert original['curve']
    assert response['basis']['satellite']['noradId']==item['satellite']['noradId']
    cached=client.post('/api/predictions/groups',headers=logged,json=body).json()['data'];execute_next()
    assert client.get('/api/predictions/'+cached['id'],headers=logged).json()['data']['execution']['cacheHits']==3
    reused=client.get(f"/api/predictions/{cached['id']}/events/{item['id']}",headers=logged).json()['data']
    assert reused['computation']['fromCache'] and reused['computation']['calculatedAt']==original['computation']['calculatedAt']
    broken=client.post('/api/predictions/groups',headers=logged,json={**body,'minElevation':11}).json()['data']
    with SessionLocal() as db:
        row=db.get(Prediction,broken['id']);b=copy.deepcopy(row.basis);b['targets'][0]['orbit']['raw']['MEAN_MOTION']=-1;row.basis=b;db.commit()
    execute_next();result=client.get('/api/predictions/'+broken['id'],headers=logged).json()['data'];assert result['status']=='completed' and len(result['execution']['failures'])==1

def test_cache_key_contains_physical_conditions_version_and_algorithm(client,logged):
    task=submit(client,logged);basis=task['basis'];key=cache_key(basis)
    for change in [('minElevation',11),('start',(now()+timedelta(days=1)).isoformat())]:
        b=copy.deepcopy(basis);b[change[0]]=change[1];assert cache_key(b)!=key
    b=copy.deepcopy(basis);b['orbit']['version']='another-version';assert cache_key(b)!=key
    b=copy.deepcopy(basis);b['station']['elevation_m']=100;assert cache_key(b)!=key
    b=copy.deepcopy(basis);b['station']['name']='Rename only';assert cache_key(b)==key
    with patch('backend.app.services.prediction_math.ALGORITHM','new-algorithm'):assert cache_key(basis)!=key

def test_group_cancel_does_not_block_api_or_publish_partial_events(client,logged):
    slug,_=group();s=station(client,logged);task=client.post('/api/predictions/groups',headers=logged,json={'stationId':s['id'],'group':slug,'size':3,'start':now().isoformat(),'acceptStale':True}).json()['data']
    started=threading.Event();release=threading.Event()
    def blocked(basis,checkpoint):started.set();assert release.wait(10);checkpoint(50);return []
    with patch('backend.app.services.predictions.calculate',blocked):
        thread=threading.Thread(target=execute_next);thread.start();assert started.wait(10)
        before=time.perf_counter();assert client.get('/api/health/live').status_code==200;assert time.perf_counter()-before<1
        r=client.post('/api/predictions/'+task['id']+'/cancel',headers=logged);assert r.json()['data']['status']=='cancelling';release.set();thread.join(10);assert not thread.is_alive()
    assert client.get('/api/predictions/'+task['id'],headers=logged).json()['data']['status']=='cancelled'
    assert client.get('/api/predictions/'+task['id']+'/results',headers=logged).status_code==409
    with SessionLocal() as db:assert db.scalar(select(func.count()).select_from(PredictionEvent).where(PredictionEvent.task_id==task['id']))==0

def test_replay_bounded_coordinates_and_private_access(client,logged):
    task=completed(client,logged);body=event_body(client,logged,task);path=f"/api/predictions/{task['id']}/events/{body['eventId']}/replay"
    result=client.get(path,headers=logged);assert result.status_code==200,result.text;track=result.json()['data']
    assert 2<=len(track['samples'])<=2001 and track['coordinateFrame']=='ITRS/ECEF'
    assert instant(track['eventStart'])-instant(track['start'])==timedelta(seconds=60)
    raw=task['basis']['orbit']['raw']
    for row in [track['samples'][0],track['samples'][-1]]:
        reference=state_at(from_omm(raw),row[0]);assert np.linalg.norm(np.asarray(row[1:4])-reference['ecef_m'])<.01
        assert abs(row[4]-reference['lat'])<1e-7 and len(row)==12
    other=authorization(register(client)[0]);assert client.get(path,headers=other).status_code==404

def test_save_idempotent_privacy_snapshot_and_wall_clock_intent(client,logged):
    task=completed(client,logged);body=event_body(client,logged,task)
    a=client.post('/api/plans',headers=logged,json=body);assert a.status_code==201,a.text;plan=a.json()['data']
    b=client.post('/api/plans',headers=logged,json=body).json();assert b['existing'] and b['data']['id']==plan['id']
    assert instant(plan['start'])-instant(plan['reminder']['dueAt'])==timedelta(minutes=10)
    assert plan['status']=='upcoming' and plan['version']==1
    other=authorization(register(client)[0]);assert client.get('/api/plans/'+plan['id'],headers=other).status_code==404
    assert client.get('/api/plans',headers=other).json()['total']==0
    assert client.post('/api/plans/'+plan['id']+'/cancel',headers=other,json={'expectedVersion':1}).status_code==404
    client.delete('/api/stations/'+task['basis']['station']['id'],headers=logged)
    with SessionLocal() as db:db.delete(db.get(Prediction,task['id']));db.commit()
    assert client.get('/api/plans/'+plan['id'],headers=logged).json()['data']['snapshot']==plan['snapshot']
    replay=client.get('/api/plans/'+plan['id']+'/replay',headers=logged);assert replay.status_code==200
    assert client.get('/api/plans/'+plan['id'],headers=logged).json()['data']['reminder']==plan['reminder']

def test_past_event_and_orbit_update_cannot_be_silently_saved(client,logged):
    task=completed(client,logged);body=event_body(client,logged,task)
    with SessionLocal() as db:
        row=db.get(Prediction,task['id']);values=copy.deepcopy(row.results);values[0]['start']=(now()-timedelta(seconds=1)).isoformat();row.results=values;db.commit()
    assert client.post('/api/plans',headers=logged,json=body).status_code==409
    body=event_body(client,logged,task,1)
    with SessionLocal() as db:
        satellite=db.get(Satellite,25544);old_hash=satellite.content_hash;satellite.content_hash='0'*64;db.commit()
    try:assert client.post('/api/plans',headers=logged,json=body).json()['error']['code']=='PLAN_ORBIT_UPDATED'
    finally:
        with SessionLocal() as db:db.get(Satellite,25544).content_hash=old_hash;db.commit()

def test_recalculate_preview_confirm_version_and_reminder_replacement(client,logged):
    task=completed(client,logged);body=event_body(client,logged,task);plan=client.post('/api/plans',headers=logged,json=body).json()['data'];candidate=event_body(client,logged,task,1);candidate['reminderMinutes']=30
    r=client.post('/api/plans/'+plan['id']+'/preview',headers=logged,json=candidate);assert r.status_code==200,r.text;change=r.json()['data'];assert change['old']['event']['start']!=change['new']['event']['start']
    assert client.get('/api/plans/'+plan['id'],headers=logged).json()['data']['version']==1
    url=f"/api/plans/{plan['id']}/changes/{change['id']}/confirm";r=client.post(url,headers=logged);assert r.status_code==200,r.text
    updated=r.json()['data'];assert updated['version']==2 and updated['reminderMinutes']==30
    assert client.post(url,headers=logged).json()['existing']
    with SessionLocal() as db:
        assert db.get(PlanReminder,(plan['id'],1,10)).status=='cancelled'
        assert db.get(PlanReminder,(plan['id'],2,30)).due_at==instant(updated['start'])-timedelta(minutes=30)
        assert db.get(PlanVersion,(plan['id'],1)).data['snapshot']==plan['snapshot']

def test_cancel_invalidates_preview_and_is_idempotent(client,logged):
    task=completed(client,logged);body=event_body(client,logged,task);plan=client.post('/api/plans',headers=logged,json=body).json()['data']
    change=client.post('/api/plans/'+plan['id']+'/preview',headers=logged,json=event_body(client,logged,task,1)).json()['data']
    cancelled=client.post('/api/plans/'+plan['id']+'/cancel',headers=logged,json={'expectedVersion':1}).json()['data'];assert cancelled['status']=='cancelled' and cancelled['version']==2
    assert client.post('/api/plans/'+plan['id']+'/cancel',headers=logged,json={'expectedVersion':1}).status_code==200
    assert client.post(f"/api/plans/{plan['id']}/changes/{change['id']}/confirm",headers=logged).status_code==409
    assert client.get('/api/plans?status=cancelled',headers=logged).json()['total']==1

def test_expired_proposal_and_version_conflict(client,logged):
    task=completed(client,logged);body=event_body(client,logged,task);plan=client.post('/api/plans',headers=logged,json=body).json()['data'];change=client.post('/api/plans/'+plan['id']+'/preview',headers=logged,json=event_body(client,logged,task,1)).json()['data']
    with SessionLocal() as db:db.get(PlanProposal,change['id']).expires_at=now()-timedelta(seconds=1);db.commit()
    assert client.post(f"/api/plans/{plan['id']}/changes/{change['id']}/confirm",headers=logged).json()['error']['code']=='PROPOSAL_EXPIRED'
    assert client.post('/api/plans/'+plan['id']+'/cancel',headers=logged,json={'expectedVersion':2}).status_code==409

def test_large_batch_process_cancellation_remains_responsive(client,logged):
    s=station(client,logged);preview=client.get('/api/predictions/groups/active/batch?size=25',headers=logged).json();assert len(preview['list'])==25
    task=client.post('/api/predictions/groups',headers=logged,json={'stationId':s['id'],'group':'active','size':25,'start':now().isoformat(),'days':7,'acceptStale':True}).json()['data']
    thread=threading.Thread(target=execute_next);thread.start()
    for _ in range(100):
        value=client.get('/api/predictions/'+task['id'],headers=logged).json()['data']
        if value['status']=='running':break
        time.sleep(.02)
    assert value['status']=='running';before=time.perf_counter()
    assert client.post('/api/predictions/'+task['id']+'/cancel',headers=logged).status_code==200
    assert client.get('/api/health/live').status_code==200
    thread.join(15);assert not thread.is_alive() and time.perf_counter()-before<15
    assert client.get('/api/predictions/'+task['id'],headers=logged).json()['data']['status']=='cancelled'

def test_reminder_missed_and_plan_state_use_real_time(client,logged):
    task=completed(client,logged);body=event_body(client,logged,task)
    with SessionLocal() as db:
        row=db.get(Prediction,task['id']);values=copy.deepcopy(row.results);values[0]['start']=(now()+timedelta(minutes=1)).isoformat();values[0]['end']=(now()+timedelta(minutes=6)).isoformat();row.results=values;db.commit()
    plan=client.post('/api/plans',headers=logged,json=body).json()['data'];assert plan['reminder']['state']=='missed'
    with patch('backend.app.api.plans.now',return_value=instant(plan['start'])+timedelta(minutes=1)):
        assert client.get('/api/plans/'+plan['id'],headers=logged).json()['data']['status']=='ongoing'
    with patch('backend.app.api.plans.now',return_value=instant(plan['end'])+timedelta(seconds=1)):
        assert client.get('/api/plans?status=ended',headers=logged).json()['total']==1


def replay_group(client,h,size=3,slug=None):
    if not slug:slug,_=group()
    s=station(client,h)
    r=client.post('/api/predictions/groups',headers=h,json={'stationId':s['id'],'group':slug,'size':size,'start':now().isoformat(),'days':1,'acceptStale':True})
    assert r.status_code==202,r.text
    task=r.json()['data'];assert execute_next()
    task=client.get('/api/predictions/'+task['id'],headers=h).json()['data'];assert task['status']=='completed'
    return task


def test_group_replay_full_snapshot_geometry_and_window_overlap(client,logged):
    from backend.phase1.orbits import TS,observer
    task=replay_group(client,logged);basis=task['basis'];url='/api/predictions/'+task['id']+'/group-replay'
    def get(at):
        r=client.get(url,headers=logged,params={'at':at});assert r.status_code==200,r.text
        return r.json()['data']
    one=get(basis['start']);two=get((instant(basis['start'])+timedelta(minutes=5)).isoformat())
    assert one['totalCount']==one['renderedCount']==len(basis['targets'])==3
    assert one['sampleCount']<=61 and two['sampleCount']<=61 and two['stepSeconds']<=20
    assert instant(one['end'])>instant(two['start']) and not one['failed']
    for row,target in zip(one['satellites'],basis['targets']):
        sat=from_omm(target['orbit']['raw']);site=observer(basis['station']['latitude'],basis['station']['longitude'],basis['station']['elevation_m'])
        for i in [0,len(row['samples'])//2,len(row['samples'])-1]:
            at=instant(one['start'])+timedelta(seconds=i*one['stepSeconds']);sample=row['samples'][i]
            assert np.linalg.norm(np.asarray(state_at(sat,at)['ecef_m'])-sample[:3])<.1
            assert abs((sat-site).at(TS.from_datetime(at)).altaz()[0].degrees-sample[3])<.00001
        assert row['orbitVersion']==target['orbit']['version']
    end=get(basis['end']);assert instant(end['end'])==instant(basis['end'])
    for at in [(instant(basis['start'])-timedelta(seconds=1)).isoformat(),(instant(basis['end'])+timedelta(seconds=1)).isoformat(),'invalid','2026-11-15T00:00:00']:
        assert client.get(url,headers=logged,params={'at':at}).status_code==422


def test_group_replay_selection_permissions_and_no_event_retained(client,logged):
    task=replay_group(client,logged);basis=task['basis'];url='/api/predictions/'+task['id']+'/group-replay';at={'at':basis['start']}
    other=authorization(register(client)[0])
    assert client.get(url,headers=other,params=at).status_code==404
    assert client.get(url,params=at).status_code==401
    target=basis['targets'][0];norad=target['satellite']['noradId']
    # No-event stars must remain selectable and present in the full map batch.
    with SessionLocal() as db:
        db.execute(delete(PredictionEvent).where(PredictionEvent.task_id==task['id'],PredictionEvent.norad_id==norad));db.commit()
    r=client.get(url+'/satellites/'+str(norad),headers=logged,params=at);assert r.status_code==200,r.text
    payload=r.json();assert payload['data'] is None and payload['basis']['orbit']==target['orbit']
    assert client.get(url+'/satellites/'+str(norad),headers=other,params=at).status_code==404
    assert client.get(url+'/satellites/99999999',headers=logged,params=at).status_code==404
    assert client.get(url+'/satellites/'+str(norad),headers=logged,params={**at,'eventId':'wrong'}).status_code==404
    mapped=client.get(url,headers=logged,params=at).json()['data'];assert norad in [x['noradId'] for x in mapped['satellites']]
    single=completed(client,logged)
    assert client.get('/api/predictions/'+single['id']+'/group-replay',headers=logged,params={'at':single['basis']['start']}).status_code==422


def test_group_replay_500_bounded_cache_and_explicit_failure(client,logged):
    from backend.app.services.group_replay import window,calculate_window
    task=replay_group(client,logged);basis=copy.deepcopy(task['basis'])
    # A full 500-target immutable snapshot, independent of event-table pagination.
    scope=client.get('/api/predictions/groups/active/batch?size=500',headers=logged).json()['list'];assert len(scope)==500
    from backend.app.api.predictions import make_basis
    with SessionLocal() as db:
        satellites=db.scalars(select(Satellite).where(Satellite.norad_id.in_([x['noradId'] for x in scope])).order_by(Satellite.norad_id)).all()
        # make_basis reads only these fields from the station.
        from types import SimpleNamespace
        site=SimpleNamespace(**basis['station'],created_at=instant(basis['station']['createdAt']))
        basis['targets']=[{k:v for k,v in make_basis(site,sat,instant(basis['start']),1,10,True).items() if k in ['satellite','orbit']} for sat in satellites]
    before=time.perf_counter();value=window(basis,basis['start']);seconds=time.perf_counter()-before
    assert value['totalCount']==500 and value['renderedCount']+len(value['failed'])==500
    assert len({x['noradId'] for x in value['satellites']})==value['renderedCount']
    assert len(json.dumps(value))<4_000_000 and seconds<10
    original=basis['targets'][0]['satellite']['noradId'];basis['targets'][0]['orbit']['raw']={}
    broken=window(basis,basis['start']);assert any(x['noradId']==original and x['code']=='INVALID_ORBIT' for x in broken['failed'])
    for i in range(6):window(basis,(instant(basis['start'])+timedelta(minutes=i*5)).isoformat())
    assert calculate_window.cache_info().currsize<=4
    Path('docs/evidence/phase6-multi-replay-performance-2026-11-15.json').write_text(json.dumps({'passed':True,'targetCount':500,'renderedCount':value['renderedCount'],'failedCount':len(value['failed']),'windowSeconds':seconds,'sampleCount':value['sampleCount'],'payloadBytes':len(json.dumps(value)),'cacheMaxWindows':4,'fixture':'500 saved real catalog roots; window generation only, forecast throughput measured separately'},indent=2),encoding='utf-8')
