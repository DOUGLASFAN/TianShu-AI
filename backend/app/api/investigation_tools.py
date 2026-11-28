"""Evidence linked to the same owner, data version and time range as the investigation."""
import csv
import io
import json
import math
import re
from statistics import mean, pstdev
from typing import Literal
from urllib.parse import urlencode
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import AwareDatetime, BaseModel, Field, ValidationError
from sqlalchemy import func, select

from .telemetry import Upload, assets, database, encode, read_asset, report, store_asset
from ..core.security import current_user
from ..db import get_db
from ..models import Satellite, WeatherEvent
from ..services.investigation import compare_window
from ..services.telemetry import analyze, digest, instant, parse

router = APIRouter(prefix='/api/investigation-tools', tags=['调查工具'])


def matching_assets(user, norad, kind):
    return [a for a in assets(user) if a['norad']==norad and a.get('kind','telemetry')==kind]


@router.get('/satellites/{norad}')
def dossier(norad:int,user=Depends(current_user),db=Depends(get_db)):
    sat=db.get(Satellite,norad)
    archives=matching_assets(user,norad,'telemetry')
    if sat is None and not archives:
        raise HTTPException(404,'SATELLITE_NOT_FOUND')
    with database() as local:
        notes=local.execute("""SELECT id,json_extract(report,'$.channel'),json_extract(report,'$.start'),
            json_extract(report,'$.candidates') FROM runs WHERE owner=? AND json_extract(report,'$.asset.norad')=?
            AND json_array_length(report,'$.candidates')>0 ORDER BY rowid DESC LIMIT 8""",(user.id,norad)).fetchall()
    meta=sat.metadata_raw if sat else {}
    return dict(name=sat.name if sat else archives[0]['mission'],norad=norad,
        purpose=meta.get('PURPOSE') or meta.get('MISSION') or None,
        orbit=dict(epoch=sat.epoch.isoformat(),source=sat.source,version=sat.content_hash) if sat else None,
        archives=[{k:a.get(k) for k in ('id','mission','source','coverageStart','coverageEnd')} for a in archives],
        candidates=[dict(run=key,channel=ch,start=start,record=json.loads(hits)[0]) for key,ch,start,hits in notes])


def shape(values):
    if len(values)<3:return None
    # Resample on relative segment progress. Report this as shape similarity, not equal cadence.
    sampled=[]
    for i in range(32):
        idx=i*(len(values)-1)/31
        a=int(idx);b=min(a+1,len(values)-1)
        sampled.append(values[a]+(values[b]-values[a])*(idx-a))
    center=mean(sampled);scale=pstdev(sampled)
    if not scale:return None
    return [(x-center)/scale for x in sampled]


@router.get('/runs/{key}/similar')
def similar(key:str,user=Depends(current_user)):
    saved=report(key,user);used=set(saved['used'])
    reference=shape([p['value'] for p in saved['points'] if p['record'] in used])
    if reference is None:return dict(matches=[],reason='参考片段有效变化不足，无法比较形状')
    found=[]
    with database() as local:
        reviews={(sha,ch,seg):dict(run=run,note=review) for run,sha,ch,seg,review in local.execute("""SELECT id,json_extract(report,'$.asset.sha256'),
            json_extract(report,'$.channel'),json_extract(report,'$.segment'),review FROM runs WHERE owner=? ORDER BY rowid""",(user.id,))}
    for a in matching_assets(user,saved['asset']['norad'],'telemetry')[:12]:
        if a['unit']!=saved['asset']['unit']:continue
        meta,text=read_asset(user.id,a['id'])
        for ch,seg in list(parse(text))[:40]:
            if ch!=saved['channel'] or (meta['sha256']==saved['asset']['sha256'] and seg==saved['segment']):continue
            try:r=analyze(text,meta,ch,seg)
            except ValueError:continue
            admitted=set(r['used']);profile=shape([p['value'] for p in r['points'] if p['record'] in admitted])
            if profile is None:continue
            score=sum(x*y for x,y in zip(reference,profile))/len(reference)
            found.append(dict(asset=a['id'],segment=seg,channel=ch,start=r['start'],source=meta['source'],
                correlation=max(-1,min(1,score)),curve=profile,labels=sorted({p['raw'].get('anomaly','未知') for p in r['points']}),
                review=reviews.get((meta['sha256'],ch,seg))))
    return dict(matches=sorted(found,key=lambda r:-r['correlation'])[:5],reference=reference,
                reason='同 NORAD、通道和登记单位，按相对进度重采样后比较标准化波形。')


@router.get('/runs/{key}/context')
def context(key:str,user=Depends(current_user),db=Depends(get_db)):
    return context_for_window(key,user,db)


