import uuid
from datetime import datetime,timezone
from sqlalchemy import (Boolean,CheckConstraint,DateTime,ForeignKey,Index,Integer,JSON,
                        String,Text,UniqueConstraint,text)
from sqlalchemy.orm import Mapped,mapped_column
from .db import Base


def uid():return str(uuid.uuid4())
def now():return datetime.now(timezone.utc)


class RuntimeState(Base):
    __tablename__='runtime_states'
    key:Mapped[str]=mapped_column(String(64),primary_key=True)
    value:Mapped[dict]=mapped_column(JSON,default=dict)
    updated_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)


class User(Base):
    __tablename__='users'
    __table_args__=(CheckConstraint("role IN ('user','admin')",name='ck_users_role'),)
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=uid)
    username:Mapped[str]=mapped_column(String(32),unique=True,index=True)
    password_hash:Mapped[str]=mapped_column(Text)
    role:Mapped[str]=mapped_column(String(12),default='user')
    enabled:Mapped[bool]=mapped_column(Boolean,default=True)
    is_guest:Mapped[bool]=mapped_column(Boolean,default=False,server_default=text('false'))
    token_version:Mapped[int]=mapped_column(Integer,default=0)
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)


class SamplingProfile(Base):
    __tablename__ = 'sampling_profiles'
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    user_id: Mapped[str] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), index=True)
    configuration: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class AuthSession(Base):
    __tablename__='auth_sessions'
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=uid)
    user_id:Mapped[str]=mapped_column(ForeignKey('users.id',ondelete='CASCADE'),index=True)
    expires_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),index=True)
    revoked:Mapped[bool]=mapped_column(Boolean,default=False)


class Satellite(Base):
    __tablename__='satellites'
    norad_id:Mapped[int]=mapped_column(Integer,primary_key=True)
    name:Mapped[str]=mapped_column(String(200),index=True)
    owner:Mapped[str|None]=mapped_column(String(32),nullable=True,index=True)
    object_type:Mapped[str|None]=mapped_column(String(12),nullable=True)
    launch_date:Mapped[str|None]=mapped_column(String(40),nullable=True)
    orbit_raw:Mapped[dict]=mapped_column(JSON)
    metadata_raw:Mapped[dict]=mapped_column(JSON,default=dict)
    content_hash:Mapped[str]=mapped_column(String(64))
    epoch:Mapped[datetime]=mapped_column(DateTime(timezone=True),index=True)
    fetched_at:Mapped[datetime]=mapped_column(DateTime(timezone=True))
    source:Mapped[str]=mapped_column(String(64),default='CelesTrak')


class SatelliteGroup(Base):
    __tablename__='satellite_groups'
    slug:Mapped[str]=mapped_column(String(40),primary_key=True)
    name:Mapped[str]=mapped_column(String(80))


class GroupMember(Base):
    __tablename__='satellite_group_members'
    group_slug:Mapped[str]=mapped_column(ForeignKey('satellite_groups.slug',ondelete='CASCADE'),primary_key=True)
    norad_id:Mapped[int]=mapped_column(ForeignKey('satellites.norad_id',ondelete='CASCADE'),primary_key=True,index=True)


class DataSource(Base):
    __tablename__='data_sources'
    id:Mapped[str]=mapped_column(String(40),primary_key=True)
    name:Mapped[str]=mapped_column(String(100))
    url:Mapped[str]=mapped_column(Text)
    last_success_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True)


class CollectionRun(Base):
    __tablename__='collection_runs'
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=uid)
    source_id:Mapped[str]=mapped_column(ForeignKey('data_sources.id'),index=True)
    status:Mapped[str]=mapped_column(String(20),index=True)
    mode:Mapped[str]=mapped_column(String(32))
    record_count:Mapped[int]=mapped_column(Integer,default=0)
    started_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now,index=True)
    finished_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True)
    error_code:Mapped[str|None]=mapped_column(String(80),nullable=True)


