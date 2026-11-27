"""Typed AI actions for discovery and bounded observation calculations."""
from datetime import timedelta
import re
from threading import BoundedSemaphore
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select

from .predictions import make_basis
from .research import config, structured_call
from ..core.security import current_user
from ..db import get_db
from ..models import Satellite, Station, now
from ..services.prediction_math import calculate

router = APIRouter(prefix='/api/exploration-assistant', tags=['AI 探索'])
slots = BoundedSemaphore(2)


class Prompt(BaseModel):
    text: str = Field(min_length=2, max_length=400)


class Action(BaseModel):
    model_config = ConfigDict(extra='forbid')
    intent: Literal['search','observe','bookmarks','diagnose','unsupported']
    query: str = Field(default='', max_length=100)
    group: Literal['','BEIDOU','GPS-OPS','GALILEO','STATIONS'] = ''
    station: str = Field(default='', max_length=80)
    window: Literal['now','tonight','next-day'] = 'next-day'


@router.post('/interpret')
def interpret(body: Prompt, user=Depends(current_user)):
    provider='qwen'
    if not user.is_guest and all(config('deepseek-cloud')):
        provider='deepseek-cloud'
    if not all(config(provider)[:2]):
        raise HTTPException(503,'AI_MODEL_UNAVAILABLE')
    messages=[
        {'role':'system','content':'''将用户描述翻译成受限的 JSON 地图动作。只输出 intent, query, group, station, window。
search 用来找卫星；observe 展示可观测窗口；bookmarks 查当前时段书签；diagnose 查画面；其他用 unsupported。
query 只写卫星名称（如 ISS）或 NORAD 编号，不附加其他文字。选导航星座时 group 可为 BEIDOU、GPS-OPS、GALILEO，空间站组 STATIONS，不知道则空。station 保留用户明确写出的站名。
例：{"intent":"observe","query":"ISS","group":"","station":"北京","window":"tonight"}。不要编造坐标、编号或观测结果。'''},
        {'role':'user','content':body.text},
    ]
    try:
        action,model=structured_call(provider,messages,Action,200)
    except (httpx.HTTPError, ValueError, ValidationError, KeyError, TypeError, IndexError) as exc:
        raise HTTPException(503,'AI_MODEL_UNAVAILABLE') from exc
    # Explicit clock, object and station terms take priority over inferred fields.
    text=body.text.strip()
    if re.search(r'为什么.{0,18}(消失|没显示|看不到)|画面诊断',text):
        action=Action(intent='diagnose')
    elif re.search(r'书签|值得看.{0,4}(时刻|时间)',text):
        action=Action(intent='bookmarks')
    elif re.search(r'观测|过境|能看到',text):
        action.intent='observe'
        action.group=''
        if '今晚' in text:action.window='tonight'
        elif '现在' in text or '当前' in text:action.window='now'
        if '北京' in text:action.station='北京'
    if action.intent in ('search','observe'):
        identifier=re.search(r'(?i)\b(?:NORAD\s*)?(\d{4,7})\b',text)
        if identifier:action.query=identifier.group(1)
        elif re.search(r'(?i)\bISS\b|国际空间站',text):action.query='25544'
        elif '北斗' in text:
            action.group='BEIDOU';action.query='北斗三号' if '三号' in text else ''
        if action.intent=='observe' and re.search(r'推荐|哪些卫星|观测的卫星',text) and not identifier and 'ISS' not in text.upper() and '国际空间站' not in text:
            action.query=''
    return dict(action=action.model_dump(),model=model)


class Scenario(BaseModel):
    station: str = Field(min_length=1,max_length=80)
    minimum: float = Field(default=15,ge=0,le=85)


class ObservationRequest(BaseModel):
    query: str = Field(default='',max_length=100)
    group: Literal['','BEIDOU','GPS-OPS','GALILEO','STATIONS'] = ''
    window: Literal['now','tonight','next-day'] = 'next-day'
    start: AwareDatetime|None = None
    scenarios: list[Scenario] = Field(min_length=1,max_length=2)


