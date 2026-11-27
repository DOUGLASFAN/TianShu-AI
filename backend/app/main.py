import logging,re,time,uuid,asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI,HTTPException,Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError,OperationalError
from starlette.exceptions import HTTPException as StarletteHTTPException
from .api import auth,catalog,personal,admin,explore,realtime,predictions,plans,notifications,environment,dashboard,maps,sampling
from .core.cache import cache
from .db import engine


@asynccontextmanager
async def lifespan(app):
    app.state.map_tile_semaphore=asyncio.Semaphore(8)
    yield
    maps.close_http_client()
    engine.dispose()


app=FastAPI(title='星枢 API',version='0.2.0',lifespan=lifespan)


@app.middleware('http')
async def request_context(request:Request,call_next):
    rid=request.headers.get('x-request-id','')
    request.state.request_id=rid if re.fullmatch(r'[A-Za-z0-9_-]{1,64}',rid) else uuid.uuid4().hex
    response=await call_next(request)
    response.headers['X-Request-ID']=request.state.request_id
    response.headers['X-Content-Type-Options']='nosniff'
    if request.url.path.startswith('/api/auth'):response.headers['Cache-Control']='no-store'
    return response


MESSAGES={'AUTH_REQUIRED':'请先登录','SESSION_INVALID':'登录已失效，请重新登录','INVALID_CREDENTIALS':'用户名或密码错误',
          'SAMPLING_PROFILE_NOT_FOUND':'采样方案不存在或无权访问','SAMPLING_PRESET_NOT_FOUND':'找不到该卫星组','SAMPLING_TIME_RANGE':'采样区间须在当前时刻前后 7 天内','SAMPLING_BUSY':'采样计算繁忙，请稍后重试','SAMPLING_PROFILE_LIMIT':'最多保存 50 个采样方案',
          'MAP_LAYER_NOT_FOUND':'未找到该底图图层','MAP_PROVIDER_NOT_FOUND':'未找到该地图来源','MAP_KEY_REQUIRED':'天地图尚未配置开发者 Key','MAP_TILE_RANGE':'地图瓦片范围无效','MAP_UPSTREAM_UNAVAILABLE':'在线地图暂不可用，请保留本地底图或稍后重试','MAP_DEMO_FAILURE':'故障演示中，在线地图请求已暂停',
          'SOURCE_NOT_FOUND':'未找到该任务来源','TASK_NOT_FOUND':'未找到该任务','MANUAL_REFRESH_LIMIT':'同类手动刷新间隔至少 60 秒，请稍后重试',
          'NOTIFICATION_NOT_FOUND':'通知不存在或无权访问','WEATHER_SOURCE_INVALID':'未找到该空间天气来源','WEATHER_EVENT_NOT_FOUND':'未找到该空间天气事件','WEATHER_SNAPSHOT_NOT_FOUND':'该来源原始快照暂不可用',
          'GROUP_REPLAY_REQUIRED':'请选择已完成的分组预测','REPLAY_TIME_RANGE':'回放时间须在本次预测范围内，并带有时区','SATELLITE_NOT_IN_BATCH':'该卫星不属于本次预测批次',
          'GROUP_NOT_FOUND':'未找到该分组','EMPTY_BATCH':'该批次没有可预测对象','BATCH_CHANGED':'分组目录已更新，请刷新并重新确认批次对象','PREDICTION_NOT_COMPLETE':'预测尚未完成，请等待任务结果',
          'PLAN_NOT_FOUND':'观测计划不存在或无权访问','PAST_EVENT':'过境已开始，不能保存为未来计划，请重新预测',
          'PLAN_ORBIT_UPDATED':'轨道根数已有更新，请重新计算后保存计划','PLAN_VERSION_CONFLICT':'计划版本已变化，请重新查看差异',
          'PLAN_TARGET_MISMATCH':'重算结果必须属于原计划的卫星','PROPOSAL_NOT_FOUND':'更新预览不存在','PROPOSAL_EXPIRED':'更新预览已过期，请重新预览',
          'STATION_LIMIT':'最多保存 50 个观测站','PREDICTION_NOT_FOUND':'预测任务不存在或无权访问','EVENT_NOT_FOUND':'过境事件不存在',
          'PREDICTION_TIME_RANGE':'开始时间须在当前至未来 7 天内','STALE_ORBIT_ACK_REQUIRED':'轨道根数已陈旧，请确认后继续',
          'PREDICTION_QUEUE_FULL':'预测队列已满，请等待或取消已有任务',
          'USERNAME_TAKEN':'该用户名已被使用','ADMIN_REQUIRED':'需要管理员权限','STATION_NOT_FOUND':'观测站不存在或无权访问',
          'LAST_ADMIN_REQUIRED':'必须保留至少一个可用管理员','ORIGIN_REJECTED':'请求来源不被允许',
          'LOGIN_RATE_LIMIT':'登录尝试过多，请稍后重试','GUEST_SIGN_OUT_REQUIRED':'请退出当前账号后再使用游客体验。','COLLECTION_RUNNING':'采集任务正在运行',
          'SATELLITE_NOT_FOUND':'未找到该卫星，请更换目标','ORBIT_PROPAGATION_FAILED':'该卫星当前无法传播，请更换时间或目标',
          'EXPLICIT_TIMEZONE_REQUIRED':'请选择带有时区的时间','TIME_RANGE_EXCEEDED':'探索采样时间须在当前前后 7 天以内'}


