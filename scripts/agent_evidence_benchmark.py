"""Matched verdicts on public telemetry cases under four verification policies."""
import argparse
import json
import time
from pathlib import Path
from typing import Literal
from pydantic import BaseModel
from backend.app.api.research import structured_call,config,model_usage
from backend.app.services.telemetry import analyze,digest
from backend.app.services.trusted_analysis import check_claim
from scripts.evidence_benchmark import examples,GROUPS,ROOT

class Judgment(BaseModel):
    action:Literal['accept','request_verification','insufficient']


def compare_policies(provider):
    base=ROOT/'assets/data/telemetry/opssat-v2'
    meta=json.loads(base.with_suffix('.json').read_bytes())
    content=base.with_suffix('.csv').read_bytes().decode()
    rows=[]
    for split,seg in GROUPS.items():
        report=analyze(content,meta,'CADC0872',seg)
        report['id']=digest((meta['sha256']+seg+report['algorithm']).encode())
        for kind,claim,correct in examples(report):
            started=time.perf_counter();usage=[];token=model_usage.set(usage)
            try:
                judgment,model=structured_call(provider,[
                  {'role':'system','content':'比较报告证据与待核验结论。信息一致选 accept，有偏差调用工具选 request_verification，无法判断选 insufficient。返回 JSON 对象 action。'},
                  {'role':'user','content':json.dumps({'evidence':correct,'claim':claim},ensure_ascii=False)}],Judgment,96)
                action=judgment.action
            except Exception as exc:
                model=config(provider)[1];action=type(exc).__name__
            finally:model_usage.reset(token)
            elapsed=time.perf_counter()-started
            status=check_claim(report,claim)['status']
            single={'accept':'已核验','request_verification':status,'insufficient':'证据不足'}.get(action,'运行失败')
            policies={'unchecked':'已核验','rules':status,'agent':single,'agent_with_gate':status if single=='已核验' else single}
            rows.append(dict(split=split,case=kind,segment=seg,provider=provider,model=model,modelAction=action,tokenUsage=usage,
                             modelSeconds=elapsed,claim=claim,expectedEvidence=correct,policies=policies))
    return rows

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('provider',choices=['qwen','deepseek']);p.add_argument('output',type=Path)
    args=p.parse_args();rows=compare_policies(args.provider)
    args.output.write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print([(r['case'],r['modelAction']) for r in rows if r['split']=='test'])
