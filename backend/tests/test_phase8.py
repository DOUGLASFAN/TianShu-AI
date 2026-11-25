"""Real PostgreSQL accounting, admin queue races, audit and explicit demo recovery."""
import copy,json,threading,uuid
from datetime import timedelta
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete,select,func
from backend.tests.test_phase6 import client,logged,isolated,completed,station
from backend.tests.test_phase2 import administrator,authorization,register
from backend.app.db import SessionLocal,engine
from backend.app.models import Satellite,SatelliteGroup,GroupMember,JobRun,AdminAudit,RuntimeState,User,AuthSession,now
from backend.app.services import scheduling as jobs
from backend.app.services.statistics import aggregate
from backend.app.services.catalog_filters import orbit_class
from backend.app.services.operations import demo_state,require_external,DemoFailure,enqueue,execute_manual
from backend.app.main import app

@pytest.fixture(autouse=True)
def cleanup_operations():
    assert '_test_' in engine.url.database
    with SessionLocal() as db,db.begin():
        db.execute(delete(JobRun));db.execute(delete(AdminAudit));db.execute(delete(RuntimeState).where(RuntimeState.key.like('job:%')|RuntimeState.key.like('history:%')|RuntimeState.key.in_(['demo:external','statistics:last_good'])))
    yield
    with SessionLocal() as db,db.begin():
        db.execute(delete(Satellite).where(Satellite.norad_id>=900000000));db.execute(delete(SatelliteGroup).where(SatelliteGroup.slug.like('phase8_%')))

def test_orbit_classification_mutually_exclusive_and_invalid_safe():
    configurations=[(15.5,.001,'LEO'),(2,.01,'MEO'),(1.0027,.001,'GEO'),(2,.7,'HEO'),(0,0,'unknown'),(None,None,'unknown')]
    with SessionLocal() as db,db.begin():
        template=db.get(Satellite,25544)
        for i,(motion,ecc,expected) in enumerate(configurations):
            raw=copy.deepcopy(template.orbit_raw);raw.update(MEAN_MOTION=motion,ECCENTRICITY=ecc,INCLINATION=55)
            db.add(Satellite(norad_id=900000000+i,name='Classification fixture',orbit_raw=raw,metadata_raw={},content_hash='fixture',epoch=now(),fetched_at=now(),source='test'))
    with SessionLocal() as db:
        values=dict(db.execute(select(Satellite.norad_id,orbit_class).where(Satellite.norad_id>=900000000)).all())
    assert [values[900000000+i] for i in range(6)]==[x[2] for x in configurations]

def test_aggregation_counts_coverage_unknown_and_calendar_months(client,logged):
    value=aggregate();total=value['activeCount'];assert sum(x['count'] for x in value['orbits'])==total
    assert sum(x['count'] for x in value['owners'])==sum(x['count'] for x in value['purposes'])==total
    assert len(value['launches'])==12 and value['launches']==sorted(value['launches'],key=lambda x:x['month'])
    assert value['coverage']['launchDateKnown']+value['coverage']['launchDateUnknown']==total
    assert value['catalogCount']==value['ownerKnownCount']+value['ownerUnknownCount']
    assert any(x['key']=='unknown' for x in value['purposes'])
    baseline=total
    with SessionLocal() as db,db.begin():
        template=db.get(Satellite,25544)
        db.add(SatelliteGroup(slug='phase8_overlap',name='Overlap fixture'));db.flush()
        db.add(Satellite(norad_id=900000010,name='Accounting fixture',orbit_raw=template.orbit_raw,metadata_raw={'PURPOSE':' '},owner=' ',launch_date='2026-02-30',content_hash='fixture',epoch=now(),fetched_at=now(),source='test'));db.flush()
        db.add_all([GroupMember(group_slug='active',norad_id=900000010),GroupMember(group_slug='phase8_overlap',norad_id=900000010)])
    other=aggregate();assert other['activeCount']==baseline+1 and other['coverage']['launchDateUnknown']==value['coverage']['launchDateUnknown']+1
    assert sum(x['count'] for x in other['orbits'])==baseline+1
    assert other['owners'][-1]['key']==other['purposes'][-1]['key']=='unknown'

def test_statistics_cache_durable_and_stale_metadata(client,logged):
    with patch.object(jobs.cache,'put',return_value=False):value=jobs.statistics()
    response=client.get('/api/dashboard/statistics',headers=logged).json();assert response['data']==value and response['meta']['cacheHit']
    assert response['meta']['storage']=='persistent_postgresql_snapshot'
    old=dict(value,generatedAt=(now()-timedelta(hours=1)).isoformat());jobs.write('statistics:last_good',old)
    assert client.get('/api/dashboard/statistics',headers=logged).json()['meta']['stale']

