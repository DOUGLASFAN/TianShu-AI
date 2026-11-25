"""Durable single-star queue, executed outside the API process under a PG lease."""
from sqlalchemy import select,text,delete
from sqlalchemy.dialects.postgresql import insert
from datetime import datetime,timedelta
from concurrent.futures import ThreadPoolExecutor,ProcessPoolExecutor,as_completed,TimeoutError as FutureTimeout
from threading import Event,Thread
import multiprocessing
import os
import hashlib,json,time
from ..db import SessionLocal,engine
from ..models import Prediction,PredictionEvent,PredictionCache,now
from .prediction_math import calculate,Cancelled

ACTIVE=('queued','running','cancelling')

def cache_key(basis):
    from .prediction_math import ALGORITHM
    station=basis['station']
    values={'algorithm':ALGORITHM,'orbitVersion':basis['orbit']['version'],'raw':basis['orbit']['raw'],
            'station':{k:station[k] for k in ['latitude','longitude','elevation_m']},
            'start':basis['start'],'end':basis['end'],'days':basis['days'],'minimum':basis['minElevation'],'solar':-6}
    return hashlib.sha256(json.dumps(values,sort_keys=True,separators=(',',':')).encode()).hexdigest()

_process_stop=None

def initialize_math_process(stop):
    global _process_stop
    _process_stop=stop
    # Windows Stop-Process can kill the worker without its Python finally blocks.
    # Each math child watches the actual parent handle, so no orphan pool survives.
    parent=multiprocessing.parent_process()
    def watch_parent():
        while parent is not None:
            if not parent.is_alive():os._exit(0)
            time.sleep(.5)
    Thread(target=watch_parent,daemon=True,name='parent-lifetime').start()

def process_calculate(basis):
    def check(_):
        if _process_stop.is_set():raise Cancelled()
    return calculate(basis,check)

def cached_calculate(basis,checkpoint,math_calculate=None):
    key=cache_key(basis)
    with SessionLocal() as db:
        cached=db.get(PredictionCache,key)
        if cached and cached.created_at>now()-timedelta(hours=2):checkpoint(99);return cached.results,True,cached.created_at.isoformat()
    result=(math_calculate or calculate)(basis,checkpoint)
    calculated_at=now()
    with SessionLocal() as db:
        db.execute(insert(PredictionCache).values(key=key,results=result,created_at=calculated_at).on_conflict_do_update(index_elements=['key'],set_={'results':result,'created_at':calculated_at}))
        db.execute(delete(PredictionCache).where(PredictionCache.created_at<now()-timedelta(hours=2)));db.commit()
    return result,False,calculated_at.isoformat()

def calculate_group(id,basis,checkpoint):
    targets=basis['targets'];execution={'totalSatellites':len(targets),'completedSatellites':0,'failures':[],'cacheHits':0,'eventCount':0}
    stop=Event()
    process_pool=None;process_stop=None
    if len(targets)>=25:
        context=multiprocessing.get_context('spawn');process_stop=context.Event()
        process_pool=ProcessPoolExecutor(max_workers=4,mp_context=context,initializer=initialize_math_process,initargs=(process_stop,))
    def math_calculate(basis,checkpoint):
        if process_pool is None:return calculate(basis,checkpoint)
        future=process_pool.submit(process_calculate,basis)
        while True:
            checkpoint(0)
            try:return future.result(timeout=.25)
            except FutureTimeout:continue
    def work(target):
        def check(_):
            if stop.is_set():raise Cancelled()
            try:checkpoint(int(execution['completedSatellites']/len(targets)*99))
            except Cancelled:stop.set();raise
        sub={k:v for k,v in basis.items() if k not in ['targets','group','kind']};sub.update(target)
        check(0)
        return cached_calculate(sub,check,math_calculate)
    pool=ThreadPoolExecutor(max_workers=4,thread_name_prefix='prediction')
    futures={pool.submit(work,target):target for target in targets}
    try:
        for future in as_completed(futures):
            target=futures[future]
            try:
                results,hit,calculated_at=future.result()
                checkpoint(int(execution['completedSatellites']/len(targets)*99))
                with SessionLocal() as db:
                    for item in results:
                        item=dict(item,id=f"{target['satellite']['noradId']}:{item['id']}",satellite=target['satellite'],computation={'fromCache':hit,'calculatedAt':calculated_at})
                        summary={k:v for k,v in item.items() if k!='curve'}
                        db.add(PredictionEvent(task_id=id,event_id=item['id'],norad_id=target['satellite']['noradId'],start_at=datetime.fromisoformat(item['start']),max_elevation=item['max_elevation'],visual=bool(item['visible_windows']),summary=summary,payload=item))
                    db.commit()
                execution['cacheHits']+=int(hit);execution['eventCount']+=len(results)
            except Cancelled:raise
            except FileNotFoundError:raise
            except Exception:execution['failures'].append({'noradId':target['satellite']['noradId'],'name':target['satellite']['name'],'code':'ORBIT_PROPAGATION_FAILED'})
            execution['completedSatellites']+=1
            with SessionLocal() as db:
                row=db.get(Prediction,id);row.execution=dict(execution);db.commit()
    finally:
        stop.set()
        if process_stop is not None:process_stop.set()
        pool.shutdown(wait=True,cancel_futures=True)
        if process_pool is not None:process_pool.shutdown(wait=True,cancel_futures=True)
    return execution

