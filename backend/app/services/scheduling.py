"""Independent bounded jobs, persistent schedules, per-job PostgreSQL leases."""
import json,math,ssl,urllib.request,urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timedelta,timezone
from sqlalchemy import select,func,text
from sqlalchemy.dialects.postgresql import insert
from ..db import SessionLocal,engine
from ..models import RuntimeState,Satellite,JobRun,DataSource,now
from ..core import cache
from .collection import collect,create_run

INTERVALS={'orbit':7200,'iss':10,'statistics':300,'environment':600,'metadata':86400,'recovery':86400}
LOCKS={'orbit':847241,'iss':847242,'statistics':847243,'environment':847244,'metadata':847245,'recovery':847246}

def read(key):
    with SessionLocal() as db:
        row=db.get(RuntimeState,key)
        return dict(row.value) if row else None

def write(key,value):
    with SessionLocal() as db,db.begin():
        stmt=insert(RuntimeState).values(key=key,value=value,updated_at=now())
        db.execute(stmt.on_conflict_do_update(index_elements=['key'],set_={'value':value,'updated_at':now()}))

def iss_position(downloader=None):
    from .operations import require_external
    require_external()
    req=urllib.request.Request('https://api.wheretheiss.at/v1/satellites/25544?units=kilometers',headers={'User-Agent':'StarNexus-Course/0.4','Accept':'application/json'})
    # No automatic retries or redirects; failures retain the previous valid value.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    context=ssl.create_default_context()
    import certifi
    context.load_verify_locations(certifi.where())
    if downloader:payload,_=downloader(req.full_url)
    else:
        with urllib.request.build_opener(NoRedirect(),urllib.request.HTTPSHandler(context=context)).open(req,timeout=6) as response:payload=response.read(262145)
    if len(payload)>262144:raise ValueError('ISS_PAYLOAD_TOO_LARGE')
    data=json.loads(payload)
    values=[float(data[k]) for k in ('latitude','longitude','altitude','velocity','timestamp')]
    lat,lng,alt,speed,stamp=values
    if not all(math.isfinite(x) for x in values) or data.get('id')!=25544 or data.get('units')!='kilometers' or not(-90<=lat<=90 and -180<=lng<=180 and 200<alt<600 and 0<speed<40000):raise ValueError('ISS_RESPONSE_INVALID')
    source_time=datetime.fromtimestamp(stamp,timezone.utc)
    if abs((now()-source_time).total_seconds())>300:raise ValueError('ISS_SOURCE_TIME_INVALID')
    value={'latitude':lat,'longitude':lng,'altitudeKm':alt,'velocityKmS':speed/3600,'sourceTime':source_time.isoformat(),'fetchedAt':now().isoformat(),'source':'Where the ISS at?','positionType':'external_calculated_position'}
    write('iss:last_good',value);cache.put('iss:last_good',value,60)
    return {'sourceTime':value['sourceTime']}

def statistics():
    from .statistics import aggregate
    value=aggregate()
    write('statistics:last_good',value);cache.put('statistics:last_good',value,300)
    return value

def metadata():
    from .collection import source
    from .operations import require_external
    require_external()
    body,request=source.fetch('satcat_active','https://celestrak.org/satcat/records.php?GROUP=ACTIVE&FORMAT=JSON',86400)
    if body is None:raise ValueError('METADATA_SOURCE_UNAVAILABLE')
    rows=json.loads(body)
    if not isinstance(rows,list) or not rows:raise ValueError('METADATA_FORMAT_INVALID')
    values={}
    for row in rows:
        if not isinstance(row,dict) or not isinstance(row.get('NORAD_CAT_ID'),int) or not {'OWNER','OBJECT_TYPE','LAUNCH_DATE'}.intersection(row):raise ValueError('METADATA_FORMAT_INVALID')
        if row['NORAD_CAT_ID'] in values:raise ValueError('METADATA_DUPLICATE_ID')
        values[row['NORAD_CAT_ID']]=row
    count=0
    with SessionLocal() as db,db.begin():
        for sat in db.scalars(select(Satellite).where(Satellite.norad_id.in_(values))):
            raw=values[sat.norad_id];merged={**sat.metadata_raw,**{k:v for k,v in raw.items() if v not in (None,'')}};sat.metadata_raw=merged;sat.owner=merged.get('OWNER') or None;sat.object_type=merged.get('OBJECT_TYPE') or None;sat.launch_date=merged.get('LAUNCH_DATE') or None;count+=1
    return {'records':count,'delivery':request.get('delivery'),'sourceFetchedAt':request.get('attempted_at')}

def orbit():
    run=create_run('scheduled');count=collect(run)
    if count is None:raise ValueError('ORBIT_COLLECTION_FAILED')
    return {'runId':run,'records':count}

from .weather import collect_all
JOBS={'orbit':orbit,'iss':iss_position,'statistics':statistics,'environment':collect_all,'metadata':metadata}

