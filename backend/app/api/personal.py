from fastapi import APIRouter,Depends,HTTPException
from sqlalchemy import select,func,update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session
from ..core.security import current_user
from ..db import get_db
from ..models import Favorite,Satellite,Station,User
from ..schemas import FavoriteInput,StationInput

router=APIRouter(prefix='/api',tags=['个人资源'])


def station_data(row):
    return {'id':row.id,'name':row.name,'latitude':row.latitude,'longitude':row.longitude,
            'elevation_m':row.elevation_m,'is_default':row.is_default,'createdAt':row.created_at.isoformat()}


@router.get('/favorites')
def favorites(user:User=Depends(current_user),db:Session=Depends(get_db)):
    rows=db.execute(select(Satellite).join(Favorite).where(Favorite.user_id==user.id).order_by(Satellite.norad_id)).scalars().all()
    return {'total':len(rows),'list':[{'noradId':row.norad_id,'name':row.name} for row in rows]}


@router.post('/favorites',status_code=201)
def add_favorite(body:FavoriteInput,user:User=Depends(current_user),db:Session=Depends(get_db)):
    if not db.get(Satellite,body.noradId):raise HTTPException(404,'SATELLITE_NOT_FOUND')
    db.execute(insert(Favorite).values(user_id=user.id,norad_id=body.noradId).on_conflict_do_nothing())
    db.commit();return {'data':{'noradId':body.noradId,'isFavorite':True}}


@router.delete('/favorites/{norad_id}')
def remove_favorite(norad_id:int,user:User=Depends(current_user),db:Session=Depends(get_db)):
    row=db.get(Favorite,(user.id,norad_id))
    if row:db.delete(row);db.commit()
    return {'data':{'noradId':norad_id,'isFavorite':False}}


@router.get('/stations')
def stations(user:User=Depends(current_user),db:Session=Depends(get_db)):
    rows=db.scalars(select(Station).where(Station.user_id==user.id).order_by(Station.created_at)).all()
    return {'total':len(rows),'list':[station_data(row) for row in rows]}


@router.post('/stations',status_code=201)
def create_station(body:StationInput,user:User=Depends(current_user),db:Session=Depends(get_db)):
    db.scalar(select(User).where(User.id==user.id).with_for_update())
    count=db.scalar(select(func.count()).select_from(Station).where(Station.user_id==user.id))
    if count>=50:raise HTTPException(409,'STATION_LIMIT')
    values=body.model_dump();values['is_default']=body.is_default or count==0
    if values['is_default']:db.execute(update(Station).where(Station.user_id==user.id).values(is_default=False))
    row=Station(user_id=user.id,**values);db.add(row);db.commit()
    return {'data':station_data(row)}


def own_station(id,user,db):
    row=db.get(Station,id)
    if not row or row.user_id!=user.id:raise HTTPException(404,'STATION_NOT_FOUND')
    return row


@router.get('/stations/{id}')
def get_station(id:str,user:User=Depends(current_user),db:Session=Depends(get_db)):
    return {'data':station_data(own_station(id,user,db))}


@router.patch('/stations/{id}')
def update_station(id:str,body:StationInput,user:User=Depends(current_user),db:Session=Depends(get_db)):
    db.scalar(select(User).where(User.id==user.id).with_for_update())
    row=own_station(id,user,db)
    values=body.model_dump();values['is_default']=row.is_default or body.is_default
    if values['is_default']:db.execute(update(Station).where(Station.user_id==user.id,Station.id!=id).values(is_default=False))
    for key,value in values.items():setattr(row,key,value)
    db.commit();return {'data':station_data(row)}


@router.delete('/stations/{id}')
def delete_station(id:str,user:User=Depends(current_user),db:Session=Depends(get_db)):
    db.scalar(select(User).where(User.id==user.id).with_for_update())
    row=own_station(id,user,db);was_default=row.is_default;db.delete(row);db.flush()
    if was_default:
        replacement=db.scalar(select(Station).where(Station.user_id==user.id).order_by(Station.created_at,Station.id).limit(1))
        if replacement:replacement.is_default=True
    db.commit();return {'data':{'deleted':True,'snapshotsRetained':True}}
