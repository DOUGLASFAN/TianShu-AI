"""Account-owned sampling configurations and bounded track calculation."""
from datetime import datetime, timedelta, timezone
from threading import BoundedSemaphore
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, model_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session
from typing_extensions import Annotated

from ..core.security import current_user
from ..db import get_db
from ..models import GroupMember, SamplingProfile, Satellite, User, now
from .explore import sample

router = APIRouter(prefix='/api/sampling', tags=['采样管理'])
slots = BoundedSemaphore(2)

# Match navigation systems by source names in the imported public catalog.
# These presets do not certify whether an individual satellite is operational.
NAVIGATION_PATTERNS = {
    'beidou': ('BEIDOU-%', 'BEIDOU %'),
    'gps': ('NAVSTAR %', 'GPS %'),
    'galileo': ('%(GALILEO %', '%(GALILEO-%', 'GALILEO %'),
    'glonass': ('%[GLONASS-%', 'GLONASS %'),
    'qzss': ('QZS-%',),
    'navic': ('IRNSS-%', 'NVS-%(IRNSS-%'),
}
PRESETS = {
    'gnss': ('GNSS 导航总览', '导航星座'),
    'beidou': ('北斗（中国）', '导航星座'),
    'gps': ('GPS（美国）', '导航星座'),
    'galileo': ('伽利略（欧洲）', '导航星座'),
    'glonass': ('GLONASS（俄罗斯）', '导航星座'),
    'qzss': ('QZSS（日本）', '导航星座'),
    'navic': ('NavIC（印度）', '导航星座'),
    'stations': ('空间站及相关飞船', '观测与通信'),
    'earth-observation': ('对地观测（Landsat / Sentinel）', '观测与通信'),
    'starlink': ('星链（Starlink）', '观测与通信'),
}


def target_summary(row):
    return {'noradId': row.norad_id, 'name': row.name}


