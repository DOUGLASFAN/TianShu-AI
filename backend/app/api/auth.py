import hashlib
from fastapi import APIRouter,Depends,HTTPException,Request,Response
from sqlalchemy import select
from sqlalchemy.orm import Session
from ..core.cache import allow_login
from ..core.config import settings
from ..core.security import DUMMY,browser_origin,current_user,issue,passwords,resolve
from ..db import get_db
from ..models import User
from ..schemas import Credentials

router=APIRouter(prefix='/api/auth',tags=['认证'])


def user_data(user):return {'id':user.id,'username':user.username,'role':user.role,'enabled':user.enabled}


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
    if not user or not valid or not user.enabled:raise HTTPException(401,'INVALID_CREDENTIALS')
    token,expiry=issue(user,db);db.commit()
    response.set_cookie('star_session',token,httponly=True,secure=settings().secure_cookies,
                        samesite='strict',max_age=settings().token_hours*3600,path='/api/auth')
    response.headers['Cache-Control']='no-store'
    return {'accessToken':token,'tokenType':'Bearer','expiresAt':expiry.isoformat(),'user':user_data(user)}


@router.post('/session')
def restore(request:Request,response:Response,db:Session=Depends(get_db)):
    browser_origin(request,required=True)
    token=request.cookies.get('star_session')
    if not token:raise HTTPException(401,'AUTH_REQUIRED')
    user,session=resolve(token,db)
    response.headers['Cache-Control']='no-store'
    return {'accessToken':token,'tokenType':'Bearer','expiresAt':session.expires_at.isoformat(),'user':user_data(user)}


@router.get('/me')
def me(user:User=Depends(current_user)):return {'data':user_data(user)}


@router.post('/logout')
def logout(request:Request,response:Response,user:User=Depends(current_user),db:Session=Depends(get_db)):
    browser_origin(request)
    request.state.auth_session.revoked=True;db.commit()
    response.delete_cookie('star_session',path='/api/auth')
    return {'data':{'loggedOut':True}}
