import hashlib
from datetime import timedelta
from fastapi import APIRouter,Depends,HTTPException,Request,Response
from sqlalchemy import delete,select
from sqlalchemy.orm import Session
from ..core.cache import allow_login
from ..core.config import settings
from ..core.security import DUMMY,browser_origin,current_user,issue,passwords,resolve
from ..db import get_db
from ..models import Station,User,now,uid
from ..schemas import Credentials

router=APIRouter(prefix='/api/auth',tags=['认证'])
GUEST_LIFETIME=timedelta(hours=2)


def user_data(user):return {'id':user.id,'username':user.username,'role':user.role,'enabled':user.enabled,'isGuest':user.is_guest}


def session_data(response,user,token,expiry):
    response.headers['Cache-Control']='no-store'
    return {'accessToken':token,'tokenType':'Bearer','expiresAt':expiry.isoformat(),'user':user_data(user)}


def start_session(response,user,db,lifetime):
    token,expiry=issue(user,db,lifetime=lifetime)
    db.commit()
    response.set_cookie('star_session',token,httponly=True,secure=settings().secure_cookies,
                        samesite='strict',max_age=int(lifetime.total_seconds()),path='/api/auth')
    return session_data(response,user,token,expiry)


@router.post('/register',status_code=201)
def register(body:Credentials,request:Request,db:Session=Depends(get_db)):
    browser_origin(request)
    if db.scalar(select(User.id).where(User.username==body.username)):raise HTTPException(409,'USERNAME_TAKEN')
    user=User(username=body.username,password_hash=passwords.hash(body.password),role='user',enabled=True,token_version=0)
    db.add(user);db.commit()
    return {'data':user_data(user)}


@router.post('/login')
def login(body:Credentials,request:Request,response:Response,db:Session=Depends(get_db)):
    browser_origin(request)
    key=hashlib.sha256(((request.client.host if request.client else 'unknown')+':'+body.username).encode()).hexdigest()
    if not allow_login(key):raise HTTPException(429,'LOGIN_RATE_LIMIT')
    user=db.scalar(select(User).where(User.username==body.username))
    valid=passwords.verify(body.password,user.password_hash if user else DUMMY)
    if not user or not valid or not user.enabled or user.is_guest:raise HTTPException(401,'INVALID_CREDENTIALS')
    return start_session(response,user,db,timedelta(hours=settings().token_hours))


@router.post('/guest')
def guest(request:Request,response:Response,db:Session=Depends(get_db)):
    browser_origin(request,required=True)
    token=request.cookies.get('star_session')
    if token:
        try:
            user,session=resolve(token,db)
        except HTTPException as error:
            if error.status_code!=401:raise
        else:
            if not user.is_guest:raise HTTPException(409,'GUEST_SIGN_OUT_REQUIRED')
            return session_data(response,user,token,session.expires_at)
    host=request.client.host if request.client else 'unknown'
    key=hashlib.sha256(f'guest:{host}'.encode()).hexdigest()
    if not allow_login(key):raise HTTPException(429,'LOGIN_RATE_LIMIT')
    # Keep expired guest rows out of the account store without affecting active or registered users.
    expired=select(User.id).where(User.is_guest.is_(True),User.created_at<now()-timedelta(days=1))
    expired=expired.order_by(User.created_at,User.id).limit(32).with_for_update(skip_locked=True)
    db.execute(delete(User).where(User.id.in_(expired)))
    user=User(username='guest-'+uid().replace('-','')[:26],password_hash=DUMMY,role='user',is_guest=True)
    db.add(user)
    db.flush()
    db.add(Station(user_id=user.id,name='北京（示例站）',latitude=39.9,longitude=116.4,
                   elevation_m=0,is_default=True))
    return start_session(response,user,db,GUEST_LIFETIME)


@router.post('/session')
def restore(request:Request,response:Response,db:Session=Depends(get_db)):
    browser_origin(request,required=True)
    token=request.cookies.get('star_session')
    if not token:raise HTTPException(401,'AUTH_REQUIRED')
    user,session=resolve(token,db)
    return session_data(response,user,token,session.expires_at)


@router.get('/me')
def me(user:User=Depends(current_user)):return {'data':user_data(user)}


@router.post('/logout')
def logout(request:Request,response:Response,user:User=Depends(current_user),db:Session=Depends(get_db)):
    browser_origin(request)
    request.state.auth_session.revoked=True;db.commit()
    response.delete_cookie('star_session',path='/api/auth')
    return {'data':{'loggedOut':True}}
