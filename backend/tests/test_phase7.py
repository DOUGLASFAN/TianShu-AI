"""Real database reminder races, user isolation and weather failure semantics."""
import copy,json,threading,uuid
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
import pytest
from sqlalchemy import delete,select,func
from backend.tests.test_phase6 import client,logged,isolated,completed,event_body
from backend.tests.test_phase2 import register,authorization
from backend.app.db import SessionLocal,engine
from backend.app.models import Notification,ObservationPlan,PlanReminder,WeatherEvent,WeatherSnapshot,CollectionRun,now
from backend.app.services.reminders import dispatch,summary
from backend.app.services.weather import SOURCES,parse,collect_source,source_state
from backend.app.api.plans import record

@pytest.fixture(autouse=True)
def weather_isolation():
    assert '_test_' in engine.url.database
    with SessionLocal() as db,db.begin():
        db.execute(delete(WeatherEvent));db.execute(delete(WeatherSnapshot));db.execute(delete(CollectionRun).where(CollectionRun.source_id.in_(SOURCES)))

def plan(client,h,threshold=10):
    task=completed(client,h);body={**event_body(client,h,task),'reminderMinutes':threshold}
    r=client.post('/api/plans',headers=h,json=body);assert r.status_code==201,r.text
    return r.json()['data']

def due_at(id):
    with SessionLocal() as db:return db.get(PlanReminder,(id,1,db.get(ObservationPlan,id).reminder_minutes)).due_at

@pytest.mark.parametrize('threshold',[5,10,30])
def test_real_clock_threshold_and_exactly_once(client,logged,threshold):
    p=plan(client,logged,threshold);due=due_at(p['id'])
    # A future browser replay timestamp has no input path to the scheduler.
    assert dispatch(clock=lambda:due-timedelta(seconds=1))['sent']==0
    with SessionLocal() as db:
        reminder=db.get(PlanReminder,(p['id'],1,threshold));reminder.status='pending';db.commit()
    assert dispatch(clock=lambda:due+timedelta(milliseconds=20))['sent']==1
    assert dispatch(clock=lambda:due+timedelta(seconds=2))['sent']==0
    value=client.get('/api/notifications',headers=logged).json();assert value['unread']==value['total']==1
    n=value['list'][0];assert n['data']['threshold']==threshold and n['data']['version']==1 and n['planId']==p['id']

def test_restart_missed_and_future_recovery(client,logged):
    p=plan(client,logged);due=due_at(p['id'])
    with SessionLocal() as db:
        r=db.get(PlanReminder,(p['id'],1,10));r.status='pending';db.commit()
    assert dispatch(clock=lambda:due-timedelta(seconds=1),recovery=True)['missed']==0
    assert dispatch(clock=lambda:due+timedelta(seconds=1),recovery=True)['missed']==1
    assert client.get('/api/notifications',headers=logged).json()['total']==0
    assert client.get('/api/plans/'+p['id'],headers=logged).json()['data']['reminder']['state']=='missed'

def test_late_dispatch_cancel_and_version_revoke(client,logged):
    p=plan(client,logged);due=due_at(p['id'])
    with SessionLocal() as db:
        r=db.get(PlanReminder,(p['id'],1,10));r.status='pending';db.commit()
    assert dispatch(clock=lambda:due+timedelta(seconds=61))['missed']==1
    with SessionLocal() as db:
        r=db.get(PlanReminder,(p['id'],1,10));r.status='pending';db.commit()
    assert dispatch(clock=lambda:due)['sent']==1
    r=client.post('/api/plans/'+p['id']+'/cancel',headers=logged,json={'expectedVersion':1});assert r.status_code==200
    assert dispatch(clock=lambda:due)['sent']==0
    n=client.get('/api/notifications',headers=logged).json();assert n['unread']==0 and n['list'][0]['revokedAt']

def test_recalculation_revokes_old_notification_and_new_version_schedules(client,logged):
    p=plan(client,logged);due=due_at(p['id'])
    with SessionLocal() as db:
        db.get(PlanReminder,(p['id'],1,10)).status='pending';db.commit()
    assert dispatch(clock=lambda:due)['sent']==1
    # Exercise the same locked version-record path used by confirmed recalculation.
    with SessionLocal() as db,db.begin():
        row=db.scalar(select(ObservationPlan).where(ObservationPlan.id==p['id']).with_for_update());row.version=2;row.start_at=now()+timedelta(hours=2);row.end_at=row.start_at+timedelta(minutes=10);record(row,db,'recalculated');future=row.start_at-timedelta(minutes=10)
    n=client.get('/api/notifications',headers=logged).json();assert n['unread']==0 and n['list'][0]['revokedAt']
    assert dispatch(clock=lambda:future)['sent']==1
    value=client.get('/api/notifications',headers=logged).json();assert value['total']==2 and value['unread']==1
    assert {n['data']['version'] for n in value['list']}=={1,2}

