"""Compare hypotheses using measurements already admitted by a frozen report."""
from statistics import median, pstdev, mean


def compare_window(report, start, end, target, instant):
    points = [point for point in report['points'] if start <= instant(point['utc']) <= end]
    used = set(report['used'])
    valid = [point for point in points if point['record'] in used]
    if len(valid) < 3:
        raise ValueError('调查窗口至少需要三个有效测量点')
    values = [point['value'] for point in valid]
    md = median(values)
    rules = []
    for name, center, spread in (
        ('MAD', md, 1.4826 * median(abs(value-md) for value in values)),
        ('三倍标准差', mean(values), pstdev(values)),
    ):
        threshold = 3 * spread
        candidates = [p['record'] for p in valid if abs(p['value']-center) > threshold]
        rules.append(dict(name=name,center=center,threshold=threshold,records=candidates,
                          zeroSpread=spread==0,targetHit=target in candidates))
    union = set(rules[0]['records']) | set(rules[1]['records'])
    disagreement = sorted(set(rules[0]['records']) ^ set(rules[1]['records']))
    shared = sorted(union - set(disagreement))
    excluded = [p['record'] for p in points if p['record'] not in used]
    observed = sorted({instant(p['utc']) for p in points})
    cadence = report['asset'].get('cadenceSeconds')
    gaps = []
    previous = {instant(p['utc']): p for p in points}
    if cadence:
        for a,b in zip(observed,observed[1:]):
            raw_a = previous[a]['raw'].get('sampling')
            raw_b = previous[b]['raw'].get('sampling')
            if not raw_a or raw_a!=raw_b:
                continue
            try:
                spacing=float(raw_a)
            except ValueError:
                continue
            if spacing>0 and (b-a).total_seconds()>1.5*spacing:
                gaps.append(dict(start=a.isoformat(),end=b.isoformat(),record=previous[b]['record']))
    hits = [rule['targetHit'] for rule in rules]
    in_window = target is not None and any(p['record']==target for p in points)
    baseline = target in report['candidates']
    changed = in_window and baseline != hits[0]
    hypotheses = [
        dict(id='signal',title='测量值偏离局部背景',
             status='双规则支持偏离' if shared else '双规则证据不足',
             support=f'{len(shared)} 条记录被两种规则同时标记。',
             against='阈值只衡量相对偏离。需要独立测量区分真实变化与传感器效应。',
             records=shared[:12]),
        dict(id='quality',title='采样或数据质量影响',
             status='发现质量线索' if excluded or gaps else '未见已记录的质量异常',
             support=f'{len(excluded)} 条记录未用于计算，已识别 {len(gaps)} 段采样间断。' if cadence else f'{len(excluded)} 条记录未用于计算。缺少经核验的采样间隔。',
             against='质量标记和间断只能说明数据覆盖受限。需要采集日志核对它们是否影响目标点。',
             records=list(dict.fromkeys(excluded+[g['record'] for g in gaps]))[:12]),
        dict(id='sensitivity',title='检测规则或窗口敏感',
             status='观察到敏感性' if disagreement or changed else '当前比较未观察到差异',
             support=f'{len(disagreement)} 条记录只被一种规则标记。'+('目标点在原窗口和当前窗口的 MAD 判断不同。' if changed else ''),
             against='结论仅适用于当前范围和两种阈值。可移动窗口边界继续复算。',
             records=list(dict.fromkeys(([target] if changed else [])+disagreement))[:12]),
    ]
    quality=dict(missing=sum(p['value'] is None for p in points),
                 interpolated=sum(p.get('quality')=='补点' for p in points),
                 flagged=sum(p.get('quality')=='质量待核验' for p in points),
                 duplicateTimes=len(points)-len(observed),unit=report['asset'].get('unit','未提供'),
                 conversions=report.get('conversions',{}))
    return dict(start=start.isoformat(),end=end.isoformat(),included=len(valid),excluded=excluded,gaps=gaps,quality=quality,
                rules=rules,hypotheses=hypotheses,target=target if in_window else None,
                baselineHit=baseline if in_window else None,windowChanged=changed)
