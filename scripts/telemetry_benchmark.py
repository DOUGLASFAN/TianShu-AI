"""Offline TianShu-Bench segment-level detection on the pinned OPSSAT-AD v2 archive."""
import argparse
import csv
import hashlib
import io
import json
import math
import statistics
import sys
import time
import zipfile
from collections import defaultdict
from pathlib import Path

EXPECTED='d5201e9e751eb2a53a0ff7c11567dc4239f594ea4b479b2aa66fe67ddcbcb9ba'
RULES=('mad-3','zscore-3')


def predict(values,rule):
    if rule=='mad-3':
        center=statistics.median(values)
        dispersion=1.4826*statistics.median(abs(v-center) for v in values)
    else:
        center=statistics.mean(values)
        dispersion=statistics.pstdev(values)
    return int(any(abs(v-center)>3*dispersion for v in values))


def run(source,output):
    raw=source.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=EXPECTED: raise ValueError('原始数据摘要不符')
    groups=defaultdict(list)
    for row in csv.DictReader(io.StringIO(raw.decode())):
        groups[row['channel'],row['segment']].append(row)
    results=[]
    for (channel,segment),rows in sorted(groups.items()):
        labels={int(r['anomaly']) for r in rows}
        splits={int(r['train']) for r in rows}
        if len(labels)!=1 or len(splits)!=1:raise ValueError('片段含互相冲突的标签或分组')
        values=[float(r['value']) for r in rows]
        if not all(math.isfinite(v) for v in values):raise ValueError('样本含无效数值')
        split='development' if splits.pop()==1 else 'test'
        label=labels.pop()
        for rule in RULES:
            start=time.perf_counter()
            y=predict(values,rule)
            results.append(dict(channel=channel,segment=segment,split=split,label=label,predicted=y,
                                rule=rule,count=len(values),seconds=time.perf_counter()-start))
    summary=[]
    for split in ('development','test'):
        for rule in RULES:
            subset=[r for r in results if r['split']==split and r['rule']==rule]
            counts={k:0 for k in ('TP','TN','FP','FN')}
            for r in subset:
                counts[{(1,1):'TP',(0,0):'TN',(0,1):'FP',(1,0):'FN'}[r['label'],r['predicted']]]+=1
            summary.append(dict(split=split,rule=rule,segments=len(subset),**counts,seconds=sum(r['seconds'] for r in subset)))
    manifest=dict(version='TianShu-Bench/1',source='https://zenodo.org/records/15108715',sha256=EXPECTED,
                  split='original train column, no tuning',scoring='one decision per channel/segment; any point over threshold',python=sys.version)
    table=io.StringIO(newline='');writer=csv.DictWriter(table,fieldnames=results[0]);writer.writeheader();writer.writerows(results)
    bars=''.join(f'<text x="5" y="{30+i*36}">{r["split"]} {r["rule"]}</text><rect x="190" y="{16+i*36}" width="{400*r["FP"]/max(1,r["segments"])}" height="16" fill="steelblue"/><text x="610" y="{30+i*36}">{r["FP"]}/{r["segments"]}</text>' for i,r in enumerate(summary))
    output.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json',json.dumps(manifest,indent=2));z.writestr('summary.json',json.dumps(summary,indent=2))
        z.writestr('segments.csv',table.getvalue());z.write(__file__,'benchmark.py')
        z.writestr('false-positives.svg','<svg xmlns="http://www.w3.org/2000/svg" width="740" height="160">'+bars+'</svg>')
        z.writestr('README.txt','Download segments.csv from the manifest source. Run python benchmark.py segments.csv experiment.zip. FP bars show false positives divided by all segments. Wall times vary.')
    return dict(manifest=manifest,summary=summary)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('source',type=Path);parser.add_argument('output',type=Path)
    parser.add_argument('--summary',type=Path)
    args=parser.parse_args();result=run(args.source,args.output)
    if args.summary:args.summary.write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
    print(json.dumps(result['summary']))