def execute_next():
    with engine.connect() as lease:
        if not lease.scalar(text('SELECT pg_try_advisory_lock(521115)')):return False
        try:
            with SessionLocal() as db:
                # No live worker can own these rows while we hold the exclusive lease.
                for row in db.scalars(select(Prediction).where(Prediction.status.in_(['running','cancelling']))):
                    row.status='cancelled' if row.cancel_requested else 'failed'
                    row.error_code=None if row.cancel_requested else 'WORKER_INTERRUPTED';row.finished_at=now()
                    db.execute(delete(PredictionEvent).where(PredictionEvent.task_id==row.id))
                row=db.scalar(select(Prediction).where(Prediction.status=='queued').order_by(Prediction.created_at).limit(1).with_for_update())
                if not row:db.commit();return False
                if row.cancel_requested:row.status='cancelled';row.finished_at=now();db.commit();return True
                row.status='running';row.started_at=now();row.progress=1
                id,basis=row.id,row.basis;db.commit()
            checked=[0,0]
            def checkpoint(progress):
                stamp=time.monotonic()
                if stamp-checked[0]<.2:return
                with SessionLocal() as db:
                    row=db.get(Prediction,id,with_for_update=True)
                    if row.cancel_requested:raise Cancelled()
                    row.progress=max(row.progress,progress);db.commit()
                checked[:]=[stamp,progress]
            try:
                if basis.get('kind')=='group':
                    execution=calculate_group(id,basis,checkpoint);result=[]
                    if len(execution['failures'])==execution['totalSatellites']:raise ValueError('All targets failed')
                else:
                    result,hit,calculated_at=cached_calculate(basis,checkpoint)
                    result=[dict(item,computation={'fromCache':hit,'calculatedAt':calculated_at}) for item in result]
                    execution={'totalSatellites':1,'completedSatellites':1,'cacheHits':int(hit),'eventCount':len(result),'failures':[]}
                status,code='completed',None
            except Cancelled:result=[];status,code='cancelled',None
            except FileNotFoundError:result=[];status,code='failed','EPHEMERIS_UNAVAILABLE'
            except Exception:result=[];status,code='failed','ORBIT_PROPAGATION_FAILED'
            with SessionLocal() as db:
                row=db.get(Prediction,id,with_for_update=True)
                # Cancellation and completion serialize on the row: one final outcome.
                if row.cancel_requested:status,code,result='cancelled',None,[]
                row.status=status;row.error_code=code;row.results=result;row.finished_at=now()
                if status=='completed':row.execution=execution
                else:db.execute(delete(PredictionEvent).where(PredictionEvent.task_id==id))
                if status=='completed':row.progress=100
                db.commit()
            return True
        finally:
            lease.execute(text('SELECT pg_advisory_unlock(521115)'));lease.commit()
