from datetime import timedelta
from fastapi import APIRouter,Depends,HTTPException,Query
from sqlalchemy import select,func,text
from sqlalchemy.orm import Session
from ..db import get_db
from ..models import Prediction,PredictionEvent,Station,Satellite,SatelliteGroup,GroupMember,User,now
from ..schemas import PredictionInput,GroupPredictionInput
from ..core.security import current_user
from ..services.prediction_math import ALGORITHM
from ..services.predictions import ACTIVE
from .personal import own_station,station_data
from backend.phase1.orbits import instant

router=APIRouter(prefix='/api/predictions',tags=['观测预测'])

def own(id,user,db):
    row=db.get(Prediction,id)
    if not row or row.user_id!=user.id:raise HTTPException(404,'PREDICTION_NOT_FOUND')
    return row

def summary(row,db,compact=False):
    sat=db.get(Satellite,row.basis['satellite']['noradId'])
    basis=row.basis
    if compact:basis={k:v for k,v in basis.items() if k!='targets'};basis={**basis,'orbit':{k:v for k,v in basis['orbit'].items() if k!='raw'}}
    stamp=now();end=instant(row.basis['end']);epoch=instant(row.basis['orbit']['epoch'])
    targets=row.basis.get('targets') or [{'satellite':row.basis['satellite'],'orbit':row.basis['orbit']}]
    versions=dict(db.execute(select(Satellite.norad_id,Satellite.content_hash).where(Satellite.norad_id.in_([x['satellite']['noradId'] for x in targets]))).all())
    updated=any(versions.get(x['satellite']['noradId'])!=x['orbit']['version'] for x in targets)
    stale=any((stamp-instant(x['orbit']['epoch'])).total_seconds()>72*3600 for x in targets)
    future=any((stamp-instant(x['orbit']['epoch'])).total_seconds() < -600 for x in targets)
    return {'id':row.id,'status':row.status,'progress':row.progress,'errorCode':row.error_code,
            'basis':basis,'execution':row.execution,'createdAt':row.created_at.isoformat(),
            'startedAt':row.started_at.isoformat() if row.started_at else None,
            'finishedAt':row.finished_at.isoformat() if row.finished_at else None,'total':row.execution.get('eventCount',len(row.results)),
            'freshness':{'windowEnded':stamp>end,'orbitUpdated':updated,
                         'stale':stale,'futureEpoch':future,
                         'epochAgeHours':round((stamp-epoch).total_seconds()/3600,1)}}


def make_basis(station,sat,start,days,minimum,accept_stale):
    stamp=now();end=start+timedelta(days=days);age=(stamp-sat.epoch).total_seconds();stale=age>72*3600 or age < -600
    basis={'station':station_data(station),'satellite':{'noradId':sat.norad_id,'name':sat.name},
           'start':start.isoformat(),'end':end.isoformat(),'days':days,'minElevation':minimum,
           'solarAltitudeLimit':-6,'opticalScanSeconds':5,'edgeToleranceSeconds':.25,'geometricEdgeToleranceSeconds':.025,
           'algorithm':ALGORITHM,'computedTimeSystem':'UTC','coordinateFrame':'WGS84',
           'orbit':{'raw':sat.orbit_raw,'version':sat.content_hash,'epoch':sat.epoch.isoformat(),'fetchedAt':sat.fetched_at.isoformat(),'source':sat.source},
           'staleAcknowledged':accept_stale,'staleAtSubmission':stale,
           'maxEpochDistanceHours':max(abs((start-sat.epoch).total_seconds()),abs((end-sat.epoch).total_seconds()))/3600,
           'limitations':'潜在目视窗口仅考虑仰角、太阳高度与卫星受光；不含亮度、天气、地形和折射。5 秒采样可能遗漏更短子窗口。'}
    return basis

@router.post('',status_code=202)
def create(body:PredictionInput,user:User=Depends(current_user),db:Session=Depends(get_db)):
    # Serializes bounded queue admission across API processes and concurrent requests.
    db.execute(text('SELECT pg_advisory_xact_lock(521116)'))
    station=own_station(body.stationId,user,db);sat=db.get(Satellite,body.noradId)
    if not sat:raise HTTPException(404,'SATELLITE_NOT_FOUND')
    start=instant(body.start);stamp=now();end=start+timedelta(days=body.days)
    if start<stamp-timedelta(minutes=2) or start>stamp+timedelta(days=7):raise HTTPException(422,'PREDICTION_TIME_RANGE')
    age=(stamp-sat.epoch).total_seconds();stale=age>72*3600 or age < -600
    if stale and not body.acceptStale:raise HTTPException(409,'STALE_ORBIT_ACK_REQUIRED')
    active=select(func.count()).select_from(Prediction).where(Prediction.status.in_(ACTIVE))
    if db.scalar(active.where(Prediction.user_id==user.id))>=3 or db.scalar(active)>=32:raise HTTPException(429,'PREDICTION_QUEUE_FULL')
    basis=make_basis(station,sat,start,body.days,body.minElevation,body.acceptStale)
    row=Prediction(user_id=user.id,basis=basis);db.add(row);db.commit()
    return {'data':summary(row,db)}