def execute(name,force=False,clock=now,run_id=None):
    # A queued manual run has priority: avoid taking/releasing the same lease every
    # scheduler tick just before its consumer, which could starve the queue.
    if run_id is None:
        with SessionLocal() as db:
            if db.scalar(select(JobRun.id).where(JobRun.job==name,JobRun.status=='queued').limit(1)):return False
    with engine.connect() as lease:
        if not lease.scalar(text('SELECT pg_try_advisory_lock(:key)'),{'key':LOCKS[name]}):return False
        try:
            stamp=clock();previous=read('job:'+name) or {}
            interrupted=previous.get('status')=='running'
            with SessionLocal() as db:
                interrupted=interrupted or bool(db.scalar(select(JobRun.id).where(JobRun.job==name,JobRun.status=='running').limit(1)))
            if not force and not interrupted and previous.get('nextAt') and datetime.fromisoformat(previous['nextAt'])>stamp:return False
            with SessionLocal() as db,db.begin():
                db.execute(text('SELECT pg_advisory_xact_lock(:key)'),{'key':LOCKS[name]+1000})
                # Owning the session lease proves an old running row has no live executor.
                for old in db.scalars(select(JobRun).where(JobRun.job==name,JobRun.status=='running')):
                    old.status='failed';old.finished_at=stamp;old.error_code='WORKER_INTERRUPTED'
                db.flush()
                if run_id:
                    task=db.get(JobRun,run_id,with_for_update=True)
                    if not task or task.status!='queued':return False
                else:
                    if db.scalar(select(JobRun.id).where(JobRun.job==name,JobRun.status=='queued').limit(1)):return False
                    task=JobRun(job=name,status='queued',mode='scheduled');db.add(task);db.flush()
                task.status='running';task.started_at=stamp;run_id=task.id
            state=dict(previous,status='running',attemptedAt=stamp.isoformat(),nextAt=(stamp+timedelta(seconds=INTERVALS[name])).isoformat(),intervalSeconds=INTERVALS[name])
            state['recoveredFromInterrupted']=interrupted
            write('job:'+name,state)
            try:
                from .operations import require_external,recover_sources
                if name in ['orbit','iss','metadata','environment']:require_external()
                result=recover_sources() if name=='recovery' else JOBS[name]()
                if name=='recovery' and not result.get('recovered'):raise ValueError('RECOVERY_PARTIAL_FAILURE')
                partial=name=='environment' and any(x.get('status')!='success' for x in result.get('sources',[]))
                state.update(status='partial' if partial else 'success',result=result,errorCode='PARTIAL_SOURCE_FAILURE' if partial else None,consecutiveFailures=0)
                if not partial:state['lastSuccessAt']=clock().isoformat()
            except Exception as error:
                failures=previous.get('consecutiveFailures',0)+1
                delay=min(3600,max(INTERVALS[name],60*2**min(failures-1,6)))
                if isinstance(error,urllib.error.HTTPError):
                    retry=error.headers.get('Retry-After','')
                    if retry.isdigit():delay=max(delay,min(int(retry),86400))
                    code='UPSTREAM_HTTP_'+str(error.code)
                else:code=str(error) if str(error) in ['DEMO_SOURCE_FAILURE','RECOVERY_PARTIAL_FAILURE','METADATA_SOURCE_UNAVAILABLE','ALL_WEATHER_SOURCES_FAILED'] else 'JOB_FAILED'
                state.update(status='failed',errorCode=code,consecutiveFailures=failures,nextAt=(clock()+timedelta(seconds=delay)).isoformat())
            state['finishedAt']=clock().isoformat();write('job:'+name,state)
            with SessionLocal() as db,db.begin():
                task=db.get(JobRun,run_id);task.status=state['status'];task.finished_at=clock();task.error_code=state.get('errorCode');task.result={**task.result,**(state.get('result',{}) if state['status'] in ['success','partial'] else {'checks':(read('demo:external') or {}).get('checks',[])} if name=='recovery' else {})}
            history=read('history:'+name) or {'list':[]}
            history['list']=(history['list']+[{'attemptedAt':state['attemptedAt'],'finishedAt':state['finishedAt'],'status':state['status'],'errorCode':state.get('errorCode')}])[-100:]
            write('history:'+name,history)
            return True
        finally:
            lease.execute(text('SELECT pg_advisory_unlock(:key)'),{'key':LOCKS[name]});lease.commit()

def serve(stop):
    # Separate futures prevent a slow orbit request from blocking the ISS schedule.
    futures={}
    from .predictions import execute_next
    from .reminders import dispatch
    from .operations import execute_manual
    recovered=False
    def reminder_tick():
        nonlocal recovered
        # Retry recovery if the database is temporarily unavailable at startup.
        result=dispatch(recovery=not recovered);recovered=True;return result
    with ThreadPoolExecutor(max_workers=8,thread_name_prefix='collector') as pool:
        while not stop.is_set():
            for name in [*JOBS,'predictions','reminders','manuals']:
                if name not in futures or futures[name].done():
                    if name in futures:
                        try:futures[name].result()
                        except Exception:pass  # DB unavailable; next tick retries without logging secrets.
                    futures[name]=pool.submit(execute_next) if name=='predictions' else pool.submit(reminder_tick) if name=='reminders' else pool.submit(execute_manual) if name=='manuals' else pool.submit(execute,name)
            stop.wait(1)
