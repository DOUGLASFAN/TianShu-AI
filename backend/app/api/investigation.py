"""Owner-scoped investigation tools for exploration and historical telemetry."""
import json
from typing import Literal
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import AwareDatetime, BaseModel, Field, ValidationError
from sqlalchemy import func, select

from .research import config, structured_call
from .telemetry import database, report
from ..core.security import current_user
from ..db import get_db
from ..models import Prediction, PredictionEvent, WeatherEvent
from ..services.investigation import compare_window
from ..services.telemetry import instant

router=APIRouter(prefix='/api/investigation',tags=['异常调查'])


@router.get('/bookmarks')
def bookmarks(start:AwareDatetime|None=None,end:AwareDatetime|None=None,user=Depends(current_user),db_session=Depends(get_db)):
    if (start is None)!=(end is None) or (start and start>end):
        raise HTTPException(422,'书签时间范围无效')
    with database() as db:
        rows=db.execute("""SELECT runs.id,json_extract(report,'$.asset.mission'),
            json_extract(report,'$.asset.norad'),json_extract(report,'$.asset.sha256'),
            json_extract(report,'$.asset.tle'),json_extract(point.value,'$.record'),
            json_extract(point.value,'$.utc')
            FROM runs, json_each(report,'$.points') point
            WHERE owner=? AND json_extract(point.value,'$.utc') BETWEEN ? AND ?
            AND EXISTS(SELECT 1 FROM json_each(report,'$.candidates') hit
                WHERE hit.value=json_extract(point.value,'$.record'))
            ORDER BY json_extract(point.value,'$.utc') DESC LIMIT 120""",
            (user.id,instant(start.isoformat()).isoformat() if start else '',
             instant(end.isoformat()).isoformat() if end else '9999')).fetchall()
    unique={}
    for run,mission,norad,sha,tle,record,utc in rows:
        unique.setdefault((sha,record),dict(kind='telemetry',id=f'{run}:{record}',run=run,mission=mission,
                                           norad=norad,record=record,time=utc,orbit=bool(tle)))
    entries=list(unique.values())[:8]
    if start is not None and end is not None:
        # Keep each source represented. Times come from the archived event itself.
        passes=db_session.execute(select(PredictionEvent).join(Prediction)
            .where(Prediction.user_id==user.id,Prediction.status=='completed',
                PredictionEvent.start_at.between(start,end)).order_by(PredictionEvent.start_at).limit(3)).scalars()
        entries.extend(dict(kind='pass',id=f'{p.task_id}:{p.event_id}',task=p.task_id,event=p.event_id,
            norad=p.norad_id,time=p.start_at.isoformat(),visual=p.visual) for p in passes)
        event_time=func.coalesce(WeatherEvent.occurred_at,WeatherEvent.issued_at)
        weather=db_session.execute(select(WeatherEvent,event_time.label('when')).where(event_time.between(start,end))
            .order_by(event_time.desc()).limit(3))
        entries.extend(dict(kind='weather',id=e.id,time=when.isoformat(),category=e.category,source=e.source_id)
                       for e,when in weather)
    return sorted(entries,key=lambda item:instant(item['time']))


class Selection(BaseModel):
    start:AwareDatetime
    end:AwareDatetime
    target:int|None=None
    ai:bool=False


class Focus(BaseModel):
    order:list[Literal['signal','quality','sensitivity']]=Field(min_length=3,max_length=3)


@router.post('/runs/{key}')
def investigate(key:str,selection:Selection,user=Depends(current_user)):
    saved=report(key,user)
    if not instant(saved['start'])<=selection.start<=selection.end<=instant(saved['end']):
        raise HTTPException(422,'调查范围须在报告覆盖范围内')
    try:
        result=compare_window(saved,selection.start,selection.end,selection.target,instant)
    except ValueError as error:
        raise HTTPException(422,str(error)) from error
    result.update(reportId=key,source=saved['asset']['sha256'],model=None)
    if selection.ai:
        endpoint,model,_=config('qwen')
        if not model or urlparse(endpoint).hostname not in ('localhost','127.0.0.1','::1'):
            result['aiIssue']='未配置本机 Qwen。已显示规则分析。'
            return result
        summaries=[{k:h[k] for k in ('id','status','support')} for h in result['hypotheses']]
        try:
            chosen,model=structured_call('qwen',[{'role':'system','content':
                '优先复核有证据的解释。只返回 JSON，例如 {"order":["quality","signal","sensitivity"]}，三个 ID 各一次。'},
                {'role':'user','content':json.dumps(summaries,ensure_ascii=False)}],Focus,96)
            by_id={h['id']:h for h in result['hypotheses']}
            if set(chosen.order)!=set(by_id):
                raise ValueError('invalid order')
            result.update(hypotheses=[by_id[k] for k in chosen.order],model=model)
        except (httpx.HTTPError, ValueError, ValidationError, KeyError, TypeError, IndexError):
            result['aiIssue']='模型暂未给出有效排序。已显示规则分析。'
    return result
