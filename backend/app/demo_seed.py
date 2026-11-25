"""Populate a separate local showcase account using the current orbit catalogue."""
import hashlib
import json
import secrets
from datetime import timedelta
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

from sqlalchemy import select, text

from backend.phase1.orbits import instant
from .api.plans import record
from .api.predictions import make_basis
from .core.config import ROOT
from .core.security import passwords
from .db import SessionLocal
from .models import Favorite, ObservationPlan, Prediction, PredictionEvent, Satellite, Station, User, now
from .services.prediction_math import calculate


ACCOUNT_FILE = ROOT / '.local/config/showcase-account.json'
USERNAME = 'xingxu_demo'
FAVORITES = (25544, 48274, 20580, 43001, 54234)
STATIONS = (
    ('演示 · 北京', 39.9042, 116.4074),
    ('演示 · 上海', 31.2304, 121.4737),
    ('演示 · 深圳', 22.5431, 114.0579),
)


def seed_id(label):
    return str(uuid5(NAMESPACE_URL, f'xingxu-local-showcase/v1/{label}'))


def seed():
    stamp = now()
    day = stamp.astimezone(ZoneInfo('Asia/Shanghai')).date().isoformat()
    with SessionLocal() as db, db.begin():
        db.execute(text('SELECT pg_advisory_xact_lock(521119)'))
        user = db.get(User, seed_id('account'))
        if user is None and db.scalar(select(User.id).where(User.username == USERNAME)):
            raise RuntimeError('演示用户名已被其他账号使用，未修改该账号。')
        if ACCOUNT_FILE.exists():
            credentials = json.loads(ACCOUNT_FILE.read_text(encoding='utf-8'))
        elif user is None:
            credentials = {'username': USERNAME, 'password': secrets.token_urlsafe(15)}
            ACCOUNT_FILE.parent.mkdir(parents=True, exist_ok=True)
            with ACCOUNT_FILE.open('x', encoding='utf-8') as stream:
                json.dump(credentials, stream, indent=2)
        else:
            raise RuntimeError('独立演示账号已存在，凭据文件缺失。')
        if user is None:
            user = User(id=seed_id('account'), username=USERNAME, password_hash=passwords.hash(credentials['password']), role='user', enabled=True, token_version=0)
            db.add(user)
            db.flush()
        elif user.username != USERNAME or user.role != 'user' or not user.enabled or not passwords.verify(credentials['password'], user.password_hash):
            raise RuntimeError('演示账号状态与本地凭据不一致，未重设账号。')

        satellites = {norad: sat for norad in FAVORITES if (sat := db.get(Satellite, norad)) is not None}
        if 25544 not in satellites:
            raise RuntimeError('目录缺少 ISS，请先使用项目启动脚本初始化目录。')
        for norad in satellites:
            if db.get(Favorite, (user.id, norad)) is None:
                db.add(Favorite(user_id=user.id, norad_id=norad))

        stations = []
        has_default = db.scalar(select(Station.id).where(Station.user_id == user.id, Station.is_default)) is not None
        for index, (name, latitude, longitude) in enumerate(STATIONS):
            station = db.get(Station, seed_id(f'station/{index}'))
            if station is None:
                station = Station(id=seed_id(f'station/{index}'), user_id=user.id, name=name, latitude=latitude,
                                  longitude=longitude, elevation_m=0, is_default=index == 0 and not has_default)
                db.add(station)
            stations.append(station)
        db.flush()

        report = {'preparedAt': stamp.isoformat(), 'username': USERNAME, 'favorites': list(satellites),
                  'stations': [station.name for station in stations], 'predictions': [], 'plans': []}
        for index, norad in enumerate((25544, 48274)):
            if norad not in satellites:
                continue
            basis = make_basis(stations[index], satellites[norad], stamp, 3, 10, True)
            task = db.get(Prediction, seed_id(f'{day}/single/{norad}'))
            if task is None:
                events = calculate(basis)
                task = completed_task(user.id, seed_id(f'{day}/single/{norad}'), basis, events)
                db.add(task)
                db.flush()
            future = [event for event in task.results if instant(event['start']) > now() + timedelta(minutes=30)]
            existing = db.get(ObservationPlan, seed_id(f'{day}/plan/{norad}'))
            if existing is None and future:
                event = next((item for item in future if item['max_elevation'] >= 35), future[0])
                plan = ObservationPlan(id=seed_id(f'{day}/plan/{norad}'), user_id=user.id,
                    source_key=hashlib.sha256(f"{task.id}:{event['id']}".encode()).hexdigest(),
                    snapshot={'taskId':task.id,'eventId':event['id'],'basis':task.basis,'event':event,
                              'computedAt':task.finished_at.isoformat(),'acceptedStale':True},
                    start_at=instant(event['start']),end_at=instant(event['end']),reminder_minutes=10)
                db.add(plan)
                db.flush()
                record(plan, db, 'created')
                existing = plan
            report['predictions'].append({'id':task.id,'kind':'single','events':len(task.results),'noradId':norad})
            if existing:
                report['plans'].append({'id':existing.id,'start':existing.start_at.isoformat()})

        if 48274 in satellites:
            task_id = seed_id(f'{day}/group')
            task = db.get(Prediction, task_id)
            if task is None:
                bases = [make_basis(stations[0], satellites[norad], stamp, 1, 10, True) for norad in (25544, 48274)]
                targets = [{key:basis[key] for key in ('satellite','orbit','staleAtSubmission','maxEpochDistanceHours')} for basis in bases]
                basis = dict(bases[0], kind='group', targets=targets,
                             group={'slug':'stations','name':'演示 · ISS 与天宫','page':1,'size':25,'total':2,'count':2,'firstNorad':25544,'lastNorad':48274})
                events = []
                for sub in bases:
                    for event in calculate(sub):
                        events.append(dict(event, id=f"{sub['satellite']['noradId']}:{event['id']}", satellite=sub['satellite']))
                task = completed_task(user.id, task_id, basis, [], target_count=2, event_count=len(events))
                db.add(task)
                db.flush()
                for event in events:
                    db.add(PredictionEvent(task_id=task.id,event_id=event['id'],norad_id=event['satellite']['noradId'],
                        start_at=instant(event['start']),max_elevation=event['max_elevation'],visual=bool(event['visible_windows']),
                        summary={key:value for key,value in event.items() if key!='curve'},payload=event))
            report['predictions'].append({'id':task.id,'kind':'group','events':task.execution['eventCount']})
    return report


def completed_task(user_id, task_id, basis, events, target_count=1, event_count=None):
    stamp = now()
    return Prediction(id=task_id,user_id=user_id,status='completed',progress=100,basis=basis,
        started_at=stamp,finished_at=stamp,results=events,
        execution={'totalSatellites':target_count,'completedSatellites':target_count,'failures':[],
                   'cacheHits':0,'eventCount':len(events) if event_count is None else event_count})


if __name__ == '__main__':
    print(json.dumps(seed(), ensure_ascii=True))
