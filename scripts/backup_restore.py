"""Back up the native project database and verify by restoring into a new database."""
import argparse
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
DATABASE = 'xingxu'
APP_ROLE = 'xingxu_app'
TABLES = ('users', 'satellites', 'favorites', 'observation_stations', 'observation_plans', 'sampling_profiles')


def settings():
    private = json.loads((ROOT / '.local/config/local-services.json').read_text())
    manifest = json.loads((ROOT / '.local/tools/services-manifest.json').read_text())
    tools = next(item['executable'] for item in manifest['services'] if item['name'] == 'postgresql')
    return (ROOT / tools).parent, private


def counts(connection):
    return {table: connection.execute(sql.SQL('SELECT count(*) FROM {}').format(sql.Identifier(table))).fetchone()[0]
            for table in TABLES}


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def backup(directory):
    binaries, private = settings()
    directory.mkdir(parents=True, exist_ok=True)
    label = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid4().hex[:6]
    archive = directory / f'xingxu-{label}.dump'
    with psycopg.connect(host='127.0.0.1', dbname=DATABASE, user=APP_ROLE, password=private['db_password']) as db:
        db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        snapshot = db.execute('SELECT pg_export_snapshot()').fetchone()[0]
        expected = counts(db)
        subprocess.run([str(binaries / 'pg_dump.exe'), '-h', '127.0.0.1', '-U', APP_ROLE, '-d', DATABASE,
                        '--format=custom', '--no-owner', '--no-acl', '--snapshot='+snapshot, '-f', str(archive)],
                       check=True, env={**os.environ, 'PGPASSWORD': private['db_password']})
    archive.with_suffix('.json').write_text(json.dumps({'sha256': digest(archive), 'tables': expected}, indent=2)+'\n', encoding='utf-8')
    return {'archive': str(archive), 'tables': expected}


def verify(archive):
    metadata = json.loads(archive.with_suffix('.json').read_text(encoding='utf-8'))
    if digest(archive) != metadata['sha256']:
        raise ValueError('Backup digest mismatch')
    binaries, private = settings()
    target = 'xingxu_restore_' + uuid4().hex[:12]
    admin = {'host': '127.0.0.1', 'user': 'xingxu_admin', 'password': private['admin_password']}
    with psycopg.connect(**admin, dbname='postgres', autocommit=True) as db:
        db.execute(sql.SQL('CREATE DATABASE {} OWNER {}').format(sql.Identifier(target), sql.Identifier(APP_ROLE)))
    subprocess.run([str(binaries / 'pg_restore.exe'), '-h', '127.0.0.1', '-U', APP_ROLE, '-d', target,
                    '--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', str(archive)],
                   check=True, env={**os.environ, 'PGPASSWORD': private['db_password']})
    with psycopg.connect(**admin, dbname=target) as db:
        restored = counts(db)
        migration = db.execute('SELECT version_num FROM alembic_version').fetchone()[0]
    if restored != metadata['tables']:
        raise ValueError('Restored counts differ from the backup snapshot')
    return {'database': target, 'sha256': metadata['sha256'], 'tables': restored,
            'alembicRevision': migration, 'verified': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    dump = commands.add_parser('backup')
    dump.add_argument('--directory', type=Path, default=ROOT / '.local/backups')
    restore = commands.add_parser('verify')
    restore.add_argument('archive', type=Path)
    args = parser.parse_args()
    print(json.dumps(backup(args.directory.resolve()) if args.action == 'backup' else verify(args.archive.resolve())))
