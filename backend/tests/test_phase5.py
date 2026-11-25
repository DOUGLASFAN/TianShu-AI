"""Stage 5: isolated PostgreSQL queue/privacy and independent topocentric reference."""
import copy,json,math,time,threading
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch
import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete,select
from sgp4.api import jday
from backend.app.db import SessionLocal,engine
from backend.app.main import app
from backend.app.models import Prediction,Satellite,now
from backend.app.services.predictions import execute_next
from backend.app.services.prediction_math import calculate,eligible_windows,Cancelled
from backend.phase1.orbits import from_omm,instant,TS
from backend.tests.test_phase2 import register,authorization

ROWS=json.loads(Path('assets/data/orbits/representative-2026-11-12.json').read_text())
def basis(norad=25544,days=1,lat=39.9,lng=116.4,minimum=10):
    return {'orbit':{'raw':next(x for x in ROWS if int(x['NORAD_CAT_ID'])==norad)},
            'station':{'latitude':lat,'longitude':lng,'elevation_m':0},'start':'2026-11-12T00:00:00+00:00',
            'end':(instant('2026-11-12T00:00:00+00:00')+timedelta(days=days)).isoformat(),'days':days,'minElevation':minimum}

@pytest.fixture(autouse=True)
def isolated_queue():
    assert '_test_' in engine.url.database,'Use scripts/verify_phase2_backend.py --stage 5; never clear the application queue'
    with SessionLocal() as db:db.execute(delete(Prediction));db.commit()

@pytest.fixture
def client():
    with TestClient(app,headers={'Origin':'http://testserver'}) as c:yield c

@pytest.fixture
def logged(client):return authorization(register(client)[0])

def station(client,logged,**values):
    r=client.post('/api/stations',headers=logged,json={'name':'北京观测站','latitude':39.9,'longitude':116.4,**values});assert r.status_code==201,r.text
    return r.json()['data']

def submit(client,logged,**values):
    s=station(client,logged)
    r=client.post('/api/predictions',headers=logged,json={'stationId':s['id'],'noradId':25544,'start':(now()+timedelta(minutes=1)).isoformat(),'days':1,'minElevation':10,'acceptStale':True,**values})
    assert r.status_code==202,r.text
    return r.json()['data']

def test_station_default_edit_delete_and_privacy(client,logged):
    a=station(client,logged);assert a['is_default']
    b=station(client,logged,name='上海',is_default=True)
    rows=client.get('/api/stations',headers=logged).json()['list'];assert sum(s['is_default'] for s in rows)==1
    assert next(s for s in rows if s['is_default'])['id']==b['id']
    body={k:b[k] for k in ['name','latitude','longitude','elevation_m','is_default']};body['elevation_m']=100
    assert client.patch('/api/stations/'+b['id'],headers=logged,json=body).json()['data']['elevation_m']==100
    other=authorization(register(client)[0])
    for method in ['get','delete']:
        assert getattr(client,method)('/api/stations/'+b['id'],headers=other).status_code==404
    client.delete('/api/stations/'+b['id'],headers=logged)
    assert client.get('/api/stations/'+a['id'],headers=logged).json()['data']['is_default']

@pytest.mark.parametrize('field,value',[('latitude',91),('longitude',-181),('elevation_m',10001),('name','   ')])
def test_station_validation(client,logged,field,value):
    r=client.post('/api/stations',headers=logged,json={'name':'test','latitude':0,'longitude':0,field:value});assert r.status_code==422

def test_conditions_timezone_ranges_and_old_roots(client,logged):
    s=station(client,logged);start=(now()+timedelta(minutes=1)).isoformat()
    body={'stationId':s['id'],'noradId':25544,'start':start,'days':7,'minElevation':0,'acceptStale':True}
    for key,value in [('start',start[:19]),('days',2),('minElevation',-1),('minElevation',91),('start',(now()+timedelta(days=8)).isoformat())]:
        assert client.post('/api/predictions',headers=logged,json={**body,key:value}).status_code==422
    with SessionLocal() as db:
        sat=db.get(Satellite,25544);epoch=sat.epoch;sat.epoch=now()-timedelta(days=10);db.commit()
    try:
        denied=client.post('/api/predictions',headers=logged,json={**body,'acceptStale':False});assert denied.status_code==409
        r=client.post('/api/predictions',headers=logged,json=body).json()['data'];assert r['basis']['staleAtSubmission'] and r['freshness']['stale']
        assert instant(r['basis']['end'])-instant(r['basis']['start'])==timedelta(days=7)
        assert r['basis']['maxEpochDistanceHours']>7*24
    finally:
        with SessionLocal() as db:sat=db.get(Satellite,25544);sat.epoch=epoch;db.commit()

