"""Source-specific weather semantics, append-only raw evidence and last-good fallback."""
import hashlib,json,math,re,ssl,subprocess,urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timedelta,timezone
from pathlib import Path
from sqlalchemy import select
from ..db import SessionLocal
from ..models import DataSource,CollectionRun,WeatherSnapshot,WeatherEvent,now
from ..core.config import ROOT

SOURCES={
 'noaa-kp':{'name':'NOAA SWPC · Kp 观测','url':'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json','kind':'observation','freshHours':6},
 'gfz-kp':{'name':'GFZ · Kp 暂定观测','url':'https://www-app3.gfz-potsdam.de/kp_index/Kp_ap_Ap_SN_F107_nowcast.txt','kind':'observation','freshHours':6},
 'noaa-forecast':{'name':'NOAA SWPC · Kp 预测','url':'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json','kind':'forecast','freshHours':12},
 'noaa-alerts':{'name':'NOAA SWPC · 官方通报','url':'https://services.swpc.noaa.gov/products/alerts.json','kind':'warning','freshHours':1},
 'donki-flr':{'name':'NASA DONKI · 耀斑','url':'https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/FLR','kind':'observation','freshHours':1},
 'donki-cme':{'name':'NASA DONKI · 日冕物质抛射','url':'https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/CME','kind':'observation','freshHours':1}}

def stamp(value):
    if not isinstance(value,str) or not value.strip():return None
    try:
        dt=datetime.fromisoformat(value.strip().replace('Z','+00:00'))
        return (dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt).astimezone(timezone.utc)
    except ValueError:return None

def finite(value,lower=0,upper=9):
    result=float(value)
    if not math.isfinite(result) or not lower<=result<=upper:raise ValueError('Invalid Kp')
    return result

def event_time(text,label):
    match=re.search(r'(?:^|\n)'+label+r':\s*(\d{4} [A-Za-z]{3} \d{1,2} \d{4}) UTC',text,re.I)
    if not match:return None
    try:return datetime.strptime(match[1],'%Y %b %d %H%M').replace(tzinfo=timezone.utc).isoformat()
    except ValueError:return None

