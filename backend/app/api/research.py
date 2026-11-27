"""A bounded model planner for scientific reports. Tool inputs remain bound to the owner and report."""
from contextvars import ContextVar
import json
import os
import time
import uuid
from types import SimpleNamespace
from typing import Literal
from urllib.parse import urlparse
import httpx
from fastapi import APIRouter,BackgroundTasks,Depends,HTTPException
from pydantic import BaseModel,ConfigDict,Field,ValidationError
from .telemetry import database,encode,report,replay
from ..core.security import current_user
from ..services.trusted_analysis import check_claim

router=APIRouter(prefix='/api/research',tags=['科研任务'])
model_usage=ContextVar("research_model_usage",default=None)
Tool=Literal['archive','quality','detect','verify','summary']
TOOLS={'archive':'提取任务、版本和来源','quality':'核对使用与排除的样本','detect':'回查确定性检测结果','verify':'核验结论引用与数值','summary':'整理已核验结论'}
class Plan(BaseModel):
    model_config=ConfigDict(extra='forbid')
    steps:list[Tool]=Field(min_length=1,max_length=5)

class Task(BaseModel):
    model_config=ConfigDict(extra='forbid')
    report:str=Field(min_length=1,max_length=128)
    provider:Literal['form','qwen','deepseek','deepseek-cloud']='form'
    request:str=Field(min_length=1,max_length=600)
    outcome:Literal['report','analysis']='report'


def config(provider):
    prefix='STAR_'+provider.upper().replace('-','_')
    from dotenv import dotenv_values
    from ..core.config import ROOT
    stored=dotenv_values(ROOT/'.env',interpolate=False)
    def setting(suffix):
        return os.environ.get(prefix+suffix,stored.get(prefix+suffix) or '')
    return setting('_URL'),setting('_MODEL'),setting('_KEY')


class SummarySelection(BaseModel):
    model_config=ConfigDict(extra='forbid')
    sections:list[Literal['coverage','candidate','limitations']]=Field(min_length=1,max_length=3)


def structured_call(provider,messages,response_type,budget):
    endpoint,model,key=config(provider)
    if not endpoint or not model:raise ValueError('模型地址或模型名尚未配置')
    parsed=urlparse(endpoint)
    if parsed.scheme!='https' and not (parsed.scheme=='http' and parsed.hostname in ('localhost','127.0.0.1','::1')):
        raise ValueError('模型服务需使用 HTTPS 或本机地址')
    payload={'model':model,'messages':messages,'max_tokens':budget,'temperature':0}
    if provider=='deepseek-cloud':
        if parsed.geturl().rstrip('/')!='https://api.deepseek.com' or not key:
            raise ValueError('DeepSeek 官方 API 需要官方 HTTPS 地址与服务端密钥')
        schema_instruction={'role':'system','content':'Return a JSON object matching this schema: '+encode(response_type.model_json_schema())}
        payload.update(messages=[schema_instruction,*messages],response_format={'type':'json_object'},thinking={'type':'disabled'})
    if parsed.hostname in ('127.0.0.1','localhost','::1'):
        payload['response_format']={'type':'json_object','schema':response_type.model_json_schema()}
    response=httpx.post(endpoint.rstrip('/')+'/chat/completions',headers={'Authorization':'Bearer '+key} if key else {},json=payload,timeout=45)
    response.raise_for_status()
    data=response.json()
    trace=model_usage.get()
    if trace is not None:
        trace.append(dict(model=data.get('model') or model,budget=budget,usage=data.get('usage',{})))
    return response_type.model_validate_json(data['choices'][0]['message']['content']),data.get('model') or model


def selected_summary(provider,request,r,outputs):
    # The model selects verified statements. Raw private measurements stay in the report archive.
    facts={'coverage':dict(text=f"有效测量 {len(r['used'])} 条",citation=r['id']+'#stats.count'),
           'limitations':dict(text=r['limitations'],citation=r['id']+'#limitations')}
    if 'detect' in outputs:
        facts['candidate']=dict(text=f"当前规则检出 {len(r['candidates'])} 个候选点",citation=r['id']+'#candidates')
    selection,model=structured_call(provider,[
        {'role':'system','content':'从可用栏目选择要在报告展示的内容。返回 JSON，例如 {"sections":["coverage","limitations"]}。'},
        {'role':'user','content':request+'。可用栏目：'+','.join(facts)}],SummarySelection,128)
    fields=list(dict.fromkeys([k for k in selection.sections if k in facts]+['coverage','limitations']))
    return dict(model=model,statements=[facts[k] for k in fields],status=outputs['verify']['status'])