def match_station(db, owner, name):
    items=db.scalars(select(Station).where(Station.user_id==owner).order_by(Station.is_default.desc(),Station.name)).all()
    exact=[item for item in items if item.id==name or item.name==name]
    matches=exact or [item for item in items if name in item.name]
    if len(matches)!=1:
        raise HTTPException(422,'AI_OBSERVATION_STATION')
    return matches[0]


@router.post('/observation')
def observation(body: ObservationRequest,user=Depends(current_user),db=Depends(get_db)):
    from ..models import GroupMember
    from datetime import timezone
    clock=now()
    start=body.start or clock
    if body.window=='tonight' and body.start is None:
        beijing=timezone(timedelta(hours=8))
        evening=clock.astimezone(beijing).replace(hour=18,minute=0,second=0,microsecond=0)
        start=max(clock,evening)
    if not clock-timedelta(minutes=2)<=start<=clock+timedelta(days=7):
        raise HTTPException(422,'PREDICTION_TIME_RANGE')
    duration={'now':timedelta(minutes=30),'tonight':timedelta(hours=12),'next-day':timedelta(days=1)}[body.window]
    if body.window=='tonight' and body.start is None:
        duration=evening+timedelta(hours=12)-start
    stations=[match_station(db,user.id,s.station) for s in body.scenarios]
    query=select(Satellite)
    if body.group in ('GPS-OPS','GALILEO'):
        from ..api.sampling import NAVIGATION_PATTERNS
        from sqlalchemy import or_
        key='gps' if body.group=='GPS-OPS' else 'galileo'
        query=query.where(or_(*(Satellite.name.ilike(pattern) for pattern in NAVIGATION_PATTERNS[key])))
    elif body.group:
        query=query.where(Satellite.norad_id.in_(select(GroupMember.norad_id).where(GroupMember.group_slug==body.group.lower())))
    text=body.query.strip()
    if text.upper() in ('ISS','ISS (ZARYA)','国际空间站'):
        query=query.where(Satellite.norad_id==25544)
    elif text=='北斗三号':
        query=query.where(Satellite.name.ilike('%BEIDOU-3%'))
    elif text.isdigit():
        query=query.where(Satellite.norad_id==int(text))
    elif text:
        query=query.where(Satellite.name.icontains(text,autoescape=True))
    elif not body.group:
        query=query.where(Satellite.norad_id.in_([25544,48274,20580,43013]))
    satellites=list(db.scalars(query.order_by(Satellite.epoch.desc(),Satellite.norad_id).limit(7)))
    if not slots.acquire(blocking=False):
        raise HTTPException(429,'PREDICTION_QUEUE_FULL')
    try:
        output=[]
        for station,scenario in zip(stations,body.scenarios):
            choices=[]; skipped=[]
            for satellite in satellites[:6]:
                basis=make_basis(station,satellite,start,1,scenario.minimum,False)
                if basis['staleAtSubmission']:
                    skipped.append(dict(norad=satellite.norad_id,reason='根数过期或历元异常'))
                    continue
                basis['end']=(start+duration).isoformat()
                try:
                    passes=calculate(basis)
                except (ValueError,RuntimeError,OSError):
                    skipped.append(dict(norad=satellite.norad_id,reason='轨道或观测计算不可用'))
                    continue
                for event in passes:
                    choices.append(dict(norad=satellite.norad_id,name=satellite.name,start=event['start'],end=event['end'],
                        peak=event['peak'],elevation=event['max_elevation'],duration=event['duration_s'],
                        optical=bool(event['visible_windows']),visibleNow=event['partial_start'],
                        orbitEpoch=basis['orbit']['epoch'],orbitSource=basis['orbit']['source']))
            choices.sort(key=lambda v:(not v['optical'],-v['elevation'],v['start']))
            output.append(dict(station={'id':station.id,'name':station.name,'lat':station.latitude,'lng':station.longitude},
                minimum=scenario.minimum,windows=choices[:12],skipped=skipped,total=len(choices),
                opticalWindows=sum(v['optical'] for v in choices)))
        return dict(start=start.isoformat(),end=(start+duration).isoformat(),scenarios=output,
                    targets=min(6,len(satellites)),limited=len(satellites)>6,
                    scope='仅评估所列或匹配的最多六颗卫星。目视条件基于受光与太阳高度，不含天气、亮度和遮挡。')
    finally:
        slots.release()