@router.get('')
def history(page:int=Query(1,ge=1),size:int=Query(10,ge=1,le=50),user:User=Depends(current_user),db:Session=Depends(get_db)):
    query=select(Prediction).where(Prediction.user_id==user.id)
    total=db.scalar(select(func.count()).select_from(query.subquery()))
    rows=db.scalars(query.order_by(Prediction.created_at.desc()).offset((page-1)*size).limit(size)).all()
    return {'list':[summary(row,db,compact=True) for row in rows],'total':total,'page':page,'size':size}

@router.get('/{id}')
def get(id:str,user:User=Depends(current_user),db:Session=Depends(get_db)):
    return {'data':summary(own(id,user,db),db)}

@router.post('/{id}/cancel')
def cancel(id:str,user:User=Depends(current_user),db:Session=Depends(get_db)):
    row=db.scalar(select(Prediction).where(Prediction.id==id,Prediction.user_id==user.id).with_for_update())
    if not row:raise HTTPException(404,'PREDICTION_NOT_FOUND')
    if row.status in ACTIVE:
        row.cancel_requested=True
        if row.status=='queued':row.status='cancelled';row.finished_at=now()
        else:row.status='cancelling'
        db.commit()
    return {'data':summary(row,db)}

@router.get('/{id}/results')
def results(id:str,page:int=Query(1,ge=1),size:int=Query(8,ge=1,le=50),sort:str=Query('time',pattern='^(time|elevation)$'),
            visual:bool=False,user:User=Depends(current_user),db:Session=Depends(get_db)):
    row=own(id,user,db)
    if row.status!='completed':raise HTTPException(409,'PREDICTION_NOT_COMPLETE')
    if row.basis.get('kind')=='group':
        query=select(PredictionEvent).where(PredictionEvent.task_id==id)
        if visual:query=query.where(PredictionEvent.visual==True)
        total=db.scalar(select(func.count()).select_from(query.subquery()))
        order=[PredictionEvent.start_at,PredictionEvent.event_id] if sort=='time' else [PredictionEvent.max_elevation.desc(),PredictionEvent.start_at,PredictionEvent.event_id]
        values=db.scalars(query.with_only_columns(PredictionEvent.summary).order_by(*order).offset((page-1)*size).limit(size)).all()
        return {'list':values,'total':total,'page':page,'size':size,'taskId':id}
    items=[item for item in row.results if not visual or item['visible_windows']]
    items=sorted(items,key=lambda x:x['start'] if sort=='time' else -x['max_elevation'])
    return {'list':[{k:v for k,v in x.items() if k!='curve'} for x in items[(page-1)*size:page*size]],'total':len(items),'page':page,'size':size,'taskId':row.id}

@router.get('/{id}/events/{event_id}')
def event(id:str,event_id:str,user:User=Depends(current_user),db:Session=Depends(get_db)):
    row=own(id,user,db)
    found=event_data(row,event_id,db)
    if not found:raise HTTPException(404,'EVENT_NOT_FOUND')
    return {'data':dict(found,satellite=found.get('satellite',row.basis['satellite'])),'basis':event_basis(row,found),'taskId':row.id}


def event_data(row,event_id,db):
    if row.status!='completed':raise HTTPException(409,'PREDICTION_NOT_COMPLETE')
    if row.basis.get('kind')=='group':
        entry=db.get(PredictionEvent,(row.id,event_id));return entry.payload if entry else None
    return next((x for x in row.results if x['id']==event_id),None)


def event_basis(row,item):
    basis={k:v for k,v in row.basis.items() if k not in ['targets','group','kind']}
    if row.basis.get('kind')=='group':
        target=next(x for x in row.basis['targets'] if x['satellite']['noradId']==item['satellite']['noradId']);basis.update(target)
    return basis