class OrbitElement(Base):
    __tablename__='orbit_elements'
    __table_args__=(UniqueConstraint('norad_id','content_hash',name='uq_orbit_version'),
                    Index('ix_orbit_sat_epoch','norad_id','epoch'))
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=uid)
    norad_id:Mapped[int]=mapped_column(ForeignKey('satellites.norad_id',ondelete='CASCADE'),index=True)
    run_id:Mapped[str]=mapped_column(ForeignKey('collection_runs.id'),index=True)
    epoch:Mapped[datetime]=mapped_column(DateTime(timezone=True))
    fetched_at:Mapped[datetime]=mapped_column(DateTime(timezone=True))
    content_hash:Mapped[str]=mapped_column(String(64))
    raw:Mapped[dict]=mapped_column(JSON)


class Favorite(Base):
    __tablename__='favorites'
    user_id:Mapped[str]=mapped_column(ForeignKey('users.id',ondelete='CASCADE'),primary_key=True)
    norad_id:Mapped[int]=mapped_column(ForeignKey('satellites.norad_id',ondelete='CASCADE'),primary_key=True)
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)


class Station(Base):
    __tablename__='observation_stations'
    __table_args__=(CheckConstraint('latitude >= -90 AND latitude <= 90',name='ck_station_lat'),
                    CheckConstraint('longitude >= -180 AND longitude <= 180',name='ck_station_lng'),
                    Index('uq_station_default','user_id',unique=True,postgresql_where=text('is_default')))
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=uid)
    user_id:Mapped[str]=mapped_column(ForeignKey('users.id',ondelete='CASCADE'),index=True)
    name:Mapped[str]=mapped_column(String(80))
    latitude:Mapped[float]
    longitude:Mapped[float]
    elevation_m:Mapped[float]=mapped_column(default=0)
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)
    is_default:Mapped[bool]=mapped_column(Boolean,default=False)


class Prediction(Base):
    __tablename__='predictions'
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=uid)
    user_id:Mapped[str]=mapped_column(ForeignKey('users.id',ondelete='CASCADE'),index=True)
    status:Mapped[str]=mapped_column(String(16),default='queued',index=True)
    progress:Mapped[int]=mapped_column(Integer,default=0)
    cancel_requested:Mapped[bool]=mapped_column(Boolean,default=False)
    basis:Mapped[dict]=mapped_column(JSON)
    results:Mapped[list]=mapped_column(JSON,default=list)
    error_code:Mapped[str|None]=mapped_column(String(64),nullable=True)
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now,index=True)
    started_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True)
    finished_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True)
    execution:Mapped[dict]=mapped_column(JSON,default=dict)


class PredictionEvent(Base):
    __tablename__='prediction_events'
    task_id:Mapped[str]=mapped_column(ForeignKey('predictions.id',ondelete='CASCADE'),primary_key=True)
    event_id:Mapped[str]=mapped_column(String(48),primary_key=True)
    norad_id:Mapped[int]=mapped_column(Integer)
    start_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),index=True)
    max_elevation:Mapped[float]
    visual:Mapped[bool]=mapped_column(Boolean)
    summary:Mapped[dict]=mapped_column(JSON)
    payload:Mapped[dict]=mapped_column(JSON)


class PredictionCache(Base):
    __tablename__='prediction_cache'
    key:Mapped[str]=mapped_column(String(64),primary_key=True)
    results:Mapped[list]=mapped_column(JSON)
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now,index=True)


class ObservationPlan(Base):
    __tablename__='observation_plans'
    __table_args__=(UniqueConstraint('user_id','source_key',name='uq_plan_source'),)
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=uid)
    user_id:Mapped[str]=mapped_column(ForeignKey('users.id',ondelete='CASCADE'),index=True)
    source_key:Mapped[str]=mapped_column(String(64))
    version:Mapped[int]=mapped_column(Integer,default=1)
    status:Mapped[str]=mapped_column(String(16),default='active')
    snapshot:Mapped[dict]=mapped_column(JSON)
    start_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),index=True)
    end_at:Mapped[datetime]=mapped_column(DateTime(timezone=True))
    reminder_minutes:Mapped[int]=mapped_column(Integer,default=10)
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)
    updated_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)


class PlanVersion(Base):
    __tablename__='plan_versions'
    plan_id:Mapped[str]=mapped_column(ForeignKey('observation_plans.id',ondelete='CASCADE'),primary_key=True)
    version:Mapped[int]=mapped_column(Integer,primary_key=True)
    data:Mapped[dict]=mapped_column(JSON)
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)


