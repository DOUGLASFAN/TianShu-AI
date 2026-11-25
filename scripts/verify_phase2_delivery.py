"""Summarize existing execution evidence and inspect the running local delivery."""
import json
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
import httpx
import yaml
from sqlalchemy import inspect, text
from backend.app.db import engine

ROOT = Path(__file__).resolve().parents[1]
evidence = ROOT / 'docs/evidence'
suite = ET.parse(evidence / 'phase2-backend-2026-11-12.xml').getroot().find('testsuite')
browser = json.loads((evidence / 'phase2-browser-2026-11-12.json').read_text(encoding='utf-8'))
persistence = json.loads((evidence / 'phase2-persistence-2026-11-12.json').read_text(encoding='utf-8'))
secrets = json.loads((ROOT / '.local/config/local-services.json').read_text(encoding='utf-8'))
accounts = json.loads((ROOT / '.local/config/demo-accounts.json').read_text(encoding='utf-8'))
def strings(value):
    if isinstance(value, dict):
        for item in value.values(): yield from strings(item)
    elif isinstance(value, list):
        for item in value: yield from strings(item)
    elif isinstance(value, str) and len(value) >= 16: yield value
known = list(strings(secrets)) + list(strings(accounts))
for line in (ROOT / '.env').read_text(encoding='utf-8-sig').splitlines():
    if '=' in line and any(word in line.split('=', 1)[0] for word in ('PASSWORD', 'SECRET')):
        known.append(line.split('=', 1)[1].strip().strip('"\''))
outputs = [p for p in (ROOT / 'frontend/dist').rglob('*') if p.suffix in ('.js', '.css', '.html')]
leaks = [str(p.relative_to(ROOT)) for p in outputs if any(s and s in p.read_text(encoding='utf-8') for s in known)]
assert outputs and not leaks, 'Build secret scan failed'
schema = inspect(engine)
tables = [t for t in schema.get_table_names() if t != 'alembic_version']
with engine.connect() as db:
    count = db.scalar(text('SELECT count(*) FROM satellites'))
    version = db.scalar(text('SHOW server_version'))
compose = yaml.safe_load((ROOT / 'compose.yaml').read_text(encoding='utf-8'))
assert {'postgres','redis','api','web'} <= set(compose['services'])
with httpx.Client(timeout=10) as client:
    ready = client.get('http://127.0.0.1:8001/api/health/ready')
    ready.raise_for_status()
    page = client.get('http://127.0.0.1:5174/')
    page.raise_for_status()
    api = client.get('http://127.0.0.1:8001/openapi.json')
    api.raise_for_status()
    (evidence / 'phase2-openapi-2026-11-12.json').write_text(json.dumps(api.json(), ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
report = {
    'stage': 2, 'checked_at': datetime.now(timezone.utc).isoformat(),
    'backend': {'tests': int(suite.attrib['tests']), 'failures': int(suite.attrib['failures']), 'errors': int(suite.attrib['errors'])},
    'browser': {'checks': len(browser['checks']), 'passed': browser['all_passed']},
    'service_restart_and_persistence': persistence['all_passed'],
    'postgres_version': version, 'business_tables': len(tables),
    'foreign_keys': sum(len(schema.get_foreign_keys(t)) for t in tables),
    'indexes': sum(len(schema.get_indexes(t)) for t in tables),
    'satellite_count': count, 'frontend_build_known_secret_scan': {'files': len(outputs), 'passed': not leaks},
    'compose': {'yaml_parsed': True, 'container_execution_verified': False, 'reason': 'Docker unavailable'},
    'live_readiness': ready.json(), 'web_http_status': page.status_code,
    'application_stop_keep_services_then_start': 'passed on 2026-11-12; process UTC identity retained',
    'visual_scope': 'Foundation workbench only; phase 3 formal A-style 3D not accepted',
}
assert report['backend']['tests'] == 20 and not report['backend']['failures'] and not report['backend']['errors']
assert report['browser']['passed'] and report['service_restart_and_persistence']
(evidence / 'phase2-acceptance-2026-11-12.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