def test_three_day_timezone_equivalence_and_future_epoch_ack(client,logged):
    s=station(client,logged);start=now()+timedelta(minutes=1)
    from datetime import timezone
    body={'stationId':s['id'],'noradId':25544,'start':start.astimezone(timezone(timedelta(hours=8))).isoformat(),'days':3,'minElevation':90,'acceptStale':True}
    result=client.post('/api/predictions',headers=logged,json=body).json()['data']
    assert instant(result['basis']['start'])==start
    assert instant(result['basis']['end'])-start==timedelta(days=3)
    with SessionLocal() as db:
        sat=db.get(Satellite,25544);epoch=sat.epoch;sat.epoch=now()+timedelta(hours=2);db.commit()
    try:
        assert client.post('/api/predictions',headers=logged,json={**body,'acceptStale':False}).status_code==409
        result=client.post('/api/predictions',headers=logged,json=body).json()['data']
        assert result['freshness']['futureEpoch']
    finally:
        with SessionLocal() as db:db.get(Satellite,25544).epoch=epoch;db.commit()

def test_task_queue_completion_snapshot_pagination_and_retention(client,logged):
    task=submit(client,logged,days=7);id=task['id'];assert task['status']=='queued'
    assert execute_next()
    result=client.get('/api/predictions/'+id,headers=logged).json()['data'];assert result['status']=='completed' and result['progress']==100
    assert result['finishedAt'] and len(result['basis']['orbit']['version'])==64
    listing=client.get(f'/api/predictions/{id}/results?size=2&sort=elevation',headers=logged).json()
    assert listing['total']>2 and len(listing['list'])==2
    assert listing['list'][0]['max_elevation']>=listing['list'][1]['max_elevation']
    event=client.get(f"/api/predictions/{id}/events/{listing['list'][0]['id']}",headers=logged).json()['data']
    assert len(event['curve'])>=2 and all(len(row)==8 for row in event['curve'])
    visual=client.get(f'/api/predictions/{id}/results?visual=true',headers=logged).json()
    assert all(x['visible_windows'] for x in visual['list'])
    station_id=task['basis']['station']['id'];client.delete('/api/stations/'+station_id,headers=logged)
    assert client.get('/api/predictions/'+id,headers=logged).json()['data']['basis']==task['basis']
    # New session proves no process-local result store is involved.
    with SessionLocal() as db:assert len(db.get(Prediction,id).results)==result['total']
    assert client.post(f'/api/predictions/{id}/cancel',headers=logged).json()['data']['status']=='completed'

def test_private_tasks_and_cancel_queued(client,logged):
    task=submit(client,logged);other=authorization(register(client)[0]);id=task['id']
    for suffix in ['', '/results','/events/1']:
        assert client.get('/api/predictions/'+id+suffix,headers=other).status_code==404
    assert client.post(f'/api/predictions/{id}/cancel',headers=other).status_code==404
    assert client.get('/api/predictions',headers=other).json()['total']==0
    assert client.post(f'/api/predictions/{id}/cancel',headers=logged).json()['data']['status']=='cancelled'
    assert not execute_next()

def test_running_cancel_wins_completion_race(client,logged):
    task=submit(client,logged);started=threading.Event();release=threading.Event()
    def blocked(basis,checkpoint):started.set();assert release.wait(10);return [{'id':'fake-result'}]
    with patch('backend.app.services.predictions.calculate',blocked):
        thread=threading.Thread(target=execute_next);thread.start();assert started.wait(10)
        assert client.get('/api/predictions/'+task['id'],headers=logged).json()['data']['status']=='running'
        r=client.post('/api/predictions/'+task['id']+'/cancel',headers=logged).json()['data'];assert r['status']=='cancelling'
        release.set();thread.join(10);assert not thread.is_alive()
    r=client.get('/api/predictions/'+task['id'],headers=logged).json()['data'];assert r['status']=='cancelled' and r['total']==0

def test_propagation_failure_and_restart_recovery(client,logged):
    t=submit(client,logged)
    with SessionLocal() as db:
        row=db.get(Prediction,t['id']);b=copy.deepcopy(row.basis);b['orbit']['raw']['MEAN_MOTION']=-1;row.basis=b;db.commit()
    execute_next();assert client.get('/api/predictions/'+t['id'],headers=logged).json()['data']['errorCode']=='ORBIT_PROPAGATION_FAILED'
    t=submit(client,logged)
    with SessionLocal() as db:row=db.get(Prediction,t['id']);row.status='running';db.commit()
    assert not execute_next()
    assert client.get('/api/predictions/'+t['id'],headers=logged).json()['data']['errorCode']=='WORKER_INTERRUPTED'

def test_queue_bound_and_missing_resources(client,logged):
    for _ in range(3):submit(client,logged)
    s=station(client,logged);body={'stationId':s['id'],'noradId':25544,'start':now().isoformat(),'acceptStale':True}
    assert client.post('/api/predictions',headers=logged,json=body).status_code==429
    assert client.post('/api/predictions',headers=logged,json={**body,'noradId':999999998}).status_code==404
    assert client.get('/api/predictions').status_code==401