class PlanReminder(Base):
    __tablename__='plan_reminders'
    plan_id:Mapped[str]=mapped_column(ForeignKey('observation_plans.id',ondelete='CASCADE'),primary_key=True)
    version:Mapped[int]=mapped_column(Integer,primary_key=True)
    threshold:Mapped[int]=mapped_column(Integer,primary_key=True)
    due_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),index=True)
    status:Mapped[str]=mapped_column(String(16),default='pending',index=True)


class PlanProposal(Base):
    __tablename__='plan_proposals'
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=uid)
    plan_id:Mapped[str]=mapped_column(ForeignKey('observation_plans.id',ondelete='CASCADE'),index=True)
    expected_version:Mapped[int]=mapped_column(Integer)
    candidate:Mapped[dict]=mapped_column(JSON)
    reminder_minutes:Mapped[int]=mapped_column(Integer)
    expires_at:Mapped[datetime]=mapped_column(DateTime(timezone=True))
    applied:Mapped[bool]=mapped_column(Boolean,default=False)


class Notification(Base):
    __tablename__='notifications'
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=uid)
    user_id:Mapped[str]=mapped_column(ForeignKey('users.id',ondelete='CASCADE'),index=True)
    plan_id:Mapped[str|None]=mapped_column(ForeignKey('observation_plans.id',ondelete='SET NULL'),nullable=True,index=True)
    dedup_key:Mapped[str]=mapped_column(String(100),unique=True)
    payload:Mapped[dict]=mapped_column(JSON)
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now,index=True)
    updated_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)
    read_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True)
    revoked_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True)


class WeatherSnapshot(Base):
    __tablename__='weather_snapshots'
    run_id:Mapped[str]=mapped_column(ForeignKey('collection_runs.id'),primary_key=True)
    source_id:Mapped[str]=mapped_column(ForeignKey('data_sources.id'),index=True)
    fetched_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now,index=True)
    published_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True)
    source_time:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True)
    content_hash:Mapped[str]=mapped_column(String(64))
    raw_path:Mapped[str]=mapped_column(Text)
    payload:Mapped[dict]=mapped_column(JSON)


class WeatherEvent(Base):
    __tablename__='weather_events'
    id:Mapped[str]=mapped_column(String(64),primary_key=True)
    source_id:Mapped[str]=mapped_column(ForeignKey('data_sources.id'),index=True)
    run_id:Mapped[str]=mapped_column(ForeignKey('collection_runs.id'))
    kind:Mapped[str]=mapped_column(String(24),index=True)
    category:Mapped[str]=mapped_column(String(24),index=True)
    issued_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True,index=True)
    occurred_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True,index=True)
    fetched_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now)
    payload:Mapped[dict]=mapped_column(JSON)


class JobRun(Base):
    __tablename__='job_runs'
    __table_args__=(Index('uq_job_active','job',unique=True,postgresql_where=text("status IN ('queued','running')")),)
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=uid)
    job:Mapped[str]=mapped_column(String(40),index=True)
    mode:Mapped[str]=mapped_column(String(24))
    status:Mapped[str]=mapped_column(String(16),index=True)
    actor_id:Mapped[str|None]=mapped_column(ForeignKey('users.id',ondelete='SET NULL'),nullable=True)
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now,index=True)
    started_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True)
    finished_at:Mapped[datetime|None]=mapped_column(DateTime(timezone=True),nullable=True)
    result:Mapped[dict]=mapped_column(JSON,default=dict)
    error_code:Mapped[str|None]=mapped_column(String(80),nullable=True)


class AdminAudit(Base):
    __tablename__='admin_audits'
    id:Mapped[str]=mapped_column(String(36),primary_key=True,default=uid)
    actor_id:Mapped[str|None]=mapped_column(ForeignKey('users.id',ondelete='SET NULL'),nullable=True)
    action:Mapped[str]=mapped_column(String(40),index=True)
    target:Mapped[str]=mapped_column(String(64))
    data:Mapped[dict]=mapped_column(JSON,default=dict)
    created_at:Mapped[datetime]=mapped_column(DateTime(timezone=True),default=now,index=True)
