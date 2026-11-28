import {GuideEntry} from './InteractiveGuide';
import {ExploreAssistant} from './ExplorationAssistant';
import {InvestigationShelf,type SavedInvestigation} from './InvestigationShelf';
import {findRegionTracks,regionFrom,type GeoPoint,type RegionHit} from './exploreRegion';
import {SmartBookmarks} from './SmartBookmarks';
import {BasemapControls} from './BasemapControls';
import {SpaceControls} from './SpaceControls';
import {lazy,Suspense,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {motion} from 'motion/react';
import {ArrowLeft,ArrowRight,ArrowsOutSimple,CaretRight,CheckCircle,Crosshair,GlobeHemisphereEast,MagnifyingGlass,MapPin,Pause,Play,Broadcast as Satellite,Star,Target,WarningCircle,X,Cloud,Eye} from '@phosphor-icons/react';
import {api} from './api';
import {useRealtime} from './useRealtime';
import {isMobileLayout,useMobileLayout} from './mobileLayout';
import {timeZones,timeZoneOptions,readBasemapPreferences,useDisplaySettings,type TimeZone} from './DisplaySettings';
import {Select} from './components/Select';
const SatellitePreview=lazy(()=>import('./SatellitePreview').then(module=>({default:module.SatellitePreview})));
import {createOrbitScene,type OrbitScene,type SceneData,type Telemetry} from './orbitScene';
import './explore.css';

const qualityNames:Record<string,string>={available:'根数可用',stale:'根数陈旧',very_stale:'根数严重陈旧',future_epoch:'未来历元'};
const liveSceneKey=['explore-scene',null] as const;
const replaySceneKey=['explore-scene',null,'replay'] as const;
function localTime(stamp:number,zone:TimeZone){
 return new Date(stamp+timeZones[zone].offsetHours*3600000).toISOString().slice(0,19);
}
const numeric=(value:unknown,digits=2)=>Number.isFinite(Number(value))&&value!==null&&value!==undefined?Number(value).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
function ErrorMessage({error,retry}:{error:unknown;retry?:()=>void}){return error?<div className="explore-error" role="alert"><WarningCircle size={18}/><div><span>{error instanceof Error?error.message:String(error)}</span>{retry&&<button onClick={retry}>重新尝试</button>}</div></div>:null;}

export function Explore(){
 const cache=useQueryClient(),[params,setParams]=useSearchParams();
 const [systemReduced,setSystemReduced]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches);
 useEffect(()=>{const media=window.matchMedia('(prefers-reduced-motion: reduce)');const changed=()=>setSystemReduced(media.matches);media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);},[]);
 const {timeZone,setTimeZone,lessMotion,setLessMotion}=useDisplaySettings(),reduced=!!systemReduced||lessMotion;
 const selected=Number(params.get('sat')||25544),page=Math.max(1,Number(params.get('page'))||1),group=params.get('group')||'',search=params.get('q')||'';
 const historicalId=params.get('historical'),historicalAt=historicalId?params.get('at'):null;
 const origin=historicalId?new URLSearchParams({run:historicalId}):null;
 for(const field of ['record','start','end']){
  const value=params.get(field);
  if(value)origin?.set(field,value);
 }
 const returnToReport=origin?.has('record')&&<Link className="button" to={'/telemetry?'+origin}>返回调查记录 #{origin.get('record')}</Link>;
 const samplingId=params.get('sampling')||historicalId;
 const replaying=!!samplingId||params.get('mode')==='replay';
 const [globalView,setGlobalView]=useState(false);
 const [showDiagnosis,setShowDiagnosis]=useState(false),[bookmarkRequest,openBookmarks]=useState(0);
 const [undoFilter,setUndoFilter]=useState<Record<string,string>|null>(null);
 const [regionPoints,setRegionPoints]=useState<GeoPoint[]|null>(null),[regionHits,setRegionHits]=useState<RegionHit[]|null>(null);
 const [regionStart,setRegionStart]=useState(''),[regionEnd,setRegionEnd]=useState(''),[regionIssue,setRegionIssue]=useState('');
 const [bounds,setBounds]=useState({south:'',north:'',west:'',east:''});
 const sessionId=params.get('session');
 const savedScene=useQuery({queryKey:['investigation-session',sessionId],enabled:!!sessionId,
  queryFn:()=>api<SavedInvestigation>('/investigation-tools/sessions/'+encodeURIComponent(sessionId!))});
 const restoredView=useRef<string|null>(null);

 const [keyword,setKeyword]=useState(search),[clean,setClean]=useState(false),[clouds,setClouds]=useState(true),[rate,setRate]=useState(1),[playing,setPlaying]=useState(true),[tracking,setTracking]=useState(false);
 const [engine,setEngine]=useState<OrbitScene|null>(null),[engineError,setEngineError]=useState(''),[rebuild,setRebuild]=useState(0),[message,setMessage]=useState('');
 const [timeInput,setTimeInput]=useState<number|null>(null);
 function formatTime(value:string|undefined){
  const stamp=Date.parse(value??'');
  return Number.isFinite(stamp)?localTime(stamp,timeZone).replace('T',' ')+' '+timeZones[timeZone].suffix:'—';
 }
 const [telemetry,setTelemetry]=useState<Telemetry|null>(null),host=useRef<HTMLDivElement>(null);
 const mobile=useMobileLayout();
 const [sheet,setSheet]=useState<'search'|'detail'|'time'|null>(null);
 const [fromSearch,setFromSearch]=useState(false),[showModel,setShowModel]=useState(false);
 const stagePanel=useRef<HTMLElement>(null),dialog=useRef<HTMLDialogElement>(null),sheetTitle=useRef<HTMLHeadingElement>(null);
 const sheetTrigger=useRef<HTMLElement>(null),resultTrigger=useRef<HTMLButtonElement>(null);
 useEffect(()=>{if(!mobile){setSheet(null);setFromSearch(false);setShowModel(false);}},[mobile]);
 useLayoutEffect(()=>{
  const panel=dialog.current;
  if(!panel?.isConnected)return;
  if(!sheet){
   if(panel.open){panel.close();sheetTrigger.current?.focus({preventScroll:true});}
   return;
  }
  if(!panel.open)panel.showModal();
  const searchTarget=sheet==='search'?(resultTrigger.current||panel.querySelector<HTMLInputElement>('.orbit-search input')):null;
  (searchTarget?.isConnected?searchTarget:sheetTitle.current)?.focus({preventScroll:true});
 },[mobile,sheet]);
 const [previewReady,setPreviewReady]=useState(false);
 const replayClock=useRef<{scene:SceneData;time?:string;rate:number;playing:boolean}|null>(null);
 function update(values:Record<string,string>){setParams(previous=>{const p=new URLSearchParams(previous);for(const [key,value]of Object.entries(values))value?p.set(key,value):p.delete(key);return p;},{replace:true});}
 const updateRef=useRef(update);updateRef.current=update;
 const mapSelect=useRef<(id:number)=>void>(()=>{});
 mapSelect.current=id=>{choose(id);if(mobile)openSheet('detail',stagePanel.current);};
 const scene=useQuery<SceneData>({
  refetchInterval:query=>!replaying?Math.max(10000,Date.parse(query.state.data?.end||new Date(Date.now()+600000).toISOString())-Date.now()-60000):false,
  queryKey:historicalId?['historical-scene',historicalId]:samplingId?['explore-scene',samplingId]:replaying?replaySceneKey:liveSceneKey,
  queryFn:({signal})=>api(historicalId?`/telemetry/runs/${encodeURIComponent(historicalId)}/scene`:samplingId?`/sampling/profiles/${encodeURIComponent(samplingId)}/scene`:'/explore/scene',{signal}),
  refetchOnMount:samplingId?'always':!replaying,refetchOnWindowFocus:!replaying,refetchOnReconnect:!replaying,
  staleTime:replaying?Infinity:300000,retry:samplingId?false:undefined,
 });
 const showGlobal=globalView&&!replaying;
 const globalFeed=useQuery({queryKey:['global-overview'],queryFn:({signal})=>api('/explore/global',{signal}),enabled:showGlobal,refetchInterval:showGlobal?20000:false});
 useEffect(()=>{engine?.global(showGlobal?globalFeed.data:null);},[engine,showGlobal,globalFeed.data]);
 const facets=useQuery({queryKey:['catalog-facets'],queryFn:()=>api('/catalog/facets')});
 const country=params.get('country')||'',purpose=params.get('use')||'',orbitFilter=params.get('orbit')||'';
 const directory=useQuery({queryKey:['explore-catalog',search,group,page,country,purpose,orbitFilter],enabled:!samplingId,queryFn:({signal})=>api(`/satellites?page=${page}&size=8&keyword=${encodeURIComponent(search)}${group?'&group='+encodeURIComponent(group):''}&country=${encodeURIComponent(country)}&use=${encodeURIComponent(purpose)}${orbitFilter?'&orbit='+orbitFilter:''}`,{signal})});
 const groups=useQuery({queryKey:['groups'],queryFn:({signal})=>api('/groups',{signal})});
 const details=useQuery({queryKey:['detail',selected],queryFn:({signal})=>api(`/satellites/${selected}`,{signal}),enabled:!historicalId&&Number.isInteger(selected)&&selected>0});
 const trackTime=scene.data&&(replaying?new Date((Date.parse(scene.data.start)+Date.parse(scene.data.end))/2).toISOString():scene.data.generatedAt);
 const trackKey=['explore-trajectory',selected,trackTime,replaying?'replay':'live'];
 const trajectory=useQuery({queryKey:trackKey,queryFn:({signal})=>api(`/explore/satellites/${selected}/trajectory?at=${encodeURIComponent(trackTime!)}`,{signal}),enabled:!samplingId&&!!trackTime&&selected>0,staleTime:replaying?Infinity:300000,refetchOnWindowFocus:!replaying,refetchOnReconnect:!replaying,
  placeholderData:previous=>!replaying&&previous?.data?.noradId===selected?previous:undefined});
 const highlightIds:number[]=undoFilter?(directory.data?.list||[]).slice(0,6).map((item:{noradId:number})=>item.noradId):[];
 const filterTracks=useQuery({
  queryKey:['explore-assistant-highlight',highlightIds,trackTime],
  enabled:!!undoFilter&&!replaying&&!!trackTime&&highlightIds.length>0,
  queryFn:async({signal})=>(await Promise.allSettled(highlightIds.map(id=>api<{data:SceneData['satellites'][number]}>(`/explore/satellites/${id}/trajectory?at=${encodeURIComponent(trackTime!)}`,{signal})))).flatMap(r=>r.status==='fulfilled'?[r.value.data]:[]),
  staleTime:60000,
 });
 useEffect(()=>{engine?.highlightMatches(undoFilter&&!replaying?filterTracks.data||[]:[]);},[engine,undoFilter,replaying,filterTracks.data]);
 const selectedTrack=samplingId?scene.data?.satellites.find(track=>track.noradId===selected):trajectory.data?.data;
 const favorites=useQuery({queryKey:['favorites'],queryFn:()=>api('/favorites')});
 useRealtime(selected,value=>{if(!replaying&&trackTime)cache.setQueryData(trackKey,value);});
 const favoriteIds=new Set<number>(favorites.data?.list.map((x:any)=>x.noradId)||[]),isFavorite=favoriteIds.has(selected);
 const favorite=useMutation({mutationFn:({id,exists}:{id:number;exists:boolean})=>api(exists?`/favorites/${id}`:'/favorites',{method:exists?'DELETE':'POST',body:exists?undefined:JSON.stringify({noradId:id})}),
  onSuccess:()=>{cache.invalidateQueries({queryKey:['favorites']});setMessage('关注列表已保存。');}});
 useEffect(()=>{if(keyword===search)return;const timer=setTimeout(()=>updateRef.current({q:keyword,page:''}),300);return()=>clearTimeout(timer);},[keyword,search]);
 useEffect(()=>{
  let cancelled=false,instance:OrbitScene|null=null;setEngine(null);setEngineError('');
  createOrbitScene(host.current!,{telemetry:data=>{if(cancelled)return;if(replayClock.current){replayClock.current.time=data.time;replayClock.current.playing=data.playing;}setTelemetry(data);setPlaying(data.playing);setTracking(data.tracking);},
   select:id=>mapSelect.current(id),drag:()=>{setTracking(false);setMessage('已退出跟踪，当前为自由视角。');},error:setEngineError},reduced,{fitMobileGlobe:isMobileLayout,basemapPreferences:readBasemapPreferences()})
   .then(value=>{if(cancelled){value.dispose();return;}instance=value;setEngine(value);}).catch(error=>{if(!cancelled)setEngineError(error.message);});
  return()=>{cancelled=true;instance?.dispose();};
 },[rebuild]);
 useEffect(()=>{engine?.setReducedMotion(reduced);},[engine,reduced]);
 useEffect(()=>{
  if(!engine&&!engineError)return;
  const timer=setTimeout(()=>setPreviewReady(true),650);
  return()=>clearTimeout(timer);
 },[engine,engineError]);
 useEffect(()=>{
  if(!engine||!scene.data)return;
  if(replaying){
   const previous=replayClock.current;
   const clock=previous?.scene===scene.data?previous:{scene:scene.data,time:historicalId?params.get('at')||undefined:undefined,rate:1,playing:false};
   replayClock.current=clock;
   engine.overview(scene.data,{...clock,live:false});
   setRate(clock.rate);setPlaying(clock.playing);
  }else{
   replayClock.current=null;
   engine.overview(scene.data,{live:true});
   setRate(1);setPlaying(true);
  }
 },[engine,scene.data,replaying]);
 useEffect(()=>{if(engine&&scene.data&&historicalAt&&engine.seek(historicalAt)){
  engine.play(false);setPlaying(false);
  if(replayClock.current){replayClock.current.time=historicalAt;replayClock.current.playing=false;}
 }},[engine,scene.data,historicalAt]);
 useEffect(()=>{engine?.select(selected);setTracking(false);setTelemetry(null);},[engine,selected]);
 useEffect(()=>{engine?.track(selectedTrack?.noradId===selected?selectedTrack:null);},[engine,selectedTrack,selected,scene.data]);
 useEffect(()=>{
  if(!engine||regionPoints===null)return;
  engine.pickRegion(regionPoints.length<2?p=>setRegionPoints(old=>old&&old.length<2?[...old,p]:old):null);
  engine.drawRegion(regionPoints.length===2?regionFrom(regionPoints[0],regionPoints[1]):null);
  return ()=>{engine.pickRegion(null);engine.drawRegion(null)};
 },[engine,regionPoints]);
 useEffect(()=>{
  const saved=savedScene.data;if(!engine||!scene.data||!saved||restoredView.current===saved.id)return;
  restoredView.current=saved.id;
  const at=new URLSearchParams(saved.query).get('at');
  if(at&&replaying&&engine.seek(at))engine.play(false);
  if(saved.camera)engine.restoreCamera(saved.camera);
 },[engine,scene.data,replaying,savedScene.data]);
 useEffect(()=>{engine?.clouds(clouds);},[engine,clouds]);
 useEffect(()=>{if(!message)return;const timer=setTimeout(()=>setMessage(''),4500);return()=>clearTimeout(timer);},[message]);
 const detail=details.data?.data,orbit=detail?.orbitElements,q=selectedTrack?.dataQuality||detail?.dataQuality;
 const period=orbit?.MEAN_MOTION?1440/Number(orbit.MEAN_MOTION):null;
 const start=Date.parse(scene.data?.start||''),end=Date.parse(scene.data?.end||''),current=Date.parse(telemetry?.time||scene.data?.generatedAt||'');
 const controlsReady=!!engine&&!!scene.data&&!engineError;
 const canTarget=controlsReady&&!!selectedTrack&&!trajectory.error&&telemetry?.valid;
 const globalStatus=globalFeed.data?.delivery==='snapshot'?'历史快照':telemetry?.globalStatus==='ready'?'已覆盖当前时刻':globalFeed.isFetching?'正在加载点位':'等待当前时刻的数据';
 const globalCount=globalFeed.data?.renderedCount?.toLocaleString();
 const globalCatalogCount=globalFeed.data?.catalogCount?.toLocaleString();
 const displayTime=telemetry?.time||(!replaying?scene.data?.generatedAt:undefined);
 const mode=replaying?(telemetry?.atEnd?'回放结束':playing?'播放中':'已暂停'):'跟随当前时刻';
 function choose(id:number){if(id===selected)return;update({sat:String(id)});setMessage('');}
 function chooseFromList(id:number,trigger:HTMLButtonElement){
  choose(id);
  if(mobile){
   if(document.activeElement instanceof HTMLInputElement)document.activeElement.blur();
   resultTrigger.current=trigger;
   setFromSearch(true);
   setSheet('detail');
  }
 }
 function openSheet(next:NonNullable<typeof sheet>,trigger:HTMLElement|null){
  sheetTrigger.current=trigger;
  resultTrigger.current=null;
  setFromSearch(false);
  setSheet(next);
 }
 function closeSheet(focusMap=false){
  if(focusMap)sheetTrigger.current=stagePanel.current;
  setSheet(null);
  setShowModel(false);
 }
 function locate(){
  if(!engine?.locate())setMessage('当前时刻没有有效采样位置。');
  else{setTracking(false);if(mobile)closeSheet(true);}
 }
 function follow(){
  const following=engine?.follow()||false;
  setTracking(following);
  if(following&&mobile)closeSheet(true);
 }
 function seek(value:string){if(engine?.seek(value)){engine.play(false);setPlaying(false);if(replayClock.current){replayClock.current.time=value;replayClock.current.playing=false;}}else setMessage('请选择回放范围内的时间。');}
 function enterReplay(){if(replaying)return;if(scene.data)cache.setQueryData(replaySceneKey,scene.data);update({mode:'replay'});}
 function enterLive(){if(!replaying)return;update({sampling:'',historical:'',at:'',mode:''});}
 const selectedName=detail?.name||directory.data?.list.find((row:any)=>row.noradId===selected)?.name||scene.data?.satellites.find(row=>row.noradId===selected)?.name||`NORAD ${selected}`;
 const metadata=[['国家 / 组织',detail?.owner||'未知'],['发射日期',detail?.launchDate||'未知'],['轨道周期',period?numeric(period)+' min':'未知'],['轨道倾角',orbit?numeric(orbit.INCLINATION)+'°':'未知'],['偏心率',orbit?numeric(orbit.ECCENTRICITY,5):'未知'],['对象类型',detail?.objectType||'未知']];
 const directoryTotal=(samplingId?scene.data?.satellites.length:directory.data?.total)?.toLocaleString()??'—';
 const directoryPanel=<aside className="orbit-panel orbit-directory" aria-label={samplingId?"方案卫星":"卫星目录"}>
   {!mobile&&<div className="orbit-panel-title"><div><h1>{samplingId?"方案卫星":"卫星"}</h1></div><span className="directory-total">{directoryTotal} 颗</span></div>}
   {samplingId?<div className="orbit-list" aria-busy={scene.isFetching}>
    {scene.data?.satellites.map(item=><div key={item.noradId} className={`orbit-row ${item.noradId===selected?'is-selected':''}`}>
     <button className="orbit-row-main" aria-pressed={item.noradId===selected} aria-label={`选择 ${item.name}`} onClick={event=>chooseFromList(item.noradId,event.currentTarget)}><Satellite size={19} weight="light"/><span><strong>{item.name}</strong><small>NORAD {item.noradId}</small></span></button>
    </div>)}
    {scene.isPending&&<p className="orbit-empty">正在加载方案轨迹…</p>}
    {scene.data?.satellites.length===0&&<p className="orbit-empty">方案中没有可绘制的轨迹。</p>}
   </div>:<>
   <form className="orbit-search" onSubmit={e=>{e.preventDefault();update({q:keyword,page:''});}}><MagnifyingGlass size={18}/><input aria-label="搜索卫星" placeholder="名称 / NORAD 编号" value={keyword} onChange={e=>setKeyword(e.target.value)}/>{keyword&&<button type="button" aria-label="清空搜索" onClick={()=>{setKeyword('');update({q:'',page:''});}}><X size={16}/></button>}</form>
   <div className="orbit-filter"><label htmlFor="orbit-group">目录分组</label><Select id="orbit-group" label="目录分组" value={group} onChange={value=>update({group:value,page:''})} options={[{value:'',label:'全部公开活跃目录'},...(groups.data?.list||[]).map((row:any)=>({value:row.slug,label:row.name}))]}/></div>
   <details className="catalog-extra-filters"><summary>更多筛选</summary>{([['country','国家 / 组织','countries'],['use','用途','purposes'],['orbit','轨道类型','orbits']] as const).map(([key,label,list])=><label key={key}>{label}<Select label={label} value={params.get(key)||''} onChange={value=>update({[key]:value,page:''})} options={[{value:'',label:'全部'},...(facets.data?.data[list]||[]).map((row:any)=>({value:row.value,label:row.value==='unknown'?'未知':row.value,description:`${row.count.toLocaleString()} 颗`}))]}/></label>)}</details>
   <ErrorMessage error={directory.error||groups.error} retry={()=>{directory.refetch();groups.refetch();}}/>
   <div className="orbit-list" aria-busy={directory.isFetching}>{directory.isPending?<div className="orbit-empty">正在检索目录…</div>:directory.data?.list.map((item:any)=><div key={item.noradId} className={`orbit-row ${item.noradId===selected?'is-selected':''}`}>
    <button className="orbit-row-main" aria-pressed={item.noradId===selected} aria-label={`选择 ${item.name}`} onClick={event=>chooseFromList(item.noradId,event.currentTarget)}><Satellite size={19} weight="light"/><span><strong>{item.name}</strong><small>NORAD {item.noradId} <i/> {item.owner||'归属未知'}</small></span></button>
    <button className={`orbit-star ${favoriteIds.has(item.noradId)?'saved':''}`} aria-label={`${favoriteIds.has(item.noradId)?'取消关注':'关注'} ${item.name}`} disabled={favorite.isPending} onClick={()=>favorite.mutate({id:item.noradId,exists:favoriteIds.has(item.noradId)})}><Star size={18} weight={favoriteIds.has(item.noradId)?'fill':'regular'}/></button>
   </div>)}{directory.data?.total===0&&<div className="orbit-empty"><MagnifyingGlass size={25}/><b>未找到匹配的卫星</b><p>试试 ISS、北斗分组或 NORAD 编号。</p></div>}</div>
   {(!mobile||page>1||(directory.data?.total||0)>8)&&<div className="orbit-pagination"><button aria-label="上一页卫星" disabled={page<=1||directory.isFetching} onClick={()=>update({page:String(page-1)})}><ArrowLeft size={17}/></button><span>{page} / {Math.max(1,Math.ceil((directory.data?.total||0)/8))}</span><button aria-label="下一页卫星" disabled={page*8>=(directory.data?.total||0)||directory.isFetching} onClick={()=>update({page:String(page+1)})}><ArrowRight size={17}/></button></div>}
   </>}
  </aside>;
 const satellitePreview=<div className="satellite-preview-slot" aria-busy={!previewReady}>
     {previewReady?<Suspense fallback={<div className="satellite-preview"><span className="model-feedback">模型加载中…</span></div>}><SatellitePreview reduced={reduced}/></Suspense>:<div className="satellite-preview"/>}
    </div>;
 const satelliteActions=<div className="satellite-actions"><div className="target-actions"><button disabled={!canTarget} onClick={locate}><Crosshair size={18}/>定位</button><button className={tracking?'following':'primary'} disabled={!canTarget} onClick={follow}><Target size={18}/>{tracking?'退出跟踪':'持续跟踪'}</button></div>
   <div className="satellite-secondary-actions"><Link className="button observation-entry" to={`/observations?sat=${selected}`}><Eye size={17}/>预测过境</Link>
   <button className={`detail-favorite ${isFavorite?'is-saved':''}`} disabled={favorite.isPending||favorites.isPending||!!favorites.error} onClick={()=>favorite.mutate({id:selected,exists:isFavorite})}><Star size={17} weight={isFavorite?'fill':'regular'}/>{favorite.isPending?'正在保存…':isFavorite?'已加入关注':'关注卫星'}</button></div></div>;
 const orbitFacts=<dl className="orbit-facts">{metadata.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
 const detailPanel=<aside className="orbit-panel orbit-detail" aria-label="卫星详情">
   <div className="satellite-identity">{!mobile&&satellitePreview}<span className="norad-label">NORAD {selected}</span><h2>{selectedName}</h2><span className={`orbit-quality ${q?.state||''}`}>{q?.state==='available'?<CheckCircle size={14}/>:<WarningCircle size={14}/>} {qualityNames[q?.state]||'等待数据'}</span></div>
   <ErrorMessage error={details.error} retry={()=>details.refetch()}/><ErrorMessage error={trajectory.error} retry={()=>trajectory.refetch()}/>
   {detail&&<>{mobile&&satelliteActions}<div className="live-parameters"><div><span>推算高度</span><strong data-testid="altitude">{telemetry?.valid?numeric(telemetry.alt,1):'—'}<small> km</small></strong></div><div><span>轨道速度</span><strong>{telemetry?.valid?numeric(telemetry.speed):'—'}<small> km/s</small></strong></div></div>
   <div className="position-strip"><MapPin size={15}/><span>{telemetry?.valid?`${numeric(Math.abs(telemetry.lat!))}° ${telemetry.lat!>=0?'N':'S'} / ${numeric(Math.abs(telemetry.lng!))}° ${telemetry.lng!>=0?'E':'W'}`:'等待当前时刻的有效位置'}</span></div>
   {!mobile&&satelliteActions}
   <ErrorMessage error={favorite.error||favorites.error} retry={()=>favorites.refetch()}/>
   {mobile?<details className="mobile-orbit-facts"><summary>轨道参数</summary>{orbitFacts}</details>:orbitFacts}
   {mobile&&<details className="mobile-orbit-model" onToggle={event=>setShowModel(event.currentTarget.open)}><summary>三维模型</summary>{showModel&&satellitePreview}</details>}
   <details className="detail-provenance"><summary>数据来源</summary><div className="provenance"><span>根数历元</span><time>{formatTime(q?.epoch)}</time><span>采集时间</span><time>{formatTime(q?.fetchedAt)}</time><p>三维模型：通用示意，并非所选卫星的真实外形或姿态。<br/>模型来源见预览区“来源”</p><p>来源：{q?.source||'CelesTrak'}<br/>位置由 SGP4 推算，不是卫星实时遥测。</p>{q?.state!=='available'&&<p className="provenance-warning">根数时效存在限制，请结合历元理解推算结果。</p>}</div></details></>}
   {trajectory.isFetching&&<p className="sample-note">正在计算所选卫星轨迹…</p>}
   {samplingId&&scene.data&&!selectedTrack&&<p className="scene-warning">当前方案没有这颗卫星的有效轨迹。</p>}{trajectory.data&&telemetry&&!telemetry.valid&&<div className="explore-error"><WarningCircle size={18}/>此时刻没有该卫星的轨迹点。</div>}
  </aside>;
 const modeButtons=<div className="timebar-modes animated-segments" role="group" aria-label="显示模式">
    <button type="button" aria-pressed={!replaying} onClick={enterLive}>实时态势</button>
    <button type="button" aria-pressed={replaying} onClick={enterReplay}>轨迹回放</button>
   </div>;
 const timeDescription=<div className="timebar-description">
    <strong>{replaying?(scene.data?.profileName||'默认轨迹回放'):showGlobal?'全球点位':'代表卫星'}</strong>
    <span>{replaying?(historicalId?'历史遥测 · 按同期归档根数推算':samplingId?'方案内卫星 · 按最新可用根数推算':'代表卫星与所选卫星 · 按公开根数推算'):showGlobal?`${globalCount?`${globalCount} / ${globalCatalogCount??'—'} 颗 · `:''}${globalStatus} · 按公开根数推算`:'代表卫星与所选卫星的位置 · 按公开根数推算'}</span>
   </div>;
 const clock=<div className="clock-display"><span className={replaying?'simulation-mode':'current-mode'}>{mode}</span><time dateTime={displayTime}>{formatTime(displayTime)}</time></div>;
 const replayControls=<div className="timebar-replay">
    <button className="play-control" aria-label={telemetry?.atEnd?'重新播放轨道':playing?'暂停轨道':'播放轨道'} disabled={!controlsReady}
     onClick={()=>{
      if(telemetry?.atEnd&&scene.data)seek(scene.data.start);
      const next=!!telemetry?.atEnd||!playing;
      engine?.play(next);setPlaying(next);
      if(replayClock.current)replayClock.current.playing=next;
     }}>{playing?<Pause size={19} weight="fill"/>:<Play size={19} weight="fill"/>}</button>
    <div className="timebar-timeline">
     <div className="timeline-labels"><span>{formatTime(scene.data?.start)}</span><span>{formatTime(scene.data?.end)}</span></div>
     {mobile&&<button type="button" className="mobile-replay-time" aria-label="定位回放时间" aria-haspopup="dialog" onClick={event=>openSheet('time',event.currentTarget)}><time dateTime={displayTime}>{formatTime(displayTime)}</time></button>}
     <input type="range" aria-label="采样时间轴" min={Number.isFinite(start)?start:0} max={Number.isFinite(end)?end:1} step={1000}
      value={Number.isFinite(current)&&Number.isFinite(start)&&Number.isFinite(end)?Math.max(start,Math.min(end,current)):0} disabled={!controlsReady}
      onKeyDown={event=>{if(scene.data&&(event.key==='End'||event.key==='Home')){event.preventDefault();seek(event.key==='End'?scene.data.end:scene.data.start);}}}
      onChange={event=>seek(new Date(Number(event.target.value)).toISOString())}/>
    </div>
    <select aria-label="轨道播放倍率" value={rate} disabled={!controlsReady}
     onChange={event=>{const value=Number(event.target.value);setRate(value);engine?.rate(value);if(replayClock.current)replayClock.current.rate=value;}}>
     {[1,10,30,60].map(n=><option key={n} value={n}>{n}×</option>)}
    </select>
   </div>;
 const liveActions=<div className="timebar-live-actions">
    <button type="button" aria-pressed={showGlobal} onClick={()=>setGlobalView(value=>!value)}><GlobeHemisphereEast size={17}/> 全球总览</button>
   </div>;
 const exactTimeTool=<details name="explore-time-tools"><summary>精确时间</summary><form onSubmit={event=>{event.preventDefault();if(timeInput!==null)seek(new Date(timeInput).toISOString());}}>
     <label htmlFor="exact-time">指定时间 · {timeZones[timeZone].label}</label>
     <input id="exact-time" type="datetime-local" step="1" value={timeInput===null?'':localTime(timeInput,timeZone)}
      onChange={event=>{const stamp=Date.parse(event.target.value+timeZones[timeZone].isoOffset);setTimeInput(Number.isFinite(stamp)?stamp:null);}} required/>
     <button disabled={!controlsReady}>定位时间</button>
    </form></details>;
 const timeTools=<div className="timebar-tools" role="group" aria-label="时间工具">
  {undoFilter&&<button onClick={()=>{setKeyword(undoFilter.q);update(undoFilter);setUndoFilter(null)}}>撤销 AI 筛选</button>}
  <Link to="/sampling">{samplingId?'管理本方案':'自定义采样'}</Link>
  <label className="timebar-zone"><span>时区</span><select aria-label="显示时区" value={timeZone} onChange={event=>setTimeZone(event.target.value as TimeZone)}>
   {timeZoneOptions.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}
  </select></label>
  {replaying&&exactTimeTool}
  <label><input type="checkbox" checked={reduced} disabled={!!systemReduced} onChange={event=>setLessMotion(event.target.checked)}/>减少动态效果{systemReduced?'（系统）':''}</label>
 </div>;
 function applyAssistant(q:string,newGroup:string){
  setUndoFilter({q:search,group,page:String(page),country,use:purpose,orbit:orbitFilter,mode:params.get('mode')||'',sampling:params.get('sampling')||'',historical:historicalId||'',at:historicalAt||''});
  const keyword=q==='北斗三号'?'BEIDOU-3':q||({galileo:'GALILEO','gps-ops':'NAVSTAR'} as Record<string,string>)[newGroup]||'';
  setKeyword(keyword);
  update({q:keyword,group:['stations','beidou'].includes(newGroup)?newGroup:'',page:'1',country:'',use:'',orbit:'',sampling:'',historical:'',mode:'',at:''});
  if(mobile)openSheet('search',stagePanel.current);
 }
 function runRegion(lastTwoHours=false){
  if(!scene.data||!engine||!regionPoints||regionPoints.length!==2)return;
  const finish=lastTwoHours?Date.parse(displayTime||scene.data.end):regionEnd?Date.parse(regionEnd):Date.parse(scene.data.end);
  const begin=lastTwoHours?finish-7200000:regionStart?Date.parse(regionStart):Date.parse(scene.data.start);
  if(lastTwoHours&&Number.isFinite(finish)){setRegionStart(new Date(begin).toISOString());setRegionEnd(new Date(finish).toISOString())}
  if(!Number.isFinite(begin)||!Number.isFinite(finish)||begin>=finish||begin<Date.parse(scene.data.start)||finish>Date.parse(scene.data.end)){
   setRegionIssue('所选时段超出当前场景可用轨迹。请使用覆盖该时段的历史回放。');setRegionHits(null);return;
  }
  setRegionIssue('');setRegionHits(findRegionTracks(scene.data,regionFrom(regionPoints[0],regionPoints[1]),begin,finish,engine.groundPoint));
 }
 const assistantActions=<div className="ai-home-actions">
  <GuideEntry className="explore-guide-entry"/><ExploreAssistant selected={selected} apply={applyAssistant} locate={(norad,station)=>{choose(norad);engine?.locateGround(station.lng,station.lat)}}
   bookmarks={()=>openBookmarks(n=>n+1)} diagnose={()=>setShowDiagnosis(true)}/>
  <SmartBookmarks start={scene.data?.start} end={scene.data?.end} formatTime={formatTime} requestOpen={bookmarkRequest}/>
  <button type="button" disabled={!engine||!scene.data} aria-expanded={regionPoints!==null} onClick={()=>{setRegionPoints(regionPoints===null?[]:null);setRegionHits(null);setRegionIssue('')}}>圈选地图</button>
  <button type="button" aria-expanded={showDiagnosis} onClick={()=>setShowDiagnosis(!showDiagnosis)}>画面诊断</button>
 </div>;
 const regionPanel=regionPoints!==null&&<div className="ai-home-notice ai-region-panel">
  <strong>区域轨迹调查</strong><p aria-live="polite">{regionPoints.length<2?'点击地球上区域的两个对角点（'+regionPoints.length+'/2）':'已选矩形区域，检测地面投影是否进入。'}</p>
  <details><summary>手动输入经纬度</summary><form onSubmit={event=>{
   event.preventDefault();
   setRegionPoints([{lat:Number(bounds.south),lng:Number(bounds.west)},{lat:Number(bounds.north),lng:Number(bounds.east)}]);
   setRegionHits(null);setRegionIssue('');
  }}><div className="ai-field-grid">{([['south','南纬界'],['north','北纬界'],['west','西经界'],['east','东经界']] as const).map(([key,label])=>
   <label key={key}>{label}<input type="number" value={bounds[key]} step="any" required min={key==='south'||key==='north'?-90:-180}
    max={key==='south'||key==='north'?90:180} onChange={e=>setBounds({...bounds,[key]:e.target.value})}/></label>)}</div>
   <button>应用坐标区域</button></form></details>
  <div className="ai-field-grid"><label>起点（带时区）<input value={regionStart} onChange={e=>{setRegionStart(e.target.value);setRegionHits(null)}} placeholder={scene.data?.start}/></label>
   <label>终点（带时区）<input value={regionEnd} onChange={e=>{setRegionEnd(e.target.value);setRegionHits(null)}} placeholder={scene.data?.end}/></label></div>
  <div className="investigation-actions"><button disabled={regionPoints.length!==2} onClick={()=>runRegion()}>查找经过区域的卫星</button>
   <button disabled={regionPoints.length!==2} onClick={()=>runRegion(true)}>查过去两小时</button><button onClick={()=>{setRegionPoints([]);setRegionHits(null)}}>重选区域</button><button onClick={()=>setRegionPoints(null)}>关闭</button></div>
  {regionIssue&&<p role="alert">{regionIssue}</p>}
  {regionHits&&<><p>仅检查当前场景中 {scene.data?.satellites.length??0} 条可用轨迹。时间为采样边界，可能漏掉采样间经过。</p>
   {!regionHits.length&&<p>可用轨迹没有发现进入区域的采样点。</p>}<ul>{regionHits.slice(0,12).map(hit=><li key={hit.norad+hit.entry}>
    <strong>{hit.name}</strong> {formatTime(hit.entry)}{hit.entryClipped?'（起点已在区域）':''} 至 {formatTime(hit.exit)}{hit.exitClipped?'（终点仍在区域）':''}
    <button onClick={()=>{choose(hit.norad);if(replaying)seek(hit.entry)}}>定位卫星</button>
   </li>)}</ul></>}
 </div>;
 const diagnosisPanel=showDiagnosis&&regionPoints===null&&<div className="ai-home-notice">
  <strong>当前画面诊断 · NORAD {selected}</strong>
  {scene.error?<p>轨迹加载失败。可以重试或返回实时态势。</p>:scene.isPending?<p>场景正在载入，待轨迹返回后才能判断覆盖。</p>
   :replaying&&!selectedTrack?<p>当前回放数据没有这颗卫星的轨迹。</p>
   :telemetry?.valid===false?<p>当前时刻没有所选卫星的有效轨迹点。</p>
   :<p>若找不到标记，请检查相机视野和目录筛选。当前场景{showGlobal?'显示全球总览':'使用代表卫星或所选轨迹'}。</p>}
  {undoFilter&&<p>已定位当前结果页中最多 6 颗具有可用轨迹的匹配卫星。</p>}{(search||group||country||purpose||orbitFilter)&&<p>筛选生效：{[search,group,country,purpose,orbitFilter].filter(Boolean).join(' / ')}</p>}
  <div className="investigation-actions">
   <button onClick={()=>{setKeyword('');update({q:'',group:'',page:'1',country:'',use:'',orbit:''})}}>清除筛选</button>
   {replaying&&selectedTrack&&<button onClick={()=>seek(selectedTrack.start)}>回到轨迹起点</button>}
   {replaying&&<button onClick={enterLive}>返回实时态势</button>}
   {scene.error&&<button onClick={()=>scene.refetch()}>重试轨迹</button>}
   <button onClick={()=>setShowDiagnosis(false)}>关闭</button>
  </div>
 </div>;
 const shelf=<InvestigationShelf capture={()=>{const snapshot=new URLSearchParams(params);
  snapshot.delete('session');
  if(replaying&&displayTime)snapshot.set('at',displayTime);
  return {path:'/explore',query:snapshot.toString(),camera:engine?.cameraState(),report:historicalId||undefined};
 }}/>;
 const toast=<motion.div className="orbit-toast" role="status" aria-live="polite" initial={false} animate={{opacity:message?1:0,y:message||reduced?0:8}} transition={{duration:reduced?0:.16}}>{message}</motion.div>;
 return <main className={`explorer ${clean?'clean-view':''} ${mobile?'mobile-explorer':''} ${reduced?'explorer-reduced':''}`} aria-label="卫星探索工作台">
  {!mobile&&directoryPanel}
  <section className="orbital-stage" ref={stagePanel} tabIndex={-1} aria-label="地球与轨道">
   <div className="orbit-globe" ref={host} aria-label="可旋转的三维地球"><div className="globe-credits"/></div>
   {!mobile&&!clean&&<div className="investigation-globe-entry">{assistantActions}</div>}
   {engine&&scene.isPending&&<div className="scene-status" role="status">正在加载卫星轨迹</div>}
   <BasemapControls map={engine?.basemap} showControls={false}/><SpaceControls engine={engine}/><div className="globe-tools"><button aria-label="全球视角" title="全球视角" disabled={!controlsReady} onClick={()=>{engine?.home();setTracking(false);setMessage('已恢复全球视角。');}}><GlobeHemisphereEast size={21}/></button><button aria-label="切换云层" title="历史合成云层" aria-pressed={clouds} disabled={!engine} onClick={()=>setClouds(!clouds)}><Cloud size={21}/></button><button aria-label="纯净视图" title="纯净视图" aria-pressed={clean} onClick={()=>setClean(!clean)}><ArrowsOutSimple size={21}/></button></div>
   {tracking&&<div className="tracking-pill"><Target size={16}/>正在跟踪 {detail?.name||selected}<button onClick={()=>{engine?.follow();setTracking(false);}}>退出跟踪</button></div>}
   {regionPanel}{diagnosisPanel}
   <div className="stage-legend"><span><i className="legend-line amber"/>空间轨迹（地固系）</span><span><i className="legend-line dashed"/>地面投影</span><span><i className="legend-point"/>公开卫星</span></div>
   <div className="stage-messages">{showGlobal&&globalFeed.data&&telemetry?.globalStatus==='outside'&&<p className="scene-warning">当前时刻的全球点位暂不可用，正在等待下一批推算。</p>}{showGlobal&&<ErrorMessage error={globalFeed.error} retry={()=>globalFeed.refetch()}/>}{showGlobal&&globalFeed.data?.delivery==='snapshot'&&<p className="scene-warning">数据库暂不可用，显示 {formatTime(globalFeed.data.generatedAt)} 的历史快照，区间外不绘制点位。</p>}<ErrorMessage error={engineError} retry={()=>setRebuild(v=>v+1)}/><ErrorMessage error={scene.error} retry={()=>scene.refetch()}/>{samplingId&&scene.error&&<Link className="button" to="/sampling">返回采样管理</Link>}{scene.data?.failed.length!>0&&<p className="scene-warning">{scene.data?.failed.length} 颗卫星暂无法推算，未绘制。</p>}</div>
   {mobile&&!sheet&&toast}
  </section>

  {mobile?<>
   {!clean&&<section className="mobile-explore-deck" aria-label="地图操作">
    <div className="mobile-satellite-actions">
     <button type="button" className="mobile-satellite-search" aria-haspopup="dialog" onClick={event=>openSheet('search',event.currentTarget)}><MagnifyingGlass size={19}/>找卫星</button>
     <button type="button" className="mobile-selected-satellite" aria-label="所选卫星" aria-haspopup="dialog" onClick={event=>openSheet('detail',event.currentTarget)}><Satellite size={18}/><span>{selectedName}</span><small>详情</small><CaretRight size={14}/></button>
    </div>
    <div className="mobile-map-modes">
     {modeButtons}
     {!replaying&&liveActions}
     {assistantActions}
    </div>
    {shelf}
    {returnToReport}
    {replaying?replayControls:<div className="mobile-live-time"><span>实时 <time dateTime={displayTime}>{formatTime(displayTime)}</time></span></div>}
   </section>}
   <dialog className="mobile-explore-sheet" ref={dialog} data-sheet={sheet||undefined} aria-labelledby="mobile-explore-sheet-title"
    onClose={event=>{if(!event.currentTarget.open&&sheet)closeSheet();}} onCancel={event=>{event.preventDefault();closeSheet();}} onClick={event=>{if(event.target===event.currentTarget)closeSheet();}}>
    <header>
     {sheet==='detail'&&fromSearch&&<button type="button" aria-label="返回找卫星" onClick={()=>{setShowModel(false);setSheet('search');}}><ArrowLeft size={21}/></button>}
     <h2 id="mobile-explore-sheet-title" ref={sheetTitle} tabIndex={-1}>{sheet==='search'?(samplingId?'方案卫星':'找卫星'):sheet==='detail'?'卫星详情':'时间与数据'}</h2>
     {sheet==='search'&&<span className="directory-total">{directoryTotal} 颗</span>}
     <button type="button" aria-label="关闭面板" onClick={()=>closeSheet()}><X size={21}/></button>
    </header>
    <div className="mobile-search-pane" hidden={sheet!=='search'}>{directoryPanel}</div>
    {sheet==='detail'&&detailPanel}
    {sheet==='time'&&<section className="mobile-time-pane">{timeDescription}{clock}{replaying&&<p className="mobile-replay-bounds">回放范围<br/>{formatTime(scene.data?.start)}<br/>{formatTime(scene.data?.end)}</p>}<div className="timebar-tools">{replaying&&exactTimeTool}</div></section>}
    {sheet&&message&&<p className="mobile-sheet-status" role="status">{message}</p>}
   </dialog>
  </>:<>
   {detailPanel}
   <section className={`orbit-timebar ${replaying?'is-replay':'is-live'}`} aria-label="轨道时间控制">
   {modeButtons}
   {timeDescription}
   {clock}
   {replaying?replayControls:liveActions}
   <div className="timebar-secondary">
    <span className="timebar-use">{replaying?'拖动时间轴或选择倍率播放。全球总览在实时态势中查看。':'查看当前点位。拖动时间或倍速播放请切到轨迹回放。'}</span>
    {returnToReport}{timeTools}{shelf}
   </div>
  </section>
  </>}
  {clean&&<button className="restore-panels" onClick={()=>setClean(false)}><Eye size={18}/>恢复面板</button>}
  {!mobile&&toast}
 </main>;
}