def independent_elevation(raw,lat,lng,dt):
    # Independent WGS84 ENU transform + GMST1982 TEME rotation (zero polar motion).
    sat=from_omm(raw).model;t=TS.from_datetime(dt)
    jd,fr=jday(dt.year,dt.month,dt.day,dt.hour,dt.minute,dt.second+dt.microsecond/1e6)
    code,r,_=sat.sgp4(jd,fr);assert code==0
    c=(float(t.ut1)-2451545)/36525
    theta=math.radians(((67310.54841+(876600*3600+8640184.812866)*c+.093104*c*c-6.2e-6*c*c*c)/240)%360)
    x,y,z=r;ecef=np.array([math.cos(theta)*x+math.sin(theta)*y,-math.sin(theta)*x+math.cos(theta)*y,z])*1000
    phi,lam=math.radians(lat),math.radians(lng);e2=1-(1-1/298.257223563)**2;n=6378137/math.sqrt(1-e2*math.sin(phi)**2)
    ground=np.array([n*math.cos(phi)*math.cos(lam),n*math.cos(phi)*math.sin(lam),n*(1-e2)*math.sin(phi)])
    delta=ecef-ground;up=np.dot(delta,[math.cos(phi)*math.cos(lam),math.cos(phi)*math.sin(lam),math.sin(phi)])
    return math.degrees(math.asin(up/np.linalg.norm(delta)))

def test_independent_reference_endpoints_peak_and_seven_day_performance():
    b=basis(days=7);begin=time.perf_counter();result=calculate(b);elapsed=time.perf_counter()-begin
    assert len(result)==40 and elapsed<5
    errors=[]
    for item in result:
        for endpoint in ['start','end']:
            dt=instant(item[endpoint]);e=independent_elevation(b['orbit']['raw'],39.9,116.4,dt)
            errors.append(abs(e-10));assert abs(e-10)<.08
        p=independent_elevation(b['orbit']['raw'],39.9,116.4,instant(item['peak']))
        assert abs(p-item['max_elevation'])<.003
        assert item['duration_s']>0 and 0<=item['start_azimuth']<=360
    Path('docs/evidence/phase5-numerical-2026-11-15.json').write_text(json.dumps({'passes':len(result),'sevenDaySeconds':elapsed,'maxEndpointElevationErrorDeg':max(errors),'visualWindows':sum(len(x['visible_windows']) for x in result),'reference':'Independent GMST1982 TEME→ECEF and WGS84 ENU; shared SGP4 theory, not independent real observations','firstPass':{k:v for k,v in result[0].items() if k!='curve'}},indent=2),encoding='utf-8')

def test_no_pass_boundary_and_continuous_geostationary():
    assert calculate(basis(lat=90))==[]
    b=basis();first=calculate(b)[0];b['start']=first['peak'];b['end']=(instant(first['end'])+timedelta(seconds=30)).isoformat()
    r=calculate(b);assert r[0]['partial_start'] and not r[0]['partial_end']
    b=basis();b['start']=(instant(first['start'])-timedelta(seconds=30)).isoformat();b['end']=first['peak']
    r=calculate(b);assert not r[0]['partial_start'] and r[0]['partial_end']
    geo=next(x for x in ROWS if float(x['MEAN_MOTION'])<1.1)
    b=basis(int(geo['NORAD_CAT_ID']),lat=0,lng=110)
    # Position observer at GEO sub-longitude to ensure a genuine continuous interval.
    from backend.phase1.orbits import state_at
    b['station']['longitude']=state_at(from_omm(geo),b['start'])['lng']
    r=calculate(b);assert len(r)==1 and r[0]['continuous'] and abs(r[0]['duration_s']-86400)<.01

def test_multiple_optical_subwindows_and_cancellation_checkpoint():
    start=instant('2026-11-12T00:00:00Z');times=[start+timedelta(seconds=i*5) for i in range(6)]
    predicate=lambda dt:2<(dt-start).total_seconds()<8 or 12<(dt-start).total_seconds()<22
    r=eligible_windows(times,[predicate(dt) for dt in times],predicate)
    assert len(r)==2 and abs((instant(r[0]['start'])-start).total_seconds()-2)<.25
    def cancelled(_):raise Cancelled()
    with pytest.raises(Cancelled):calculate(basis(),cancelled)

def test_real_optical_intervals_satisfy_three_conditions_and_zenith_threshold():
    from backend.phase1.orbits import conditions,load_ephemeris,observer
    b=basis(days=3);r=calculate(b);ephem=load_ephemeris();sat=from_omm(b['orbit']['raw']);site=observer(39.9,116.4)
    try:
        windows=[w for event in r for w in event['visible_windows']];assert len(windows)==4
        for w in windows:
            dt=instant(w['start'])+(instant(w['end'])-instant(w['start']))/2
            c=conditions(sat,site,dt,ephem)
            assert c['elevation']>=10 and c['sun_altitude'] < -6 and c['sunlit']
        assert calculate(basis(minimum=90))==[]
    finally:ephem.close()

def test_real_sgp4_decay_failure():
    b=basis();b['orbit']=copy.deepcopy(b['orbit']);b['orbit']['raw']['MEAN_MOTION']=99
    with pytest.raises(ValueError):calculate(b)
