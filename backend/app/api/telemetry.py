"""Authenticated historical telemetry cases. Private assets and runs are owner-scoped."""
import csv
import json
import sqlite3
from contextlib import contextmanager
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from fastapi.responses import Response

from ..core.config import ROOT
from ..core.security import current_user
from ..services.telemetry import VERSION, analyze, digest, instant, parse, inventory

router = APIRouter(prefix='/api/telemetry', tags=['历史遥测'])
SAMPLE = ROOT/'assets/data/telemetry/opssat-v2'
STORE = ROOT/'.local/data/telemetry/cases.sqlite3'


@contextmanager
def database():
    STORE.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(STORE, timeout=10)
    try:
        with conn:
            conn.execute('CREATE TABLE IF NOT EXISTS assets(owner TEXT,id TEXT,meta TEXT,content TEXT, PRIMARY KEY(owner,id))')
            conn.execute('CREATE TABLE IF NOT EXISTS runs(owner TEXT,id TEXT,report TEXT,review TEXT, PRIMARY KEY(owner,id))')
            conn.execute('CREATE TABLE IF NOT EXISTS failures(owner TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP, parameters TEXT, reason TEXT)')
            conn.execute('CREATE TABLE IF NOT EXISTS event_reviews(owner TEXT,run TEXT,record INTEGER,note TEXT, PRIMARY KEY(owner,run,record))')
            yield conn
    finally:
        conn.close()


def encode(obj):
    return json.dumps(obj,ensure_ascii=False,sort_keys=True,allow_nan=False)


def read_asset(owner,key):
    if key == 'opssat-v2':
        meta=json.loads(SAMPLE.with_suffix('.json').read_bytes())
        content=SAMPLE.with_suffix('.csv').read_bytes().decode()
    else:
        with database() as db:
            row=db.execute('SELECT meta,content FROM assets WHERE owner=? AND id=?',(owner,key)).fetchone()
        if not row: raise HTTPException(404,'案例不存在')
        meta,content=json.loads(row[0]),row[1]
    if digest(content.encode()) != meta['sha256']: raise HTTPException(409,'原件校验失败')
    return meta,content


class Upload(BaseModel):
    mission:str=Field(min_length=1,max_length=120)
    norad:int=Field(gt=0)
    source:str=Field(min_length=1,max_length=500)
    version:str=Field(min_length=1,max_length=100)
    unit:str=Field(min_length=1,max_length=80)
    sha256:str=Field(pattern='^[0-9a-f]{64}$')
    content:str=Field(min_length=1,max_length=2_000_000)
    tle:str=Field(default='',max_length=300)
    orbitSource:str=Field(default='',max_length=500)
    cadenceSeconds:bool=False
    kind:Literal['telemetry','observation']='telemetry'
    station:str=Field(default='',max_length=150)


@router.post('/assets')
def upload(body:Upload,user=Depends(current_user)):
    if user.is_guest: raise HTTPException(403,'请使用正式账号导入私有档案')
    meta=body.model_dump(exclude={'content'})
    if digest(body.content.encode())!=meta['sha256']: raise HTTPException(422,'文件摘要不符')
    try:
        groups=parse(body.content)
        meta["coverageStart"]=min(p["utc"] for pts in groups.values() for p in pts)
        meta["coverageEnd"]=max(p["utc"] for pts in groups.values() for p in pts)
        if body.kind=='observation' and not body.station.strip():
            raise ValueError('观测档案需要站点标识')
        if body.tle:
            from backend.phase1.orbits import from_tle
            if not body.orbitSource or from_tle(body.tle).model.satnum!=body.norad:
                raise ValueError('根数身份或来源不匹配')
    except (ValueError,OverflowError,csv.Error) as exc: raise HTTPException(422,str(exc)) from exc
    key=digest(encode(meta).encode())
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        if not db.execute('SELECT 1 FROM assets WHERE owner=? AND id=?',(user.id,key)).fetchone() and db.execute('SELECT COUNT(*) FROM assets WHERE owner=?',(user.id,)).fetchone()[0]>=100:
            raise HTTPException(409,'个人档案数量已达 100 份')
        db.execute('INSERT OR IGNORE INTO assets VALUES(?,?,?,?)',(user.id,key,encode(meta),body.content))
    return {'id':key,'quality':inventory(groups)}


