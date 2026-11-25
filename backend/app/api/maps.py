"""Authenticated, bounded relay to named map services; never a general URL proxy."""
import asyncio,ssl,threading,urllib.error
import httpx
from fastapi import APIRouter,Depends,HTTPException,Query,Request,Response
from ..core.security import current_user
from ..core.config import settings
from ..services.operations import require_external,DemoFailure,demo_state

router=APIRouter(prefix='/api/maps',tags=['分级底图'],dependencies=[Depends(current_user)])
_client=None
_client_lock=threading.Lock()
def http_client():
    global _client
    with _client_lock:
        if _client is None:
            import certifi
            context=ssl.create_default_context();context.load_verify_locations(certifi.where())
            _client=httpx.Client(verify=context,timeout=httpx.Timeout(10,connect=5,pool=5),limits=httpx.Limits(max_connections=8,max_keepalive_connections=8,keepalive_expiry=60),follow_redirects=False)
        return _client
def close_http_client():
    global _client
    with _client_lock:
        if _client is not None:_client.close();_client=None
ESRI={'imagery':'World_Imagery','streets':'World_Street_Map','labels':'Reference/World_Boundaries_and_Places'}
TDT={'imagery':'img','streets':'vec','labels':'cia','street-labels':'cva'}

def public_config():
    config=settings();tdt=bool(config.tianditu_key and config.tianditu_key.get_secret_value().strip())
    preferred=config.map_provider
    if preferred not in ['local','esri','tianditu']:preferred='tianditu' if tdt else 'esri'
    if preferred=='tianditu' and not tdt:preferred='esri'
    return {'preferred':preferred,'providers':[{'id':'esri','name':'全球地图','configured':True,'maximumLevel':19,'coordinateSystem':'Web Mercator / WGS84','credit':'Esri, Vantor, Earthstar Geographics, HERE, Garmin, OpenStreetMap contributors and GIS User Community','sourceUrl':'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer'},
        {'id':'tianditu','name':'天地图','configured':tdt,'maximumLevel':18,'coordinateSystem':'官方 WMTS Web Mercator 网格；站点始终存 WGS84','credit':'天地图 · 国家地理信息公共服务平台','sourceUrl':'https://lbs.tianditu.gov.cn/server/MapService.html'}],
        'directTemplates':{} if config.arcgis_token else {name:f'https://services.arcgisonline.com/ArcGIS/rest/services/{service}/MapServer/tile/{{z}}/{{y}}/{{x}}' for name,service in ESRI.items()},
        'tileUrl':'/api/maps/tiles/{provider}/{layer}/{z}/{x}/{y}','localFallback':'/earth/day-8k.jpg','localCredit':'Solar System Scope / INOVE · CC BY 4.0',
        'coverageNote':'影像精度与年代因地区而异，非实时卫星画面；没有道路或建筑三维几何。','cachePolicy':'按需在线请求，不批量预取，不将供应商瓦片保存为离线包'}

@router.get('/config')
def config():return {'data':{**public_config(),'demoActive':demo_state().get('phase')=='active'}}

def tile_url(provider,layer,z,x,y):
    config=settings()
    if provider=='esri':
        if layer not in ESRI:raise HTTPException(404,'MAP_LAYER_NOT_FOUND')
        url=f'https://services.arcgisonline.com/ArcGIS/rest/services/{ESRI[layer]}/MapServer/tile/{z}/{y}/{x}'
        if config.arcgis_token:url+='?token='+config.arcgis_token.get_secret_value()
        return url,bool(config.arcgis_token)
    if provider=='tianditu':
        if not config.tianditu_key:raise HTTPException(409,'MAP_KEY_REQUIRED')
        if layer not in TDT:raise HTTPException(404,'MAP_LAYER_NOT_FOUND')
        name=TDT[layer]
        from urllib.parse import urlencode
        return f'https://t0.tianditu.gov.cn/{name}_w/wmts?'+urlencode({'SERVICE':'WMTS','REQUEST':'GetTile','VERSION':'1.0.0','LAYER':name,'STYLE':'default','TILEMATRIXSET':'w','FORMAT':'tiles','TILEMATRIX':z,'TILEROW':y,'TILECOL':x,'tk':config.tianditu_key.get_secret_value()}),True
    raise HTTPException(404,'MAP_PROVIDER_NOT_FOUND')

def fetch_tile(url,credentialed=False):
    require_external()
    with http_client().stream('GET',url,headers={'User-Agent':'StarNexus-Course/0.9','Accept':'image/png,image/jpeg,image/webp','Accept-Encoding':'identity'}) as response:
        if response.status_code>=300:raise urllib.error.HTTPError('map-service',response.status_code,'Map upstream error',None,None)
        chunks=[];size=0
        for chunk in response.iter_bytes():
            size+=len(chunk)
            if size>2_000_000:raise ValueError('MAP_TILE_TOO_LARGE')
            chunks.append(chunk)
        body=b''.join(chunks)
    if len(body)>2_000_000:raise ValueError('MAP_TILE_TOO_LARGE')
    png=body.startswith(b'\x89PNG\r\n\x1a\n');jpg=body.startswith(b'\xff\xd8\xff');webp=body.startswith(b'RIFF') and body[8:12]==b'WEBP'
    if not png and not jpg and not webp:raise ValueError('MAP_INVALID_IMAGE')
    return body,'image/png' if png else 'image/jpeg' if jpg else 'image/webp'

@router.get('/tiles/{provider}/{layer}/{z}/{x}/{y}')
async def tile(provider:str,layer:str,z:int,x:int,y:int,request:Request):
    limit=18 if provider=='tianditu' or layer=='labels' else 19
    if not 0<=z<=limit or not 0<=x<2**z or not 0<=y<2**z:raise HTTPException(422,'MAP_TILE_RANGE')
    url,credentialed=tile_url(provider,layer,z,x,y)
    if not hasattr(request.app.state,'map_tile_semaphore'):request.app.state.map_tile_semaphore=asyncio.Semaphore(8)
    try:
        import anyio
        async with request.app.state.map_tile_semaphore:
            body,kind=await anyio.to_thread.run_sync(fetch_tile,url,credentialed)
    except DemoFailure:raise HTTPException(503,'MAP_DEMO_FAILURE')
    except urllib.error.HTTPError as error:raise HTTPException(404 if error.code==404 else 502,'MAP_UPSTREAM_UNAVAILABLE')
    except Exception:raise HTTPException(502,'MAP_UPSTREAM_UNAVAILABLE')
    return Response(content=body,media_type=kind,headers={'Cache-Control':'private, no-store','X-Map-Provider':provider,'X-Map-Tile':f'{z}/{x}/{y}'})