def test_admin_permissions_user_search_and_unique_admin_protection(client,logged,administrator):
    for path in ['/api/admin/jobs','/api/admin/data-sources','/api/admin/audits']:
        assert client.get(path,headers=logged).status_code==403
    assert client.post('/api/admin/demo',headers=logged,json={'enabled':True}).status_code==403
    who=register(client)[0]['user'];assert client.patch('/api/admin/users/'+who['id'],headers=logged,json={'enabled':False}).status_code==403
    admins=client.get('/api/admin/users?keyword=admin',headers=authorization(administrator)).json()['list'];only=next(x for x in admins if x['role']=='admin')
    assert client.patch('/api/admin/users/'+only['id'],headers=authorization(administrator),json={'enabled':False}).status_code==409
    assert client.get('/api/admin/users?keyword=does_not_exist',headers=authorization(administrator)).json()['total']==0

def test_user_disable_revokes_session_and_audits(client,administrator):
    result,_=register(client);h=authorization(result);user=result['user']
    assert client.patch('/api/admin/users/'+user['id'],headers=authorization(administrator),json={'enabled':False}).status_code==200
    assert client.get('/api/dashboard/statistics',headers=h).status_code==401
    assert client.patch('/api/admin/users/'+user['id'],headers=authorization(administrator),json={'enabled':True}).status_code==200
    assert client.get('/api/dashboard/statistics',headers=h).status_code==401
    actions=client.get('/api/admin/audits',headers=authorization(administrator)).json()['list'];assert {a['action'] for a in actions}=={'user_disabled','user_enabled'}

def test_manual_queue_dedup_rate_limit_request_id_and_execution(client,administrator):
    one=client.post('/api/admin/data-sources/statistics/refresh',headers={**authorization(administrator),'X-Request-ID':'phase8-request'})
    assert one.status_code==202;id=one.json()['data']['taskId']
    two=client.post('/api/admin/data-sources/statistics/refresh',headers=authorization(administrator));assert two.json()['data']['taskId']==id and two.json()['data']['existing']
    assert execute_manual()
    detail=client.get('/api/admin/jobs/'+id,headers=authorization(administrator)).json()['data'];assert detail['status']=='success' and detail['result']['requestId']=='phase8-request'
    assert client.post('/api/admin/data-sources/statistics/refresh',headers=authorization(administrator)).status_code==429

def test_concurrent_manual_enqueues_share_task_id(client,administrator):
    user=client.get('/api/admin/users?keyword=admin',headers=authorization(administrator)).json()['list'][0]['id'];ids=[]
    def submit():
        with SessionLocal() as db,db.begin():ids.append(enqueue('statistics',db.get(User,user),db)[0].id)
    threads=[threading.Thread(target=submit) for _ in range(5)]
    for t in threads:t.start()
    for t in threads:t.join(10);assert not t.is_alive()
    assert len(ids)==5 and len(set(ids))==1

def test_persistent_job_pagination_details_failure_and_redaction(client,administrator):
    for _ in range(12):
        with patch.dict(jobs.JOBS,{'statistics':lambda:(_ for _ in ()).throw(RuntimeError('secret_password_should_never_appear'))}):assert jobs.execute('statistics',force=True)
    first=client.get('/api/admin/jobs?status=failed&job=statistics',headers=authorization(administrator)).json();second=client.get('/api/admin/jobs?status=failed&job=statistics&page=2',headers=authorization(administrator)).json();assert first['total']==12 and len(second['list'])==2
    assert all(x['errorCode']=='JOB_FAILED' for x in first['list'])
    assert 'secret_password_should_never_appear' not in json.dumps(first)
    assert client.get('/api/admin/jobs/'+first['list'][0]['id'],headers=authorization(administrator)).status_code==200

def test_interrupted_running_job_is_failed_then_retried(client,administrator):
    with SessionLocal() as db,db.begin():row=JobRun(job='statistics',mode='manual',status='running',started_at=now());db.add(row);db.flush();id=row.id
    jobs.write('job:statistics',{'status':'success','nextAt':(now()+timedelta(days=1)).isoformat()})
    assert jobs.execute('statistics')
    old=client.get('/api/admin/jobs/'+id,headers=authorization(administrator)).json()['data'];assert old['status']=='failed' and old['errorCode']=='WORKER_INTERRUPTED'

