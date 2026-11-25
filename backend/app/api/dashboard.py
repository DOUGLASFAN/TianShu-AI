from datetime import datetime,timedelta
from fastapi import APIRouter,Depends,HTTPException,Query
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..core.security import current_user
from ..db import get_db
from ..models import User,Station,Prediction,PredictionEvent,Satellite,GroupMember,now
from ..services.scheduling import read,statistics
from ..services.operations import demo_state
from .environment import overview as weather_overview

router=APIRouter(prefix='/api',tags=['态势统计'],dependencies=[Depends(current_user)])

@router.get('/system/status')
def system_status():return {'data':{'demo':demo_state(),'serverTime':now().isoformat()}}

@router.get('/dashboard/statistics')
def stats():
    value=read('statistics:last_good');hit=bool(value and value.get('version')==2)
    if not hit:value=statistics()
    age=max(0,(now()-datetime.fromisoformat(value['generatedAt'])).total_seconds())
    return {'data':value,'meta':{'cacheHit':hit,'cacheAgeSeconds':age,'stale':age>600,'storage':'persistent_postgresql_snapshot','lastJob':read('job:statistics'),'demo':demo_state()}}

@router.get('/dashboard/weather')
def weather(db:Session=Depends(get_db)):
    data=weather_overview(db)['data'];return {'data':{'observation':data['observation'],'asOf':data['asOf']}}

@router.get('/dashboard/activity')
def activity(db:Session=Depends(get_db)):
    rows=db.scalars(select(Satellite).where(Satellite.norad_id.in_(select(GroupMember.norad_id).where(GroupMember.group_slug=='active'))).order_by(Satellite.fetched_at.desc(),Satellite.epoch.desc(),Satellite.norad_id).limit(30)).all()
    return {'list':[{'satellite':{'noradId':r.norad_id,'name':r.name},'epoch':r.epoch.isoformat(),'fetchedAt':r.fetched_at.isoformat()} for r in rows],'asOf':now().isoformat()}

@router.get('/dashboard/ranking')
def ranking(stationId:str|None=None,user:User=Depends(current_user),db:Session=Depends(get_db)):
    station=db.scalar(select(Station).where(Station.user_id==user.id,Station.id==stationId)) if stationId else None
    if stationId and not station:raise HTTPException(404,'STATION_NOT_FOUND')
    if not station:return {'list':[],'status':'choose_station','basis':None}
    # Use a finished, saved calculation; no invented predictions or cross-user results.
    tasks=db.scalars(select(Prediction).where(Prediction.user_id==user.id,Prediction.status=='completed').order_by(Prediction.finished_at.desc()).limit(100)).all()
    task=next((t for t in tasks if t.basis['station']['id']==station.id),None)
    if not task:return {'list':[],'status':'no_prediction','basis':None}
    if task.basis.get('kind')=='group':
        entries=db.scalars(select(PredictionEvent.summary).where(PredictionEvent.task_id==task.id,PredictionEvent.start_at>=now()).order_by(PredictionEvent.start_at).limit(30)).all()
    else:entries=[x for x in task.results if datetime.fromisoformat(x['start'])>=now()][:30]
    changed=any(task.basis['station'][k]!=getattr(station,k) for k in ['latitude','longitude','elevation_m'])
    return {'list':[{'id':x['id'],'satellite':x.get('satellite',task.basis['satellite']),'start':x['start'],'maxElevation':x['max_elevation'],'taskId':task.id} for x in entries],
            'status':'station_changed' if changed else 'available' if entries else 'no_future_events','basis':{'taskId':task.id,'station':task.basis['station'],'computedAt':task.finished_at.isoformat(),'start':task.basis['start'],'end':task.basis['end'],'staleOrbit':task.basis.get('staleAtSubmission',False)}}
