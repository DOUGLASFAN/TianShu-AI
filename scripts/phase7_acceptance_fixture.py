"""Explicit test-account-only fixtures for real worker/browser timing acceptance.

Never changes another user's plan. Generated events are labeled acceptance fixtures,
not astronomical predictions. No debug endpoint or accelerated production clock.
"""
import argparse,copy,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from datetime import timedelta
from sqlalchemy import select
from backend.app.db import SessionLocal
from backend.app.models import User,ObservationPlan,PlanReminder,now
from backend.app.api.plans import record

parser=argparse.ArgumentParser();parser.add_argument('username');parser.add_argument('--delay',type=int,default=10);parser.add_argument('--threshold',type=int,choices=[5,10,30],default=10);parser.add_argument('--label',default='调度验收');args=parser.parse_args()
if not args.username.startswith('phase7_') or not -300<=args.delay<=300:raise SystemExit('Only generated phase7_ acceptance accounts and bounded delays are supported')
with SessionLocal() as db,db.begin():
    user=db.scalar(select(User).where(User.username==args.username))
    if not user or user.role!='user':raise SystemExit('Acceptance account not found')
    start=now()+timedelta(minutes=args.threshold,seconds=args.delay);end=start+timedelta(minutes=6)
    snapshot={'basis':{'satellite':{'noradId':25544,'name':args.label+'（验收夹具）'},'station':{'id':'test-fixture','name':'验收站','latitude':39.9,'longitude':116.4,'elevation_m':0},'algorithm':'acceptance fixture, not astronomical data','orbit':{'epoch':now().isoformat(),'version':'fixture'},'minElevation':10,'days':1},
              'event':{'id':'fixture','start':start.isoformat(),'end':end.isoformat()},'acceptanceFixture':True}
    row=ObservationPlan(user_id=user.id,source_key='fixture:'+now().isoformat(),snapshot=snapshot,start_at=start,end_at=end,reminder_minutes=args.threshold)
    db.add(row);db.flush();record(row,db,'created')
    # A queued overdue fixture simulates stopping the worker across its threshold.
    if args.delay<0:db.get(PlanReminder,(row.id,1,args.threshold)).status='pending'
    result={'id':row.id,'dueAt':(start-timedelta(minutes=args.threshold)).isoformat(),'start':start.isoformat(),'fixture':True,'scope':'only generated acceptance account'}
print(json.dumps(result))