def parse(source,body,at=None):
    at=at or now();points=[];events=[]
    if source=='gfz-kp':
        for line in body.decode('utf-8-sig').splitlines():
            if not line.strip() or line.startswith('#'):continue
            columns=line.split()
            if len(columns)!=28:raise ValueError('Invalid GFZ columns')
            day=datetime(*map(int,columns[:3]),tzinfo=timezone.utc);status=int(columns[-1])
            if status not in (0,1,2):raise ValueError('Invalid GFZ status')
            for i,value in enumerate(columns[7:15]):
                if float(value)==-1:continue
                date=day+timedelta(hours=i*3)
                if date>at+timedelta(minutes=10):continue
                points.append({'time':date.isoformat(),'kp':finite(value),'kind':'observation','quality':'definitive' if status>=1 else 'preliminary_nowcast'})
        if not points:raise ValueError('No valid GFZ Kp')
    else:
        raw=json.loads(body)
        if not isinstance(raw,list):raise ValueError('Expected list')
        if source in ['noaa-kp','noaa-forecast']:
            rows=[dict(zip(raw[0],x)) for x in raw[1:]] if raw and isinstance(raw[0],list) else raw
            for row in rows:
                fields={k.lower():v for k,v in row.items()};date=stamp(fields.get('time_tag'))
                if date is None:raise ValueError('Missing timestamp')
                flag=str(fields.get('observed','')).lower()
                # Future estimates cannot be observations; preserve the original quality flag.
                kind='observation' if source=='noaa-kp' or flag=='observed' or (flag=='estimated' and date<=at) else 'forecast' if flag in ['predicted','estimated'] else 'unknown'
                if kind=='unknown':raise ValueError('Unrecognized forecast type')
                if kind=='observation' and date>at+timedelta(minutes=10):continue
                points.append({'time':date.isoformat(),'kp':finite(fields.get('kp',fields.get('kp_index'))),'kind':kind,'quality':flag or 'estimated_observation','officialScale':fields.get('noaa_scale') or None})
            if not points:raise ValueError('No valid Kp')
        elif source=='noaa-alerts':
            for row in raw:
                issued=stamp(row.get('issue_datetime'));message=row.get('message');product=row.get('product_id')
                if not issued or not isinstance(message,str) or not isinstance(product,str):raise ValueError('Invalid bulletin')
                match=re.search(r'(?:^|\n)\s*((?:(?:CONTINUED|EXTENDED|CANCEL|CANCELLED) )?(?:ALERT|WARNING|WATCH|SUMMARY))\b',message,re.I)
                bulletin=match[1].upper() if match else 'NOTICE';cancelled='CANCEL' in bulletin
                kind='warning' if any(x in bulletin for x in ['ALERT','WARNING','WATCH']) else 'notice'
                category='geomagnetic' if 'geomagnetic' in message.lower() else 'radiation' if re.search(r'electron|proton|radiation',message,re.I) else 'radio' if 'radio' in message.lower() else 'other'
                level=re.search(r'(?:NOAA|Noaa) Scale:\s*([GRS][1-5])\b',message)
                occurred=event_time(message,'(?:Begin Time|Threshold Reached)')
                valid_to=event_time(message,'(?:Valid To|Now Valid Until)')
                events.append({'sourceKey':product+':'+issued.isoformat(),'kind':kind,'category':category,'issuedAt':issued.isoformat(),'occurredAt':occurred,
                  'title':{'geomagnetic':'地磁活动通报','radiation':'辐射环境通报','radio':'射电活动通报','other':'空间天气通报'}[category],
                  'bulletinType':bulletin,'officialScale':level[1] if level else None,'validTo':valid_to,'cancelled':cancelled,'text':message,
                  'url':SOURCES[source]['url'],'raw':row})
        elif source.startswith('donki-'):
            for row in raw:
                key=row.get('flrID' if source=='donki-flr' else 'activityID');date=stamp(row.get('beginTime' if source=='donki-flr' else 'startTime'))
                if not isinstance(key,str) or date is None:raise ValueError('Invalid DONKI event')
                link=row.get('link') or 'https://ccmc.gsfc.nasa.gov/DONKI/'
                if not re.match(r'^https://(?:kauai\.ccmc\.gsfc\.nasa\.gov|ccmc\.gsfc\.nasa\.gov)/',link):raise ValueError('Invalid DONKI link')
                events.append({'sourceKey':key,'kind':'observation','category':'flare' if source=='donki-flr' else 'cme','issuedAt':None,'occurredAt':date.isoformat(),
                  'title':'太阳耀斑' if source=='donki-flr' else '日冕物质抛射','officialScale':row.get('classType') if source=='donki-flr' else None,
                  'validTo':None,'cancelled':False,'text':row.get('note') or '', 'url':link,'raw':row})
        else:raise ValueError('Unknown source')
    points=sorted({(p['time'],p['kind']):p for p in points}.values(),key=lambda p:p['time'])[-96:]
    return {'points':points,'events':events,'unit':'Kp (0–9)','timeSystem':'UTC'}

def source_url(source,at=None):
    at=at or now();url=SOURCES[source]['url']
    if source.startswith('donki-'):url+='?startDate='+(at-timedelta(days=7)).date().isoformat()+'&endDate='+at.date().isoformat()
    return url

def download(url):
    from .operations import require_external
    require_external()
    import certifi
    context=ssl.create_default_context();context.load_verify_locations(certifi.where())
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    req=urllib.request.Request(url,headers={'User-Agent':'StarNexus-Course/0.7','Accept':'application/json,text/plain','Accept-Encoding':'identity'})
    try:
        with urllib.request.build_opener(NoRedirect(),urllib.request.HTTPSHandler(context=context)).open(req,timeout=12) as r:
            body=r.read(4_000_001);modified=stamp(r.headers.get('Last-Modified'))
            if modified is None:
                from email.utils import parsedate_to_datetime
                try:modified=parsedate_to_datetime(r.headers['Last-Modified']) if r.headers.get('Last-Modified') else None
                except (ValueError,TypeError):modified=None
            result={'transport':'urllib','publishedAt':modified.isoformat() if modified else None}
    except urllib.error.HTTPError:raise
    except (OSError,urllib.error.URLError):
        # One alternate verified TLS transport; no insecure certificate bypass.
        value=subprocess.run(['curl.exe','--silent','--show-error','--fail','--proto','=https','--max-time','15','--connect-timeout','7','--max-filesize','4000000',url],capture_output=True,timeout=18)
        if value.returncode:raise ValueError('UPSTREAM_UNAVAILABLE')
        body=value.stdout;result={'transport':'curl','publishedAt':None}
    if len(body)>4_000_000:raise ValueError('PAYLOAD_TOO_LARGE')
    return body,result

