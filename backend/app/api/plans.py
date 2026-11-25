"""Private immutable plan snapshots, versioned confirmations and durable reminder intents."""
import hashlib,json
from datetime import timedelta
from fastapi import APIRouter,Depends,HTTPException,Query
from sqlalchemy import select,func,update
from sqlalchemy.orm import Session
from ..db import get_db
from ..models import ObservationPlan,PlanVersion,PlanReminder,PlanProposal,Notification,User,Satellite,now
from ..schemas import PlanInput,PlanCancel
from ..core.security import current_user
from .predictions import own,event_data,event_basis
from backend.phase1.orbits import instant

router=APIRouter(prefix='/api/plans',tags=['观测计划'])

def own_plan(id,user,db,lock=False):
    query=select(ObservationPlan).where(ObservationPlan.id==id,ObservationPlan.user_id==user.id)
    if lock:query=query.with_for_update()
    row=db.scalar(query)
    if not row:raise HTTPException(404,'PLAN_NOT_FOUND')
    return row

def state(row):
    return 'cancelled' if row.status=='cancelled' else 'ended' if row.end_at<=now() else 'ongoing' if row.start_at<=now() else 'upcoming'

def data(row,db):
    reminder=db.get(PlanReminder,(row.id,row.version,row.reminder_minutes))
    return {'id':row.id,'version':row.version,'status':state(row),'snapshot':row.snapshot,'start':row.start_at.isoformat(),'end':row.end_at.isoformat(),
            'reminderMinutes':row.reminder_minutes,'reminder':{'dueAt':reminder.due_at.isoformat(),'state':reminder.status} if reminder else None,
            'createdAt':row.created_at.isoformat(),'updatedAt':row.updated_at.isoformat()}

def validate_snapshot(snapshot,db,accept_stale):
    basis=snapshot['basis'];event=snapshot['event']
    if instant(event['start'])<=now():raise HTTPException(409,'PAST_EVENT')
    sat=db.get(Satellite,basis['satellite']['noradId'])
    if not sat or sat.content_hash!=basis['orbit']['version']:raise HTTPException(409,'PLAN_ORBIT_UPDATED')
    age=(now()-instant(basis['orbit']['epoch'])).total_seconds()
    if (age>72*3600 or age < -600) and not accept_stale:raise HTTPException(409,'STALE_ORBIT_ACK_REQUIRED')

def candidate(body,user,db):
    task=own(body.predictionId,user,db);event=event_data(task,body.eventId,db)
    if not event:raise HTTPException(404,'EVENT_NOT_FOUND')
    value={'taskId':task.id,'eventId':event['id'],'basis':event_basis(task,event),'event':event,'computedAt':task.finished_at.isoformat(),'acceptedStale':body.acceptStale}
    validate_snapshot(value,db,body.acceptStale);return value

def record(row,db,action):
    if action!='created':db.execute(update(Notification).where(Notification.plan_id==row.id,Notification.revoked_at.is_(None)).values(revoked_at=now(),updated_at=now()))
    db.execute(update(PlanReminder).where(PlanReminder.plan_id==row.id,PlanReminder.status.in_(['pending','missed'])).values(status='cancelled'))
    db.add(PlanVersion(plan_id=row.id,version=row.version,data={'snapshot':row.snapshot,'status':row.status,'reminderMinutes':row.reminder_minutes,'action':action}))
    due=row.start_at-timedelta(minutes=row.reminder_minutes)
    db.add(PlanReminder(plan_id=row.id,version=row.version,threshold=row.reminder_minutes,due_at=due,status='cancelled' if row.status=='cancelled' else 'missed' if due<=now() else 'pending'))

@router.post('',status_code=201)
def create(body:PlanInput,user:User=Depends(current_user),db:Session=Depends(get_db)):
    # User lock and unique source key make retries/double clicks return the same plan.
    db.scalar(select(User).where(User.id==user.id).with_for_update())
    key=hashlib.sha256((body.predictionId+':'+body.eventId).encode()).hexdigest()
    previous=db.scalar(select(ObservationPlan).where(ObservationPlan.user_id==user.id,ObservationPlan.source_key==key))
    if previous:return {'data':data(previous,db),'existing':True}
    value=candidate(body,user,db)
    row=ObservationPlan(user_id=user.id,source_key=key,snapshot=value,start_at=instant(value['event']['start']),end_at=instant(value['event']['end']),reminder_minutes=body.reminderMinutes)
    db.add(row);db.flush();record(row,db,'created');db.commit()
    return {'data':data(row,db),'existing':False}

