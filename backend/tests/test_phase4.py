import json
from datetime import timedelta
from unittest.mock import patch
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from backend.app.main import app
from backend.app.services import scheduling as jobs
from backend.app.api.realtime import consume
from backend.app.models import now
from backend.tests.test_phase2 import register,authorization

@pytest.fixture
def client():
    with TestClient(app,headers={'Origin':'http://testserver'}) as c:yield c

def test_schedule_intervals_persistence_and_failure_preserves_good():
    assert {key:jobs.INTERVALS[key] for key in ['orbit','iss','statistics']}=={'orbit':7200,'iss':10,'statistics':300}
    stamp=now()+timedelta(days=1)
    jobs.write('iss:last_good',{'marker':'preserve'})
    with patch.dict(jobs.JOBS,{'iss':lambda:(_ for _ in ()).throw(ValueError('private URL/password must not leak'))}):
        assert jobs.execute('iss',force=True,clock=lambda:stamp)
    state=jobs.read('job:iss')
    assert state['status']=='failed' and state['errorCode']=='JOB_FAILED'
    assert 'password' not in json.dumps(state)
    assert jobs.read('iss:last_good')=={'marker':'preserve'}
    assert not jobs.execute('iss',clock=lambda:stamp+timedelta(seconds=10))
    with patch.dict(jobs.JOBS,{'iss':lambda:{'ok':True}}):
        assert jobs.execute('iss',clock=lambda:stamp+timedelta(hours=2))
    assert jobs.read('job:iss')['status']=='success'

def test_statistics_unique_and_durable():
    with patch.object(jobs.cache,'put',return_value=False):value=jobs.statistics()
    assert value['catalogCount']==value['ownerKnownCount']+value['ownerUnknownCount']
    assert jobs.read('statistics:last_good')==value

def test_interrupted_job_is_recovered_with_lease():
    stamp=now()
    jobs.write('job:statistics',{'status':'running','nextAt':(stamp+timedelta(hours=2)).isoformat()})
    with patch.dict(jobs.JOBS,{'statistics':lambda:{'recovered':True}}):
        assert jobs.execute('statistics',clock=lambda:stamp)
    assert jobs.read('job:statistics')['recoveredFromInterrupted'] is True

@pytest.mark.parametrize('alteration',[{'latitude':float('nan')},{'timestamp':1},{'units':'miles'}])
def test_invalid_iss_response_preserves_original_timestamp(alteration):
    jobs.write('iss:last_good',{'sourceTime':'2026-11-11T00:00:00+00:00','marker':'valid'})
    payload=dict(id=25544,latitude=40,longitude=120,altitude=410,velocity=27000,timestamp=now().timestamp(),units='kilometers')
    payload.update(alteration)
    with patch('urllib.request.build_opener') as opener:
        opener.return_value.open.return_value.__enter__.return_value.read.return_value=json.dumps(payload).encode()
        with pytest.raises(ValueError):jobs.iss_position()
    assert jobs.read('iss:last_good')=={'sourceTime':'2026-11-11T00:00:00+00:00','marker':'valid'}

def test_ticket_authentication_and_one_use(client):
    assert client.post('/api/realtime/ticket').status_code==401
    credentials,_=register(client)
    result=client.post('/api/realtime/ticket',headers=authorization(credentials))
    assert result.status_code==200 and result.json()['expiresIn']==30
    raw=result.json()['ticket'];assert consume(raw) and consume(raw) is None

