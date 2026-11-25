from datetime import timedelta
from fastapi import APIRouter,Depends,HTTPException,Query,Response
from sqlalchemy import select,func
from sqlalchemy.orm import Session
from ..db import get_db
from ..core.security import current_user
from ..core.config import ROOT
from ..models import WeatherSnapshot,WeatherEvent,CollectionRun,now
from ..services.weather import SOURCES,source_state,stamp

router=APIRouter(prefix='/api/environment',tags=['空间环境'],dependencies=[Depends(current_user)])

@router.get('')
def overview(db:Session=Depends(get_db)):
    at=now();states={};snapshots={}
    for id in SOURCES:states[id],snapshots[id]=source_state(id,db,at)
    available=[id for id in ['noaa-kp','gfz-kp'] if states[id]['state']=='available']
    retained=[id for id in ['noaa-kp','gfz-kp'] if snapshots[id]]
    chosen=available[0] if available else max(retained,key=lambda id:snapshots[id].source_time or snapshots[id].fetched_at) if retained else None
    points=snapshots[chosen].payload['points'] if chosen else []
    latest=points[-1] if points else None;fresh=bool(chosen and states[chosen]['state']=='available')
    forecast=snapshots['noaa-forecast'];future=[p for p in forecast.payload['points'] if p['kind']=='forecast' and stamp(p['time'])>=at] if forecast else []
    forecast_peak=max(future,key=lambda p:p['kp']) if future else None
    notice_count=db.scalar(select(func.count()).select_from(WeatherEvent).where(WeatherEvent.source_id=='noaa-alerts',WeatherEvent.issued_at>=at-timedelta(days=7)))
    return {'data':{'asOf':at.isoformat(),'observation':{'sourceId':chosen,'state':'available' if fresh else 'stale' if latest else 'unknown','latest':latest,
       'label':'地磁活动增强' if fresh and latest['kp']>=5 else '未达地磁暴阈值' if fresh else '状态未知'},
       'trend':points,'forecast':{'state':states['noaa-forecast']['state'],'points':future,'peak':forecast_peak},'sources':list(states.values()),'officialNoticeCount':notice_count,
       'interpretation':'Kp 描述全球地磁活动。导航、通信和卫星运行可能受空间天气影响；不能据此判断某地点或设备已经发生故障。'}}

def event_data(row):return {'id':row.id,'sourceId':row.source_id,'sourceName':SOURCES[row.source_id]['name'],'fetchedAt':row.fetched_at.isoformat(),'runId':row.run_id,**{k:v for k,v in row.payload.items() if k!='raw'}}

@router.get('/events')
def events(kind:str=Query('all',pattern='^(all|observation|forecast|warning|notice)$'),category:str=Query('all',pattern='^(all|flare|cme|geomagnetic|radiation|radio|other)$'),
           source:str='all',days:int=Query(7,ge=1,le=30),page:int=Query(1,ge=1),size:int=Query(8,ge=1,le=50),db:Session=Depends(get_db)):
    if source!='all' and source not in SOURCES:raise HTTPException(422,'WEATHER_SOURCE_INVALID')
    date=func.coalesce(WeatherEvent.issued_at,WeatherEvent.occurred_at)
    query=select(WeatherEvent).where(date>=now()-timedelta(days=days))
    if source!='all':query=query.where(WeatherEvent.source_id==source)
    if kind!='all':query=query.where(WeatherEvent.kind==kind)
    if category!='all':query=query.where(WeatherEvent.category==category)
    total=db.scalar(select(func.count()).select_from(query.subquery()))
    rows=db.scalars(query.order_by(date.desc(),WeatherEvent.id).offset((page-1)*size).limit(size)).all()
    return {'list':[event_data(x) for x in rows],'total':total,'page':page,'size':size,'timeBasis':'issuedAt, otherwise occurredAt'}

@router.get('/events/{id}')
def event(id:str,db:Session=Depends(get_db)):
    row=db.get(WeatherEvent,id)
    if not row:raise HTTPException(404,'WEATHER_EVENT_NOT_FOUND')
    state,_=source_state(row.source_id,db)
    item=event_data(row);valid=stamp(item.get('validTo'))
    item['validity']='cancelled' if item['cancelled'] else 'expired' if valid and valid<now() else 'within_validity' if valid else 'not_provided'
    return {'data':item,'raw':row.payload['raw'],'source':state}

@router.get('/sources/{id}/runs')
def runs(id:str,db:Session=Depends(get_db)):
    if id not in SOURCES:raise HTTPException(404,'WEATHER_SOURCE_INVALID')
    rows=db.scalars(select(CollectionRun).where(CollectionRun.source_id==id).order_by(CollectionRun.started_at.desc()).limit(20)).all()
    return {'list':[{'id':r.id,'status':r.status,'startedAt':r.started_at.isoformat(),'finishedAt':r.finished_at.isoformat() if r.finished_at else None,'records':r.record_count,'errorCode':r.error_code} for r in rows]}

@router.get('/snapshots/{run_id}/raw')
def raw(run_id:str,db:Session=Depends(get_db)):
    row=db.get(WeatherSnapshot,run_id)
    if not row:raise HTTPException(404,'WEATHER_SNAPSHOT_NOT_FOUND')
    path=(ROOT/row.raw_path).resolve();allowed=(ROOT/'.local/data/environment').resolve()
    if not path.is_relative_to(allowed) or not path.is_file():raise HTTPException(404,'WEATHER_SNAPSHOT_NOT_FOUND')
    return Response(content=path.read_bytes(),media_type='text/plain; charset=utf-8',headers={'X-Content-SHA256':row.content_hash})