def report_window(saved,record=None,start=None,end=None):
    point=next((p for p in saved['points'] if p['record']==record),None) if record is not None else None
    if record is not None and point is None:
        raise HTTPException(422,'WORKFLOW_RECORD_NOT_FOUND')
    first,last=instant(saved['start']),instant(saved['end'])
    start,end=start or first,end or last
    if not (first<=start<=end<=last) or (point and not start<=instant(point['utc'])<=end):
        raise HTTPException(422,'WORKFLOW_WINDOW_INVALID')
    return point,start,end


def context_for_window(key,user,db,window=None,point=None):
    from backend.phase1.orbits import from_tle
    saved=report(key,user);meta=saved['asset'];start,end=window or (instant(saved['start']),instant(saved['end']))
    begin,finish=start.isoformat(),end.isoformat()
    stamp=func.coalesce(WeatherEvent.occurred_at,WeatherEvent.issued_at)
    origin=dict(run=key)
    if point:
        origin['record']=point['record']
    if window and (start!=instant(saved['start']) or end!=instant(saved['end'])):
        origin.update(start=begin,end=finish)
    entries=[dict(kind='telemetry',start=begin,end=finish,source=meta['source'],
                  label=saved['channel'],state='所选调查时间窗' if window else '报告时间窗',link='/telemetry?'+urlencode(origin))]
    for row,time in db.execute(select(WeatherEvent,stamp).where(stamp.between(start,end)).order_by(stamp).limit(30)):
        entries.append(dict(kind='weather',start=time.isoformat(),source=row.source_id,label=row.category,
                            state='时刻重合，尚无因果证据',link='/environment?event='+row.id))
    if meta.get('tle') and meta.get('orbitSource'):
        sat=from_tle(meta['tle']);epoch=sat.epoch.utc_datetime()
        aligned=sat.model.satnum==meta['norad'] and max(abs((t-epoch).total_seconds()) for t in (start,end))<=86400
        replay=urlencode(dict(historical=key,sat=meta['norad'],at=point['utc'] if point else begin,
                              **{k:v for k,v in origin.items() if k!='run'}))
        entries.append(dict(kind='orbit',start=begin if aligned else epoch.isoformat(),
            end=finish if aligned else None,source=meta['orbitSource'],label='归档根数',
            state='覆盖时段，可推算几何位置' if aligned else '根数超出允许的推算范围',
            link='/explore?'+replay if aligned else None))
    for a in matching_assets(user,meta['norad'],'observation')[:20]:
        _,text=read_asset(user.id,a['id'])
        for (channel,seg),points in parse(text).items():
            timestamps=[instant(p['utc']) for p in points if start<=instant(p['utc'])<=end]
            if timestamps:
                entries.append(dict(kind='observation',start=min(timestamps).isoformat(),end=max(timestamps).isoformat(),
                    source=a['source'],label=f"{a.get('station','站点')} · {seg}",state=f'{len(timestamps)} 条同期记录，尚未核对观测条件',
                    link='/telemetry?'+urlencode(dict(asset=a['id'],channel=channel,segment=seg))))
            if len(entries)>=60:break
        if len(entries)>=60:break
    return dict(entries=sorted(entries,key=lambda e:instant(e['start'])),start=begin,end=finish,
                missing=[k for k in ('orbit','weather','observation') if not any(e['kind']==k for e in entries)])


@router.get('/runs/{key}/challenge')
def challenge(key:str,user=Depends(current_user)):
    saved=report(key,user)
    return challenge_report(saved,saved['candidates'][0] if saved['candidates'] else None)


def challenge_report(saved,target):
    points=saved['points']; start,end=instant(saved['start']),instant(saved['end'])
    used=set(saved['used'])
    configs=[('原窗口',start,end,saved)]
    if target is not None:
        index=next(i for i,p in enumerate(points) if p['record']==target)
        configs.append(('候选点附近',instant(points[max(0,index-10)]['utc']),instant(points[min(len(points)-1,index+10)]['utc']),saved))
        configs.append(('排除目标点',start,end,dict(saved,used=list(used-{target}))))
    results=[]
    for name,a,b,source in configs:
        try:
            compared=compare_window(source,a,b,target,instant)
            results.append(dict(name=name,**compared))
        except ValueError as exc:results.append(dict(name=name,reason=str(exc)))
    return dict(target=target,results=results,limitations='比较检测结论在规则、窗口及样本变化时的稳定性。排除目标点用于对照。')