@router.get('/presets')
def presets(group: str | None = Query(None, max_length=32), page: int = Query(1, ge=1),
            _: User = Depends(current_user), db: Session = Depends(get_db)):
    if group is None:
        return {'list': [{'slug': slug, 'name': name, 'category': category}
                         for slug, (name, category) in PRESETS.items()]}
    if group not in PRESETS:
        raise HTTPException(404, 'SAMPLING_PRESET_NOT_FOUND')
    if group == 'stations':
        match = Satellite.norad_id.in_(select(GroupMember.norad_id).where(GroupMember.group_slug == 'stations'))
    else:
        if group == 'gnss':
            patterns = tuple(pattern for system in NAVIGATION_PATTERNS.values() for pattern in system)
        elif group == 'earth-observation':
            patterns = ('LANDSAT %', 'SENTINEL-%')
        elif group == 'starlink':
            patterns = ('STARLINK-%',)
        else:
            patterns = NAVIGATION_PATTERNS[group]
        match = or_(*(Satellite.name.ilike(pattern) for pattern in patterns))
    members = select(Satellite.norad_id, Satellite.name).where(match)
    total = db.scalar(select(func.count()).select_from(members.subquery()))
    size = 12
    pages = max(1, (total + size - 1) // size)
    page = min(page, pages)
    rows = db.execute(members.order_by(Satellite.norad_id).offset((page - 1) * size).limit(size))
    return {'list': [target_summary(row) for row in rows], 'total': total, 'page': page, 'pages': pages}


@router.get('/targets')
def targets(ids: list[Annotated[int, Field(ge=1, le=999999999)]] = Query(min_length=1, max_length=12),
            _: User = Depends(current_user), db: Session = Depends(get_db)):
    rows = db.execute(select(Satellite.norad_id, Satellite.name).where(Satellite.norad_id.in_(ids)))
    return {'list': [target_summary(row) for row in rows]}


class SamplingInput(BaseModel):
    model_config = ConfigDict(extra='forbid')

    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
    mode: Literal['fixed', 'relative']
    start: AwareDatetime | None = None
    end: AwareDatetime | None = None
    offsetMinutes: int = Field(default=0, ge=-1440, le=1440)
    durationMinutes: int = Field(default=120, ge=1, le=1440)
    stepSeconds: Literal[10, 20, 30, 60, 120, 300] = 30
    noradIds: list[Annotated[int, Field(ge=1, le=999999999)]] = Field(min_length=1, max_length=12)

    @model_validator(mode='after')
    def check_window(self):
        if self.mode == 'fixed':
            if self.start is None or self.end is None:
                raise ValueError('固定区间需要开始和结束时间')
            seconds = (self.end - self.start).total_seconds()
        else:
            seconds = self.durationMinutes * 60
        if not 60 <= seconds <= 86400 or seconds % 60:
            raise ValueError('区间须为 1 分钟至 24 小时，时长按整分钟计算')
        if seconds % self.stepSeconds:
            raise ValueError('区间时长须能被采样间隔整除')
        self.noradIds = list(dict.fromkeys(self.noradIds))
        if (seconds // self.stepSeconds + 1) * len(self.noradIds) > 12000:
            raise ValueError('单次最多 12000 个采样点，请延长间隔或减少卫星')
        return self


def owned(profile_id: str, user: User, db: Session):
    profile = db.get(SamplingProfile, profile_id)
    if profile is None or profile.user_id != user.id:
        raise HTTPException(404, 'SAMPLING_PROFILE_NOT_FOUND')
    return profile


def serialize(profile: SamplingProfile):
    return {'id': profile.id, 'updatedAt': profile.updated_at.isoformat(), **profile.configuration}


def calculate(configuration: SamplingInput, db: Session, preview: bool):
    stamp = now()
    if configuration.mode == 'fixed':
        start = configuration.start.astimezone(timezone.utc)
        end = configuration.end.astimezone(timezone.utc)
    else:
        start = stamp.replace(second=0, microsecond=0) + timedelta(minutes=configuration.offsetMinutes)
        end = start + timedelta(minutes=configuration.durationMinutes)
    if start < stamp - timedelta(days=7) or end > stamp + timedelta(days=7):
        raise HTTPException(422, 'SAMPLING_TIME_RANGE')
    minutes = int((end - start).total_seconds() // 60)
    rows = {sat.norad_id: sat for sat in db.scalars(
        select(Satellite).where(Satellite.norad_id.in_(configuration.noradIds)))}
    satellites, failed = [], []
    if not slots.acquire(blocking=False):
        raise HTTPException(429, 'SAMPLING_BUSY')
    try:
        for norad_id in configuration.noradIds:
            if norad_id not in rows:
                failed.append({'noradId': norad_id, 'code': 'SATELLITE_NOT_FOUND'})
                continue
            try:
                track = sample(rows[norad_id], start, minutes, configuration.stepSeconds)
            except HTTPException as error:
                failed.append({'noradId': norad_id, 'code': error.detail})
                continue
            if preview:
                samples = track['samples']
                track = {key: value for key, value in track.items() if key != 'samples'}
                track['sampleCount'] = len(samples)
            satellites.append(track)
    finally:
        slots.release()
    return {'start': start.isoformat(), 'end': end.isoformat(), 'generatedAt': stamp.isoformat(),
            'satellites': satellites, 'failed': failed, 'stepSeconds': configuration.stepSeconds}


@router.get('/profiles')
def list_profiles(user: User = Depends(current_user), db: Session = Depends(get_db)):
    profiles = db.scalars(select(SamplingProfile).where(SamplingProfile.user_id == user.id)
                          .order_by(SamplingProfile.updated_at.desc()))
    return {'data': [serialize(profile) for profile in profiles]}


@router.post('/profiles', status_code=201)
def create_profile(body: SamplingInput, user: User = Depends(current_user), db: Session = Depends(get_db)):
    db.scalar(select(User.id).where(User.id == user.id).with_for_update())
    count = db.scalar(select(func.count()).select_from(SamplingProfile).where(SamplingProfile.user_id == user.id))
    if count >= 50:
        raise HTTPException(409, 'SAMPLING_PROFILE_LIMIT')
    profile = SamplingProfile(user_id=user.id, configuration=body.model_dump(mode='json'))
    db.add(profile)
    db.commit()
    return {'data': serialize(profile)}


@router.put('/profiles/{profile_id}')
def update_profile(profile_id: str, body: SamplingInput, user: User = Depends(current_user), db: Session = Depends(get_db)):
    profile = owned(profile_id, user, db)
    profile.configuration = body.model_dump(mode='json')
    db.commit()
    return {'data': serialize(profile)}


@router.delete('/profiles/{profile_id}')
def delete_profile(profile_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    db.delete(owned(profile_id, user, db))
    db.commit()
    return {'ok': True}


@router.post('/preview')
def preview(body: SamplingInput, _: User = Depends(current_user), db: Session = Depends(get_db)):
    return calculate(body, db, preview=True)


@router.get('/profiles/{profile_id}/scene')
def profile_scene(profile_id: str, user: User = Depends(current_user), db: Session = Depends(get_db)):
    profile = owned(profile_id, user, db)
    result = calculate(SamplingInput.model_validate(profile.configuration), db, preview=False)
    return {**result, 'profileName': profile.configuration['name'],
            'meta': {'coordinateFrame': 'ITRS/ECEF', 'positionUnit': 'm', 'velocityUnit': 'km/s',
                     'sampleFormat': ['offsetSeconds', 'x', 'y', 'z', 'speed'], 'algorithm': 'SGP4 + Skyfield ITRS'}}
