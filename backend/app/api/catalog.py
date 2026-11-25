from datetime import timedelta
import hashlib,json
from fastapi import APIRouter,Depends,HTTPException,Query
from sqlalchemy import func,or_,select
from sqlalchemy.orm import Session
from ..core import cache
from ..core.security import current_user
from ..db import get_db
from ..models import GroupMember,Satellite,SatelliteGroup,User,now
from ..services.catalog_filters import filtered,orbit_class,purpose,owner

router=APIRouter(prefix='/api',tags=['目录'],dependencies=[Depends(current_user)])


def quality(sat):
    age=(now()-sat.epoch).total_seconds()/3600
    state='future_epoch' if age < -.1667 else 'very_stale' if age>168 else 'stale' if age>72 else 'available'
    return {'source':sat.source,'epoch':sat.epoch.isoformat(),'fetchedAt':sat.fetched_at.isoformat(),
            'epochAgeHours':round(age,3),'state':state,'positionType':'orbit_prediction'}


def brief(sat):
    return {'noradId':sat.norad_id,'name':sat.name,'owner':sat.owner,'objectType':sat.object_type,
            'launchDate':sat.launch_date,'dataQuality':quality(sat)}


@router.get('/satellites')
def satellites(page:int=Query(1,ge=1),size:int=Query(20,ge=1,le=100),keyword:str=Query('',max_length=64),
               group:str|None=Query(None,max_length=40),country:str|None=Query(None,max_length=32),use:str|None=Query(None,max_length=128),orbit:str|None=Query(None,pattern='^(LEO|MEO|GEO|HEO|unknown)$'),db:Session=Depends(get_db)):
    statement=select(Satellite)
    if keyword:
        escaped=keyword.replace('\\','\\\\').replace('%','\\%').replace('_','\\_')
        match=Satellite.name.ilike('%'+escaped+'%',escape='\\')
        if keyword.isdigit() and len(keyword)<=9:match=or_(match,Satellite.norad_id==int(keyword))
        statement=statement.where(match)
    if group:statement=statement.join(GroupMember,GroupMember.norad_id==Satellite.norad_id).where(GroupMember.group_slug==group)
    statement=filtered(statement,country,use,orbit)
    total=db.scalar(select(func.count()).select_from(statement.subquery()))
    rows=db.scalars(statement.order_by(Satellite.norad_id).offset((page-1)*size).limit(size)).all()
    return {'total':total,'list':[brief(sat) for sat in rows],'page':page,'size':size,
            'meta':{'scope':'imported public active directory; not all actual orbiting objects','source':'CelesTrak'}}


@router.get('/satellites/{norad_id}')
def detail(norad_id:int,db:Session=Depends(get_db)):
    sat=db.get(Satellite,norad_id)
    if not sat:raise HTTPException(404,'SATELLITE_NOT_FOUND')
    metadata_hash=hashlib.sha256(json.dumps(sat.metadata_raw,sort_keys=True).encode()).hexdigest()[:16]
    key=f'sat-detail:{sat.norad_id}:{sat.content_hash}:{metadata_hash}'
    static=cache.get(key)
    hit=static is not None
    if static is None:
        static={'orbitElements':sat.orbit_raw,'metadata':sat.metadata_raw}
        cache.put(key,static,7200)
    return {'data':dict(brief(sat),**static),'meta':{'cacheHit':hit,'source':'CelesTrak','units':{'altitude':'km','velocity':'km/s','angles':'degrees','epoch':'UTC'}}}


@router.get('/groups')
def groups(db:Session=Depends(get_db)):
    rows=db.execute(select(SatelliteGroup.slug,SatelliteGroup.name,func.count(GroupMember.norad_id))
                    .outerjoin(GroupMember,GroupMember.group_slug==SatelliteGroup.slug).group_by(SatelliteGroup.slug,SatelliteGroup.name)).all()
    return {'total':len(rows),'list':[{'slug':r[0],'name':r[1],'count':r[2]} for r in rows]}


@router.get('/catalog/facets')
def facets(db:Session=Depends(get_db)):
    result={}
    for name,expression in [('countries',owner),('purposes',purpose),('orbits',orbit_class)]:
        rows=db.execute(select(expression,func.count()).select_from(Satellite).group_by(expression)).all()
        result[name]=[{'value':key,'count':count} for key,count in sorted(rows,key=lambda row:str(row[0]))]
    return {'data':result,'meta':{'scope':'unique imported NORAD objects','purposeRule':'source PURPOSE only; missing remains unknown','orbitRule':'LEO apogee<2000km; GEO period 1436±30min and e<0.1; MEO apogee<35786km and e<0.25; remainder HEO'}}


@router.get('/dashboard/summary')
def summary(db:Session=Depends(get_db)):
    from ..services.scheduling import read
    value=cache.get('statistics:last_good')
    delivery='redis' if value else 'database_snapshot'
    if value is None:value=read('statistics:last_good')
    age=None
    if value:
        from datetime import datetime
        age=max(0,(now()-datetime.fromisoformat(value['generatedAt'])).total_seconds())
    return {'data':{'catalogCount':value['catalogCount'] if value else db.scalar(select(func.count()).select_from(Satellite)),
                    'groupCount':db.scalar(select(func.count()).select_from(SatelliteGroup))},
            'meta':{'scope':'当前已导入的公开活跃目录，不等于全部在轨卫星','source':'CelesTrak',
                    'delivery':delivery if value else 'database','cacheAgeSeconds':age,'statisticsGeneratedAt':value['generatedAt'] if value else None}}
