from typing import Literal
from fastapi import APIRouter,Depends
from pydantic import BaseModel,FiniteFloat,Field
from .telemetry import report,database,encode
from ..core.security import current_user
from ..services.telemetry import digest
from ..services.trusted_analysis import compare,check_claim

router=APIRouter(prefix='/api/trusted',tags=['可信分析'])


def save(owner,result):
    key=digest(encode(result).encode())
    with database() as db:
        db.execute('CREATE TABLE IF NOT EXISTS checks(owner TEXT,id TEXT,result TEXT,PRIMARY KEY(owner,id))')
        db.execute('INSERT OR IGNORE INTO checks VALUES(?,?,?)',(owner,key,encode(result)))
    return dict(id=key,**result)


class Pair(BaseModel):
    left:str
    right:str


class Claim(BaseModel):
    report:str
    norad:int
    channel:str
    start:str
    end:str
    metric:Literal['count','mean','span']
    value:FiniteFloat
    unit:str=Field(min_length=1,max_length=80)
    citation:str


@router.post('/compare')
def compare_reports(body:Pair,user=Depends(current_user)):
    return save(user.id,compare(report(body.left,user),report(body.right,user)))


@router.post('/check')
def check(body:Claim,user=Depends(current_user)):
    return save(user.id,check_claim(report(body.report,user),body.model_dump()))

@router.get('/experiments')
def experiments(user=Depends(current_user)):
    import json
    from ..core.config import ROOT
    names={'detection':'phase16-opssat-benchmark.json','evidence':'phase16-evidence-ablation.json',
           'qwen':'phase16-qwen-plans.json','deepseek':'phase16-deepseek-plans.json',
           'modelScores':'phase16-model-scores.json','qwenEvidence':'phase16-qwen-policies.json','deepseekEvidence':'phase16-deepseek-policies.json'}
    return {key:json.loads(path.read_bytes()) for key,name in names.items()
            if (path:=ROOT/'docs/evidence'/name).is_file()}


@router.get('/experiments/{name}/download')
def download_experiment(name:Literal['detection','evidence','models'],user=Depends(current_user)):
    from fastapi import HTTPException
    from fastapi.responses import FileResponse
    from ..core.config import ROOT
    file={'detection':'tian-shu-bench-v1.zip','evidence':'evidence-bench-v1.zip','models':'model-bench-v1.zip'}[name]
    path=ROOT/'.local/data/telemetry'/file
    if not path.is_file():raise HTTPException(404,'本环境尚未生成该实验包')
    return FileResponse(path,media_type='application/zip',filename=file)

@router.get('/checks')
def archive(user=Depends(current_user)):
    import json
    with database() as db:
        db.execute('CREATE TABLE IF NOT EXISTS checks(owner TEXT,id TEXT,result TEXT,PRIMARY KEY(owner,id))')
        rows=db.execute('SELECT id,result FROM checks WHERE owner=? ORDER BY rowid DESC LIMIT 30',(user.id,)).fetchall()
    return [dict(id=key,**json.loads(raw)) for key,raw in rows]