def make_plan(task, *, budget=192, prior=None):
    if task.provider=='form':
        return list(TOOLS),'form/1'
    instructions='只返回 JSON 格式的有序工具列表 steps。只选与用户请求有关的工具，按照以下登记顺序排列。如需 summary，必须先 verify。工具说明：'+encode(TOOLS)
    messages=[{'role':'system','content':instructions},{'role':'user','content':task.request}]
    if prior is not None:
        messages.append({'role':'user','content':'复核上一步计划与原请求的匹配，给出最终工具列表：'+encode(prior)})
    result,model=structured_call(task.provider,messages,Plan,budget)
    plan=result.steps
    return plan,model


def ordered_tools(proposed,outcome='analysis'):
    selected=set(proposed)
    if outcome=='report':selected.add('summary')
    if 'summary' in selected:selected.add('verify')
    return [name for name in TOOLS if name in selected]


def schema(db):
    db.execute("""CREATE TABLE IF NOT EXISTS research_jobs(id TEXT PRIMARY KEY, owner TEXT, task TEXT,
        state TEXT, attempt INTEGER, touched REAL, log TEXT, issue TEXT)""")
    db.execute('CREATE TABLE IF NOT EXISTS research_attempts(job TEXT,attempt INTEGER,log TEXT,issue TEXT,state TEXT,PRIMARY KEY(job,attempt))')
    db.execute("UPDATE research_jobs SET state='interrupted',issue='执行中断，允许重试' WHERE state IN ('running','queued') AND touched<?",(time.time()-120,))


def invoke(tool,r,outputs):
    if tool=='archive':
        return dict(mission=r['asset']['mission'],norad=r['asset']['norad'],version=r['asset']['version'],source=r['asset']['source'])
    if tool=='quality':
        return dict(used=len(r['used']),missing=r['missing'],duplicates=r['duplicateTimes'],excluded=r.get('excludedQuality',[]))
    if tool=='detect':
        return dict(algorithm=r['algorithm'],rule=r['rule'],records=r['candidates'])
    if tool=='verify':
        return check_claim(r,dict(metric='count',value=r['stats']['count'],citation=r['id']+'#stats.count',unit='个',
                                  start=r['start'],end=r['end'],channel=r['channel'],norad=r['asset']['norad']))
    verified=outputs['verify']
    return dict(status=verified['status'],window=[r['start'],r['end']],citation=verified.get('citation'),
                text=f"{r['asset']['mission']} {r['channel']}：核验状态为{verified['status']}。有效样本 {verified.get('verifiedValue','待核验')}。",limitations=r['limitations'])


def execute(job,owner,attempt):
    with database() as db:
        taken=db.execute("UPDATE research_jobs SET state='running',touched=? WHERE id=? AND owner=? AND state='queued' AND attempt=?",(time.time(),job,owner,attempt)).rowcount
        if not taken:return
        task=Task.model_validate_json(db.execute('SELECT task FROM research_jobs WHERE id=?',(job,)).fetchone()[0])
    logs=[]; outputs={}; usage=[];trace_token=model_usage.set(usage)
    def record(state,issue=''):
        with database() as db:
            return db.execute("UPDATE research_jobs SET state=?,log=?,touched=?,issue=? WHERE id=? AND owner=? AND state='running' AND attempt=?",
                        (state,encode(logs),time.time(),issue,job,owner,attempt)).rowcount
    try:
        r=report(task.report,SimpleNamespace(id=owner))
        start=time.perf_counter();proposed,model=make_plan(task);steps=ordered_tools(proposed,task.outcome)
        logs.append(dict(tool='plan',model=model,proposed=proposed,steps=steps,usage=list(usage),elapsed=time.perf_counter()-start,report=r['id'],version=r['asset']['sha256']))
        for tool in steps:
            if not record('running'):return
            start=time.perf_counter()
            if tool=='detect':
                replay(task.report,SimpleNamespace(id=owner,is_guest=True))
            outputs[tool]=selected_summary(task.provider,task.request,r,outputs) if tool=='summary' and task.provider!='form' else invoke(tool,r,outputs)
            logs.append(dict(tool=tool,toolVersion='1',elapsed=time.perf_counter()-start,result=outputs[tool]))
        record('completed')
    except Exception as exc:
        reason=str(exc) if isinstance(exc,ValueError) and not isinstance(exc,ValidationError) else type(exc).__name__
        record('review',reason[:180])
    finally:
        model_usage.reset(trace_token)




