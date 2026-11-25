"""Persistent admin tasks, explicit fault injection, and real recovery probes."""
import json
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from fastapi import HTTPException
from sqlalchemy import select,text
from ..db import SessionLocal
from ..models import RuntimeState,JobRun,AdminAudit,now

DEMO_KEY='demo:external'
class DemoFailure(ValueError):pass

def demo_state():
    with SessionLocal() as db:
        row=db.get(RuntimeState,DEMO_KEY)
        return dict(row.value) if row else {'phase':'normal','checks':[]}

def require_external():
    if demo_state().get('phase')=='active':raise DemoFailure('DEMO_SOURCE_FAILURE')

def enqueue(job,user,db,limited=True,request_id=None):
    from .scheduling import LOCKS
    if job not in LOCKS:raise HTTPException(404,'SOURCE_NOT_FOUND')
    db.execute(text('SELECT pg_advisory_xact_lock(:key)'),{'key':LOCKS[job]+1000})
    previous=db.scalar(select(JobRun).where(JobRun.job==job,JobRun.status.in_(['queued','running'])).order_by(JobRun.created_at).limit(1))
    if previous:return previous,True
    if limited and db.scalar(select(JobRun.id).where(JobRun.job==job,JobRun.mode=='manual',JobRun.created_at>now()-timedelta(seconds=60)).limit(1)):
        raise HTTPException(429,'MANUAL_REFRESH_LIMIT',headers={'Retry-After':'60'})
    row=JobRun(job=job,status='queued',mode='manual',actor_id=user.id,result={'requestId':request_id} if request_id else {});db.add(row);db.flush()
    db.add(AdminAudit(actor_id=user.id,action='enqueue',target=row.id,data={'job':job}));return row,False

def execute_manual():
    from .scheduling import execute
    with SessionLocal() as db:
        row=db.scalar(select(JobRun).where(JobRun.status=='queued').order_by(JobRun.created_at).limit(1))
        if not row:return False
        id,job=row.id,row.job
    return execute(job,force=True,run_id=id)

def recover_sources():
    from .weather import download,parse
    from .scheduling import iss_position,write
    definitions=[('orbit','https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=JSON'),('metadata','https://celestrak.org/satcat/records.php?CATNR=25544&FORMAT=JSON'),
                 ('iss',None),('noaa-kp','https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'),('gfz-kp','https://www-app3.gfz-potsdam.de/kp_index/Kp_ap_Ap_SN_F107_nowcast.txt')]
    def probe(entry):
        name,url=entry
        try:
            if name=='iss':iss_position(downloader=download)
            else:
                body,_=download(url)
                if name in ['noaa-kp','gfz-kp']:
                    from .weather import stamp
                    parsed=parse(name,body)
                    latest=max(stamp(p['time']) for p in parsed['points'])
                    if now()-latest>timedelta(hours=6):raise ValueError('Source data stale')
                else:
                    data=json.loads(body)
                    if not isinstance(data,list) or not any(int(r.get('NORAD_CAT_ID',0))==25544 for r in data):raise ValueError('Invalid source format')
                    row=next(r for r in data if int(r.get('NORAD_CAT_ID',0))==25544)
                    if name=='orbit':
                        from backend.phase1.orbits import from_omm
                        from_omm(row)
                    elif not {'OWNER','OBJECT_TYPE','LAUNCH_DATE'}.intersection(row):raise ValueError('Invalid metadata format')
            return {'source':name,'status':'success','checkedAt':now().isoformat(),'scope':'实际连通性与格式检查；非全量采集'}
        except Exception:return {'source':name,'status':'failed','errorCode':'RECOVERY_CHECK_FAILED','checkedAt':now().isoformat()}
    with ThreadPoolExecutor(max_workers=5,thread_name_prefix='recovery') as pool:checks=list(pool.map(probe,definitions))
    state=demo_state();state.update(phase='normal' if all(x['status']=='success' for x in checks) else 'degraded',checks=checks,checkedAt=now().isoformat())
    write(DEMO_KEY,state)
    if state['phase']=='degraded':return {'checks':checks,'recovered':False,'errorCode':'RECOVERY_PARTIAL_FAILURE'}
    return {'checks':checks,'recovered':True}
