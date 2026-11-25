"""Bounded, vectorized multi-satellite playback from an immutable task snapshot."""
import json,math
from datetime import timedelta
from functools import lru_cache
import numpy as np
from sgp4.api import SatrecArray,jday
from skyfield.sgp4lib import TEME
from skyfield.framelib import itrs
from backend.phase1.orbits import TS,from_omm,instant

def window(basis,at):
    start,end=instant(basis['start']),instant(basis['end']);at=instant(at)
    if at<start-timedelta(milliseconds=1) or at>end+timedelta(milliseconds=1):raise ValueError('Outside task interval')
    at=max(start,min(end,at));bucket=int((at-start).total_seconds()//300)
    return calculate_window(json.dumps(basis,sort_keys=True,separators=(',',':')),bucket)

@lru_cache(maxsize=4)
def calculate_window(serialized,bucket):
    basis=json.loads(serialized);targets=basis.get('targets',[])
    if not 1<=len(targets)<=500:raise ValueError('Invalid target count')
    query_start,query_end=instant(basis['start']),instant(basis['end'])
    start=max(query_start,query_start+timedelta(seconds=bucket*300-300))
    end=min(query_end,query_start+timedelta(seconds=bucket*300+900))
    count=max(1,math.ceil((end-start).total_seconds()/20));step=(end-start).total_seconds()/count
    dates=[start+timedelta(seconds=i*step) for i in range(count+1)];t=TS.from_datetimes(dates)
    models=[];valid_targets=[];failed=[]
    for target in targets:
        try:models.append(from_omm(target['orbit']['raw']).model);valid_targets.append(target)
        except (ValueError,KeyError,TypeError):failed.append(dict(target['satellite'],code='INVALID_ORBIT'))
    satellites=[]
    if models:
        times=[jday(d.year,d.month,d.day,d.hour,d.minute,d.second+d.microsecond/1e6) for d in dates]
        error,positions,_=SatrecArray(models).sgp4(np.asarray([x[0] for x in times]),np.asarray([x[1] for x in times]))
        rotation=np.einsum('ijt,kjt->ikt',itrs.rotation_at(t),TEME.rotation_at(t))
        xyz=np.einsum('ijt,ntj->nti',rotation,positions)*1000
        station=basis['station'];phi,lam=map(math.radians,[station['latitude'],station['longitude']]);height=station['elevation_m']
        e2=1-(1-1/298.257223563)**2;n=6378137/math.sqrt(1-e2*math.sin(phi)**2)
        observer=np.array([(n+height)*math.cos(phi)*math.cos(lam),(n+height)*math.cos(phi)*math.sin(lam),(n*(1-e2)+height)*math.sin(phi)])
        up=np.array([math.cos(phi)*math.cos(lam),math.cos(phi)*math.sin(lam),math.sin(phi)])
        delta=xyz-observer;norm=np.linalg.norm(delta,axis=2)
        elevations=np.degrees(np.arcsin(np.clip(np.einsum('ntj,j->nt',delta,up)/norm,-1,1)))
        valid=(error==0).all(axis=1)&np.isfinite(xyz).all(axis=(1,2))&np.isfinite(elevations).all(axis=1)
        for i,target in enumerate(valid_targets):
            if not valid[i]:failed.append(dict(target['satellite'],code='ORBIT_PROPAGATION_FAILED'));continue
            samples=np.column_stack([xyz[i].round(2),elevations[i].round(6)]).tolist()
            satellites.append({**target['satellite'],'orbitVersion':target['orbit']['version'],'epoch':target['orbit']['epoch'],'samples':samples})
    return {'start':start.isoformat(),'end':end.isoformat(),'queryStart':basis['start'],'queryEnd':basis['end'],'stepSeconds':step,'sampleCount':count+1,
            'satellites':satellites,'totalCount':len(targets),'renderedCount':len(satellites),'failed':failed,
            'station':basis['station'],'minElevation':basis['minElevation'],'coordinateFrame':'ITRS/ECEF','positionUnit':'m',
            'sampleFormat':['x','y','z','elevationDeg'],'interpolation':'linear, no extrapolation','scope':'complete submitted batch; geometric elevation only'}
