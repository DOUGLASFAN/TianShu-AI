from datetime import timedelta
from fastapi import APIRouter,Depends,HTTPException,Query,Request
from pydantic import BaseModel
from sqlalchemy import select,func,text
from sqlalchemy.orm import Session
from ..core.security import admin
from ..db import get_db
from ..models import AuthSession,CollectionRun,DataSource,User,JobRun,AdminAudit,RuntimeState,now
from ..schemas import UserStatus
from ..services.collection import collect,create_run
from .auth import user_data
from ..services.operations import enqueue,demo_state,DEMO_KEY
from ..services.scheduling import read,INTERVALS
from ..services.weather import SOURCES,source_state

SOURCE_JOBS={'celestrak':'orbit','metadata':'metadata','iss':'iss','statistics':'statistics',**{id:'environment' for id in SOURCES}}
JOB_LABELS={'orbit':'轨道目录','metadata':'元数据','iss':'空间站位置','statistics':'统计聚合','environment':'空间天气','recovery':'恢复检查'}

router=APIRouter(prefix='/api/admin',tags=['管理'],dependencies=[Depends(admin)])


@router.get('/users')
def users(page:int=Query(1,ge=1),size:int=Query(20,ge=1,le=100),keyword:str=Query('',max_length=32),db:Session=Depends(get_db)):
    query=select(User)
    if keyword:query=query.where(User.username.contains(keyword,autoescape=True))
    rows=db.scalars(query.order_by(User.created_at,User.id).offset((page-1)*size).limit(size)).all()
    return {'total':db.scalar(select(func.count()).select_from(query.subquery())),'list':[user_data(u) for u in rows],'page':page,'size':size}


@router.patch('/users/{id}')
def status(id:str,body:UserStatus,actor:User=Depends(admin),db:Session=Depends(get_db)):
    # Lock admins in stable order to preserve the last-admin invariant under concurrent requests.
    admins=db.scalars(select(User).where(User.role=='admin').order_by(User.id).with_for_update()).all()
    user=db.get(User,id)
    if not user:raise HTTPException(404,'USER_NOT_FOUND')
    if not body.enabled and user.role=='admin' and user.enabled and sum(u.enabled for u in admins)<=1:
        raise HTTPException(409,'LAST_ADMIN_REQUIRED')
    if user.enabled!=body.enabled:
        user.enabled=body.enabled;user.token_version+=1
        for row in db.scalars(select(AuthSession).where(AuthSession.user_id==user.id)):row.revoked=True
        db.add(AdminAudit(actor_id=actor.id,action='user_enabled' if body.enabled else 'user_disabled',target=id,data={}))
    db.commit();return {'data':user_data(user)}


@router.get('/data-sources')
def sources(db:Session=Depends(get_db)):
    rows={r.id:r for r in db.scalars(select(DataSource))};values=[];demo=demo_state()
    for id,job in SOURCE_JOBS.items():
        row=rows.get(id);state=read('job:'+job) or {};latest=db.scalar(select(JobRun).where(JobRun.job==job).order_by(JobRun.created_at.desc()).limit(1))
        item={'id':id,'job':job,'name':row.name if row else JOB_LABELS.get(job,id),'url':row.url if row else None,'lastAttemptAt':state.get('attemptedAt'),'nextAt':state.get('nextAt'),
              'lastSuccessAt':row.last_success_at.isoformat() if row and row.last_success_at else state.get('lastSuccessAt'),'status':latest.status if latest else state.get('status','unknown'),
              'errorCode':latest.error_code if latest else state.get('errorCode'),'intervalSeconds':INTERVALS[job],'taskId':latest.id if latest else None,
              'latencySeconds':max(0,(latest.finished_at-latest.started_at).total_seconds()) if latest and latest.finished_at and latest.started_at else None}
        item['activeTaskStatus']=latest.status if latest and latest.status in ['queued','running'] else None
        item['recordCount']=latest.result.get('records') if latest else None
        if id in SOURCES:
            weather,last=source_state(id,db);item.update(name=SOURCES[id]['name'],url=SOURCES[id]['url'],dataState=weather['state'],sourceTime=weather['sourceTime'],fetchedAt=weather['fetchedAt'],lastAttemptAt=weather['lastAttemptAt'],lastSuccessAt=weather['fetchedAt'],errorCode=weather['errorCode'],status=weather['lastAttemptStatus'] or 'unknown')
            item['recordCount']=len(last.payload['points'])+len(last.payload['events']) if last else None
            attempt=db.scalar(select(CollectionRun).where(CollectionRun.source_id==id).order_by(CollectionRun.started_at.desc()).limit(1))
            item['latencySeconds']=max(0,(attempt.finished_at-attempt.started_at).total_seconds()) if attempt and attempt.finished_at else None
        if id=='iss':
            position=read('iss:last_good');item['fetchedAt']=position.get('fetchedAt') if position else None;item['recordCount']=1 if position else None
        if id=='statistics':
            snapshot=read('statistics:last_good');item['fetchedAt']=snapshot.get('generatedAt') if snapshot else None;item['recordCount']=snapshot.get('activeCount') if snapshot else None
        if id in ['celestrak','metadata']:
            from ..services.collection import source
            path=source.CACHE/('gp_active.request.json' if id=='celestrak' else 'satcat_active.request.json')
            try:
                if path.exists():item['fetchedAt']=__import__('json').loads(path.read_text(encoding='utf-8')).get('attempted_at')
            except (OSError,ValueError):item['cacheEvidenceUnavailable']=True
        if item.get('fetchedAt'):
            from datetime import datetime
            item['cacheAgeSeconds']=max(0,(now()-datetime.fromisoformat(item['fetchedAt'])).total_seconds())
        else:item['cacheAgeSeconds']=None
        item['demoActive']=demo.get('phase')=='active' and job!='statistics';values.append(item)
    return {'total':len(values),'list':values,'demo':demo}


