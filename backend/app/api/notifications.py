from fastapi import APIRouter,Depends,HTTPException,Query
from sqlalchemy import select,func,update
from sqlalchemy.orm import Session
from ..db import get_db
from ..core.security import current_user
from ..models import Notification,User,now
from ..services.reminders import summary

router=APIRouter(prefix='/api/notifications',tags=['通知中心'])

def data(row):
    return {'id':row.id,'planId':row.plan_id,'data':row.payload,'createdAt':row.created_at.isoformat(),
            'readAt':row.read_at.isoformat() if row.read_at else None,'revokedAt':row.revoked_at.isoformat() if row.revoked_at else None}

@router.get('')
def listing(unread:bool=False,page:int=Query(1,ge=1),size:int=Query(10,ge=1,le=50),user:User=Depends(current_user),db:Session=Depends(get_db)):
    query=select(Notification).where(Notification.user_id==user.id)
    if unread:query=query.where(Notification.read_at.is_(None),Notification.revoked_at.is_(None))
    total=db.scalar(select(func.count()).select_from(query.subquery()))
    rows=db.scalars(query.order_by(Notification.created_at.desc(),Notification.id).offset((page-1)*size).limit(size)).all()
    return {'list':[data(x) for x in rows],'total':total,'page':page,'size':size,**summary(user.id)}

@router.post('/read-all')
def read_all(user:User=Depends(current_user),db:Session=Depends(get_db)):
    stamp=now();db.execute(update(Notification).where(Notification.user_id==user.id,Notification.read_at.is_(None)).values(read_at=stamp,updated_at=stamp));db.commit()
    return {'data':summary(user.id)}

@router.post('/{id}/read')
def read(id:str,user:User=Depends(current_user),db:Session=Depends(get_db)):
    row=db.scalar(select(Notification).where(Notification.id==id,Notification.user_id==user.id).with_for_update())
    if not row:raise HTTPException(404,'NOTIFICATION_NOT_FOUND')
    if not row.read_at:row.read_at=row.updated_at=now()
    db.commit();return {'data':data(row)}
