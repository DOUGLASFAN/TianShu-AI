"""A mutually exclusive, reproducible active-directory accounting contract."""
from collections import Counter
from datetime import date
from sqlalchemy import select,func
from ..db import SessionLocal
from ..models import Satellite,GroupMember,SatelliteGroup,now
from .catalog_filters import orbit_class,purpose,owner

RULES={'version':'active-directory-v1','scope':'当前已导入活跃目录，按 NORAD 编号去重；不代表全球全部实际在轨物体',
 'orbits':'根数无效或近地点低于地表归为未知；LEO 远地点 <2000km；GEO 周期距1436分钟<30分钟且e<0.1（含倾斜同步）；MEO 远地点<35786km且e<0.25；其余为高轨／高偏心 HEO。按上述顺序互斥归类。',
 'launches':'按卫星目录的发射日期逐颗计数，不是火箭发射次数；近12个日历月，含当前未结束月。缺失、无效或未来日期不编造。',
 'groups':'同一卫星可属于多个分组，分组数量不能相加作为目录总数。',
 'purpose':'仅使用来源明确提供的 PURPOSE 字段，不根据名称或星座推断用途。'}

def aggregate():
    stamp=now();today=stamp.date();months=[]
    for offset in range(11,-1,-1):
        index=today.year*12+today.month-1-offset;months.append(f'{index//12:04d}-{index%12+1:02d}')
    with SessionLocal() as db:
        # EXISTS keeps each catalog row exactly once even with overlapping groups.
        active=select(GroupMember.norad_id).where(GroupMember.group_slug=='active')
        rows=db.execute(select(Satellite.norad_id,orbit_class,owner,purpose,Satellite.launch_date,Satellite.object_type,Satellite.metadata_raw['DECAY_DATE'].as_string(),Satellite.epoch,Satellite.fetched_at).where(Satellite.norad_id.in_(active))).all()
        all_count=db.scalar(select(func.count()).select_from(Satellite))
        all_unknown=db.scalar(select(func.count()).select_from(Satellite).where(owner=='unknown'))
        groups=db.execute(select(SatelliteGroup.slug,SatelliteGroup.name,func.count(GroupMember.norad_id)).outerjoin(GroupMember,GroupMember.group_slug==SatelliteGroup.slug).group_by(SatelliteGroup.slug,SatelliteGroup.name).order_by(SatelliteGroup.slug)).all()
    orbits=Counter(r[1] for r in rows);owners=Counter(r[2] for r in rows);purposes=Counter(r[3] for r in rows);launch=Counter();known_date=0
    for row in rows:
        try:
            d=date.fromisoformat(row[4])
            if d>today:continue
            known_date+=1;launch[d.isoformat()[:7]]+=1
        except (ValueError,TypeError):pass
    total=len(rows)
    def series(counter):return [{'key':key,'count':count,'percent':round(count/total*100,3) if total else 0} for key,count in sorted(counter.items(),key=lambda x:(x[0]=='unknown',-x[1],x[0]))]
    return {'version':2,'catalogCount':all_count,'activeCount':total,'outsideActiveCount':all_count-total,
      'payloadCount':sum(r[5] in ['PAY','PAYLOAD'] and not r[6] for r in rows),'payloadTypeUnknown':sum(not r[5] for r in rows),
      'groupCount':len(groups),'groups':[{'slug':g[0],'name':g[1],'count':g[2]} for g in groups],
      'orbits':[{'key':key,'count':orbits[key],'percent':round(orbits[key]/total*100,3) if total else 0} for key in ['LEO','MEO','GEO','HEO','unknown']],
      'owners':series(owners),'purposes':series(purposes),'ownerKnownCount':all_count-all_unknown,'ownerUnknownCount':all_unknown,
      'coverage':{'total':total,'ownerKnown':total-owners['unknown'],'purposeKnown':total-purposes['unknown'],'launchDateKnown':known_date,'launchDateUnknown':total-known_date},
      'launches':[{'month':month,'count':launch[month]} for month in months],
      'epochRange':[min((r[7] for r in rows),default=stamp).isoformat(),max((r[7] for r in rows),default=stamp).isoformat()],
      'lastSourceFetchedAt':max((r[8] for r in rows),default=stamp).isoformat(),'generatedAt':stamp.isoformat(),'scope':RULES['scope'],'rules':RULES}
