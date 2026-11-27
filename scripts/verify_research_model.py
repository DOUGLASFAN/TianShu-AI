"""Exercise the complete running API with a fresh local guest session and a public frozen report."""
import argparse
import json
import time
import secrets
from pathlib import Path
import httpx

def verify(url,provider):
    with httpx.Client(base_url=url,headers={'Origin':url},timeout=15) as client:
        if provider=='deepseek-cloud':
            credentials={'username':'cloud_qa_'+secrets.token_hex(4),'password':secrets.token_urlsafe(24)}
            client.post('/api/auth/register',json=credentials).raise_for_status()
            auth=client.post('/api/auth/login',json=credentials)
        else:
            auth=client.post('/api/auth/guest')
        auth.raise_for_status()
        client.headers['Authorization']='Bearer '+auth.json()['accessToken']
        response=client.post('/api/telemetry/runs',json={'asset':'opssat-v2','channel':'CADC0872','segment':'8'})
        response.raise_for_status();r=response.json()
        task={'report':r['id'],'provider':provider,'request':'查档案，检查质量、检测异常，再核验样本数并生成有证据的总结。'}
        created=client.post('/api/research/jobs',json=task);created.raise_for_status()
        for _ in range(100):
            res=client.get('/api/research/jobs/'+created.json()['id']);res.raise_for_status();job=res.json()
            if job['state'] not in ('queued','running'):break
            time.sleep(1)
        return dict(provider=provider,state=job['state'],issue=job['issue'],steps=job['steps'],report=r['id'],sampleSha256=r['asset']['sha256'])

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('provider',choices=['qwen','deepseek','deepseek-cloud']);p.add_argument('output',type=Path);p.add_argument('--url',default='http://127.0.0.1:5184')
    args=p.parse_args();result=verify(args.url,args.provider);args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(result['state'],result['issue'],[s['tool'] for s in result['steps']])
    if result['state']!='completed' or not any(s['tool']=='summary' and s['result'].get('statements') for s in result['steps']):raise SystemExit(1)
