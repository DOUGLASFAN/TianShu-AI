from sqlalchemy import case,func
from ..models import Satellite

raw_motion=Satellite.orbit_raw['MEAN_MOTION'].as_float()
motion=case((raw_motion.between(.000001,25),raw_motion),else_=None)
ecc=Satellite.orbit_raw['ECCENTRICITY'].as_float()
axis=func.power(398600.4418/func.power(motion*6.283185307179586/86400,2),1.0/3)
apogee=axis*(1+ecc)-6378.137
perigee=axis*(1-ecc)-6378.137
orbit_class=case((motion.is_(None)|ecc.is_(None)|~ecc.between(0,.999999)|(perigee<0),'unknown'),(apogee<2000,'LEO'),((func.abs(1440/motion-1436)<30)&(ecc<.1),'GEO'),((apogee<35786)&(ecc<.25),'MEO'),else_='HEO')
purpose=func.coalesce(func.nullif(func.trim(Satellite.metadata_raw['PURPOSE'].as_string()),''),'unknown')
owner=func.coalesce(func.nullif(func.trim(Satellite.owner),''),'unknown')

def filtered(statement,country=None,use=None,orbit=None):
    if country:statement=statement.where(owner==country)
    if use:statement=statement.where(purpose==use)
    if orbit:statement=statement.where(orbit_class==orbit)
    return statement