@router.get('')
def listing(status:str=Query('all',pattern='^(all|upcoming|ongoing|ended|cancelled)$'),page:int=Query(1,ge=1),size:int=Query(10,ge=1,le=50),user:User=Depends(current_user),db:Session=Depends(get_db)):
    query=select(ObservationPlan).where(ObservationPlan.user_id==user.id);stamp=now()
    if status=='cancelled':query=query.where(ObservationPlan.status=='cancelled')
    elif status!='all':
        query=query.where(ObservationPlan.status=='active')
        if status=='upcoming':query=query.where(ObservationPlan.start_at>stamp)
        elif status=='ongoing':query=query.where(ObservationPlan.start_at<=stamp,ObservationPlan.end_at>stamp)
        else:query=query.where(ObservationPlan.end_at<=stamp)
    total=db.scalar(select(func.count()).select_from(query.subquery()))
    rows=db.scalars(query.order_by(ObservationPlan.start_at,ObservationPlan.id).offset((page-1)*size).limit(size)).all()
    return {'list':[data(row,db) for row in rows],'total':total,'page':page,'size':size}

@router.get('/{id}')
def get(id:str,user:User=Depends(current_user),db:Session=Depends(get_db)):
    row=own_plan(id,user,db)
    versions=db.scalars(select(PlanVersion).where(PlanVersion.plan_id==id).order_by(PlanVersion.version.desc())).all()
    return {'data':data(row,db),'versions':[{'version':x.version,'createdAt':x.created_at.isoformat(),'data':x.data} for x in versions]}

@router.post('/{id}/cancel')
def cancel(id:str,body:PlanCancel,user:User=Depends(current_user),db:Session=Depends(get_db)):
    row=own_plan(id,user,db,True)
    if row.status=='cancelled':return {'data':data(row,db)}
    if row.version!=body.expectedVersion:raise HTTPException(409,'PLAN_VERSION_CONFLICT')
    row.status='cancelled';row.version+=1;row.updated_at=now();record(row,db,'cancelled');db.commit();return {'data':data(row,db)}

@router.post('/{id}/preview')
def preview(id:str,body:PlanInput,user:User=Depends(current_user),db:Session=Depends(get_db)):
    row=own_plan(id,user,db);value=candidate(body,user,db)
    if value['basis']['satellite']['noradId']!=row.snapshot['basis']['satellite']['noradId']:raise HTTPException(409,'PLAN_TARGET_MISMATCH')
    proposal=PlanProposal(plan_id=id,expected_version=row.version,candidate=value,reminder_minutes=body.reminderMinutes,expires_at=now()+timedelta(minutes=10));db.add(proposal);db.commit()
    return {'data':{'id':proposal.id,'expectedVersion':row.version,'old':row.snapshot,'new':value,'oldReminderMinutes':row.reminder_minutes,'newReminderMinutes':body.reminderMinutes,'expiresAt':proposal.expires_at.isoformat(),'startShiftSeconds':(instant(value['event']['start'])-row.start_at).total_seconds()}}

@router.post('/{id}/changes/{change_id}/confirm')
def confirm(id:str,change_id:str,user:User=Depends(current_user),db:Session=Depends(get_db)):
    row=own_plan(id,user,db,True);proposal=db.get(PlanProposal,change_id,with_for_update=True)
    if not proposal or proposal.plan_id!=id:raise HTTPException(404,'PROPOSAL_NOT_FOUND')
    if proposal.applied:return {'data':data(row,db),'existing':True}
    if proposal.expected_version!=row.version:raise HTTPException(409,'PLAN_VERSION_CONFLICT')
    if proposal.expires_at<=now():raise HTTPException(409,'PROPOSAL_EXPIRED')
    # Recheck wall clock and orbit version at confirmation, never replace silently.
    validate_snapshot(proposal.candidate,db,proposal.candidate.get('acceptedStale',False))
    row.snapshot=proposal.candidate;row.start_at=instant(row.snapshot['event']['start']);row.end_at=instant(row.snapshot['event']['end']);row.reminder_minutes=proposal.reminder_minutes
    row.status='active';row.version+=1;row.updated_at=now();proposal.applied=True;record(row,db,'recalculated');db.commit()
    return {'data':data(row,db),'existing':False}


@router.get('/{id}/replay')
def replay(id:str,user:User=Depends(current_user),db:Session=Depends(get_db)):
    from ..services.prediction_math import replay_data
    row=own_plan(id,user,db)
    try:return {'data':replay_data(row.snapshot['basis'],row.snapshot['event'])}
    except (ValueError,KeyError):raise HTTPException(422,'ORBIT_PROPAGATION_FAILED')
