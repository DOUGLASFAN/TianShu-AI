"""Read-only task results assembled from the tools used by the existing pages."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import AwareDatetime, BaseModel, Field
from sqlalchemy.exc import SQLAlchemyError

from .investigation_tools import challenge_report, context_for_window, report_window, similar
from .telemetry import report
from ..core.security import current_user
from ..db import get_db
from ..services.investigation import compare_window
from ..services.telemetry import instant

router = APIRouter(prefix='/api/task-workflows', tags=['探索任务'])


class InvestigationRequest(BaseModel):
    run: str = Field(min_length=1, max_length=100)
    record: int = Field(gt=0)
    start: AwareDatetime | None = None
    end: AwareDatetime | None = None


@router.post('/investigate')
def investigate(body: InvestigationRequest,user=Depends(current_user),db=Depends(get_db)):
    saved = report(body.run,user)
    point,start,end=report_window(saved,body.record,body.start,body.end)

    selected= [p for p in saved['points'] if start<=instant(p['utc'])<=end]
    selected_report=dict(saved,start=start.isoformat(),end=end.isoformat(),points=selected)
    usable=body.record in saved['used']
    warnings=[]
    try:
        window=compare_window(saved,start,end,body.record,instant)
        trial=challenge_report(selected_report,body.record)
    except ValueError:
        window=None
        trial={'results':[]}
        warnings.append('当前选区不足三个有效测量点，无法比较两条规则。')

    # The contextual search is limited to the exact selection. Similarity uses the
    # original archived segment and is labelled separately in the response.
    try:
        related=similar(body.run,user)['matches'][:3]
    except (HTTPException,ValueError):
        warnings.append('相似片段检索暂不可用。')
        related=[]
    try:
        contextual=context_for_window(body.run,user,db,window=(start,end),point=point)
    except (SQLAlchemyError,ValueError,HTTPException):
        db.rollback()
        warnings.append('同期资料查询暂不可用。')
        contextual={'entries':[],'missing':[],'start':start.isoformat(),'end':end.isoformat()}

    marks = [rule['targetHit'] for rule in window['rules']] if window else []
    near=next((r for r in trial['results'] if r['name']=='候选点附近'),None)
    narrowed=[r['targetHit'] for r in near.get('rules',[])] if near else []
    sensitive=bool(marks and narrowed and marks!=narrowed)
    if not usable:
        verdict='先复核数据质量：目标点未纳入统计'
    elif not marks:
        verdict='证据不足：扩大选区后再判断'
    elif all(marks) and not sensitive:
        verdict='值得追查：两条规则均标记该记录'
    elif any(marks) or sensitive:
        verdict='建议复核：候选受规则或窗口影响'
    else:
        verdict='当前选区内，两条规则都未标记目标点'

    next_steps=[]
    if not usable or (window and (window['excluded'] or window['gaps'])):
        next_steps.append('先核对缺测、补点、设备日志和时间同步。')
    if not window or sensitive:
        next_steps.append('扩大选区，并用相同通道的正常时段复算。')
    if saved['asset'].get('unit')=='未提供':
        next_steps.append('找回物理单位和传感器配置，确认变化量有实际意义。')
    if 'observation' in contextual['missing']:
        next_steps.append('查找同期独立观测或设备日志，验证是否为实际信号变化。')
    if not next_steps:
        next_steps.append('请复核引用的原始记录，再决定是否需要补采独立证据。')

    return dict(run=body.run,mission=saved['asset']['mission'],channel=saved['channel'],
                version=saved['asset']['sha256'],source=saved['asset']['source'],start=start.isoformat(),end=end.isoformat(),
                point=point,usable=usable,verdict=verdict,window=window,trials=trial['results'],
                related=related,context=contextual,nextSteps=next_steps,warnings=warnings,
                limitation='检测结果反映相对偏离，现有资料不足以确定异常根因。')