def test_demo_global_gate_logs_and_recovery_never_fabricates_success(client,logged,administrator):
    jobs.write('iss:last_good',{'marker':'retained'})
    assert client.post('/api/admin/demo',headers=authorization(administrator),json={'enabled':True}).status_code==200
    assert client.get('/api/system/status',headers=logged).json()['data']['demo']['phase']=='active'
    with pytest.raises(DemoFailure):require_external()
    assert jobs.execute('iss',force=True,run_id=None) is False # queued demo task owns execution
    while execute_manual():pass
    with SessionLocal() as db:rows=db.scalars(select(JobRun)).all();assert len(rows)==4 and all(r.error_code=='DEMO_SOURCE_FAILURE' for r in rows)
    assert jobs.read('iss:last_good')=={'marker':'retained'}
    r=client.post('/api/admin/demo',headers=authorization(administrator),json={'enabled':False});assert r.status_code==200 and demo_state()['phase']=='recovering'
    require_external() # injection is off while actual checks run
    def fail_recovery():
        state=demo_state();state.update(phase='degraded',checks=[{'source':'test','status':'failed'}]);jobs.write('demo:external',state);return {'recovered':False}
    with patch('backend.app.services.operations.recover_sources',fail_recovery):assert execute_manual()
    assert demo_state()['phase']=='degraded'
    failed=client.get('/api/admin/jobs/'+r.json()['taskId'],headers=authorization(administrator)).json()['data'];assert failed['status']=='failed' and failed['errorCode']=='RECOVERY_PARTIAL_FAILURE'

def test_recovery_success_only_after_all_checks_and_audit(client,administrator):
    from backend.app.services.operations import recover_sources
    client.post('/api/admin/demo',headers=authorization(administrator),json={'enabled':False})
    at=now();body=json.dumps([{'time_tag':at.isoformat(),'Kp':1}]).encode()
    with SessionLocal() as db:gp=copy.deepcopy(db.get(Satellite,25544).orbit_raw)
    def good(url):
        if 'gfz' in url:
            columns=[str(at.year),str(at.month),str(at.day),'0','0','0','0']+['1']*8+['0']*12+['0'];return ' '.join(columns).encode(),{}
        if 'celestrak' in url:return json.dumps([gp if 'elements' in url else {'NORAD_CAT_ID':25544,'OWNER':'ISS'}]).encode(),{}
        return body,{}
    with patch('backend.app.services.weather.download',good),patch('backend.app.services.scheduling.iss_position',return_value={}):assert execute_manual()
    assert demo_state()['phase']=='normal' and all(x['status']=='success' for x in demo_state()['checks'])
    assert client.get('/api/admin/audits',headers=authorization(administrator)).json()['total']>=2

def test_ranking_uses_owned_saved_station_snapshot(client,logged):
    s=station(client,logged);assert client.get('/api/dashboard/ranking?stationId='+s['id'],headers=logged).json()['status']=='no_prediction'
    task=completed(client,logged);id=task['basis']['station']['id']
    result=client.get('/api/dashboard/ranking?stationId='+id,headers=logged).json();assert result['basis']['taskId']==task['id'] and result['list']
    other=authorization(register(client)[0]);assert client.get('/api/dashboard/ranking?stationId='+id,headers=other).status_code==404


def test_metadata_refresh_preserves_known_fields_and_rejects_duplicates():
    from backend.app.services.collection import source
    with SessionLocal() as db:
        sat=db.get(Satellite,25544);saved={k:copy.deepcopy(getattr(sat,k)) for k in ['metadata_raw','owner','object_type','launch_date']}
    try:
        row={'NORAD_CAT_ID':25544,'OWNER':None,'OBJECT_TYPE':'PAY','LAUNCH_DATE':None}
        with patch.object(source,'fetch',return_value=(json.dumps([row]).encode(),{'delivery':'local_cache','attempted_at':now().isoformat()})):
            result=jobs.metadata();assert result['records']==1 and result['delivery']=='local_cache'
        with SessionLocal() as db:assert db.get(Satellite,25544).owner==saved['owner']
        with patch.object(source,'fetch',return_value=(json.dumps([row,row]).encode(),{})):
            with pytest.raises(ValueError,match='METADATA_DUPLICATE_ID'):jobs.metadata()
    finally:
        with SessionLocal() as db,db.begin():
            sat=db.get(Satellite,25544)
            for k,v in saved.items():setattr(sat,k,v)


def test_demo_start_is_idempotent(client,administrator):
    h=authorization(administrator)
    assert client.post('/api/admin/demo',headers=h,json={'enabled':True}).status_code==200
    again=client.post('/api/admin/demo',headers=h,json={'enabled':True}).json();assert again['existing']
    with SessionLocal() as db:assert db.scalar(select(func.count()).select_from(JobRun))==4


def test_partial_weather_run_retains_source_failures_instead_of_success(client,administrator):
    result={'sources':[{'source':'noaa-kp','status':'success'},{'source':'donki-flr','status':'failed'}],'succeeded':1}
    with patch.dict(jobs.JOBS,{'environment':lambda:result}):assert jobs.execute('environment',force=True)
    state=jobs.read('job:environment');assert state['status']=='partial' and state['errorCode']=='PARTIAL_SOURCE_FAILURE' and not state.get('lastSuccessAt')
    rows=client.get('/api/admin/jobs?status=partial',headers=authorization(administrator)).json()['list'];assert len(rows)==1 and rows[0]['result']['sources'][1]['status']=='failed'