def test_concurrent_scheduler_and_read_permissions(client,logged):
    p=plan(client,logged);due=due_at(p['id'])
    with SessionLocal() as db:
        db.get(PlanReminder,(p['id'],1,10)).status='pending';db.commit()
    results=[];threads=[threading.Thread(target=lambda:results.append(dispatch(clock=lambda:due))) for _ in range(4)]
    for t in threads:t.start()
    for t in threads:t.join(10);assert not t.is_alive()
    assert sum(x['sent'] for x in results)==1
    n=client.get('/api/notifications',headers=logged).json()['list'][0];other=authorization(register(client)[0])
    assert client.get('/api/notifications',headers=other).json()['total']==0
    assert client.post('/api/notifications/'+n['id']+'/read',headers=other).status_code==404
    assert client.post('/api/notifications/'+n['id']+'/read',headers=logged).status_code==200
    assert client.post('/api/notifications/'+n['id']+'/read',headers=logged).status_code==200
    assert client.post('/api/notifications/read-all',headers=logged).json()['data']['unread']==0
    assert client.get('/api/notifications').status_code==401

def fixture_kp(at,value=4):return json.dumps([{'time_tag':at.isoformat(),'Kp':value}]).encode()
def fixture_alert(at):return json.dumps([{'product_id':'TEST','issue_datetime':at.isoformat(),'message':'Space Weather Message Code: WARK05\nWARNING: Geomagnetic K-index of 5 expected\nNoaa Scale: G1 - Minor\nBegin Time: '+at.strftime('%Y %b %d %H%M')+' UTC\nValid To: '+(at+timedelta(hours=2)).strftime('%Y %b %d %H%M')+' UTC'}]).encode()
def fetched(body):return lambda _: (body,{'transport':'test_fixture','publishedAt':None})

def test_weather_semantics_no_invented_severity_or_issue_time():
    at=now();observed=parse('noaa-kp',fixture_kp(at),at);assert observed['points'][0]['kind']=='observation'
    forecasts=json.dumps([['time_tag','kp','observed','noaa_scale'],[at.isoformat(),2,'observed',None],[(at+timedelta(hours=3)).isoformat(),3,'estimated',None],[(at+timedelta(hours=6)).isoformat(),5,'predicted','G1']]).encode()
    p=parse('noaa-forecast',forecasts,at)['points'];assert [x['kind'] for x in p]==['observation','forecast','forecast']
    notice=parse('noaa-alerts',fixture_alert(at),at)['events'][0];assert notice['kind']=='warning' and notice['officialScale']=='G1' and notice['occurredAt']
    unknown=parse('noaa-alerts',json.dumps([{'product_id':'XX','issue_datetime':at.isoformat(),'message':'Notice without a severity'}]).encode(),at)['events'][0];assert unknown['kind']=='notice' and unknown['officialScale'] is None and unknown['occurredAt'] is None
    flr=parse('donki-flr',json.dumps([{'flrID':'id','beginTime':at.isoformat(),'classType':'M1.2'}]).encode(),at)['events'][0];assert flr['issuedAt'] is None and flr['kind']=='observation'
    for bad in [-1,10,float('nan')]:
        with pytest.raises(ValueError):parse('noaa-kp',fixture_kp(at,bad),at)
    with pytest.raises(ValueError):parse('noaa-forecast',json.dumps([['time_tag','kp','observed'],[at.isoformat(),1,'unrecognized']]).encode(),at)