@router.get('/runs/{key}/verification')
def verification(key:str,record:int|None=Query(None,gt=0),start:AwareDatetime|None=None,end:AwareDatetime|None=None,
                 user=Depends(current_user),db=Depends(get_db)):
    saved=report(key,user)
    point,begin,finish=report_window(saved,record,start,end)
    meta=saved['asset']
    active=db.get(Satellite,meta['norad'])
    priorities=[
        dict(label='同通道复测',detail=f"主测 {saved['channel']}，保留原始值、时区、单位、采样间隔和质检标记。"),
        dict(label='对照窗口',detail='记录相近仰角和照明条件的正常窗口，同时记录设备状态，供两段对照。'),
    ]
    selected_ids={p['record'] for p in saved['points'] if begin<=instant(p['utc'])<=finish}
    quality=dict(total=len(selected_ids),included=len(selected_ids.intersection(saved['used'])),
                 missing=len(selected_ids.intersection(saved.get('missing',[]))),
                 flagged=len(selected_ids.intersection(saved.get('excludedQuality',[]))),
                 duplicates=sum(begin<=instant(stamp)<=finish for stamp in saved.get('duplicateTimes',[])))
    if quality['missing'] or quality['flagged'] or quality['duplicates']:
        priorities.insert(0,dict(label='排除采集异常',detail='优先核查设备状态、时间同步和缺测、补点日志。'))
    if quality['included']<3:
        priorities.insert(0,dict(label='补采可比较的样本',detail='当前选区少于三个有效点。先扩大选区或找同通道连续数据，再复算规则。'))
    if meta['unit']=='未提供':
        priorities.append(dict(label='补齐单位',detail='确认物理单位、传感器量程和采集配置后再比较数值。'))
    return dict(norad=meta['norad'],mission=meta['mission'],channel=saved['channel'],priorities=priorities,source=meta['source'],
                catalogAvailable=active is not None and active.owner in (None,user.id),report=key,
                start=begin.isoformat(),end=finish.isoformat(),partial=start is not None or end is not None,quality=quality,
                point=dict(record=record,utc=point['utc']) if point else None,
                limitation='站点可见窗口只表示观测几何条件。能否采集该遥测通道取决于设备、权限和链路。')


ALIASES={'timestamp':{'timestamp','time','utc','datetime','时间','采集时间'},'channel':{'channel','sensor','通道','测点'},
         'segment':{'segment','片段','批次','batch'},'value':{'value','reading','measurement','值','测量值'},
         'unit':{'unit','units','单位'},'quality':{'quality','quality_flag','质量','标记'},'sampling':{'sampling','cadence','采样间隔'}}


class ImportInput(BaseModel):
    raw:str=Field(min_length=1,max_length=2_000_000)
    mapping:dict[str,str]=Field(default_factory=dict,max_length=7)
    channel:str=Field(default='',max_length=80)
    segment:str=Field(default='1',max_length=80)
    metadata:dict=Field(default_factory=dict,max_length=15)
    assist:bool=False


class SuggestedColumns(BaseModel):
    mapping:dict[str,str]=Field(max_length=7)


def suggest_columns(body,info):
    from urllib.parse import urlparse
    import httpx
    from .research import config, structured_call
    endpoint,model,_=config('qwen')
    if not model or urlparse(endpoint).hostname not in ('localhost','127.0.0.1','::1'):
        return dict(info,assistantNote='本机模型未配置，已保留规则建议。')
    try:
        proposed,model=structured_call('qwen',[
            {'role':'system','content':'只返回 JSON 对象 mapping，把列名映射到 timestamp、channel、segment、value、unit、quality 或 sampling。无法判断的列省略。'},
            {'role':'user','content':json.dumps(info['headers'],ensure_ascii=False)}],SuggestedColumns,128)
        mapping={k:v for k,v in info['mapping'].items() if v}
        for k,v in proposed.mapping.items():
            if k in ALIASES and v in info['headers'] and k not in mapping and v not in mapping.values():
                mapping[k]=v
        # Suggestions are preserved for confirmation even when the proposed parse fails.
        return dict(info,mapping=mapping,model=model)
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        return dict(info,assistantNote='模型未给出有效映射，已保留规则建议。')


def normalized_import(body):
    reader=csv.DictReader(io.StringIO(body.raw.removeprefix('\ufeff'),newline=''),strict=True)
    headers=reader.fieldnames or []
    if not headers or len(headers)!=len(set(headers)) or len(headers)>100:
        raise ValueError('CSV 列名缺失、重复或列数超过限制')
    suggested={key:next((h for h in headers if re.sub(r'\s+','_',h.strip().lower()) in names),'')
               for key,names in ALIASES.items()}
    mapping={k:v for k,v in (body.mapping or suggested).items() if v}
    if any(k not in ALIASES or v not in headers for k,v in mapping.items()) or len(set(mapping.values()))!=len(mapping):
        raise ValueError('每个目标字段需要不同的有效原始列')
    if not {'timestamp','value'}<=mapping.keys() or not (mapping.get('channel') or body.channel):
        return dict(headers=headers,mapping=suggested,rows=[],missing=True),None
    fields=['timestamp','channel','segment','value']+[k for k in ('unit','quality','sampling') if k in mapping]
    stream=io.StringIO(newline='');writer=csv.DictWriter(stream,fieldnames=fields,lineterminator='\n')
    writer.writeheader();preview=[]
    for n,row in enumerate(reader,1):
        if n>10000 or None in row or None in row.values():raise ValueError(f'第 {n} 条记录列数无效或超出上限')
        output={k:row[mapping[k]] if k in mapping else getattr(body,k) for k in fields}
        writer.writerow(output)
        if n<=5:preview.append(output)
    content=stream.getvalue()
    parse(content)
    return dict(headers=headers,mapping=mapping,rows=preview,missing=False),content


