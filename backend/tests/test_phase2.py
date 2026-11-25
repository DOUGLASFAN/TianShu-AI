"""Integration tests against isolated real PostgreSQL and Redis (DB 15)."""
import json,uuid
from datetime import timedelta
from unittest.mock import patch
import jwt,pytest
from fastapi.testclient import TestClient
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import func,inspect,select,text
from backend.app.main import app
from backend.app.db import engine,SessionLocal
from backend.app.models import AuthSession,CollectionRun,Favorite,OrbitElement,Satellite,Station,User,now
from backend.app.core import cache
from backend.app.core.config import ROOT,settings
from backend.app.services.collection import collect,create_run


@pytest.fixture
def client():
    with TestClient(app,headers={'Origin':'http://testserver'}) as value:yield value


def register(client):
    name='test_'+uuid.uuid4().hex[:12]
    password='LocalTest-'+uuid.uuid4().hex
    response=client.post('/api/auth/register',json={'username':name,'password':password})
    assert response.status_code==201
    login=client.post('/api/auth/login',json={'username':name,'password':password})
    assert login.status_code==200
    return login.json(),password


def authorization(result):return {'Authorization':'Bearer '+result['accessToken']}


@pytest.fixture(scope='session')
def administrator():
    credentials=json.loads((ROOT/'.local/config/demo-accounts.json').read_text())['admin']
    with TestClient(app,headers={'Origin':'http://testserver'}) as c:
        response=c.post('/api/auth/login',json=credentials)
        assert response.status_code==200
        return response.json()


@pytest.mark.parametrize('url',['/api/satellites','/api/favorites','/api/stations','/api/admin/users','/api/dashboard/summary'])
def test_unauthorized_returns_401(client,url):
    response=client.get(url)
    assert response.status_code==401
    assert response.json()['error']['code']=='AUTH_REQUIRED'
    assert response.json()['requestId']==response.headers['X-Request-ID']


def test_registration_password_hash_and_role_rejection(client):
    result,password=register(client)
    with SessionLocal() as db:
        user=db.get(User,result['user']['id'])
        assert user.password_hash.startswith('$argon2id$') and password not in user.password_hash
        assert user.role=='user'
    denied=client.post('/api/auth/register',json={'username':'evil_'+uuid.uuid4().hex[:5],'password':password,'role':'admin'})
    assert denied.status_code==422 and password not in denied.text
    duplicate=client.post('/api/auth/register',json={'username':result['user']['username'].upper(),'password':password})
    assert duplicate.status_code==409


def test_login_cookie_restore_and_wrong_password(client):
    result,_=register(client)
    cookie=client.cookies.get('star_session')
    assert cookie
    assert client.post('/api/auth/session').json()['user']['id']==result['user']['id']
    response=client.get('/api/auth/me',headers=authorization(result))
    assert response.status_code==200 and 'password' not in response.text
    bad=client.post('/api/auth/login',json={'username':result['user']['username'],'password':'wrong-password-here'})
    assert bad.status_code==401 and 'accessToken' not in bad.text
    rejected=client.post('/api/auth/session',headers={'Origin':'https://untrusted.example'})
    assert rejected.status_code==403
    with TestClient(app) as no_origin:
        no_origin.cookies.set('star_session',cookie,path='/api/auth')
        assert no_origin.post('/api/auth/session').status_code==403


def test_logout_persistently_revokes_session(client):
    result,_=register(client);header=authorization(result)
    assert client.post('/api/auth/logout',headers=header).status_code==200
    assert client.get('/api/auth/me',headers=header).status_code==401
    assert client.post('/api/auth/session').status_code==401
    with TestClient(app) as second:assert second.get('/api/auth/me',headers=header).status_code==401


def test_expired_tampered_and_missing_claims_rejected(client):
    result,_=register(client)
    claims=jwt.decode(result['accessToken'],settings().jwt_secret.get_secret_value(),algorithms=['HS256'],audience='star-nexus-web')
    claims['exp']=now()-timedelta(seconds=5)
    expired=jwt.encode(claims,settings().jwt_secret.get_secret_value(),algorithm='HS256')
    assert client.get('/api/auth/me',headers={'Authorization':'Bearer '+expired}).status_code==401
    missing=jwt.encode({'sub':result['user']['id']},settings().jwt_secret.get_secret_value(),algorithm='HS256')
    assert client.get('/api/auth/me',headers={'Authorization':'Bearer '+missing}).status_code==401
    assert client.get('/api/auth/me',headers={'Authorization':'Bearer nonsense'}).status_code==401