def test_weather_valid_raw_persistence_dedup_and_event_links(client,logged):
    at=now();assert collect_source('noaa-alerts',fetched(fixture_alert(at)),clock=lambda:at)['status']=='success'
    assert collect_source('noaa-alerts',fetched(fixture_alert(at)),clock=lambda:at+timedelta(seconds=1))['status']=='success'
    listing=client.get('/api/environment/events?kind=warning&category=geomagnetic',headers=logged).json();assert listing['total']==1
    detail=client.get('/api/environment/events/'+listing['list'][0]['id'],headers=logged).json();assert detail['data']['validity']=='within_validity' and detail['raw']['product_id']=='TEST'
    runs=client.get('/api/environment/sources/noaa-alerts/runs',headers=logged).json();assert len(runs['list'])==2
    raw=client.get('/api/environment/snapshots/'+detail['data']['runId']+'/raw',headers=logged);assert raw.status_code==200 and raw.content==fixture_alert(at)
    assert raw.headers['x-content-sha256']
    assert client.get('/api/environment').status_code==401

def test_weather_stale_unknown_and_failure_fallback(client,logged):
    at=now();empty=client.get('/api/environment',headers=logged).json()['data'];assert empty['observation']['state']=='unknown' and empty['observation']['latest'] is None
    collect_source('noaa-kp',fetched(fixture_kp(at)),clock=lambda:at)
    def fail(_):raise OSError('injected')
    assert collect_source('noaa-kp',fail,clock=lambda:at+timedelta(seconds=1))['status']=='failed'
    current=client.get('/api/environment',headers=logged).json()['data'];source=next(x for x in current['sources'] if x['id']=='noaa-kp');assert source['usingLastGood'] and current['observation']['latest']['kp']==4
    with patch('backend.app.api.environment.now',return_value=at+timedelta(hours=7)):
        stale=client.get('/api/environment',headers=logged).json()['data'];assert stale['observation']['state']=='stale' and stale['observation']['label']=='状态未知'
    with patch('backend.app.api.environment.now',return_value=at+timedelta(hours=1)):
        collect_source('gfz-kp',lambda _: (b'bad shape',{}),clock=lambda:at)
        assert next(x for x in client.get('/api/environment',headers=logged).json()['data']['sources'] if x['id']=='gfz-kp')['state']=='unknown'

def test_weather_filter_pagination_and_expired_bulletin(client,logged):
    at=now();items=json.loads(fixture_alert(at));items*=0
    for i in range(11):items.extend(json.loads(fixture_alert(at-timedelta(hours=i))))
    assert collect_source('noaa-alerts',fetched(json.dumps(items).encode()),clock=lambda:at)['status']=='success'
    first=client.get('/api/environment/events?size=8',headers=logged).json();second=client.get('/api/environment/events?size=8&page=2',headers=logged).json();assert first['total']==11 and len(second['list'])==3
    assert not {x['id'] for x in first['list']} & {x['id'] for x in second['list']}
    assert client.get('/api/environment/events?category=cme',headers=logged).json()['total']==0
    expired=client.get('/api/environment/events/'+second['list'][-1]['id'],headers=logged).json();assert expired['data']['validity']=='expired'
    assert client.get('/api/environment/events?source=unknown',headers=logged).status_code==422

def test_notification_websocket_initial_and_changed_summary(client,logged):
    p=plan(client,logged);due=due_at(p['id'])
    with SessionLocal() as db:
        db.get(PlanReminder,(p['id'],1,10)).status='pending';db.commit()
    ticket=client.post('/api/realtime/ticket',headers=logged).json()['ticket']
    with client.websocket_connect('/api/realtime/ws') as ws:
        ws.send_json({'type':'auth','ticket':ticket});assert ws.receive_json()['type']=='snapshot';initial=ws.receive_json();assert initial['type']=='notifications' and initial['data']['unread']==0
        dispatch(clock=lambda:due)
        for _ in range(5):
            message=ws.receive_json()
            if message['type']=='heartbeat':ws.send_json({'type':'pong'})
            if message['type']=='notifications':break
        assert message['type']=='notifications' and message['data']['unread']==1 and message['seq']>initial['seq']


def test_cancel_before_threshold_never_delivers(client,logged):
    p=plan(client,logged);due=due_at(p['id'])
    assert client.post('/api/plans/'+p['id']+'/cancel',headers=logged,json={'expectedVersion':1}).status_code==200
    assert dispatch(clock=lambda:due)['sent']==0
    assert client.get('/api/notifications',headers=logged).json()['total']==0


def test_all_weather_sources_failed_does_not_claim_success():
    from backend.app.services.weather import collect_all
    with patch('backend.app.services.weather.collect_source',side_effect=lambda source:{'source':source,'status':'failed'}):
        with pytest.raises(ValueError,match='ALL_WEATHER_SOURCES_FAILED'):collect_all()
