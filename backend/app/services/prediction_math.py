"""SGP4/WGS84 geometric passes and sampled optical eligibility; no brightness model."""
from datetime import timedelta
import math
import numpy as np
from skyfield.api import wgs84
from skyfield.framelib import itrs
from backend.phase1.orbits import TS,from_omm,observer,instant,passes,load_ephemeris,altitude

ALGORITHM='xingxu-single-1.0 / Skyfield SGP4 / DE421'

class Cancelled(Exception):pass

def eligible_windows(times,flags,probe):
    """All boolean transitions, with clipped endpoints and sub-second bisection."""
    opening=times[0] if flags[0] else None
    result=[]
    for i in range(1,len(times)):
        if bool(flags[i])==bool(flags[i-1]):continue
        left,right=times[i-1],times[i]
        while (right-left).total_seconds()>.25:
            mid=left+(right-left)/2
            if probe(mid)==bool(flags[i-1]):left=mid
            else:right=mid
        edge=left+(right-left)/2
        if flags[i]:opening=edge
        elif opening is not None:
            result.append({'start':opening.isoformat(),'end':edge.isoformat()});opening=None
    if opening is not None:result.append({'start':opening.isoformat(),'end':times[-1].isoformat()})
    return result

def calculate(basis,checkpoint=lambda progress:None):
    sat=from_omm(basis['orbit']['raw']);s=basis['station'];minimum=basis['minElevation']
    station=observer(s['latitude'],s['longitude'],s['elevation_m'])
    start,end=instant(basis['start']),instant(basis['end']);ephem=load_ephemeris()
    try:
        # Validate the whole interval in bounded batches, including below-horizon data.
        for day in range(basis['days']):
            checkpoint(2+day)
            dates=[start+timedelta(days=day,seconds=i) for i in range(0,86401,60)]
            geo=sat.at(TS.from_datetimes(dates))
            if any(geo.message) or not np.isfinite(geo.position.km).all():raise ValueError('Propagation failure')
        intervals=passes(sat,station,start,end,minimum)
        checkpoint(10)
        def values(dates):
            t=TS.from_datetimes(dates);geo=sat.at(t)
            if any(geo.message) or not np.isfinite(geo.position.km).all():raise ValueError('Propagation failure')
            alt,az,distance=(sat-station).at(t).altaz()
            solar=(ephem['earth']+station).at(t).observe(ephem['sun']).apparent().altaz()[0].degrees
            sunlit=geo.is_sunlit(ephem)
            ground=wgs84.geographic_position_of(geo)
            return np.array([alt.degrees,az.degrees,distance.km,solar,sunlit,ground.latitude.degrees,ground.longitude.degrees]).T
        def probe(dt):
            v=values([dt])[0]
            return bool(v[0]>=minimum and v[3]<-6 and v[4])
        result=[]
        for index,item in enumerate(intervals):
            a,b=instant(item['start']),instant(item['end'])
            # Refine Skyfield event estimates; keep query-clipped endpoints exact.
            for key,clipped,rising in [('start',item['partial_start'],True),('end',item['partial_end'],False)]:
                if clipped:continue
                center=instant(item[key]);left=max(start,center-timedelta(seconds=2));right=min(end,center+timedelta(seconds=2))
                if (altitude(sat,station,left)>=minimum)==(altitude(sat,station,right)>=minimum):continue
                while (right-left).total_seconds()>.025:
                    mid=left+(right-left)/2
                    if (altitude(sat,station,mid)>=minimum)==rising:right=mid
                    else:left=mid
                item[key]=(left+(right-left)/2).isoformat()
            a,b=instant(item['start']),instant(item['end']);peak=instant(item['peak'])
            if a<peak<b:
                left=max(a,peak-timedelta(seconds=2));right=min(b,peak+timedelta(seconds=2))
                for _ in range(16):
                    one=left+(right-left)/3;two=right-(right-left)/3
                    if altitude(sat,station,one)>altitude(sat,station,two):right=two
                    else:left=one
                peak=left+(right-left)/2
            peak=max(a,min(b,peak));item['peak']=peak.isoformat();item['max_elevation']=altitude(sat,station,peak)
            item['duration_s']=(b-a).total_seconds()
            # Five second optical scan. Chunking bounds memory and cancellation latency.
            count=max(1,math.ceil((b-a).total_seconds()/5));dates=[a+(b-a)*i/count for i in range(count+1)]
            batches=[]
            for offset in range(0,len(dates),1024):
                checkpoint(10+int(85*(index+offset/len(dates))/max(1,len(intervals))))
                batches.append(values(dates[offset:offset+1024]))
            scan=np.concatenate(batches)
            flags=(scan[:,0]>=minimum)&(scan[:,3]<-6)&(scan[:,4]>0)
            item['visible_windows']=eligible_windows(dates,flags,probe)
            peak=instant(item['peak']);p=values([peak])[0]
            item['peak_conditions']={'elevation':float(p[0]),'azimuth':float(p[1]),'range_km':float(p[2]),'sun_altitude':float(p[3]),'sunlit':bool(p[4])}
            item['start_azimuth']=float(scan[0,1]);item['end_azimuth']=float(scan[-1,1])
            curve_dates=sorted(set([a+(b-a)*i/min(count,360) for i in range(min(count,360)+1)]+[peak]))
            curve=values(curve_dates)
            # [time, elevation degrees, azimuth degrees, range km, solar altitude degrees, sunlit, ground latitude, longitude]
            item['curve']=[[dt.isoformat(),float(v[0]),float(v[1]),float(v[2]),float(v[3]),bool(v[4]),float(v[5]),float(v[6])] for dt,v in zip(curve_dates,curve)]
            item['id']=str(index+1);result.append(item)
        checkpoint(99)
        return result
    finally:ephem.close()