@router.post('/import/preview')
def preview(body:ImportInput,user=Depends(current_user)):
    if user.is_guest:raise HTTPException(403,'需要正式账号')
    try:
        info=normalized_import(body)[0]
        return suggest_columns(body,info) if body.assist else info
    except (csv.Error,ValueError) as exc:raise HTTPException(422,'AI_IMPORT_MAPPING') from exc


@router.post('/import/commit')
def commit_import(body:ImportInput,user=Depends(current_user)):
    if user.is_guest:raise HTTPException(403,'需要正式账号')
    try:
        if not body.mapping:raise ValueError('没有确认映射')
        info,content=normalized_import(body)
        if content is None:raise ValueError('映射不完整')
        data=Upload(**dict(body.metadata,content=content,sha256=digest(content.encode())))
    except (csv.Error,ValueError,ValidationError) as exc:raise HTTPException(422,'AI_IMPORT_MAPPING') from exc
    provenance=dict(mapping=info['mapping'],originalSha256=digest(body.raw.encode()),channel=body.channel,segment=body.segment)
    return store_asset(data,user,source_archive=(body.raw,provenance))


class InvestigationState(BaseModel):
    path:Literal['/explore','/telemetry']
    query:str=Field(max_length=1800)
    camera:list[float]|None=Field(default=None,min_length=6,max_length=6)
    report:str|None=Field(default=None,max_length=100)
    selection:list[str]|None=Field(default=None,min_length=2,max_length=2)
    investigation:dict|None=None
    workflow:dict|None=None


@router.post('/sessions')
def save_session(body:InvestigationState,user=Depends(current_user)):
    if body.report:report(body.report,user)
    if body.workflow is not None:raise HTTPException(422,'AI_SESSION_INVALID')
    return store_session(body,user)


def store_session(body,user):
    try:
        raw=encode(body.model_dump())
        if len(raw)>160000:raise ValueError
    except ValueError as exc:raise HTTPException(422,'AI_SESSION_INVALID') from exc
    key=uuid4().hex
    with database() as db:
        db.execute('CREATE TABLE IF NOT EXISTS investigation_sessions(owner TEXT,id TEXT,payload TEXT,PRIMARY KEY(owner,id))')
        if db.execute('SELECT count(*) FROM investigation_sessions WHERE owner=?',(user.id,)).fetchone()[0]>=100:
            raise HTTPException(409,'AI_SESSION_LIMIT')
        db.execute('INSERT INTO investigation_sessions VALUES(?,?,?)',(user.id,key,raw))
    return dict(id=key)


@router.get('/sessions')
def list_sessions(user=Depends(current_user)):
    with database() as db:
        db.execute('CREATE TABLE IF NOT EXISTS investigation_sessions(owner TEXT,id TEXT,payload TEXT,PRIMARY KEY(owner,id))')
        rows=db.execute('SELECT id,payload FROM investigation_sessions WHERE owner=? ORDER BY rowid DESC LIMIT 30',(user.id,)).fetchall()
    return [dict(id=key,**json.loads(raw)) for key,raw in rows]

@router.get('/sessions/{key}')
def get_session(key:str,user=Depends(current_user)):
    with database() as db:
        db.execute('CREATE TABLE IF NOT EXISTS investigation_sessions(owner TEXT,id TEXT,payload TEXT,PRIMARY KEY(owner,id))')
        row=db.execute('SELECT payload FROM investigation_sessions WHERE owner=? AND id=?',(user.id,key)).fetchone()
    if not row:raise HTTPException(404,'AI_SESSION_NOT_FOUND')
    return dict(id=key,**json.loads(row[0]))


@router.get('/imports/{key}/original')
def imported_original(key:str,user=Depends(current_user)):
    from fastapi.responses import Response
    with database() as db:
        db.execute('CREATE TABLE IF NOT EXISTS import_originals(owner TEXT,id TEXT,content TEXT,PRIMARY KEY(owner,id))')
        row=db.execute('SELECT content FROM import_originals WHERE owner=? AND id=?',(user.id,key)).fetchone()
    if not row:raise HTTPException(404,'AI_IMPORT_NOT_FOUND')
    return Response(row[0].encode(),media_type='text/csv',headers={'Content-Disposition':'attachment; filename="original.csv"','Cache-Control':'private, no-store'})
