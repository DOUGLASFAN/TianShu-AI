"""Wall-clock dispatch; plan lock serializes cancellation/recalculation and delivery."""
from datetime import timedelta
from sqlalchemy import select,func
from sqlalchemy.dialects.postgresql import insert
from ..db import SessionLocal
from ..models import ObservationPlan,PlanReminder,Notification,User,now

GRACE_SECONDS=60

def dispatch(clock=now,recovery=False):
    stamp=clock();sent=missed=0
    with SessionLocal() as db:
        ids=db.scalars(select(PlanReminder.plan_id).where(PlanReminder.status=='pending',PlanReminder.due_at<=stamp).distinct().limit(200)).all()
    for id in ids:
        with SessionLocal() as db,db.begin():
            plan=db.scalar(select(ObservationPlan).where(ObservationPlan.id==id).with_for_update(skip_locked=True))
            if not plan:continue
            reminders=db.scalars(select(PlanReminder).where(PlanReminder.plan_id==id,PlanReminder.status=='pending',PlanReminder.due_at<=stamp).with_for_update()).all()
            for reminder in reminders:
                user=db.get(User,plan.user_id)
                if plan.status!='active' or plan.version!=reminder.version or not user or not user.enabled:
                    reminder.status='cancelled';continue
                if recovery or stamp-reminder.due_at>timedelta(seconds=GRACE_SECONDS) or plan.start_at<=stamp:
                    reminder.status='missed';missed+=1;continue
                snapshot=plan.snapshot
                value={'satellite':snapshot['basis']['satellite'],'station':snapshot['basis']['station']['name'],
                       'start':plan.start_at.isoformat(),'end':plan.end_at.isoformat(),'version':plan.version,
                       'threshold':reminder.threshold,'dueAt':reminder.due_at.isoformat(),'deliveredAt':stamp.isoformat()}
                key=f'{plan.id}:{plan.version}:{reminder.threshold}'
                inserted=db.execute(insert(Notification).values(user_id=plan.user_id,plan_id=id,dedup_key=key,payload=value,created_at=stamp,updated_at=stamp).on_conflict_do_nothing(index_elements=['dedup_key']).returning(Notification.id)).scalar_one_or_none()
                sent+=int(inserted is not None);reminder.status='sent'
    return {'sent':sent,'missed':missed,'checkedAt':stamp.isoformat(),'graceSeconds':GRACE_SECONDS}

def summary(user_id):
    with SessionLocal() as db:
        unread=db.scalar(select(func.count()).select_from(Notification).where(Notification.user_id==user_id,Notification.read_at.is_(None),Notification.revoked_at.is_(None)))
        count,last=db.execute(select(func.count(),func.max(Notification.updated_at)).where(Notification.user_id==user_id)).one()
        return {'unread':unread,'revision':f'{count}:{last.isoformat() if last else ""}'}
