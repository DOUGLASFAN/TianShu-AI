"""Vectorized SGP4 catalog overview, bounded interpolation and honest snapshots."""
import json,threading,time
from datetime import timedelta
from pathlib import Path
import numpy as np
from sgp4.api import SatrecArray
from skyfield.sgp4lib import TEME
from skyfield.framelib import itrs
from sqlalchemy import select,func
from sqlalchemy.exc import OperationalError
from backend.phase1.orbits import from_omm,TS
from ..db import SessionLocal
from ..models import Satellite,now
from ..core.config import ROOT

_lock=threading.Lock();_models=None;_version=None;_ids=[];_snapshot=None
PATH=ROOT/'.local/data/runtime/global-scene.json'

def overview():
    global _models,_version,_ids,_snapshot
    with _lock:
        if _snapshot and (now().timestamp()-_snapshot['generatedTimestamp'])<15:return dict(_snapshot,delivery='memory_cache')
        started=time.perf_counter()
        try:
            with SessionLocal() as db:
                count,version=db.execute(select(func.count(),func.max(Satellite.fetched_at)).select_from(Satellite)).one()
                key=(count,str(version))
                if _models is None or key!=_version:
                    rows=db.scalars(select(Satellite).order_by(Satellite.norad_id).limit(20000)).all()
                    models=[];ids=[]
                    for row in rows:
                        try:models.append(from_omm(row.orbit_raw).model);ids.append(row.norad_id)
                        except (ValueError,KeyError,TypeError):continue
                    _models=SatrecArray(models);_ids=ids;_version=key
            generated=now()
            # Include recent past so the freshly delivered window covers a slightly
            # delayed/paused browser clock as well as the next polling interval.
            start=generated-timedelta(seconds=15);dates=[start,generated+timedelta(seconds=45)];t=TS.from_datetimes(dates)
            jd=np.asarray(t.whole);fraction=np.asarray(t.ut1_fraction)  # SGP4 expects UTC JD, not UT1.
            from sgp4.api import jday
            times=[jday(d.year,d.month,d.day,d.hour,d.minute,d.second+d.microsecond/1e6) for d in dates]
            jd=np.asarray([x[0] for x in times]);fraction=np.asarray([x[1] for x in times])
            error,positions,_=_models.sgp4(jd,fraction)
            rotation=np.einsum('ijt,kjt->ikt',itrs.rotation_at(t),TEME.rotation_at(t))
            xyz=np.einsum('ijt,ntj->nti',rotation,positions)*1000
            valid=(error==0).all(axis=1)&np.isfinite(xyz).all(axis=(1,2))
            rows=[[int(_ids[i]),*xyz[i,0].round(2).tolist(),*xyz[i,1].round(2).tolist()] for i in np.flatnonzero(valid)]
            result={'start':start.isoformat(),'end':dates[1].isoformat(),'generatedAt':generated.isoformat(),'generatedTimestamp':generated.timestamp(),
                    'sourceFetchedAt':str(version),'catalogCount':count,'candidateCount':len(_ids),'renderedCount':len(rows),
                    'failedCount':len(_ids)-len(rows),'limit':20000,'truncated':count>20000,'points':rows,
                    'coordinateFrame':'ITRS/ECEF','positionUnit':'m','computeMs':round((time.perf_counter()-started)*1000,2),'delivery':'database'}
            PATH.parent.mkdir(parents=True,exist_ok=True);temporary=PATH.with_suffix('.tmp');temporary.write_text(json.dumps(result),encoding='utf-8');temporary.replace(PATH)
            _snapshot=result;return result
        except OperationalError:
            previous=_snapshot or (json.loads(PATH.read_text(encoding='utf-8')) if PATH.exists() else None)
            if previous:return dict(previous,delivery='snapshot',databaseUnavailable=True)
            raise
