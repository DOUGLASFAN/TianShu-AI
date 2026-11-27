"""Compare a planner alone with a planner and reviewer using the same completion-token allowance."""
import argparse
import json
import time
from pathlib import Path
from backend.app.api.research import Task,make_plan,config,ordered_tools,model_usage

CASES=[
    ('dev-archive','development','只查询冻结报告的任务与数据来源。',['archive']),
    ('dev-quality','development','仅检查质量，列出缺测与排除记录。',['quality']),
    ('test-detect','test','查档案来源，回查异常候选，不写报告。',['archive','detect']),
    ('test-verify','test','只核验引用的样本数，并输出有引用的总结。',['verify','summary']),
    ('test-full','test','查任务档案、检查质量、回查异常，核验证据并总结。',['archive','quality','detect','verify','summary'])]

def run(provider):
    out=[]
    for key,split,request,expected in CASES:
        task=Task(report='fixed-public-opssat-case',provider=provider,request=request)
        for mode in ('single','planner-reviewer'):
            begin=time.perf_counter();steps=[];history=[];issue=None;model=config(provider)[1]
            usage=[];token=model_usage.set(usage)
            try:
                steps,model=make_plan(task,budget=192 if mode=='single' else 96)
                history.append(steps)
                if mode!='single':
                    steps,model=make_plan(task,budget=96,prior=steps);history.append(steps)
            except Exception as e:
                issue=type(e).__name__
            finally:model_usage.reset(token)
            out.append(dict(case=key,split=split,provider=provider,model=model,request=request,expected=expected,actual=steps,
                            tokenUsage=usage,calls=history,effective=ordered_tools(steps),mode=mode,totalCompletionBudget=192,temperature=0,ok=steps==expected and issue is None,
                            error=issue,seconds=time.perf_counter()-begin))
    return out

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('provider',choices=['qwen','deepseek']);p.add_argument('output',type=Path)
    a=p.parse_args();result=run(a.provider);a.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print({mode:sum(row['ok'] for row in result if row['mode']==mode and row['split']=='test') for mode in ('single','planner-reviewer')})
