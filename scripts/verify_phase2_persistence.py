"""Restart only project services and verify committed resources and session remain."""
import json,secrets,subprocess,sys,time,uuid
from datetime import datetime,timezone
from pathlib import Path
import httpx
from redis import Redis
from redis.retry import Retry
from redis.backoff import NoBackoff

ROOT=Path(__file__).resolve().parents[1]
private=json.loads((ROOT/'.local/config/local-services.json').read_text())
client=httpx.Client(base_url='http://127.0.0.1:8001',trust_env=False,timeout=10)
username='restart_'+uuid.uuid4().hex[:8];password=secrets.token_urlsafe(20)
created=client.post('/api/auth/register',json={'username':username,'password':password});created.raise_for_status()
login=client.post('/api/auth/login',json={'username':username,'password':password});login.raise_for_status()
header={'Authorization':'Bearer '+login.json()['accessToken']}
client.post('/api/favorites',json={'noradId':25544},headers=header).raise_for_status()
station=client.post('/api/stations',json={'name':'重启持久化验证站','latitude':39.9,'longitude':116.4},headers=header)
station.raise_for_status();station_id=station.json()['data']['id']
before=client.get('/api/satellites?page=1&size=1',headers=header).json()['total']
cache=Redis(host='127.0.0.1',password=private['redis_password'],decode_responses=True,socket_timeout=1,retry=Retry(NoBackoff(),0))
key='phase2:persistence:'+uuid.uuid4().hex;cache.set(key,'persisted',ex=600)
subprocess.run([sys.executable,'scripts/local_services.py','stop'],cwd=ROOT,check=True)
subprocess.run([sys.executable,'scripts/local_services.py','start'],cwd=ROOT,check=True)
for _ in range(30):
    try:
        response=client.get('/api/health/ready')
        if response.status_code==200:break
    except httpx.HTTPError:pass
    time.sleep(.3)
else:raise RuntimeError('API dependencies did not recover after service restart')
assert client.get('/api/auth/me',headers=header).status_code==200
assert client.get('/api/stations/'+station_id,headers=header).json()['data']['name']=='重启持久化验证站'
assert any(row['noradId']==25544 for row in client.get('/api/favorites',headers=header).json()['list'])
assert client.get('/api/satellites?page=1&size=1',headers=header).json()['total']==before
assert cache.get(key)=='persisted'
result={'checked_at':datetime.now(timezone.utc).isoformat(),'postgres_restart':True,'redis_restart':True,
        'catalog_count_before_and_after':before,'session_valid_after_restart':True,'favorite_preserved':True,
        'station_preserved':True,'redis_aof_value_preserved':True,'test_username':username,'all_passed':True}
(ROOT/'docs/evidence/phase2-persistence-2026-11-12.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
client.post('/api/auth/logout',headers=header).raise_for_status()
print(json.dumps(result,ensure_ascii=True))