def collect_source(source,fetch=download,clock=now):
    config=SOURCES[source];at=clock();url=source_url(source,at)
    with SessionLocal() as db,db.begin():
        if not db.get(DataSource,source):db.add(DataSource(id=source,name=config['name'],url=config['url']))
        db.flush();run=CollectionRun(source_id=source,status='running',mode='online_environment',started_at=at);db.add(run);db.flush();id=run.id
    try:
        body,metadata=fetch(url);parsed=parse(source,body,at);digest=hashlib.sha256(body).hexdigest()
        path=ROOT/'.local/data/environment'/source/(id+'.raw');path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body)
        parsed.update(url=url,transport=metadata.get('transport'),rawSha256=digest)
        dates=[stamp(x['time']) for x in parsed['points'] if x['kind']=='observation']+[stamp(x['occurredAt'] or x['issuedAt']) for x in parsed['events']]
        dates=[d for d in dates if d is not None]
        with SessionLocal() as db,db.begin():
            # Interrupted runs from an old worker are historical failures, not live work.
            for old in db.scalars(select(CollectionRun).where(CollectionRun.source_id==source,CollectionRun.status=='running',CollectionRun.id!=id)):
                old.status='failed';old.error_code='WORKER_INTERRUPTED';old.finished_at=at
            db.add(WeatherSnapshot(run_id=id,source_id=source,fetched_at=at,published_at=stamp(metadata.get('publishedAt')),source_time=max(dates) if dates else None,content_hash=digest,raw_path=path.relative_to(ROOT).as_posix(),payload=parsed))
            for event in parsed['events']:
                event_id=hashlib.sha256((source+':'+event['sourceKey']).encode()).hexdigest();row=db.get(WeatherEvent,event_id)
                values=dict(source_id=source,run_id=id,kind=event['kind'],category=event['category'],issued_at=stamp(event['issuedAt']),occurred_at=stamp(event['occurredAt']),fetched_at=at,payload=event)
                if row:
                    for k,v in values.items():setattr(row,k,v)
                else:db.add(WeatherEvent(id=event_id,**values))
            run=db.get(CollectionRun,id);run.status='success';run.record_count=len(parsed['points'])+len(parsed['events']);run.finished_at=clock();db.get(DataSource,source).last_success_at=at
        return {'source':source,'status':'success','runId':id,'records':len(parsed['points'])+len(parsed['events'])}
    except Exception as error:
        with SessionLocal() as db,db.begin():
            run=db.get(CollectionRun,id);run.status='failed';run.error_code='UPSTREAM_HTTP_'+str(error.code) if isinstance(error,urllib.error.HTTPError) else 'WEATHER_FETCH_OR_SCHEMA_FAILED';run.finished_at=clock()
        return {'source':source,'status':'failed','runId':id}

def collect_all():
    with ThreadPoolExecutor(max_workers=6,thread_name_prefix='weather') as pool:results=list(pool.map(collect_source,SOURCES))
    # Partial source failures remain separately queryable, other successes are retained.
    if not any(x['status']=='success' for x in results):raise ValueError('ALL_WEATHER_SOURCES_FAILED')
    return {'sources':results,'succeeded':sum(x['status']=='success' for x in results)}

def source_state(source,db,at=None):
    at=at or now();config=SOURCES[source]
    last=db.scalar(select(WeatherSnapshot).where(WeatherSnapshot.source_id==source).order_by(WeatherSnapshot.fetched_at.desc()).limit(1))
    run=db.scalar(select(CollectionRun).where(CollectionRun.source_id==source).order_by(CollectionRun.started_at.desc()).limit(1))
    age=(at-last.fetched_at).total_seconds() if last else None
    source_age=(at-last.source_time).total_seconds() if last and last.source_time else None
    stale=last is None or age>config['freshHours']*3600 or age< -300
    if source in ['noaa-kp','gfz-kp'] and (source_age is None or source_age>6*3600 or source_age< -600):stale=True
    if source=='noaa-forecast' and last:
        future=[stamp(x['time']) for x in last.payload['points'] if x['kind']=='forecast']
        if not future or max(future)<at:stale=True
    return {'id':source,**config,'state':'unknown' if last is None else 'stale' if stale else 'available',
      'lastAttemptStatus':run.status if run else None,'lastAttemptAt':run.started_at.isoformat() if run else None,'errorCode':run.error_code if run else None,
      'fetchedAt':last.fetched_at.isoformat() if last else None,'publishedAt':last.published_at.isoformat() if last and last.published_at else None,
      'sourceTime':last.source_time.isoformat() if last and last.source_time else None,'runId':last.run_id if last else None,
      'usingLastGood':bool(last and run and run.status=='failed'),'license':'Kp: CC BY 4.0 · GFZ / Matzka et al., 2021, doi:10.5880/Kp.0001; 原始文件中黑子数字段为 CC BY-NC 4.0' if source=='gfz-kp' else None},last