def test_ws_snapshot_subscribe_and_ticket_replay(client):
    credentials,_=register(client)
    raw=client.post('/api/realtime/ticket',headers=authorization(credentials)).json()['ticket']
    with client.websocket_connect('/api/realtime/ws',headers={'Origin':'http://testserver'}) as ws:
        ws.send_json({'type':'auth','ticket':raw});first=ws.receive_json()
        assert first['type']=='snapshot' and first['seq']==1
        notice=ws.receive_json();assert notice['type']=='notifications' and notice['seq']==2
        ws.send_json({'type':'subscribe','noradId':25544});message=ws.receive_json()
        assert message['type']=='trajectory' and message['seq']==3 and message['data']['data']['noradId']==25544
    with client.websocket_connect('/api/realtime/ws',headers={'Origin':'http://testserver'}) as ws:
        ws.send_json({'type':'auth','ticket':raw})
        with pytest.raises(WebSocketDisconnect) as error:ws.receive_json()
        assert error.value.code==4401

def test_wrong_origin_rejected(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/api/realtime/ws',headers={'Origin':'https://untrusted.invalid'}):pass

def test_active_socket_revoked_after_logout(client):
    credentials,_=register(client);headers=authorization(credentials)
    raw=client.post('/api/realtime/ticket',headers=headers).json()['ticket']
    with client.websocket_connect('/api/realtime/ws',headers={'Origin':'http://testserver'}) as ws:
        ws.send_json({'type':'auth','ticket':raw});assert ws.receive_json()['type']=='snapshot'
        assert ws.receive_json()['type']=='notifications'
        client.post('/api/auth/logout',headers=headers)
        with pytest.raises(WebSocketDisconnect) as error:ws.receive_json()
        assert error.value.code==4401

def test_facets_unknown_and_filters(client):
    credentials,_=register(client);headers=authorization(credentials)
    facets=client.get('/api/catalog/facets',headers=headers).json()['data']
    total=client.get('/api/satellites',headers=headers).json()['total']
    for name in ('countries','purposes','orbits'):assert sum(x['count'] for x in facets[name])==total
    for key,name in [('country','countries'),('use','purposes'),('orbit','orbits')]:
        chosen=facets[name][0]
        result=client.get('/api/satellites',params={key:chosen['value']},headers=headers)
        assert result.status_code==200 and result.json()['total']==chosen['count']

def test_ticket_expires_and_logout_revokes(client):
    from backend.app.db import SessionLocal
    from backend.app.models import RuntimeState
    import hashlib
    credentials,_=register(client);headers=authorization(credentials)
    raw=client.post('/api/realtime/ticket',headers=headers).json()['ticket']
    with SessionLocal() as db,db.begin():
        row=db.get(RuntimeState,'ws:'+hashlib.sha256(raw.encode()).hexdigest()[:60]);value=dict(row.value,expiresAt=(now()-timedelta(seconds=1)).isoformat());row.value=value
    assert consume(raw) is None
    raw=client.post('/api/realtime/ticket',headers=headers).json()['ticket']
    client.post('/api/auth/logout',headers=headers)
    assert consume(raw) is None

def test_global_coordinates_and_snapshot(tmp_path):
    import numpy as np
    from backend.app.services import global_scene as gs
    from backend.app.db import SessionLocal
    from backend.app.models import Satellite
    from backend.phase1.orbits import from_omm,state_at
    from sqlalchemy.exc import OperationalError
    with patch.object(gs,'PATH',tmp_path/'global.json'),patch.object(gs,'_snapshot',None):
        data=gs.overview()
        from datetime import timedelta
        from backend.phase1.orbits import instant
        generated=instant(data['generatedAt'])
        assert generated-instant(data['start'])==timedelta(seconds=15)
        assert instant(data['end'])-generated==timedelta(seconds=45)
        assert data['catalogCount']==data['renderedCount']+data['failedCount'] and not data['truncated']
        point=data['points'][0]
        with SessionLocal() as db:reference=state_at(from_omm(db.get(Satellite,point[0]).orbit_raw),data['start'])
        assert np.linalg.norm(np.asarray(point[1:4])-reference['ecef_m'])<.02
        with patch.object(gs,'_snapshot',None),patch.object(gs,'SessionLocal',side_effect=OperationalError('unavailable',{},None)):
            fallback=gs.overview()
        assert fallback['delivery']=='snapshot' and fallback['generatedAt']==data['generatedAt']
