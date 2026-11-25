"""Start/stop only this project's native PostgreSQL and Redis processes."""
import argparse,json,os,secrets,subprocess,time
from pathlib import Path
from urllib.parse import quote
import psycopg
from psycopg import sql
from redis import Redis
from redis.retry import Retry
from redis.backoff import NoBackoff

ROOT=Path(__file__).resolve().parents[1]
CONFIG=ROOT/'.local/config';CONFIG.mkdir(parents=True,exist_ok=True)


def config():
    p=CONFIG/'local-services.json'
    if not p.exists():
        values={'admin_password':secrets.token_urlsafe(24),'db_password':secrets.token_urlsafe(24),
                'redis_password':secrets.token_urlsafe(24),'jwt_secret':secrets.token_urlsafe(48)}
        p.write_text(json.dumps(values,indent=2)+'\n',encoding='utf-8')
    return json.loads(p.read_text())


def paths():
    manifest=json.loads((ROOT/'.local/tools/services-manifest.json').read_text())
    return {row['name']:ROOT/row['executable'] for row in manifest['services']}


def pg_call(executable,args,**kwargs):
    # A background postgres child may inherit pipe handles on Windows. Use files,
    # not communicate(PIPE), so pg_ctl startup can finish while the server stays up.
    logfile=CONFIG/(Path(executable).stem+'-'+str(time.monotonic_ns())+'.log')
    with logfile.open('wb') as output:
        result=subprocess.run([str(executable),*map(str,args)],stdout=output,stderr=subprocess.STDOUT,**kwargs)
    if result.returncode:raise RuntimeError('PostgreSQL command failed; see '+str(logfile.relative_to(ROOT)))
    return result


def start():
    values=config();binary=paths();pgbin=binary['postgresql'].parent
    pgdata=ROOT/'.local/data/postgres';pgdata.mkdir(parents=True,exist_ok=True)
    redisdata=ROOT/'.local/data/redis';redisdata.mkdir(parents=True,exist_ok=True)
    if not (pgdata/'PG_VERSION').exists():
        passwordfile=CONFIG/'postgres-bootstrap-password.txt'
        passwordfile.write_text(values['admin_password'],encoding='utf-8')
        pg_call(pgbin/'initdb.exe',['-D',pgdata,'-U','xingxu_admin','-A','scram-sha-256',
                                   '--pwfile',passwordfile,'--encoding=UTF8','--locale=C'],timeout=90)
        with (pgdata/'postgresql.conf').open('a',encoding='utf-8') as f:
            f.write("\nlisten_addresses = '127.0.0.1'\nport = 5432\ntimezone = 'UTC'\nlog_timezone = 'UTC'\n")
    status=subprocess.run([str(pgbin/'pg_ctl.exe'),'-D',str(pgdata),'status'],capture_output=True)
    if status.returncode:
        pg_call(pgbin/'pg_ctl.exe',['-D',pgdata,'-l',pgdata/'server.log','-w','start'],timeout=60)
    with psycopg.connect(host='127.0.0.1',port=5432,user='xingxu_admin',password=values['admin_password'],dbname='postgres',autocommit=True) as db:
        if not db.execute("SELECT 1 FROM pg_roles WHERE rolname='xingxu_app'").fetchone():
            db.execute(sql.SQL('CREATE ROLE xingxu_app LOGIN PASSWORD {} NOSUPERUSER NOCREATEDB NOCREATEROLE').format(sql.Literal(values['db_password'])))
        if not db.execute("SELECT 1 FROM pg_database WHERE datname='xingxu'").fetchone():
            db.execute('CREATE DATABASE xingxu OWNER xingxu_app')
    redisconf=CONFIG/'redis.conf'
    redisconf.write_text('bind 127.0.0.1\nport 6379\nprotected-mode yes\nappendonly yes\ndir ./\n'+
                         'requirepass '+values['redis_password']+'\n',encoding='utf-8')
    client=Redis(host='127.0.0.1',port=6379,password=values['redis_password'],socket_connect_timeout=1,socket_timeout=1,retry=Retry(NoBackoff(),0))
    try:client.ping()
    except Exception:
        flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
        log=(redisdata/'server.log').open('ab')
        posix_config='/cygdrive/'+redisconf.drive[0].lower()+redisconf.as_posix()[2:]
        process=subprocess.Popen([str(binary['redis']),posix_config],cwd=redisdata,stdout=log,stderr=log,creationflags=flags)
        (CONFIG/'redis-process.json').write_text(json.dumps({'pid':process.pid,'executable':str(binary['redis'])}),encoding='utf-8')
        for _ in range(30):
            try:
                if client.ping():break
            except Exception:time.sleep(.3)
        else:raise RuntimeError('Redis did not become ready; see project-local server.log')
    env=ROOT/'.env'
    if not env.exists():
        env.write_text('STAR_DATABASE_URL=postgresql+psycopg://xingxu_app:'+quote(values['db_password'],safe='')+'@127.0.0.1:5432/xingxu\n'+
                       'STAR_REDIS_URL=redis://:'+quote(values['redis_password'],safe='')+'@127.0.0.1:6379/0\n'+
                       'STAR_JWT_SECRET='+values['jwt_secret']+'\nSTAR_SECURE_COOKIES=false\n',encoding='utf-8')
    content=env.read_text(encoding='utf-8')
    for key,value in {'STAR_DB_PASSWORD':values['db_password'],'STAR_DB_ADMIN_PASSWORD':values['admin_password'],
                      'STAR_REDIS_PASSWORD':values['redis_password']}.items():
        if key+'=' not in content:content+='\n'+key+'='+value+'\n'
    env.write_text(content,encoding='utf-8')
    print(json.dumps({'postgres':'ready','redis':bool(client.ping()),'storage':'.local/data','secrets_written':True}))


def stop():
    values=config();binary=paths()
    try:Redis(host='127.0.0.1',password=values['redis_password'],socket_connect_timeout=1,socket_timeout=1,retry=Retry(NoBackoff(),0)).shutdown(save=True)
    except Exception:pass
    data=ROOT/'.local/data/postgres'
    status=subprocess.run([str(binary['postgresql'].parent/'pg_ctl.exe'),'-D',str(data),'status'],capture_output=True)
    if status.returncode==0:pg_call(binary['postgresql'].parent/'pg_ctl.exe',['-D',data,'-w','stop','-m','fast'],timeout=60)
    print('Project services stopped; data preserved.')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['start','stop']);args=parser.parse_args()
    start() if args.action=='start' else stop()
