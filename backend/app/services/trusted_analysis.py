"""Trusted comparisons operate only on measurements already admitted by each report."""
from decimal import Decimal

UNITS = {'V':('voltage','1'),'mV':('voltage','.001'),'A':('current','1'),'mA':('current','.001'),
         'm':('length','1'),'km':('length','1000'),'s':('time','1'),'ms':('time','.001')}


def factor(source, target):
    if source in ('', '未提供', 'unknown') or target in ('', '未提供', 'unknown'):
        return None
    if source == target:
        return Decimal(1)
    left,right=UNITS.get(source),UNITS.get(target)
    if not left or not right or left[0]!=right[0]:
        return None
    return Decimal(left[1])/Decimal(right[1])


def admitted(report):
    used=set(report['used'])
    return {p['utc']:p for p in report['points'] if p['record'] in used}


def compare(left,right):
    a,b=left['asset'],right['asset']
    result=dict(inputs=[left['id'],right['id']],sources=[a['source'],b['source']],pairs=[])
    if a['norad']!=b['norad'] or left['channel']!=right['channel']:
        return dict(result,status='来源冲突',reason='对象编号或通道不匹配')
    if a['sha256']==b['sha256'] or a['source']==b['source']:
        return dict(result,status='证据不足',reason='需要两份独立来源')
    if a.get('kind','telemetry')!=b.get('kind','telemetry') or a.get('station','')!=b.get('station',''):
        return dict(result,status='来源冲突',reason='观测方式或站点不匹配')
    scale=factor(b['unit'],a['unit'])
    if scale is None:
        return dict(result,status='证据不足',reason='缺少兼容的测量单位')
    l,r=admitted(left),admitted(right)
    times=sorted(l.keys() & r.keys())
    if not times:
        return dict(result,status='证据不足',reason='没有相同 UTC 时刻的有效测量')
    conflicts=0
    for t in times:
        x,y=l[t],r[t]
        delta=Decimal(str(y['value']))*scale-Decimal(str(x['value']))
        conflicts+=bool(delta)
        result['pairs'].append(dict(time=t,leftRecord=x['record'],rightRecord=y['record'],
            leftRaw=x['raw'],rightRaw=y['raw'],difference=str(delta),unit=a['unit']))
    return dict(result,status='来源冲突' if conflicts else '已核验',different=conflicts,aligned=len(times),
                leftUnpaired=len(l)-len(times),rightUnpaired=len(r)-len(times),scale=str(scale),
                reason='仅比较重合时刻。差异按记录精度给出，需结合仪器误差复核。')


def check_claim(r,claim):
    out=dict(original=claim,report=r['id'])
    expected=dict(norad=r['asset']['norad'],channel=r['channel'],start=r['start'],end=r['end'])
    for key,value in expected.items():
        if claim.get(key)!=value:
            return dict(out,status='来源冲突',reason='任务字段不匹配：'+key)
    metric=claim['metric']
    citation=r['id']+'#stats.'+metric
    if claim['citation']!=citation:
        return dict(out,status='证据不足',reason='引用未指向本报告的对应统计量')
    if not r['stats']['verified']:
        return dict(out,status='待人工确认',reason='原报告独立复算未通过')
    unit='个' if metric=='count' else r['asset']['unit']
    scale=factor(claim['unit'],unit)
    if scale is None:
        return dict(out,status='证据不足',reason='单位未知或不兼容')
    value=Decimal(str(claim['value']))*scale
    expected_value=Decimal(str(r['stats'][metric]))
    tolerance=Decimal(0) if metric=='count' else abs(expected_value)*Decimal('1e-12')
    ok=abs(value-expected_value)<=tolerance
    return dict(out,status='已核验' if ok else '已修正',verifiedValue=str(expected_value),
                unit=unit,citation=citation,used=r['used'],reason='与冻结输入的独立统计结果核对')
