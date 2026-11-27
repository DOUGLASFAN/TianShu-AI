"""Run controlled evidence-verification experiments on a frozen telemetry slice."""
import argparse
import json
import time
import zipfile
from pathlib import Path
from backend.app.services.telemetry import analyze,digest
from backend.app.services.trusted_analysis import check_claim

ROOT=Path(__file__).resolve().parents[1]
GROUPS={'development':'5','test':'8'}
CHECKS=('identity','time','units','citation','numeric')


def examples(r):
    valid=dict(norad=r['asset']['norad'],channel=r['channel'],start=r['start'],end=r['end'],
               metric='count',value=r['stats']['count'],citation=r['id']+'#stats.count',unit='个')
    errors={'identity':dict(norad=42),'time':dict(start='2000-01-01T00:00:00Z'),
            'units':dict(unit='V'),'citation':dict(citation=r['id']+'#unrelated'),'numeric':dict(value=valid['value']+1)}
    yield 'valid',valid,valid
    for name,change in errors.items():
        yield name,dict(valid,**change),valid


def evaluate(claim,correct,r,disabled):
    # Ablate one input check by supplying its expected field to that check only.
    fields={'identity':['norad','channel'],'time':['start','end'],'units':['unit'],'citation':['citation'],'numeric':['value']}
    candidate=dict(claim)
    for key in fields.get(disabled,[]):candidate[key]=correct[key]
    return check_claim(r,candidate)['status']


def experiment(destination):
    base=ROOT/'assets/data/telemetry/opssat-v2'
    content=base.with_suffix('.csv').read_bytes().decode();meta=json.loads(base.with_suffix('.json').read_bytes())
    raw=[];scores=[];quality_cases=[]
    for split,seg in GROUPS.items():
        r=analyze(content,meta,'CADC0872',seg);r['id']=digest((meta['sha256']+seg+r['algorithm']).encode())
        # Controlled parser/quality faults are separate from the claim-level error scores.
        import csv,io
        lines=list(csv.DictReader(io.StringIO(content)))
        source_rows=[x for x in lines if x['segment']==seg][:4]
        for kind in ('missing','duplicate_conflict'):
            modified=[dict(row) for row in source_rows]
            if kind=='missing':modified[0]['value']=''
            else:modified.append(dict(modified[0],value='123.5'))
            stream=io.StringIO(newline='')
            writer=csv.DictWriter(stream,fieldnames=modified[0]);writer.writeheader();writer.writerows(modified)
            text=stream.getvalue();local=dict(meta,sha256=digest(text.encode()))
            checked=analyze(text,local,'CADC0872',seg)
            passed=checked['missing']==[1] if kind=='missing' else bool(checked['duplicateTimes']) and 1 not in checked['used'] and 5 not in checked['used']
            assert passed
            quality_cases.append(dict(case=kind,split=split,source=meta['sha256'],derived=local['sha256'],rows=modified,
                                      used=checked['used'],missing=checked['missing'],duplicates=checked['duplicateTimes'],passed=passed))
        for mode in ('unchecked','all',*CHECKS):
            blocked=missed=false_reject=accepted=0
            for kind,claim,correct in examples(r):
                start=time.perf_counter()
                verdict='已核验' if mode=='unchecked' else evaluate(claim,correct,r,mode)
                elapsed=time.perf_counter()-start
                if kind!='valid':
                    if verdict=='已核验':missed+=1
                    else:blocked+=1
                elif verdict=='已核验':accepted+=1
                else:false_reject+=1
                raw.append(dict(split=split,segment=seg,mode=mode,kind=kind,claim=claim,status=verdict,seconds=elapsed))
            scores.append(dict(split=split,mode=mode,blocked=blocked,missed=missed,falseReject=false_reject,accepted=accepted))
    destination.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('trials.json',json.dumps(raw,ensure_ascii=False,indent=2))
        z.writestr('quality-cases.json',json.dumps(quality_cases,indent=2))
        z.writestr('scores.json',json.dumps(scores,indent=2))
        z.writestr('manifest.json',json.dumps(dict(input=meta['sha256'],groups=GROUPS,algorithm=r['algorithm'],cases='single-field controlled faults; five negatives and one positive per split')))
        bars=''.join(f'<text x="4" y="{20+20*i}">{v["mode"]}</text><rect fill="#387798" x="105" y="{6+20*i}" width="{v["blocked"]*40}" height="15"/>' for i,v in enumerate(scores) if v['split']=='test')
        z.writestr('intercepted.svg','<svg xmlns="http://www.w3.org/2000/svg" height="310" width="340">'+bars+'</svg>')
        z.writestr('README.txt','From the same repository revision run python -m scripts.evidence_benchmark output.zip. Corrections count as intercepted. This is a controlled fault benchmark.')
    return scores


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('output',type=Path);p.add_argument('--summary',type=Path)
    args=p.parse_args();scores=experiment(args.output)
    if args.summary:args.summary.write_text(json.dumps(scores,indent=2)+'\n',encoding='utf8')
    print(scores[8])
