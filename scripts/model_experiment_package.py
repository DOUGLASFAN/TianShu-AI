"""Package completed, locally measured planner runs and reproducibility metadata."""
import argparse
import json
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

ROOT=Path(__file__).resolve().parents[1]
def package(output):
    evidence=ROOT/'docs/evidence'
    files=[evidence/f'phase16-{p}-plans.json' for p in ('qwen','deepseek')]
    results=[]
    for f in files:
        if f.exists():results.extend(json.loads(f.read_bytes()))
    if not results:raise ValueError('No measured model runs')
    scores=[]
    for provider,model,mode in sorted(set((r['provider'],r['model'],r['mode']) for r in results)):
        rows=[r for r in results if (r['provider'],r['model'],r['mode'],r['split'])==(provider,model,mode,'test')]
        scores.append(dict(provider=provider,model=model,mode=mode,testCases=len(rows),exact=sum(r['ok'] for r in rows),
                           validAfterOrdering=sum(r['effective']==r['expected'] and not r['error'] for r in rows),
                           failures=sum(r['error'] is not None for r in rows),seconds=sum(r['seconds'] for r in rows)))
    svg=''.join(f'<text x="3" y="{25+i*26}">{escape(r["provider"]+" "+r["mode"])}</text><rect x="220" y="{10+i*26}" width="{r["exact"]*50}" height="16" fill="#387798"/><text x="390" y="{25+i*26}">{r["exact"]}/{r["testCases"]}</text>' for i,r in enumerate(scores))
    output.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as z:
        for f in files:
            if f.exists():z.write(f,f.name)
        policy_scores=[]
        for provider in ('qwen','deepseek'):
            trial_file=evidence/f'phase16-{provider}-policies.json'
            if not trial_file.exists():continue
            z.write(trial_file,trial_file.name)
            policies=json.loads(trial_file.read_bytes())
            for split in ('development','test'):
                subset=[row for row in policies if row['split']==split]
                for policy in ('unchecked','rules','agent','agent_with_gate'):
                    policy_scores.append(dict(provider=provider,split=split,policy=policy,
                        stopped=sum(row['case']!='valid' and row['policies'][policy] in ('已修正','来源冲突','证据不足') for row in subset),
                        missed=sum(row['case']!='valid' and row['policies'][policy]=='已核验' for row in subset),
                        falseReject=sum(row['case']=='valid' and row['policies'][policy]!='已核验' for row in subset),
                        failed=sum(row['policies'][policy]=='运行失败' for row in subset)))
        z.writestr('policy-scores.json',json.dumps(policy_scores,indent=2))
        for path in [ROOT/'scripts/agent_evidence_benchmark.py',ROOT/'scripts/evidence_benchmark.py',ROOT/'scripts/model_benchmark.py', ROOT/'scripts/model_experiment_package.py', ROOT/'backend/app/api/research.py',evidence/'phase15-model-runtime.json']:
            if path.exists():z.write(path,str(path.relative_to(ROOT)))
        z.writestr('scores.json',json.dumps(scores,indent=2))
        z.writestr('tool-plan-accuracy.svg','<svg xmlns="http://www.w3.org/2000/svg" width="460" height="140">'+svg+'</svg>')
        z.writestr('README.txt','From this project revision run python -m scripts.model_benchmark PROVIDER result.json with the recorded model active. Five fixed requests (2 development, 3 test); ranking is not representative. Single: 192 generated tokens max. Planner + reviewer: 96+96. Input lengths and wall times differ.')
    return scores

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('output',type=Path);p.add_argument('--summary',type=Path);a=p.parse_args()
    rows=package(a.output)
    if a.summary:a.summary.write_text(json.dumps(rows,indent=2)+'\n',encoding='utf8')
    print(rows)
