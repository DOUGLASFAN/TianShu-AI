"""Bounded, versioned SGP4 scene samples from the persisted public catalog."""
from datetime import datetime, timedelta, timezone
import hashlib
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session
from backend.phase1.orbits import from_omm, tracks
from ..core import cache
from ..core.security import current_user
from ..db import get_db
from ..models import Satellite, now
from .catalog import quality

router = APIRouter(prefix='/api/explore', tags=['三维探索'], dependencies=[Depends(current_user)])

@router.get('/global')
def global_overview():
    from ..services.global_scene import overview
    return overview()


def sample(sat, start, minutes, step):
    key = 'track:v1:' + hashlib.sha256(f'{sat.norad_id}:{sat.content_hash}:{start.isoformat()}:{minutes}:{step}'.encode()).hexdigest()
    result = cache.get(key)
    if result is None:
        try:
            points = tracks(from_omm(sat.orbit_raw), start, minutes=minutes, step_seconds=step)
            result = {'noradId': sat.norad_id, 'name': sat.name, 'version': sat.content_hash,
                      'start': start.isoformat(), 'end': points[-1]['time'], 'stepSeconds': step,
                      'samples': [[i * step, *p['ecef_m'], p['velocity']] for i, p in enumerate(points)],
                      'dataQuality': quality(sat)}
        except (ValueError, KeyError, TypeError, OverflowError):
            raise HTTPException(422, 'ORBIT_PROPAGATION_FAILED')
        cache.put(key, result, 300)
    # Quality age must be evaluated at response time, even when positions are cached.
    return dict(result, dataQuality=quality(sat))


@router.get('/scene')
def scene(db: Session = Depends(get_db)):
    # Explicit representative set. Counts are never presented as the full catalog.
    rows = db.scalars(select(Satellite).where(Satellite.norad_id.in_(
        [25544, 20580, 48274, 43013, 44713, 41866, 28654, 33591, 25994, 27424,
         37849, 39084, 43017, 40748, 43001, 43683, 41586, 29486, 24876, 32711,
         41019, 40938, 44238, 44387]))).all()
    if not rows:
        rows = db.scalars(select(Satellite).order_by(Satellite.norad_id).limit(12)).all()
    start = now().replace(second=0, microsecond=0) - timedelta(minutes=15)
    result, failed = [], []
    for sat in rows:
        try: result.append(sample(sat, start, 120, 30))
        except HTTPException: failed.append({'noradId': sat.norad_id, 'code': 'ORBIT_PROPAGATION_FAILED'})
    return {'start': start.isoformat(), 'end': (start + timedelta(minutes=120)).isoformat(),
            'generatedAt': now().isoformat(), 'satellites': result, 'failed': failed,
            'meta': {'scope': 'representative public satellites; not the full catalog',
                     'coordinateFrame': 'ITRS/ECEF', 'positionUnit': 'm', 'velocityUnit': 'km/s',
                     'sampleFormat': ['offsetSeconds', 'x', 'y', 'z', 'speed'],
                     'algorithm': 'SGP4 + Skyfield ITRS; linear client interpolation; no extrapolation'}}


@router.get('/satellites/{norad_id}/trajectory')
def trajectory(norad_id: int, at: datetime | None = Query(None), db: Session = Depends(get_db)):
    sat = db.get(Satellite, norad_id)
    if not sat: raise HTTPException(404, 'SATELLITE_NOT_FOUND')
    center = at or now()
    if center.tzinfo is None: raise HTTPException(422, 'EXPLICIT_TIMEZONE_REQUIRED')
    center = center.astimezone(timezone.utc)
    if abs((center - now()).total_seconds()) > 7 * 86400:
        raise HTTPException(422, 'TIME_RANGE_EXCEEDED')
    try: period = 1440 / float(sat.orbit_raw['MEAN_MOTION'])
    except (ValueError, KeyError, ZeroDivisionError): raise HTTPException(422, 'ORBIT_PROPAGATION_FAILED')
    # Long-period objects get a bounded arc and a truthful coverage indication.
    minutes = min(1500, max(120, int(period * 1.1) + 1))
    step = 20 if minutes <= 180 else 60 if minutes <= 800 else 120
    start = center.replace(second=0, microsecond=0) - timedelta(minutes=minutes // 2)
    return {'data': sample(sat, start, minutes, step),
            'meta': {'periodMinutes': period, 'completePeriod': minutes >= period,
                     'coordinateFrame': 'ITRS/ECEF', 'positionType': 'orbit_prediction',
                     'algorithm': 'SGP4/Skyfield', 'positionUnit': 'm', 'velocityUnit': 'km/s'}}
