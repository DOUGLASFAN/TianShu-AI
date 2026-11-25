"""Single-use ticket authentication; bounded subscriptions and resumable snapshots."""
import asyncio,hashlib,json,secrets,time,uuid
from datetime import timedelta
from fastapi import APIRouter,Depends,HTTPException,Request,Response,WebSocket,WebSocketDisconnect
from sqlalchemy import delete
from ..core.config import settings
from ..core.security import current_user,browser_origin
from ..core.cache import allow_login
from ..db import SessionLocal
from ..models import User,AuthSession,RuntimeState,now
from ..services.scheduling import read
from .explore import trajectory

router=APIRouter(tags=['实时连接'])

@router.get('/api/realtime/status',dependencies=[Depends(current_user)])
def runtime_status():return {'data':snapshot()}

@router.post('/api/realtime/ticket')
def ticket(request:Request,response:Response,user:User=Depends(current_user)):
    browser_origin(request,required=True)
    if not allow_login('ws-ticket:'+user.id):raise HTTPException(429,'WS_TICKET_RATE_LIMIT')
    response.headers['Cache-Control']='no-store'
    raw=secrets.token_urlsafe(32);key='ws:'+hashlib.sha256(raw.encode()).hexdigest()[:60]
    with SessionLocal() as db,db.begin():
        db.execute(delete(RuntimeState).where(RuntimeState.key.like('ws:%'),RuntimeState.updated_at<now()-timedelta(seconds=60)))
        db.add(RuntimeState(key=key,value={'userId':user.id,'sessionId':request.state.auth_session.id,'version':user.token_version,'expiresAt':(now()+timedelta(seconds=30)).isoformat()},updated_at=now()))
    return {'ticket':raw,'expiresIn':30}

def consume(raw):
    if not isinstance(raw,str) or len(raw)>128:return None
    with SessionLocal() as db,db.begin():
        row=db.get(RuntimeState,'ws:'+hashlib.sha256(raw.encode()).hexdigest()[:60],with_for_update=True)
        if not row:return None
        value=dict(row.value);db.delete(row)
    return value if now().isoformat()<value['expiresAt'] and authorized(value) else None

def authorized(value):
    with SessionLocal() as db:
        user=db.get(User,value['userId']);session=db.get(AuthSession,value['sessionId'])
        return bool(user and user.enabled and user.token_version==value['version'] and session and session.user_id==user.id and not session.revoked and session.expires_at>now())

def snapshot():
    return {'serverTime':now().isoformat(),'jobs':{name:read('job:'+name) for name in ('orbit','iss','statistics')},'iss':read('iss:last_good'),'statistics':read('statistics:last_good')}

def selected_track(norad):
    with SessionLocal() as db:return trajectory(norad,at=None,db=db)

@router.websocket('/api/realtime/ws')
async def socket(ws:WebSocket):
    if ws.headers.get('origin') not in settings().allowed_origins.split(','):
        await ws.close(code=1008);return
    await ws.accept();stream=uuid.uuid4().hex;seq=0
    async def send(kind,data):
        nonlocal seq
        seq+=1
        await asyncio.wait_for(ws.send_json({'type':kind,'streamId':stream,'seq':seq,'data':data}),5)
    try:
        hello=await asyncio.wait_for(ws.receive_text(),5)
        if len(hello)>512:await ws.close(code=1008);return
        hello=json.loads(hello)
        identity=await asyncio.to_thread(consume,hello.get('ticket')) if hello.get('type')=='auth' else None
        if not identity:await ws.close(code=4401);return
        previous=await asyncio.to_thread(snapshot)
        await send('snapshot',previous)
        from ..services.reminders import summary as notification_summary
        notifications=await asyncio.to_thread(notification_summary,identity['userId'])
        await send('notifications',notifications)
        selected=None;last_heartbeat=last_pong=time.monotonic();last_track=0;last_subscribe=0;last_notifications=0
        while True:
            stamp=time.monotonic()
            if stamp-last_notifications>=2:
                if not await asyncio.to_thread(authorized,identity):await ws.close(code=4401);return
                current_notifications=await asyncio.to_thread(notification_summary,identity['userId'])
                if current_notifications!=notifications:await send('notifications',current_notifications);notifications=current_notifications
                last_notifications=stamp
            if stamp-last_heartbeat>=10:
                if not await asyncio.to_thread(authorized,identity):await ws.close(code=4401);return
                if stamp-last_pong>35:await ws.close(code=4408);return
                await send('heartbeat',{'serverTime':now().isoformat()})
                current=await asyncio.to_thread(snapshot)
                changed={key:value for key,value in current.items() if key!='serverTime' and previous.get(key)!=value}
                if changed:await send('delta',dict(changed,serverTime=current['serverTime']))
                previous=current;last_heartbeat=stamp
            if selected and stamp-last_track>=60:
                try:await send('trajectory',await asyncio.to_thread(selected_track,selected))
                except HTTPException:await send('trajectory_error',{'noradId':selected,'code':'ORBIT_UNAVAILABLE'})
                last_track=stamp
            try:raw=await asyncio.wait_for(ws.receive_text(),1)
            except asyncio.TimeoutError:continue
            if len(raw)>512:await ws.close(code=1008);return
            message=json.loads(raw)
            if message.get('type')=='pong':last_pong=time.monotonic()
            elif message.get('type')=='subscribe':
                norad=message.get('noradId')
                if type(norad) is not int or not 0<norad<=999999999:await ws.close(code=1008);return
                selected=norad
                last_track=stamp-59.75 if stamp-last_subscribe<.25 else 0
                last_subscribe=stamp
            else:await ws.close(code=1008);return
    except (WebSocketDisconnect,asyncio.TimeoutError):return
    except (ValueError,TypeError,AttributeError,KeyError):
        await ws.close(code=1008)
    except Exception:
        try:await ws.close(code=1013)
        except RuntimeError:pass