def test_disabled_user_and_last_admin(client,administrator):
    result,password=register(client);admin=authorization(administrator);id=result['user']['id']
    assert client.get('/api/admin/users',headers=authorization(result)).status_code==403
    assert client.patch('/api/admin/users/'+id,json={'enabled':False},headers=admin).status_code==200
    assert client.get('/api/auth/me',headers=authorization(result)).status_code==401
    assert client.post('/api/auth/login',json={'username':result['user']['username'],'password':password}).status_code==401
    assert client.patch('/api/admin/users/'+id,json={'enabled':True},headers=admin).status_code==200
    assert client.get('/api/auth/me',headers=authorization(result)).status_code==401
    assert client.patch('/api/admin/users/'+administrator['user']['id'],json={'enabled':False},headers=admin).status_code==409


def test_favorite_idempotence_and_user_isolation(client):
    a,_=register(client);b,_=register(client);ha,hb=authorization(a),authorization(b)
    for _ in range(2):assert client.post('/api/favorites',json={'noradId':25544},headers=ha).status_code==201
    assert client.get('/api/favorites',headers=ha).json()['total']==1
    assert client.get('/api/favorites',headers=hb).json()['total']==0
    client.delete('/api/favorites/25544',headers=hb)
    assert client.get('/api/favorites',headers=ha).json()['total']==1
    assert client.post('/api/favorites',json={'noradId':999999999},headers=ha).status_code==404


def test_station_crud_cross_user_and_validation(client):
    a,_=register(client);b,_=register(client);ha,hb=authorization(a),authorization(b)
    payload={'name':'测试站','latitude':39.9,'longitude':116.4,'elevation_m':20}
    response=client.post('/api/stations',json=payload,headers=ha)
    assert response.status_code==201;id=response.json()['data']['id']
    assert client.get('/api/stations/'+id,headers=ha).json()['data']['latitude']==39.9
    for method in ('get','patch','delete'):
        kwargs={'headers':hb}
        if method=='patch':kwargs['json']=payload
        assert getattr(client,method)('/api/stations/'+id,**kwargs).status_code==404
    assert client.post('/api/stations',json=dict(payload,user_id=b['user']['id']),headers=ha).status_code==422
    assert client.post('/api/stations',json=dict(payload,latitude=91),headers=ha).status_code==422
    assert client.patch('/api/stations/'+id,json=dict(payload,name='修改后的站'),headers=ha).status_code==200
    assert client.delete('/api/stations/'+id,headers=ha).status_code==200
    assert client.get('/api/stations/'+id,headers=ha).status_code==404


def test_pagination_search_group_and_request_contract(client):
    result,_=register(client);h=authorization(result)
    response=client.get('/api/satellites?page=1&size=5',headers=dict(h,**{'X-Request-ID':'phase2-contract'}))
    data=response.json();assert response.status_code==200 and data['total']>=3 and len(data['list'])<=5
    assert response.headers['X-Request-ID']=='phase2-contract'
    found=client.get('/api/satellites?keyword=25544',headers=h).json()
    assert any(x['noradId']==25544 for x in found['list'])
    assert client.get('/api/satellites?keyword=%27%20OR%201=1',headers=h).status_code==200
    assert client.get('/api/satellites?page=0',headers=h).status_code==422
    assert client.get('/api/satellites?size=999',headers=h).status_code==422
    detail=client.get('/api/satellites/25544',headers=h).json()
    assert detail['meta']['units']['epoch']=='UTC'
    assert detail['data']['dataQuality']['source']=='CelesTrak'


def test_redis_actual_cache_and_fallback(client):
    result,_=register(client);h=authorization(result)
    assert cache.cache.ping()
    client.get('/api/satellites/25544',headers=h)
    assert client.get('/api/satellites/25544',headers=h).json()['meta']['cacheHit']
    with patch.object(cache.cache,'get',side_effect=RedisConnectionError('synthetic outage')):
        response=client.get('/api/satellites/25544',headers=h)
        assert response.status_code==200 and response.json()['data']['noradId']==25544


