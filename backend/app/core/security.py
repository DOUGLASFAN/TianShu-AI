import hashlib
import secrets
from datetime import timedelta
import jwt
from fastapi import HTTPException,Request,Depends
from fastapi.security import HTTPAuthorizationCredentials,HTTPBearer
from pwdlib import PasswordHash
from sqlalchemy.orm import Session
from ..db import get_db
from ..models import AuthSession,User,now,uid
from .config import settings

passwords=PasswordHash.recommended()
bearer=HTTPBearer(auto_error=False)
DUMMY=passwords.hash(secrets.token_urlsafe(32))


def issue(user,db,*,lifetime=None):
    expiry=now()+(lifetime if lifetime is not None else timedelta(hours=settings().token_hours))
    record=AuthSession(id=uid(),user_id=user.id,expires_at=expiry,revoked=False)
    db.add(record)
    token=jwt.encode({'sub':user.id,'jti':record.id,'ver':user.token_version,'iat':now(),
                      'exp':expiry,'iss':'star-nexus','aud':'star-nexus-web'},
                     settings().jwt_secret.get_secret_value(),algorithm='HS256')
    return token,expiry


def resolve(token,db):
    try:
        claims=jwt.decode(token,settings().jwt_secret.get_secret_value(),algorithms=['HS256'],
                          issuer='star-nexus',audience='star-nexus-web',
                          options={'require':['sub','jti','ver','iat','exp','iss','aud']})
        user=db.get(User,claims['sub']);session=db.get(AuthSession,claims['jti'])
        if not user or not user.enabled or user.token_version!=claims['ver'] or not session or session.revoked or session.user_id!=user.id or session.expires_at<=now():
            raise ValueError('Inactive session')
        return user,session
    except (jwt.PyJWTError,ValueError,TypeError,KeyError):
        raise HTTPException(401,'SESSION_INVALID',headers={'WWW-Authenticate':'Bearer'})


def current_user(request:Request,credentials:HTTPAuthorizationCredentials|None=Depends(bearer),db:Session=Depends(get_db)):
    if not credentials:raise HTTPException(401,'AUTH_REQUIRED',headers={'WWW-Authenticate':'Bearer'})
    user,session=resolve(credentials.credentials,db)
    request.state.auth_session=session
    return user


def admin(user:User=Depends(current_user)):
    if user.role!='admin':raise HTTPException(403,'ADMIN_REQUIRED')
    return user


def browser_origin(request,required=False):
    origin=request.headers.get('origin')
    if (required and not origin) or (origin and origin not in settings().allowed_origins.split(',')):
        raise HTTPException(403,'ORIGIN_REJECTED')