@router.get('/assets')
def assets(user=Depends(current_user)):
    sample,_=read_asset(user.id,'opssat-v2')
    with database() as db:
        rows=db.execute('SELECT id,meta FROM assets WHERE owner=? ORDER BY rowid DESC',(user.id,)).fetchall()
    sample_key=digest(encode(sample).encode())
    return [dict(id='opssat-v2',**sample)]+[dict(id=k,**json.loads(m)) for k,m in rows if k!=sample_key]


@router.get('/assets/{key}')
def details(key:str,user=Depends(current_user)):
    meta,content=read_asset(user.id,key)
    return dict(meta=meta,segments=inventory(parse(content)))


class Window(BaseModel):
    asset:str
    channel:str
    segment:str
    start:str|None=None
    end:str|None=None
    objective:str=Field(default='历史片段异常候选复核',min_length=1,max_length=180)


def calculate(body,user):
    meta,content=read_asset(user.id,body.asset)
    version_id=digest(encode(meta).encode())
    try:
        report=analyze(content,meta,body.channel,body.segment,body.start,body.end)
        report['objective']=body.objective
        report['assessments']=[
            dict(subject='统计复算',status='已核验' if report['stats']['verified'] else '来源冲突',basis='有效样本与独立十进制复算'),
            dict(subject='单位',status='证据不足' if meta['unit']=='未提供' else '来源已登记',basis=meta['unit']),
            dict(subject='候选事件',status='待人工确认' if report['candidates'] else '当前规则未检出',basis=report['rule']['formula'])]

        encode(report)
    except (ValueError,OverflowError,csv.Error) as exc:
        with database() as db:
            db.execute('INSERT INTO failures(owner,parameters,reason) VALUES(?,?,?)',(user.id,encode(body.model_dump()),str(exc)))
        raise HTTPException(422,str(exc)) from exc
    report['input']=dict(body.model_dump(),asset=version_id)
    key=digest(encode(report).encode())
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        if not db.execute('SELECT 1 FROM runs WHERE owner=? AND id=?',(user.id,key)).fetchone() and db.execute('SELECT COUNT(*) FROM runs WHERE owner=?',(user.id,)).fetchone()[0]>=(30 if user.is_guest else 200):
            raise HTTPException(409,'已达到个人报告数量上限')
        db.execute('INSERT OR IGNORE INTO assets VALUES(?,?,?,?)',(user.id,version_id,encode(meta),content))
        db.execute('INSERT OR IGNORE INTO runs VALUES(?,?,?,?)',(user.id,key,encode(report),''))
    return dict(id=key,**report)


@router.post('/runs')
def run(body:Window,user=Depends(current_user)):
    return calculate(body,user)


@router.get('/runs')
def history(user=Depends(current_user)):
    with database() as db:
        return [dict(id=k,channel=c,start=s,review=r,mission=m,norad=n,end=e) for k,c,s,r,m,n,e in db.execute(
            "SELECT id,json_extract(report,'$.channel'),json_extract(report,'$.start'),review,json_extract(report,'$.asset.mission'),json_extract(report,'$.asset.norad'),json_extract(report,'$.end') FROM runs WHERE owner=? ORDER BY rowid DESC",(user.id,))]


@router.get('/failures')
def failures(user=Depends(current_user)):
    with database() as db:
        return [dict(time=t,parameters=json.loads(p),reason=r) for t,p,r in db.execute(
            'SELECT created,parameters,reason FROM failures WHERE owner=? ORDER BY rowid DESC LIMIT 50',(user.id,))]


@router.get('/runs/{key}')
def report(key:str,user=Depends(current_user)):
    with database() as db:
        row=db.execute('SELECT report,review FROM runs WHERE owner=? AND id=?',(user.id,key)).fetchone()
    if not row: raise HTTPException(404,'报告不存在')
    with database() as db:
        notes=dict(db.execute('SELECT record,note FROM event_reviews WHERE owner=? AND run=?',(user.id,key)))
    return dict(id=key,review=row[1],eventReviews=notes,**json.loads(row[0]))