@router.get('/tools')
def registry(user=Depends(current_user)):
    outputs={'archive':['mission','norad','version','source'],'quality':['used','missing','duplicates','excluded'],
             'detect':['algorithm','rule','records'],'verify':['status','citation','verifiedValue','unit'],
             'summary':['status','text or statements','citations']}
    tools=[dict(name=name,description=description,version='1',input={'report':'immutable report ID'},
                output=outputs[name],scope='authenticated report owner',requires=['verify'] if name=='summary' else [])
           for name,description in TOOLS.items()]
    return dict(tools=tools,models=[dict(provider=p,model=config(p)[1],configured=bool(all(config(p)[:2])),
                host=urlparse(config(p)[0]).hostname,temperature=0,planTokenBudget=192)
                for p in ('qwen','deepseek','deepseek-cloud') if p!='deepseek-cloud' or not user.is_guest])


@router.post('/jobs',status_code=202)
def submit(task:Task,background:BackgroundTasks,user=Depends(current_user)):
    frozen=report(task.report,user)
    if user.is_guest and task.provider!='form':
        from .telemetry import read_asset
        sample,_=read_asset(user.id,'opssat-v2')
        if urlparse(config(task.provider)[0]).hostname not in ('localhost','127.0.0.1','::1') or frozen['asset']!=sample:
            raise HTTPException(403,'游客仅可使用本机模型分析公开样本')
    key=uuid.uuid4().hex
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        schema(db)
        if db.execute('SELECT count(*) FROM research_jobs WHERE owner=?',(user.id,)).fetchone()[0]>=200:
            raise HTTPException(409,'账号科研任务数量已达上限')
        if db.execute("SELECT count(*) FROM research_jobs WHERE owner=? AND state IN ('queued','running')",(user.id,)).fetchone()[0]>=2:
            raise HTTPException(429,'已有科研任务在运行')
        db.execute('INSERT INTO research_jobs VALUES(?,?,?,?,?,?,?,?)',(key,user.id,encode(task.model_dump()),'queued',1,time.time(),'[]',''))
    background.add_task(execute,key,user.id,1)
    return {'id':key}


@router.get('/jobs/{key}')
def get(key:str,user=Depends(current_user)):
    with database() as db:
        schema(db)
        row=db.execute('SELECT task,state,attempt,log,issue FROM research_jobs WHERE id=? AND owner=?',(key,user.id)).fetchone()
    if not row:raise HTTPException(404,'任务不存在')
    with database() as db:
        previous=[dict(attempt=a,steps=json.loads(log),issue=issue,state=state) for a,log,issue,state in db.execute(
            'SELECT attempt,log,issue,state FROM research_attempts WHERE job=? ORDER BY attempt',(key,))]
    return dict(id=key,task=json.loads(row[0]),state=row[1],attempt=row[2],steps=json.loads(row[3]),issue=row[4],previous=previous)


@router.post('/jobs/{key}/{action}')
def control(key:str,action:Literal['cancel','retry'],background:BackgroundTasks,user=Depends(current_user)):
    with database() as db:
        db.execute('BEGIN IMMEDIATE')
        schema(db)
        if action=='cancel':
            changed=db.execute("UPDATE research_jobs SET state='cancelled' WHERE owner=? AND id=? AND state IN ('queued','running')",(user.id,key)).rowcount
        else:
            db.execute("INSERT OR IGNORE INTO research_attempts SELECT id,attempt,log,issue,state FROM research_jobs WHERE owner=? AND id=? AND state IN ('review','interrupted')",(user.id,key))
            changed=db.execute("UPDATE research_jobs SET state='queued',attempt=attempt+1,touched=?,issue='' WHERE owner=? AND id=? AND state IN ('review','interrupted') AND attempt<3",(time.time(),user.id,key)).rowcount
            if changed:
                attempt=db.execute('SELECT attempt FROM research_jobs WHERE id=?',(key,)).fetchone()[0]
                background.add_task(execute,key,user.id,attempt)
        if not changed:raise HTTPException(409,'当前状态不能执行此操作')
    return {'id':key,'action':action}

@router.get('/jobs')
def jobs(user=Depends(current_user)):
    with database() as db:
        schema(db)
        return [dict(id=k,state=s,attempt=a) for k,s,a in db.execute(
            'SELECT id,state,attempt FROM research_jobs WHERE owner=? ORDER BY rowid DESC LIMIT 50',(user.id,))]
