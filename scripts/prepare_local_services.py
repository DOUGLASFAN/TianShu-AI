"""Download project-local portable services. No Windows service registration."""
import hashlib
import json
import ssl
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import certifi

ROOT=Path(__file__).resolve().parents[1]
DEFINITIONS=[
    ('postgresql','https://get.enterprisedb.com/postgresql/postgresql-17.11-3-windows-x64-binaries.zip',None),
    ('redis','https://github.com/redis-windows/redis-windows/releases/download/8.10.3/Redis-8.10.3-Windows-x64-msys2.zip',
     'af16df340525b431e9ec8dabfd625d5e7a233f82805b5418819904ea909c447f'),
]


def main():
    context=ssl.create_default_context();context.load_verify_locations(cafile=certifi.where())
    report={'prepared_at':datetime.now(timezone.utc).isoformat(),'services':[]}
    for name,url,expected in DEFINITIONS:
        archive=ROOT/'.local/downloads'/url.rsplit('/',1)[-1]
        archive.parent.mkdir(parents=True,exist_ok=True)
        if not archive.exists():
            print('Downloading '+name,flush=True)
            request=urllib.request.Request(url,headers={'User-Agent':'StarNexus-Project-Setup/0.1'})
            with urllib.request.urlopen(request,context=context,timeout=60) as response,archive.with_suffix('.part').open('wb') as output:
                while chunk:=response.read(1024*1024):output.write(chunk)
            archive.with_suffix('.part').replace(archive)
        digest=hashlib.sha256(archive.read_bytes()).hexdigest()
        if expected and digest!=expected:raise ValueError(name+' published asset digest mismatch')
        dest=(ROOT/'.local/tools'/name).resolve();dest.mkdir(parents=True,exist_ok=True)
        print('Extracting '+name,flush=True)
        with zipfile.ZipFile(archive) as zipped:
            for member in zipped.infolist():
                if name=='postgresql' and not (member.filename.startswith(('pgsql/bin/','pgsql/lib/','pgsql/share/'))
                                                or 'license' in member.filename.lower() or 'copyright' in member.filename.lower()):continue
                target=(dest/member.filename).resolve()
                if not target.is_relative_to(dest):raise ValueError('Unsafe archive member')
                zipped.extract(member,dest)
        binaries=list(dest.rglob('postgres.exe' if name=='postgresql' else 'redis-server.exe'))
        if len(binaries)!=1:raise ValueError('Expected one service executable')
        report['services'].append({'name':name,'source':url,'archive_sha256':digest,'published_digest_verified':bool(expected),
                                   'executable':binaries[0].relative_to(ROOT).as_posix(),
                                   'distribution':'EDB PostgreSQL official Windows binaries' if name=='postgresql' else 'redis-windows community build; not official Redis Windows distribution'})
        (ROOT/'.local/tools/services-manifest.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
        print(name+' ready',flush=True)


if __name__=='__main__':main()