def replay_data(basis,event):
    """One bounded UTC track for satellite, ground projection, chart and replay clock."""
    sat=from_omm(basis['orbit']['raw']);s=basis['station'];site=observer(s['latitude'],s['longitude'],s['elevation_m'])
    start=instant(event['start'])-timedelta(seconds=60);end=instant(event['end'])+timedelta(seconds=60)
    count=min(2000,max(2,math.ceil((end-start).total_seconds()/5)))
    dates=[start+(end-start)*i/count for i in range(count+1)];t=TS.from_datetimes(dates);geo=sat.at(t)
    if any(geo.message) or not np.isfinite(geo.position.km).all():raise ValueError('Propagation failure')
    alt,az,distance=(sat-site).at(t).altaz();ground=wgs84.geographic_position_of(geo);xyz=geo.frame_xyz(itrs).m
    ephem=load_ephemeris()
    try:
        solar=(ephem['earth']+site).at(t).observe(ephem['sun']).apparent().altaz()[0].degrees;lit=geo.is_sunlit(ephem)
        samples=[[date.isoformat(),*map(float,xyz[:,i]),float(ground.latitude.degrees[i]),float(ground.longitude.degrees[i]),float(ground.elevation.km[i]),float(alt.degrees[i]),float(az.degrees[i]),float(distance.km[i]),float(solar[i]),bool(lit[i])] for i,date in enumerate(dates)]
        return {'start':start.isoformat(),'end':end.isoformat(),'eventStart':event['start'],'eventEnd':event['end'],'samples':samples,'coordinateFrame':'ITRS/ECEF','positionUnit':'m','stepSeconds':(end-start).total_seconds()/count,'orbitVersion':basis['orbit']['version'],'algorithm':ALGORITHM,'sampleFormat':['time','x','y','z','latitude','longitude','altitudeKm','elevationDeg','azimuthDeg','rangeKm','solarAltitudeDeg','sunlit']}
    finally:ephem.close()
