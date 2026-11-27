"""Versioned offline analysis of timestamped telemetry segments."""
import csv
import hashlib
import io
import math
import statistics
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal, localcontext

from .telemetry_v1 import digest, instant, parse

VERSION = 'median-mad/2'


def quality(point):
    flag = point['raw'].get('quality', '').strip().lower()
    if flag in ('interpolated', 'imputed'):
        return '补点'
    if flag not in ('', 'good', 'valid', 'measured'):
        return '质量待核验'
    return '缺值' if point['value'] is None else '实测'


def inventory(groups):
    result = []
    for (channel, segment), points in groups.items():
        counts = Counter(p['utc'] for p in points)
        result.append(dict(channel=channel,segment=segment,count=len(points),
            start=min(counts),end=max(counts),
            duplicateTimes=[t for t,n in counts.items() if n>1],
            outOfOrder=[b['record'] for a,b in zip(points,points[1:]) if b['utc']<a['utc']],
            missing=[p['record'] for p in points if p['value'] is None],
            flagged=[p['record'] for p in points if quality(p) in ('补点','质量待核验')]))
    return result


def analyze(content, meta, channel, segment, start=None, end=None):
    if digest(content.encode()) != meta['sha256']:
        raise ValueError('原件校验失败')
    points = parse(content).get((channel, segment))
    if not points:
        raise ValueError('找不到指定通道或片段')
    first, last = min(p['utc'] for p in points), max(p['utc'] for p in points)
    lo, hi = instant(start).isoformat() if start else first, instant(end).isoformat() if end else last
    if not first <= lo <= hi <= last:
        raise ValueError('时间窗超出片段覆盖范围')
    window = [p for p in points if lo <= p['utc'] <= hi]
    scales = {'V':('voltage',1),'mV':('voltage',.001),'A':('current',1),'mA':('current',.001),'m':('length',1),'km':('length',1000)}
    conversions = {}
    for point in window:
        point['quality'] = quality(point)
        row = point['raw']
        if row.get('norad') and int(row['norad']) != meta['norad']:
            raise ValueError('记录的 NORAD 编号与档案冲突')
        if row.get('mission') and row['mission'] != meta['mission']:
            raise ValueError('记录的任务标识与档案冲突')
        target = meta['unit']
        original = row.get('unit') or target
        factor = 1.
        if original != target:
            if original not in scales or target not in scales or scales[original][0] != scales[target][0]:
                raise ValueError('测量单位不兼容')
            factor = scales[original][1]/scales[target][1]
            conversions[original+' → '+target] = factor
        point['factor'] = factor
        if point['value'] is not None:
            point['value'] *= factor
    counts = Counter(p['utc'] for p in window)
    disorder = [b['record'] for a,b in zip(window,window[1:]) if b['utc'] < a['utc']]
    ordered = sorted(window,key=lambda p:p['utc'])
    valid = [p for p in ordered if counts[p['utc']] == 1 and p['quality']=='实测']
    if not valid:
        raise ValueError('窗口内没有非重复的有效测量')
    values = [p['value'] for p in valid]
    mean = statistics.mean(values)
    with localcontext() as ctx:
        ctx.prec = 80
        reference = [Decimal(p['raw']['value'])*Decimal(str(p['factor'])) for p in window
                     if counts[p['utc']]==1 and quality(p)=='实测']
        independent = float(sum(reference)/len(reference))
        reference_span = float(max(reference)-min(reference))
    median = statistics.median(values)
    mad = statistics.median(abs(v-median) for v in values)
    cutoff = 3 * 1.4826 * mad
    candidates = [p['record'] for p in valid if abs(p['value']-median)>cutoff]
    gaps = []
    for a,b in zip(ordered,ordered[1:]):
        cadence = a['raw'].get('sampling')
        if cadence and cadence == b['raw'].get('sampling') and meta.get('cadenceSeconds'):
            seconds = float(cadence)
            elapsed = (instant(b['utc'])-instant(a['utc'])).total_seconds()
            if seconds>0 and elapsed>1.5*seconds:
                gaps.append([a['utc'],b['utc']])
    return dict(requiredEvidence=["匹配对象与时间窗的原始测量","单位来源","独立统计复算"], excludedQuality=[p["record"] for p in window if p["quality"] in ("补点","质量待核验")], conversions=conversions,steps=[dict(step='校验原件',sha256=meta['sha256']),dict(step='选择窗口',count=len(window)),dict(step='质量筛选',count=len(valid)),dict(step='Decimal 复算',mean=independent),dict(step='检测候选',count=len(candidates))],asset=meta,algorithm=VERSION,channel=channel,segment=segment,start=lo,end=hi,
                objective='历史片段异常候选复核',points=ordered,used=[p['record'] for p in valid],
                stats=dict(count=len(valid),mean=mean,stdev=statistics.pstdev(values),span=max(values)-min(values),
                           independentMean=independent,independentCount=len(reference),independentSpan=reference_span,
                           verified=len(reference)==len(values) and math.isclose(mean,independent,rel_tol=1e-12,abs_tol=1e-15)
                           and math.isclose(max(values)-min(values),reference_span,rel_tol=1e-12,abs_tol=1e-15)),
                rule=dict(median=median,mad=mad,threshold=cutoff,formula='abs(value - median) > 3 × 1.4826 × MAD'),
                candidates=candidates,duplicateTimes=[t for t,n in counts.items() if n>1],outOfOrder=disorder,
                missing=[p['record'] for p in ordered if p['value'] is None],gaps=gaps,
                limitations='重复时刻和空值排除，不插值。候选需人工复核。片段标签不能定位故障起止。')
