"""Offline report entry point with the same frozen inputs used by the API."""
import argparse
import json
from pathlib import Path
from backend.app.services.telemetry import analyze

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--channel',default='CADC0872')
    parser.add_argument('--segment',default='8')
    parser.add_argument('--output',required=True)
    args=parser.parse_args()
    sample=Path(__file__).resolve().parents[1]/'assets/data/telemetry/opssat-v2'
    meta=json.loads(sample.with_suffix('.json').read_bytes())
    content=sample.with_suffix('.csv').read_bytes().decode('utf8')
    report=analyze(content,meta,args.channel,args.segment)
    Path(args.output).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
