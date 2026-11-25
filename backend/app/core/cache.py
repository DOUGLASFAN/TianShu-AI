import json,time
from threading import Lock
from redis import Redis,RedisError
from redis.retry import Retry
from redis.backoff import NoBackoff
from .config import settings


cache=Redis.from_url(settings().redis_url,decode_responses=True,socket_connect_timeout=1,socket_timeout=1,retry=Retry(NoBackoff(),0))
_fallback={}
_fallback_lock=Lock()


def get(key):
    try:
        value=cache.get(key)
        return json.loads(value) if value else None
    except (RedisError,ValueError):return None


def put(key,value,ttl):
    try:cache.set(key,json.dumps(value,ensure_ascii=False),ex=ttl);return True
    except RedisError:return False


def allow_login(key):
    try:
        attempts=cache.incr('login:'+key)
        if attempts==1:cache.expire('login:'+key,60)
        return attempts<=12
    except RedisError:
        # Keep a bounded per-process limiter during cache outage rather than
        # allowing unlimited retries. DB-backed session validation stays available.
        with _fallback_lock:
            stamp=time.monotonic()
            if len(_fallback)>4096:
                for expired in [k for k,v in _fallback.items() if v[1]<=stamp]:_fallback.pop(expired,None)
            count,expiry=_fallback.get(key,(0,stamp+60))
            if expiry<=stamp:count,expiry=0,stamp+60
            if key not in _fallback and len(_fallback)>=8192:return False
            _fallback[key]=(count+1,expiry)
            return count<12