def error(request,status,code,fields=None,headers=None):
    return JSONResponse(status_code=status,content={'error':{'code':code,'message':MESSAGES.get(code,'请求未完成，请检查输入或稍后重试'),
                        'fields':fields or []},'requestId':getattr(request.state,'request_id',uuid.uuid4().hex)},headers=headers)


@app.exception_handler(StarletteHTTPException)
async def http_error(request,exc):
    code=exc.detail if isinstance(exc.detail,str) else 'REQUEST_ERROR'
    return error(request,exc.status_code,code,headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_error(request,exc):
    # Never echo input values: request bodies can contain passwords or tokens.
    fields=[{'field':'.'.join(map(str,e['loc'])),'type':e['type'],'message':e['msg']} for e in exc.errors()]
    return error(request,422,'VALIDATION_ERROR',fields)


@app.exception_handler(IntegrityError)
async def conflict(request,exc):return error(request,409,'DATA_CONFLICT')


@app.exception_handler(OperationalError)
async def database_unavailable(request,exc):return error(request,503,'DATABASE_UNAVAILABLE')


@app.exception_handler(Exception)
async def unexpected_error(request,exc):
    logging.getLogger('star_nexus').error('Unhandled %s requestId=%s',type(exc).__name__,getattr(request.state,'request_id','unknown'))
    return error(request,500,'INTERNAL_ERROR')


@app.get('/api/health/live',tags=['健康检查'])
def live():return {'ok':True,'version':'0.2.0'}


@app.get('/api/health/ready',tags=['健康检查'])
def ready():
    try:
        with engine.connect() as connection:connection.execute(text('SELECT 1'))
        redis_ok=bool(cache.ping())
    except Exception:
        raise HTTPException(503,'DEPENDENCY_UNAVAILABLE')
    return {'ok':True,'database':'ready','cache':'ready' if redis_ok else 'unavailable'}


app.include_router(auth.router);app.include_router(catalog.router)
app.include_router(personal.router);app.include_router(admin.router)
app.include_router(explore.router)
app.include_router(realtime.router)
app.include_router(predictions.router)
app.include_router(plans.router)
app.include_router(notifications.router)
app.include_router(environment.router)
app.include_router(dashboard.router)
app.include_router(maps.router)
app.include_router(sampling.router)

from .api import telemetry
app.include_router(telemetry.router)