@router.post('/runs/{key}/replay')
def replay(key:str,user=Depends(current_user)):
    saved=report(key,user)
    if saved['algorithm']=='median-mad/1':
        from ..services.telemetry_v1 import analyze as historical_analyze
        args=Window(**saved['input'])
        meta,content=read_asset(user.id,args.asset)
        rebuilt=historical_analyze(content,meta,args.channel,args.segment,args.start,args.end)
        rebuilt.update(input=saved['input'],objective=args.objective)
        if digest(encode(rebuilt).encode())!=key: raise HTTPException(409,'历史版本复跑不一致')
        return saved
    if saved['algorithm']!=VERSION: raise HTTPException(409,'当前环境缺少归档算法版本')
    result=calculate(Window(**saved['input']),user)
    if result['id']!=key: raise HTTPException(409,'复跑摘要不一致')
    return saved


class Review(BaseModel):
    note:str=Field(min_length=1,max_length=2000)


@router.put('/runs/{key}/review')
def review(key:str,body:Review,user=Depends(current_user)):
    with database() as db:
        if not db.execute('UPDATE runs SET review=? WHERE owner=? AND id=?',(body.note,user.id,key)).rowcount:
            raise HTTPException(404,'报告不存在')
    return {'review':body.note}


@router.get('/assets/{key}/position')
def position(key:str,time:str,user=Depends(current_user)):
    meta,content=read_asset(user.id,key)
    if not meta.get('tle'): return {'reason':'缺少该对象同期有来源的历史根数'}
    from backend.phase1.orbits import from_tle,state_at
    try:
        t=instant(time)
        if not any(min(p['utc'] for p in pts)<=t.isoformat()<=max(p['utc'] for p in pts) for pts in parse(content).values()):
            return {'reason':'所选时刻超出档案覆盖范围'}
        sat=from_tle(meta['tle'])
        if sat.model.satnum!=meta['norad'] or abs((t-sat.epoch.utc_datetime()).total_seconds())>86400:
            return {'reason':'卫星身份不符或超出根数历元前后 24 小时'}
        return dict(**state_at(sat,t),epoch=sat.epoch.utc_iso(),source=meta['orbitSource'])
    except ValueError as exc: raise HTTPException(422,str(exc)) from exc


@router.put('/runs/{key}/events/{record}/review')
def review_event(key:str,record:int,body:Review,user=Depends(current_user)):
    saved=report(key,user)
    if record not in saved['candidates']:
        raise HTTPException(404,'候选事件不存在')
    with database() as db:
        db.execute('INSERT INTO event_reviews VALUES(?,?,?,?) ON CONFLICT(owner,run,record) DO UPDATE SET note=excluded.note',
                   (user.id,key,record,body.note))
    return {'record':record,'note':body.note}


@router.get('/assets/{key}/original')
def original(key:str,user=Depends(current_user)):
    meta,content=read_asset(user.id,key)
    return Response(content.encode(),media_type='text/csv',headers={
        'Content-Disposition':f'attachment; filename="telemetry-{meta["sha256"][:12]}.csv"',
        'Cache-Control':'private, no-store'})

@router.get('/runs/{key}/scene')
def historical_scene(key:str,user=Depends(current_user)):
    from datetime import timedelta
    from backend.phase1.orbits import from_tle,state_at
    r=report(key,user)
    meta=r['asset']
    if not meta.get('tle') or not meta.get('orbitSource'):raise HTTPException(422,'缺少同期根数来源')
    sat=from_tle(meta['tle'])
    start,end=instant(r['start']),instant(r['end'])
    epoch=sat.epoch.utc_datetime()
    if sat.model.satnum!=meta['norad'] or max(abs((t-epoch).total_seconds()) for t in (start,end))>86400:
        raise HTTPException(422,'整段无法使用同一历史根数')
    if end<=start:raise HTTPException(422,'回放需要两个不同时刻')
    duration=(end-start).total_seconds()
    import math
    intervals=min(180,max(1,math.ceil(duration/5)))
    step=duration/intervals
    samples=[]
    for i in range(intervals+1):
        t=start+timedelta(seconds=i*step)
        state=state_at(sat,t)
        samples.append([i*step,*state['ecef_m'],state['velocity']])
    track=dict(start=r['start'],end=r['end'],noradId=meta['norad'],name=meta['mission'],samples=samples,
               version=meta['sha256'],stepSeconds=step,dataQuality=dict(state='available',epoch=sat.epoch.utc_iso(),source=meta['orbitSource']))
    return dict(start=r['start'],end=r['end'],generatedAt=r['start'],stepSeconds=step,profileName='历史遥测 · '+meta['mission'],satellites=[track],failed=[])