@router.get('/collection-runs')
def runs(page:int=Query(1,ge=1),size:int=Query(20,ge=1,le=100),source:str='',status:str=Query('',pattern='^(|success|failed|running)$'),days:int=Query(30,ge=1,le=365),db:Session=Depends(get_db)):
    query=select(CollectionRun).where(CollectionRun.started_at>=now()-timedelta(days=days))
    if source:query=query.where(CollectionRun.source_id==source)
    if status:query=query.where(CollectionRun.status==status)
    rows=db.scalars(query.order_by(CollectionRun.started_at.desc()).offset((page-1)*size).limit(size)).all()
    return {'total':db.scalar(select(func.count()).select_from(query.subquery())),'list':[{'id':r.id,'sourceId':r.source_id,'status':r.status,
            'mode':r.mode,'recordCount':r.record_count,'errorCode':r.error_code,'startedAt':r.started_at.isoformat(),
            'finishedAt':r.finished_at.isoformat() if r.finished_at else None} for r in rows],'page':page,'size':size}

@router.get('/collection-runs/{id}')
def collection_detail(id:str,db:Session=Depends(get_db)):
    row=db.get(CollectionRun,id)
    if not row:raise HTTPException(404,'TASK_NOT_FOUND')
    return {'data':{'id':row.id,'sourceId':row.source_id,'status':row.status,'mode':row.mode,'recordCount':row.record_count,'startedAt':row.started_at.isoformat(),'finishedAt':row.finished_at.isoformat() if row.finished_at else None,'errorCode':row.error_code}}


@router.post('/data-sources/{id}/refresh',status_code=202)
def refresh(id:str,request:Request,user:User=Depends(admin),db:Session=Depends(get_db)):
    if id not in SOURCE_JOBS:raise HTTPException(404,'SOURCE_NOT_FOUND')
    task,existing=enqueue(SOURCE_JOBS[id],user,db,request_id=request.state.request_id);db.commit()
    return {'data':{'taskId':task.id,'status':task.status,'existing':existing}}

def job_data(r):return {'id':r.id,'job':r.job,'name':JOB_LABELS.get(r.job,r.job),'mode':r.mode,'status':r.status,'createdAt':r.created_at.isoformat(),'startedAt':r.started_at.isoformat() if r.started_at else None,'finishedAt':r.finished_at.isoformat() if r.finished_at else None,'errorCode':r.error_code,'result':r.result}

@router.get('/jobs')
def jobs(job:str='',status:str=Query('',pattern='^(|queued|running|success|partial|failed)$'),days:int=Query(7,ge=1,le=365),page:int=Query(1,ge=1),size:int=Query(10,ge=1,le=50),db:Session=Depends(get_db)):
    query=select(JobRun).where(JobRun.created_at>=now()-timedelta(days=days))
    if job:query=query.where(JobRun.job==job)
    if status:query=query.where(JobRun.status==status)
    count=db.scalar(select(func.count()).select_from(query.subquery()));rows=db.scalars(query.order_by(JobRun.created_at.desc(),JobRun.id).offset((page-1)*size).limit(size)).all()
    return {'total':count,'list':[job_data(r) for r in rows],'page':page,'size':size,'jobNames':JOB_LABELS}

@router.get('/jobs/{id}')
def job(id:str,db:Session=Depends(get_db)):
    row=db.get(JobRun,id)
    if not row:raise HTTPException(404,'TASK_NOT_FOUND')
    return {'data':job_data(row)}

class DemoInput(BaseModel):enabled:bool

@router.post('/demo')
def demo(body:DemoInput,user:User=Depends(admin),db:Session=Depends(get_db)):
    db.execute(text('SELECT pg_advisory_xact_lock(847900)'));row=db.get(RuntimeState,DEMO_KEY,with_for_update=True)
    if not row:row=RuntimeState(key=DEMO_KEY,value={});db.add(row)
    current=dict(row.value)
    if body.enabled:
        if current.get('phase')=='active':return {'data':current,'existing':True}
        current.update(phase='active',startedAt=now().isoformat(),checks=[])
        row.value=current;row.updated_at=now();db.add(AdminAudit(actor_id=user.id,action='demo_started',target='external',data={}))
        for job in ['environment','iss','metadata','orbit']:enqueue(job,user,db,limited=False)
        db.commit();return {'data':current}
    limited=current.get('phase') not in ['active','recovering']
    current.update(phase='recovering',restoreRequestedAt=now().isoformat());row.value=current;row.updated_at=now()
    task,existing=enqueue('recovery',user,db,limited=limited);db.add(AdminAudit(actor_id=user.id,action='demo_restore_requested',target=task.id,data={}))
    db.commit();return {'data':current,'taskId':task.id,'existing':existing}

@router.get('/audits')
def audits(page:int=Query(1,ge=1),db:Session=Depends(get_db)):
    rows=db.execute(select(AdminAudit,User.username).outerjoin(User,User.id==AdminAudit.actor_id).order_by(AdminAudit.created_at.desc()).offset((page-1)*20).limit(20)).all()
    return {'total':db.scalar(select(func.count()).select_from(AdminAudit)),'list':[{'id':r.id,'actorName':name,'action':r.action,'target':r.target,'data':r.data,'createdAt':r.created_at.isoformat()} for r,name in rows]}