def test_failed_collection_keeps_valid_data_and_sanitizes_log():
    with SessionLocal() as db:
        before=db.get(Satellite,25544).content_hash
        count=db.scalar(select(func.count()).select_from(Satellite))
    run=create_run('test-invalid-response')
    valid=json.loads((ROOT/'.local/data/source-validation/celestrak/gp_iss.json').read_text()) [0]
    valid=dict(valid,MEAN_MOTION=float(valid['MEAN_MOTION'])+.001)
    payload=json.dumps([valid,dict(valid,NORAD_CAT_ID=25545,ECCENTRICITY=2)]).encode()
    request={'attempted_at':now().isoformat()}
    with patch('backend.app.services.collection.source.fetch',return_value=(payload,request)):
        assert collect(run) is None
    with SessionLocal() as db:
        assert db.get(Satellite,25544).content_hash==before
        assert db.scalar(select(func.count()).select_from(Satellite))==count
        record=db.get(CollectionRun,run)
        assert record.status=='failed' and record.error_code=='COLLECTION_FAILED'


def test_successful_reimport_is_idempotent():
    body=(ROOT/'assets/data/orbits/representative-2026-11-12.json').read_bytes()
    request={'attempted_at':now().isoformat()}
    count=len(json.loads(body))
    with patch('backend.app.services.collection.source.fetch',return_value=(body,request)):
        assert collect(create_run('test-cache-initial'))==count
    with SessionLocal() as db:
        before=db.scalar(select(func.count()).select_from(OrbitElement))
    run=create_run('test-cache-reimport')
    with patch('backend.app.services.collection.source.fetch',return_value=(body,request)):
        assert collect(run)==count
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(OrbitElement))==before
        assert db.get(CollectionRun,run).status=='success'


def test_failed_request_preserves_verified_snapshot(tmp_path, monkeypatch):
    import hashlib
    import urllib.error
    from backend.app.services.collection import source
    monkeypatch.setattr(source, 'CACHE', tmp_path)
    body=b'[{"NORAD_CAT_ID": 25544}]'
    url='https://example.com/gp'
    verified={'url':url,'attempted_at':now().isoformat(),'status':'http_200',
              'sha256':hashlib.sha256(body).hexdigest()}
    (tmp_path/'gp_active.json').write_bytes(body)
    (tmp_path/'gp_active.request.json').write_text(json.dumps(verified))
    def fail(*args,**kwargs):
        raise urllib.error.URLError('stubbed transport interruption')
    monkeypatch.setattr(source.urllib.request, 'build_opener', fail)
    assert source.fetch('gp_active',url,0)[0] is None
    assert source.verified_snapshot('gp_active')==(body,verified)
    (tmp_path/'gp_active.json').write_bytes(b'corrupted')
    with pytest.raises(ValueError, match='SNAPSHOT_HASH_MISMATCH'):
        source.verified_snapshot('gp_active')


def test_real_redis_login_rate_limit():
    # Primary Redis limiter is real; same key reaches its configured bound.
    key='test_'+uuid.uuid4().hex
    assert all(cache.allow_login(key) for _ in range(12))
    assert not cache.allow_login(key)


def test_cache_outage_has_bounded_login_fallback():
    key='outage_'+uuid.uuid4().hex
    with patch.object(cache.cache,'incr',side_effect=RedisConnectionError('synthetic outage')):
        assert all(cache.allow_login(key) for _ in range(12))
        assert not cache.allow_login(key)


def test_missing_metadata_does_not_erase_known_fields():
    from backend.app.services.collection import import_rows
    row=json.loads((ROOT/'.local/data/source-validation/celestrak/gp_iss.json').read_text())[0]
    request=json.loads((ROOT/'.local/data/source-validation/celestrak/gp_iss.request.json').read_text())
    with SessionLocal() as db:
        old=db.get(Satellite,25544)
        owner,launch=old.owner,old.launch_date
    run=create_run('test-missing-metadata')
    import_rows([row],{},request,[],run)
    with SessionLocal() as db:
        current=db.get(Satellite,25544)
        assert current.owner==owner and current.launch_date==launch


def test_real_schema_relations_and_no_superuser():
    inspector=inspect(engine)
    assert len(inspector.get_table_names())>=10
    for table in ['auth_sessions','favorites','observation_stations','orbit_elements','satellite_group_members']:
        assert inspector.get_foreign_keys(table)
    assert inspector.get_indexes('orbit_elements')
    with engine.connect() as db:
        assert db.execute(text('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).scalar() is False
        assert db.execute(text('SELECT count(*) FROM alembic_version')).scalar()==1
