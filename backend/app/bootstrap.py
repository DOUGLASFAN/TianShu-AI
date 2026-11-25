"""Idempotent migration/seed entry point; no hard-coded account passwords."""
import json,secrets
from alembic import command
from alembic.config import Config
from sqlalchemy import func,select
from .core.config import ROOT
from .core.security import passwords
from .db import SessionLocal
from .models import DataSource,Satellite,User
from .services.collection import collect,create_run,import_rows


def initialize():
    command.upgrade(Config(str(ROOT/'alembic.ini')),'head')
    account_path=ROOT/'.local/config/demo-accounts.json'
    if account_path.exists():accounts=json.loads(account_path.read_text())
    else:
        account_path.parent.mkdir(parents=True,exist_ok=True)
        accounts={'admin':{'username':'admin','password':secrets.token_urlsafe(15)},
                  'student':{'username':'student','password':secrets.token_urlsafe(15)}}
        account_path.write_text(json.dumps(accounts,indent=2)+'\n',encoding='utf-8')
    with SessionLocal() as db,db.begin():
        if not db.get(DataSource,'celestrak'):
            db.add(DataSource(id='celestrak',name='CelesTrak GP',url='https://celestrak.org/NORAD/elements/gp.php?GROUP=ACTIVE&FORMAT=JSON'))
        for role,credentials in accounts.items():
            if not db.scalar(select(User.id).where(User.username==credentials['username'])):
                db.add(User(username=credentials['username'],password_hash=passwords.hash(credentials['password']),
                            role='admin' if role=='admin' else 'user',enabled=True,token_version=0))
    with SessionLocal() as db:
        empty=db.scalar(select(func.count()).select_from(Satellite))==0
    if empty:
        count=None
        if (ROOT/'.local/data/source-validation/celestrak/gp_active.json').exists():
            count=collect(create_run('snapshot_seed'),network=False)
        if count is None:
            run=create_run('bundled_seed')
            rows=json.loads((ROOT/'assets/data/orbits/representative-2026-11-12.json').read_text())
            manifest=json.loads((ROOT/'assets/data/orbits/manifest-2026-11-12.json').read_text())
            count=import_rows(rows,{},manifest['gp']['source'],[('active','已导入样本',{x['NORAD_CAT_ID'] for x in rows})],run)
        if count is None:raise RuntimeError('Initial catalogue import failed; inspect collection log')
    print('Migrations and seed ready. Account credentials kept only in .local/config/demo-accounts.json')


if __name__=='__main__':initialize()