@router.get('/groups/{slug}/batch')
def batch(slug:str,page:int=Query(1,ge=1),size:int=Query(100,ge=1,le=500),user:User=Depends(current_user),db:Session=Depends(get_db)):
    group=db.get(SatelliteGroup,slug)
    if not group:raise HTTPException(404,'GROUP_NOT_FOUND')
    query=select(Satellite).join(GroupMember).where(GroupMember.group_slug==slug)
    total=db.scalar(select(func.count()).select_from(query.subquery()))
    rows=db.scalars(query.order_by(Satellite.norad_id).offset((page-1)*size).limit(size)).all()
    return {'group':{'slug':slug,'name':group.name},'total':total,'page':page,'size':size,'pages':max(1,(total+size-1)//size),'limit':500,
            'list':[{'noradId':x.norad_id,'name':x.name,'epoch':x.epoch.isoformat(),'stale':(now()-x.epoch).total_seconds()>72*3600 or (now()-x.epoch).total_seconds() < -600} for x in rows]}


@router.post('/groups',status_code=202)
def create_group(body:GroupPredictionInput,user:User=Depends(current_user),db:Session=Depends(get_db)):
    db.execute(text('SELECT pg_advisory_xact_lock(521116)'))
    station=own_station(body.stationId,user,db);start=instant(body.start)
    if start<now()-timedelta(minutes=2) or start>now()+timedelta(days=7):raise HTTPException(422,'PREDICTION_TIME_RANGE')
    scope=batch(body.group,body.batch,body.size,user,db)
    if not scope['list']:raise HTTPException(422,'EMPTY_BATCH')
    if body.expectedNoradIds is not None and body.expectedNoradIds!=[x['noradId'] for x in scope['list']]:raise HTTPException(409,'BATCH_CHANGED')
    active=select(func.count()).select_from(Prediction).where(Prediction.status.in_(ACTIVE))
    if db.scalar(active.where(Prediction.user_id==user.id))>=3 or db.scalar(active)>=32:raise HTTPException(429,'PREDICTION_QUEUE_FULL')
    if any(x['stale'] for x in scope['list']) and not body.acceptStale:raise HTTPException(409,'STALE_ORBIT_ACK_REQUIRED')
    rows=db.scalars(select(Satellite).where(Satellite.norad_id.in_([x['noradId'] for x in scope['list']])).order_by(Satellite.norad_id)).all()
    basis=make_basis(station,rows[0],start,body.days,body.minElevation,body.acceptStale)
    targets=[]
    for sat in rows:
        values=make_basis(station,sat,start,body.days,body.minElevation,body.acceptStale)
        targets.append({k:values[k] for k in ['satellite','orbit','staleAtSubmission','maxEpochDistanceHours']})
    basis.update(kind='group',targets=targets,group={**scope['group'],'page':body.batch,'size':body.size,'total':scope['total'],'count':len(rows),'firstNorad':rows[0].norad_id,'lastNorad':rows[-1].norad_id})
    basis['maxEpochDistanceHours']=max(x['maxEpochDistanceHours'] for x in targets)
    basis['staleAtSubmission']=any(x['staleAtSubmission'] for x in targets)
    row=Prediction(user_id=user.id,basis=basis,execution={'totalSatellites':len(rows),'completedSatellites':0,'cacheHits':0,'failures':[],'eventCount':0});db.add(row);db.commit()
    return {'data':summary(row,db)}


@router.get('/{id}/events/{event_id}/replay')
def replay(id:str,event_id:str,user:User=Depends(current_user),db:Session=Depends(get_db)):
    from ..services.prediction_math import replay_data
    from ..core import cache
    row=own(id,user,db);item=event_data(row,event_id,db)
    if not item:raise HTTPException(404,'EVENT_NOT_FOUND')
    key='replay:'+id+':'+event_id
    cached=cache.get(key)
    if cached:return {'data':cached}
    try:value=replay_data(event_basis(row,item),item)
    except (ValueError,KeyError):raise HTTPException(422,'ORBIT_PROPAGATION_FAILED')
    cache.put(key,value,7200);return {'data':value}


@router.get('/{id}/group-replay')
def group_replay(id:str,at:str=Query(...,max_length=64),user:User=Depends(current_user),db:Session=Depends(get_db)):
    from ..services.group_replay import window
    row=own(id,user,db)
    if row.status!='completed':raise HTTPException(409,'PREDICTION_NOT_COMPLETE')
    if row.basis.get('kind')!='group':raise HTTPException(422,'GROUP_REPLAY_REQUIRED')
    try:value=window(row.basis,at)
    except (ValueError,TypeError):raise HTTPException(422,'REPLAY_TIME_RANGE')
    return {'data':value,'taskId':id}


@router.get('/{id}/group-replay/satellites/{norad}')
def group_selection(id:str,norad:int,at:str=Query(...,max_length=64),eventId:str|None=Query(None,max_length=48),user:User=Depends(current_user),db:Session=Depends(get_db)):
    row=own(id,user,db)
    if row.status!='completed':raise HTTPException(409,'PREDICTION_NOT_COMPLETE')
    target=next((x for x in row.basis.get('targets',[]) if x['satellite']['noradId']==norad),None)
    if not target:raise HTTPException(404,'SATELLITE_NOT_IN_BATCH')
    try:stamp=instant(at)
    except (ValueError,TypeError):raise HTTPException(422,'REPLAY_TIME_RANGE')
    if stamp<instant(row.basis['start'])-timedelta(milliseconds=1) or stamp>instant(row.basis['end'])+timedelta(milliseconds=1):raise HTTPException(422,'REPLAY_TIME_RANGE')
    query=select(PredictionEvent).where(PredictionEvent.task_id==id,PredictionEvent.norad_id==norad)
    if eventId:
        entry=db.scalar(query.where(PredictionEvent.event_id==eventId))
        if not entry:raise HTTPException(404,'EVENT_NOT_FOUND')
    else:
        entries=db.scalars(query.order_by(PredictionEvent.start_at)).all()
        entry=next((x for x in entries if instant(x.summary['start'])<=stamp<=instant(x.summary['end'])),None)
        if entry is None and entries:entry=min(entries,key=lambda x:abs((x.start_at-stamp).total_seconds()))
    basis={k:v for k,v in row.basis.items() if k not in ['targets','group','kind']};basis.update(target)
    return {'data':entry.payload if entry else None,'basis':basis,'taskId':id,'selectionTime':stamp.isoformat()}
