"""Generate reproducible phase-1 algorithm evidence; no network access."""
import hashlib
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from sgp4.api import Satrec, jday
from sgp4.model import Satrec as PythonSatrec
from sgp4 import omm

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.phase1.orbits import (TS, OrbitRegistry, altitude, conditions, from_omm,
                                   from_tle, instant, load_ephemeris, observer, passes, sample_satellites, state_at)


def require(condition, description):
    if not condition:
        raise AssertionError(description)


def norm(value):
    return float(np.linalg.norm(value))


def main():
    result = {"checked_at": datetime.now(timezone.utc).isoformat(), "checks": []}
    def done(name, **data):
        result["checks"].append({"name": name, "passed": True, **data})
        print(name, 'PASS', flush=True)

    # Vallado SGP4 verification case 00005, t=0, standard WGS72 reference vector.
    line1 = '1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753'
    line2 = '2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667'
    reference = Satrec.twoline2rv(line1, line2)
    code, r, v = reference.sgp4(reference.jdsatepoch, reference.jdsatepochF)
    dr = norm(np.array(r)-[7022.46529266, -1400.08296755, 0.03995155])
    dv = norm(np.array(v)-[1.893841015, 6.405893759, 4.534807250])
    require(code == 0 and dr < 1e-7 and dv < 1e-8, 'Vallado reference mismatch')
    done('authoritative_vallado_teme', position_error_km=dr, velocity_error_km_s=dv,
         reference='Vallado et al. Revisiting Spacetrack Report #3, case 00005 t=0; https://celestrak.org/publications/AIAA/2006-6753/')

    rows = json.loads((ROOT/'assets/data/orbits/representative-2026-11-12.json').read_text())
    models = sample_satellites()
    fixed = datetime(2026, 11, 12, tzinfo=timezone.utc)
    evidence = []
    for row in rows:
        sat = models[row['NORAD_CAT_ID']]
        pure = PythonSatrec()
        omm.initialize(pure, row)
        for delta in (0, 3600, 86400):
            dt = fixed+timedelta(seconds=delta)
            jd, fr = jday(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)
            c1,r1,v1 = sat.model.sgp4(jd,fr)
            c2,r2,v2 = pure.sgp4(jd,fr)
            error = norm(np.array(r1)-r2)
            require(c1 == c2 == 0 and error < 1e-5 and norm(np.array(v1)-v2) < 1e-7, 'C++/Python propagation mismatch')
            state = state_at(sat,dt)
            t=TS.from_datetime(dt)
            centuries=(float(t.ut1)-2451545.0)/36525
            theta=math.radians(((67310.54841+(876600*3600+8640184.812866)*centuries
                                +.093104*centuries**2-6.2e-6*centuries**3)/240)%360)
            x,y,z=r1
            rotated=np.array([math.cos(theta)*x+math.sin(theta)*y,
                              -math.sin(theta)*x+math.cos(theta)*y,z])*1000
            frame_error=norm(rotated-state['ecef_m'])
            require(frame_error < .2, 'Independent GMST TEME/ECEF comparison failed')
            phi, lam = math.radians(state['lat']), math.radians(state['lng'])
            e2 = 1-(1-1/298.257223563)**2
            n = 6378137/math.sqrt(1-e2*math.sin(phi)**2)
            h=state['alt']*1000
            xyz=[(n+h)*math.cos(phi)*math.cos(lam), (n+h)*math.cos(phi)*math.sin(lam), (n*(1-e2)+h)*math.sin(phi)]
            geodetic_error=norm(np.array(xyz)-state['ecef_m'])
            require(geodetic_error < .02, 'WGS84 geodetic roundtrip failed')
            evidence.append({'noradId':sat.model.satnum,'time':dt.isoformat(),'state':state,
                             'cpp_python_position_error_km':error,'wgs84_roundtrip_error_m':geodetic_error,
                             'independent_teme_gmst_ecef_error_m':frame_error})
    done('three_regimes_cpp_python_and_wgs84', samples=evidence,
         limits='C++ and pure-Python share SGP4 theory. Independent GMST1982 rotation checks TEME/ECEF with zero polar motion; builtin UT1, not precision EOP.')

    iss = models[25544]
    tle_text = (ROOT/'assets/data/orbits/iss-2026-11-12.tle').read_text()
    tle_sat = from_tle(tle_text)
    discrepancies=[]
    for delta in (0,3600,86400):
        dt=fixed+timedelta(seconds=delta)
        a,b=state_at(iss,dt),state_at(tle_sat,dt)
        error=norm(np.array(a['ecef_m'])-b['ecef_m'])
        require(error < 50, 'TLE/OMM difference exceeds expected format-rounding tolerance')
        discrepancies.append({'time':dt.isoformat(),'position_difference_m':error})
    done('real_tle_and_omm', samples=discrepancies, tolerance_m=50)

    registry = OrbitRegistry(); registry.replace(rows)
    before = registry.models
    invalid = dict(rows[0], ECCENTRICITY=1.5)
    rejected=0
    for batch in ([rows[1],invalid], [rows[0],rows[0]], []):
        try: registry.replace(batch)
        except ValueError: rejected+=1
        require(registry.models is before, 'Invalid batch replaced valid models')
    broken=tle_text.replace('25544U','25545U',1)
    try: from_tle(broken)
    except ValueError: rejected+=1
    require(rejected == 4, 'Invalid inputs not all rejected')
    malformed=dict(rows[0],MEAN_MOTION='NaN')
    try: from_omm(malformed)
    except ValueError: rejected+=1
    require(rejected==5,'NaN accepted')
    # Force a decayed orbit to verify SGP4 errors become explicit failures.
    decayed=Satrec.twoline2rv(line1,line2)
    decayed.sgp4init(1,'i',5,20000,0,0,0,.1,0,0,0,.2,0)
    c,_,_=decayed.sgp4(decayed.jdsatepoch,decayed.jdsatepochF)
    require(c != 0,'Expected propagation error for sub-Earth orbit')
    from skyfield.api import EarthSatellite
    failing_sat=EarthSatellite.from_satrec(decayed,TS)
    caught=False
    try: state_at(failing_sat,failing_sat.epoch.utc_datetime())
    except ValueError: caught=True
    require(caught,'SGP4 failure not surfaced by application wrapper')
    done('validation_atomic_replace_and_failure', rejected_cases=rejected, sgp4_failure_code=c)

    station=observer(); eph=load_ephemeris()
    end=fixed+timedelta(days=3)
    events=passes(iss,station,fixed,end,10,eph)
    require(bool(events),'No ISS passes in reference interval')
    deltas=[]
    for event in events:
        a,b,p=instant(event['start']),instant(event['end']),instant(event['peak'])
        require(a<=p<=b and event['max_elevation']>=10,'Invalid event ordering/peak')
        for edge,rising in ((a,True),(b,False)):
            # Independent coarse scan + bisection, no reuse of find_events roots.
            left,right=edge-timedelta(seconds=30),edge+timedelta(seconds=30)
            require((altitude(iss,station,left)<10)==rising,'Wrong side of crossing')
            for _ in range(18):
                mid=left+(right-left)/2
                if (altitude(iss,station,mid)<10)==rising: left=mid
                else: right=mid
            error=abs(((left+(right-left)/2)-edge).total_seconds())
            require(error < 1,'Event root differs by more than one second')
            deltas.append(error)
        for window in event['visible_windows']:
            c=conditions(iss,station,instant(window['start'])+(instant(window['end'])-instant(window['start']))/2,eph)
            require(c['sunlit'] and c['sun_altitude'] < -6 and c['elevation']>=10,'False visible window')
    chosen=next((e for e in events if e['visible_windows']),events[0])
    middle=instant(chosen['peak'])
    partial=passes(iss,station,middle-timedelta(seconds=5),middle+timedelta(seconds=5),10,eph)
    require(len(partial)==1 and partial[0]['partial_start'] and partial[0]['partial_end'],'Partial interval missing')
    no_pass=passes(iss,station,fixed,fixed+timedelta(hours=1),90,eph)
    require(not no_pass,'Impossible threshold returned a pass')
    geo_model=models[41866]
    geo_station=observer(0,state_at(geo_model,fixed)['lng'])
    continuous=passes(geo_model,geo_station,fixed,fixed+timedelta(hours=1),10,eph)
    require(len(continuous)==1 and continuous[0]['continuous'],'Continuous GEO visibility not represented')
    done('beijing_passes_sunlight_and_boundaries', station={'lat':39.9,'lng':116.4,'elevation_m':0},
         interval=[fixed.isoformat(),end.isoformat()], min_elevation=10, events=events,
         max_independent_crossing_error_s=max(deltas), partial_interval=partial,
         no_pass_at_90_deg=True, continuous_geo=continuous,
         resolution_note='Subsecond numeric boundary resolution is not observational accuracy.')

    # Cross-check eclipse with an independent spherical ray/occlusion test.
    eclipse_checks=[]
    for minute in range(0,100,5):
        t=TS.from_datetime(fixed+timedelta(minutes=minute))
        r=iss.at(t).position.km
        sun=(eph['sun']-eph['earth']).at(t).position.km
        direction=sun-r; direction=direction/np.linalg.norm(direction)
        projection=-np.dot(r,direction)
        shadow=projection>0 and norm(r+projection*direction)<6378.1366
        actual=bool(iss.at(t).is_sunlit(eph))
        require(actual == (not shadow),'Eclipse ray comparison mismatch')
        eclipse_checks.append({'minute':minute,'sunlit':actual})
    done('independent_earth_shadow_ray_check', samples=eclipse_checks,
         note='Spherical Earth and point-Sun geometric shadow; not penumbra or brightness modelling.')

    # Compare external calculated ISS point at its own timestamp; diagnostic, not ground truth.
    external_path=ROOT/'.local/data/source-validation/environment/iss_position.json'
    if external_path.exists():
        ext=json.loads(external_path.read_text()); dt=datetime.fromtimestamp(ext['timestamp'],timezone.utc)
        ours=state_at(iss,dt)
        lat1,lat2=math.radians(ext['latitude']),math.radians(ours['lat'])
        dl=math.radians(ext['longitude']-ours['lng'])
        arc=2*math.asin(min(1,math.sqrt(math.sin((lat1-lat2)/2)**2+math.cos(lat1)*math.cos(lat2)*math.sin(dl/2)**2)))
        done('external_iss_same_time_diagnostic', time=dt.isoformat(), great_circle_difference_km=6371*arc,
             altitude_difference_km=ours['alt']-ext['altitude'], note='Different models/element sets; no real-world accuracy claim.')
    result['all_passed']=True
    path=ROOT/'docs/evidence/phase1-calculations-2026-11-12.json'
    path.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'report':str(path),'checks':len(result['checks']),'all_passed':True}))


if __name__=='__main__': main()
