"""Create an isolated real PostgreSQL test DB; never truncate the application DB."""
import argparse,json,os,subprocess,sys,uuid
from pathlib import Path
from urllib.parse import quote
import psycopg
from psycopg import sql

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--stage',choices=['2','3','4','5','6','7','8','8'],default='2');parser.add_argument('--date');args=parser.parse_args();stage=args.stage
from datetime import date as Date
date=Date.fromisoformat(args.date).isoformat() if args.date else ('2026-11-15' if stage in ['5','6','7','8'] else '2026-11-12')
values=json.loads((ROOT/'.local/config/local-services.json').read_text())
name='xingxu_phase'+stage+'_test_'+uuid.uuid4().hex[:10]
with psycopg.connect(host='127.0.0.1',user='xingxu_admin',password=values['admin_password'],dbname='postgres',autocommit=True) as db:
    db.execute(sql.SQL('CREATE DATABASE {} OWNER xingxu_app').format(sql.Identifier(name)))
env=os.environ.copy()
env['STAR_DATABASE_URL']='postgresql+psycopg://xingxu_app:'+quote(values['db_password'],safe='')+'@127.0.0.1:5432/'+name
env['STAR_REDIS_URL']='redis://:'+quote(values['redis_password'],safe='')+'@127.0.0.1:6379/15'
init=subprocess.run([sys.executable,'-m','backend.app.bootstrap'],cwd=ROOT,env=env)
if init.returncode:raise SystemExit(init.returncode)
result=subprocess.run([sys.executable,'-m','pytest',f'backend/tests/test_phase{stage}.py','-q',
                       f'--junitxml=docs/evidence/phase{stage}-backend-{date}.xml'],cwd=ROOT,env=env)
(ROOT/f'docs/evidence/phase{stage}-test-environment-{date}.json').write_text(json.dumps({
    'test_database':name,'isolated_from_application':True,'redis_database':15,'exit_code':result.returncode,
    'note':'Test database retained for evidence; no application data was dropped.'},indent=2)+'\n',encoding='utf-8')
raise SystemExit(result.returncode)
