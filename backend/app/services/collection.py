"""Validate first, then atomically import real source data and history."""
import hashlib,json,sys
from pathlib import Path
from sqlalchemy import select,delete,text
from sqlalchemy.dialects.postgresql import insert
from ..db import SessionLocal
from ..models import (CollectionRun,DataSource,GroupMember,OrbitElement,Satellite,
                      SatelliteGroup,now,uid)
from ...phase1.orbits import from_omm

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'scripts'))
import verify_satellite_sources as source


def chunks(values,size=400):
    for offset in range(0,len(values),size):yield values[offset:offset+size]


def import_rows(rows,metadata,request,groups,run_id):
    if not rows:raise ValueError('EMPTY_DATASET')
    seen=set();satellites=[];history=[]
    fetched=source.parse_time(request['attempted_at'])
    for row in rows:
        sat=from_omm(row);cat=sat.model.satnum
        if cat in seen:raise ValueError('DUPLICATE_ID')
        seen.add(cat)
        digest=hashlib.sha256(json.dumps(row,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        meta=metadata.get(cat,{})
        epoch=source.parse_time(row['EPOCH'])
        satellites.append(dict(norad_id=cat,name=row['OBJECT_NAME'] or str(cat),owner=meta.get('OWNER') or None,
                               object_type=meta.get('OBJECT_TYPE') or None,launch_date=meta.get('LAUNCH_DATE') or None,
                               orbit_raw=row,metadata_raw=meta,content_hash=digest,epoch=epoch,fetched_at=fetched,source='CelesTrak'))
        history.append(dict(id=uid(),norad_id=cat,run_id=run_id,epoch=epoch,fetched_at=fetched,content_hash=digest,raw=row))
    with SessionLocal() as db,db.begin():
        db.execute(text('SELECT pg_advisory_xact_lock(847212)'))
        for batch in chunks(satellites):
            old_metadata=dict(db.execute(select(Satellite.norad_id,Satellite.metadata_raw)
                                         .where(Satellite.norad_id.in_([x['norad_id'] for x in batch]))).all())
            for item in batch:
                merged=dict(old_metadata.get(item['norad_id']) or {})
                merged.update({key:value for key,value in item['metadata_raw'].items() if value not in (None,'')})
                item.update(metadata_raw=merged,owner=merged.get('OWNER') or None,
                            object_type=merged.get('OBJECT_TYPE') or None,launch_date=merged.get('LAUNCH_DATE') or None)
            stmt=insert(Satellite).values(batch)
            db.execute(stmt.on_conflict_do_update(index_elements=['norad_id'],set_={k:getattr(stmt.excluded,k) for k in batch[0] if k!='norad_id'}))
        for batch in chunks(history):
            db.execute(insert(OrbitElement).values(batch).on_conflict_do_nothing(constraint='uq_orbit_version'))
        for slug,name,ids in groups:
            db.execute(insert(SatelliteGroup).values(slug=slug,name=name).on_conflict_do_update(index_elements=['slug'],set_={'name':name}))
            db.execute(delete(GroupMember).where(GroupMember.group_slug==slug))
            values=[dict(group_slug=slug,norad_id=cat) for cat in ids if cat in seen]
            for batch in chunks(values):db.execute(insert(GroupMember).values(batch).on_conflict_do_nothing())
        run=db.get(CollectionRun,run_id);run.status='success';run.record_count=len(rows);run.finished_at=now()
        db.get(DataSource,'celestrak').last_success_at=now()
    return len(rows)


def collect(run_id,network=True):
    try:
        if network:
            from .operations import require_external
            require_external()
            body,request=source.fetch('gp_active','https://celestrak.org/NORAD/elements/gp.php?GROUP=ACTIVE&FORMAT=JSON',7200)
            if body is None:raise ValueError('UPSTREAM_UNAVAILABLE')
            rows=json.loads(body)
        else:
            body,request=source.verified_snapshot('gp_active')
            rows=json.loads(body)
        meta_path=source.CACHE/'satcat_active.json'
        metadata={int(x['NORAD_CAT_ID']):x for x in json.loads(meta_path.read_text())} if meta_path.exists() else {}
        groups=[('active','活跃目录',{int(x['NORAD_CAT_ID']) for x in rows})]
        for slug,label in [('stations','空间站'),('beidou','北斗')]:
            p=source.CACHE/f'gp_{slug}.json'
            if p.exists():groups.append((slug,label,{int(x['NORAD_CAT_ID']) for x in json.loads(p.read_text())}))
        return import_rows(rows,metadata,request,groups,run_id)
    except Exception as error:
        # Do not publish URLs, stack traces or configuration secrets to clients/log tables.
        code=str(error) if isinstance(error,ValueError) and str(error).isupper() and len(str(error))<80 else 'COLLECTION_FAILED'
        with SessionLocal() as db,db.begin():
            run=db.get(CollectionRun,run_id);run.status='failed';run.error_code=code;run.finished_at=now()
        return None


def create_run(mode='online'):
    with SessionLocal() as db,db.begin():
        run=CollectionRun(id=uid(),source_id='celestrak',status='running',mode=mode)
        db.add(run)
        return run.id
