import {GuideEntry,useInteractiveGuide} from './InteractiveGuide';
import {VerificationBrief} from './InvestigationEvidence';
import {ObservationComparison} from './ExplorationAssistant';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useLocation,useSearchParams} from 'react-router-dom';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {MapPin,Plus,PencilSimple,Trash,Star,X,ArrowRight,WarningCircle} from '@phosphor-icons/react';
import {api} from './api';
import {Select} from './components/Select';
import {useReplay,ReplayControls} from './useReplay';
import {PlanDialog} from './PlanDialog';
import {ObservationMap} from './ObservationMap';
import {useMobileLayout} from './mobileLayout';
import {readTimeZone} from './DisplaySettings';
import './observations.css';

const statusNames:Record<string,string>={queued:'排队中',running:'计算中',cancelling:'正在取消',cancelled:'已取消',completed:'已完成',failed:'计算失败'};
const active=(status?:string)=>['queued','running','cancelling'].includes(status||'');
const localInput=(iso:string,zone:string)=>new Date(Date.parse(iso)+(zone==='sh'?8:0)*3600000).toISOString().slice(0,16);
const toISO=(input:string,zone:string)=>new Date(input+(zone==='sh'?'+08:00':'Z')).toISOString();
const time=(iso:string,zone:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:zone==='sh'?'Asia/Shanghai':'UTC',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(iso));
function ErrorBox({error}:{error:unknown}){return error?<div className="notice error" role="alert"><WarningCircle size={18}/>{error instanceof Error?error.message:'操作失败，请重试'}</div>:null;}

function StationEditor({station,onClose,onSaved}:{station?:any;onClose:()=>void;onSaved:(id:string)=>void}){
 const cache=useQueryClient(),dialog=useRef<HTMLDialogElement>(null),returnFocus=useRef(document.activeElement as HTMLElement|null);
 const initial={name:station?.name||'',latitude:station?.latitude??39.9,longitude:station?.longitude??116.4,elevation_m:station?.elevation_m??0,is_default:station?.is_default??false};
 const [form,setForm]=useState(initial),[pick,setPick]=useState(false);const dirty=JSON.stringify(form)!==JSON.stringify(initial);
 const save=useMutation({mutationFn:()=>api(station?`/stations/${station.id}`:'/stations',{method:station?'PATCH':'POST',body:JSON.stringify(form)}),onSuccess:result=>{cache.invalidateQueries({queryKey:['stations']});onSaved(result.data.id);}});
 function close(){if(save.isPending)return;if(!dirty||window.confirm('放弃尚未保存的站点更改？'))onClose();}
 useEffect(()=>{const previous=document.body.style.overflow;document.body.style.overflow='hidden';dialog.current?.showModal();dialog.current?.querySelector<HTMLInputElement>('#obs-name')?.focus();return()=>{dialog.current?.close();document.body.style.overflow=previous;if(returnFocus.current?.isConnected)returnFocus.current.focus();};},[]);
 function field(key:string,value:any){setForm(f=>({...f,[key]:value}));}
 return <dialog ref={dialog} className="station-dialog" onCancel={e=>{e.preventDefault();close();}} aria-labelledby="station-dialog-title"><div className="section-heading"><h2 id="station-dialog-title">{station?'编辑观测站':'新建观测站'}</h2><button type="button" aria-label="关闭观测站编辑" onClick={close}><X/></button></div>
 <form onSubmit={e=>{e.preventDefault();save.mutate();}}><div className="station-editor-grid"><div><label htmlFor="obs-name">名称</label><input autoFocus id="obs-name" value={form.name} required maxLength={80} onChange={e=>field('name',e.target.value)}/><div className="coordinate-fields">{[['latitude','纬度 °',-90,90],['longitude','经度 °',-180,180]].map(([key,label,min,max])=><div key={key}><label htmlFor={'obs-'+key}>{label}</label><input id={'obs-'+key} type="number" step="any" required min={Number(min)} max={Number(max)} value={(form as any)[key]} onChange={e=>field(String(key),e.target.value===''?'':Number(e.target.value))}/></div>)}</div><label htmlFor="obs-height">海拔 m</label><input id="obs-height" type="number" min={-500} max={10000} step="any" required value={form.elevation_m} onChange={e=>field('elevation_m',e.target.value===''?'':Number(e.target.value))}/><label className="checkbox-label"><input type="checkbox" checked={form.is_default} disabled={station?.is_default} onChange={e=>field('is_default',e.target.checked)}/>设为默认观测站</label></div><div className="station-pick"><button type="button" onClick={()=>setPick(!pick)}><MapPin/>{pick?'退出选点':'地图选点'}</button><ObservationMap pick={pick} station={Number.isFinite(form.latitude)&&Number.isFinite(form.longitude)?form:null} onPick={(lat,lng)=>setForm(f=>({...f,latitude:Number(lat.toFixed(6)),longitude:Number(lng.toFixed(6))}))}/></div></div><ErrorBox error={save.error}/><div className="dialog-actions"><button type="button" disabled={save.isPending} onClick={close}>取消</button><button className="primary" disabled={save.isPending}>{save.isPending?'保存中…':'保存观测站'}</button></div></form></dialog>;
}

function ElevationCurve({event,minimum,zone,cursor,sampled=false}:{event:any;minimum:number;zone:string;cursor?:number;sampled?:boolean}){
 const host=useRef<HTMLDivElement>(null),[width,setWidth]=useState(740);
 useEffect(()=>{const observer=new ResizeObserver(entries=>setWidth(Math.max(260,Math.min(1000,Math.round(entries[0].contentRect.width)))));if(host.current)observer.observe(host.current);return()=>observer.disconnect();},[]);
 const rows=event.curve as any[],start=Date.parse(event.start),duration=Date.parse(event.end)-start;
 const [hover,setHover]=useState<number|null>(null);useEffect(()=>setHover(null),[event.id,event.start]);
 const x=(iso:string)=>52+(Date.parse(iso)-start)/Math.max(1,duration)*(width-90),y=(alt:number)=>210-(alt-(sampled?-90:0))/(sampled?180:90)*170;
 const picked=rows[hover??Math.floor(rows.length/2)];
 return <div className="elevation-chart" ref={host}><svg data-clock-time={cursor} viewBox={`0 0 ${width} 265`} role="img" aria-label={`仰角曲线，最高 ${event.max_elevation.toFixed(1)} 度，横轴为时间，纵轴为仰角度数`} onPointerMove={e=>{const rect=e.currentTarget.getBoundingClientRect(),fraction=Math.max(0,Math.min(1,((e.clientX-rect.left)/rect.width*width-52)/(width-90)));setHover(Math.round(fraction*(rows.length-1)));}} onPointerLeave={()=>setHover(null)}>
  {(sampled?[-90,-45,0,45,90]:[0,30,60,90]).map(a=><g key={a}><line x1={52} x2={width-38} y1={y(a)} y2={y(a)} stroke="#294054"/><text x={42} y={y(a)+4} textAnchor="end">{a}°</text></g>)}
  {event.visible_windows.map((w:any,i:number)=><rect key={i} x={Math.max(52,Math.min(width-38,x(w.start)))} y={40} width={Math.max(0,Math.min(width-38,x(w.end))-Math.max(52,x(w.start)))} height={170} fill="#56c8a0" opacity=".16"/>)}
  <line x1={52} x2={width-38} y1={y(minimum)} y2={y(minimum)} stroke="#ffc56b" strokeDasharray="5 4"/>
  <path d={rows.map((r,i)=>`${i?'L':'M'}${x(r[0]).toFixed(2)},${y(r[1]).toFixed(2)}`).join(' ')} fill="none" stroke="#69c5ff" strokeWidth={2.5}/>
  {[event.start,new Date(start+duration/2).toISOString(),event.end].map((t,i)=><text key={i} display={i===1&&width<480?'none':undefined} x={x(t)} y={237} textAnchor={i===0?'start':i===2?'end':'middle'}>{time(t,zone).split(' ')[1]}</text>)}
  {cursor!==undefined&&<line x1={x(new Date(cursor).toISOString())} x2={x(new Date(cursor).toISOString())} y1={40} y2={210} stroke="#ffc56b" strokeWidth={1.5}/>}
  {hover!==null&&<><line x1={x(picked[0])} x2={x(picked[0])} y1={40} y2={210} stroke="#daeafa" strokeDasharray="3 3"/><circle cx={x(picked[0])} cy={y(picked[1])} r={4} fill="#fff"/></>}
 </svg><div className="curve-legend"><span>仰角 °</span><span>最低仰角 {minimum}°</span><span>绿色区间：潜在目视窗口</span></div><p className="muted">{sampled?'窗口采样最高仰角':'最高仰角'} {event.max_elevation.toFixed(2)}°，出现在 {time(event.peak,zone)}。{hover!==null&&` 当前 ${time(picked[0],zone)}：${picked[1].toFixed(2)}°。`}</p></div>;
}

export function Observations(){
 const cache=useQueryClient(),[params,setParams]=useSearchParams(),taskId=params.get('task')||'',savedPlanId=params.get('plan')||'',replanId=params.get('replan')||'';
 const mobile=useMobileLayout(),location=useLocation(),guide=useInteractiveGuide();
 const guidePredictionId=useRef('');
 const quickRequested=useRef(location.state?.quickObservation===true);
 const [quickFeedback,setQuickFeedback]=useState(false);
 const [view,setView]=useState<'map'|'conditions'|'results'>(taskId||savedPlanId?'results':'map');
 const viewNavigation=useRef<HTMLDivElement>(null);
 const [mapOpened,setMapOpened]=useState(view==='map');
 function showView(value:typeof view){
  if(!mobile)return;
  if(value==='map')setMapOpened(true);
  setView(value);
  requestAnimationFrame(()=>{
   const navigation=viewNavigation.current;
   if(navigation&&window.scrollY>0)navigation.parentElement?.scrollIntoView({block:'start'});
  });
 }
 const clock=useReplay(),[planOpen,setPlanOpen]=useState(false),[mode,setMode]=useState(params.get('mode')==='group'||params.get('group')?'group':'single'),[groupSlug,setGroupSlug]=useState(params.get('group')||''),[batchPage,setBatchPage]=useState(Number(params.get('batch'))||1),[batchSize,setBatchSize]=useState(Number(params.get('size'))||100);
 const [stationId,setStationId]=useState(params.get('station')||''),[norad,setNorad]=useState(Number(params.get('sat'))||25544),[keyword,setKeyword]=useState(''),[search,setSearch]=useState('');
 const [zone,setZone]=useState(params.get('tz')||readTimeZone()),[start,setStart]=useState(()=>params.get('from')||localInput(new Date().toISOString(),params.get('tz')||readTimeZone())),[days,setDays]=useState(Number(params.get('days'))||1),[minimum,setMinimum]=useState(params.has('min')?Number(params.get('min')):10),[editor,setEditor]=useState<any>(null);
 const [sort,setSort]=useState(params.get('sort')||'time'),[visual,setVisual]=useState(params.get('visual')==='1'),[page,setPage]=useState(Number(params.get('resultPage'))||1),[eventId,setEventId]=useState(''),[clientError,setClientError]=useState<unknown>(null),[startIsNow,setStartIsNow]=useState(!params.has('from')||params.get('now')==='1'),restored=useRef(''),restoringSelection=useRef(false),submittedTask=useRef('');
 const groupActive=clock.track?.kind==='group';
 const [groupSelected,setGroupSelected]=useState<number|null>(null),[groupRequestedEvent,setGroupRequestedEvent]=useState(''),[onlyAbove,setOnlyAbove]=useState(false),[groupState,setGroupState]=useState<any>(null);
 const stations=useQuery({queryKey:['stations'],queryFn:()=>api('/stations')});
 const satellite=useQuery({queryKey:['detail',norad],queryFn:()=>api(`/satellites/${norad}`),enabled:norad>0});
 const options=useQuery({queryKey:['obs-search',search],queryFn:()=>api(`/satellites?size=6&keyword=${encodeURIComponent(search)}`),enabled:!!search});
 const history=useQuery({queryKey:['predictions'],queryFn:()=>api('/predictions?size=30'),refetchInterval:q=>q.state.data?.list.some((t:any)=>active(t.status))?2000:false});
 const task=useQuery({queryKey:['prediction',taskId],queryFn:()=>api(`/predictions/${taskId}`),enabled:!!taskId&&!savedPlanId,refetchInterval:q=>active(q.state.data?.data.status)?700:false});
 const savedPlan=useQuery({queryKey:['plan',savedPlanId||replanId],queryFn:()=>api(`/plans/${savedPlanId||replanId}`),enabled:!!(savedPlanId||replanId)});
 const groups=useQuery({queryKey:['groups'],queryFn:()=>api('/groups')});
 const batch=useQuery({queryKey:['group-batch',groupSlug,batchPage,batchSize],queryFn:()=>api(`/predictions/groups/${groupSlug}/batch?page=${batchPage}&size=${batchSize}`),enabled:mode==='group'&&!!groupSlug});
 const planSnapshot=savedPlanId?savedPlan.data?.data.snapshot:null;
 const data=planSnapshot?{id:planSnapshot.taskId,status:'completed',progress:100,basis:planSnapshot.basis,finishedAt:planSnapshot.computedAt,execution:{},freshness:{},total:1}:task.data?.data,basis=data?.basis,completed=data?.status==='completed';
 useEffect(()=>{
  if(guide?.stepTarget==='plan-calculate'&&mobile)showView('conditions');
  if(guide?.stepTarget==='plan-pass'&&mobile)showView('results');
 },[guide?.stepTarget,mobile]);
 const resultQuery=useQuery({queryKey:['prediction-results',taskId,page,sort,visual],queryFn:()=>api(`/predictions/${taskId}/results?page=${page}&sort=${sort}&visual=${visual}`),enabled:completed&&!savedPlanId});
 const guidePrediction=guide?.stepTarget==='plan-calculate'&&!!taskId&&guidePredictionId.current===taskId;
 const hasFuturePass=resultQuery.data?.list.some((row:any)=>Date.parse(row.start)>Date.now());
 useEffect(()=>{
  if(guidePrediction&&completed&&hasFuturePass)guide?.signal('prediction-ready');
 },[guide,guidePrediction,completed,hasFuturePass]);
 const guidePredictionStatus=guidePrediction&&(active(data?.status)||(completed&&resultQuery.isPending))?'正在计算，找到未来窗口后会进入下一步。':
  guidePrediction&&completed&&resultQuery.isSuccess&&!hasFuturePass?'没有可保存的未来过境。试着降低最低仰角或延长预测范围，再计算一次。':'';
 const eventQuery=useQuery({queryKey:['prediction-event',taskId,eventId],queryFn:()=>api(`/predictions/${taskId}/events/${eventId}`),enabled:completed&&!!eventId&&!savedPlanId&&!groupActive});
 const groupBucket=basis?Math.max(0,Math.floor((clock.time-Date.parse(basis.start))/300000)):0;
 const groupWindow=useQuery({queryKey:['group-replay-window',taskId,groupBucket],queryFn:({signal})=>api(`/predictions/${taskId}/group-replay?at=${encodeURIComponent(new Date(Date.parse(basis.start)+groupBucket*300000).toISOString())}`,{signal}),enabled:groupActive&&!!taskId,placeholderData:previous=>previous,gcTime:15000});
 const groupSelection=useQuery({queryKey:['group-replay-selection',taskId,groupSelected,groupRequestedEvent,groupBucket],queryFn:({signal})=>api(`/predictions/${taskId}/group-replay/satellites/${groupSelected}?at=${encodeURIComponent(new Date(clock.time).toISOString())}${groupRequestedEvent?'&eventId='+encodeURIComponent(groupRequestedEvent):''}`,{signal}),enabled:groupActive&&groupSelected!==null,gcTime:60000});
 const results=planSnapshot?{data:{list:[planSnapshot.event],total:1},error:null}:resultQuery,event=groupActive?groupSelection:planSnapshot?{data:{data:planSnapshot.event},error:null}:eventQuery;
 useEffect(()=>{if(groupActive&&groupSelection.data){const selected=groupSelection.data.data;setEventId(selected?.id||'');if(selected)cache.setQueryData(['prediction-event',taskId,selected.id],groupSelection.data);}},[groupActive,groupSelection.data]);
 const groupData=groupWindow.data?.data,groupCovered=!!groupData&&clock.time>=Date.parse(groupData.start)&&clock.time<=Date.parse(groupData.end);
 const groupSatellite=groupData?.satellites.find((s:any)=>s.noradId===groupSelected);
 const groupCurve=groupCovered&&groupSatellite?groupSatellite.samples.map((row:any,i:number)=>[new Date(Date.parse(groupData.start)+i*groupData.stepSeconds*1000).toISOString(),row[3]]):null;
 const groupPeak=groupCurve?.reduce((best:any,row:any)=>row[1]>best[1]?row:best,groupCurve[0]);
 const groupChart=groupCurve?{...event.data?.data,curve:groupCurve,start:groupData.start,end:groupData.end,peak:groupPeak[0],max_elevation:groupPeak[1],visible_windows:event.data?.data?.visible_windows||[]}:null;
 function startGroup(){setGroupSelected(event.data?.data?.satellite?.noradId||basis.satellite.noradId);setGroupRequestedEvent('');clock.start({kind:'group',start:basis.start,end:basis.end},clock.track?clock.time:Date.parse(basis.start));showView('map');}
 function selectGroupSatellite(id:number){setGroupRequestedEvent('');setGroupSelected(id);}
 function clearSelection(){setEventId('');setParams(p=>{const next=new URLSearchParams(p);next.delete('event');return next;},{replace:true});}

 const replay=useMutation({mutationFn:()=>api(savedPlanId?`/plans/${savedPlanId}/replay`:`/predictions/${taskId}/events/${eventId}/replay`),onSuccess:r=>{clock.start(r.data);showView('map');}});
 useEffect(()=>{clock.exit();setGroupSelected(null);setGroupRequestedEvent('');setPlanOpen(false);},[taskId,savedPlanId]);
 useEffect(()=>{if(clock.track?.kind!=='group')clock.exit();setPlanOpen(false);},[eventId]);
 useEffect(()=>{const timer=setTimeout(()=>setSearch(keyword),250);return()=>clearTimeout(timer);},[keyword]);
 useEffect(()=>{if(!startIsNow)return;const timer=setInterval(()=>setStart(localInput(new Date().toISOString(),zone)),30000);return()=>clearInterval(timer);},[startIsNow,zone]);
 useEffect(()=>{if(!stationId&&!taskId&&stations.data?.list.length)setStationId((stations.data.list.find((s:any)=>s.is_default)||stations.data.list[0]).id);},[stations.data,stationId,taskId]);
 useEffect(()=>{if(data&&restored.current!==data.id){restored.current=data.id;restoringSelection.current=true;const draft=params.get('draft')==='1';setStartIsNow(draft&&params.get('now')==='1');setMode(draft?(params.get('mode')==='group'?'group':'single'):data.basis.kind==='group'?'group':'single');setGroupSlug(draft?(params.get('group')||''):data.basis.group?.slug||'');setBatchPage(draft?(Number(params.get('batch'))||1):data.basis.group?.page||1);setBatchSize(draft?(Number(params.get('size'))||100):data.basis.group?.size||100);setStationId(draft?(params.get('station')||data.basis.station.id):data.basis.station.id);setNorad(draft?(Number(params.get('sat'))||data.basis.satellite.noradId):data.basis.satellite.noradId);setStart(draft?(params.get('from')||localInput(data.basis.start,zone)):localInput(data.basis.start,zone));setDays(draft?(Number(params.get('days'))||data.basis.days):data.basis.days);setMinimum(draft&&params.has('min')?Number(params.get('min')):data.basis.minElevation);setPage(Number(params.get('resultPage'))||1);setEventId(params.get('event')||planSnapshot?.event.id||'');}},[data,zone]);
 useEffect(()=>{if(groupActive)return;if(eventId&&params.get('event')===eventId)return;if(restoringSelection.current){restoringSelection.current=false;return;}if(results.data){const items=results.data.list,requested=params.get('event');if(!eventId&&requested&&items.some((x:any)=>x.id===requested)){setEventId(requested);return;}if(!items.some((x:any)=>x.id===eventId))setEventId(items[0]?.id||'');}},[results.data,eventId]);
 useEffect(()=>{if(!taskId||restored.current!==taskId)return;setParams(p=>{const next=new URLSearchParams(p);next.set('resultPage',String(page));next.set('sort',sort);if(visual)next.set('visual','1');else next.delete('visual');if(eventId)next.set('event',eventId);else next.delete('event');return next.toString()===p.toString()?p:next;},{replace:true});},[taskId,page,sort,visual,eventId]);
 useEffect(()=>{if(submittedTask.current&&taskId!==submittedTask.current)return;if(submittedTask.current===taskId)submittedTask.current='';if(savedPlanId||(taskId&&restored.current!==taskId))return;const next=new URLSearchParams(params);const fields={draft:'1',station:stationId,sat:String(norad),mode,group:mode==='group'?groupSlug:'',batch:String(batchPage),size:String(batchSize),from:start,days:String(days),min:String(minimum),tz:zone,now:startIsNow?'1':'0'};for(const [key,value] of Object.entries(fields))value?next.set(key,value):next.delete(key);if(next.toString()!==params.toString())setParams(next,{replace:true});},[savedPlanId,taskId,stationId,norad,mode,groupSlug,batchPage,batchSize,start,days,minimum,zone,startIsNow]);
 const eventBasis=groupActive?groupSelection.data?.basis:planSnapshot?.basis||event.data?.basis||basis;
 const currentStation=stations.data?.list.find((s:any)=>s.id===stationId);
 const dirty=!!basis&&((basis.kind==='group'?'group':'single')!==mode||(mode==='group'&&(basis.group?.slug!==groupSlug||basis.group?.page!==batchPage||basis.group?.size!==batchSize))||basis.station.id!==stationId||basis.satellite.noradId!==norad||basis.days!==days||basis.minElevation!==minimum||localInput(basis.start,zone)!==start||(currentStation&&['name','latitude','longitude','elevation_m'].some(k=>basis.station[k]!==currentStation[k])));
 const showResults=()=>showView('results');
 const create=useMutation({mutationFn:(input:{acceptStale:boolean;start:string;days:number;minimum:number})=>api(mode==='group'?'/predictions/groups':'/predictions',{method:'POST',body:JSON.stringify({stationId,...(mode==='group'?{group:groupSlug,batch:batchPage,size:batchSize,expectedNoradIds:batch.data?.list.map((x:any)=>x.noradId)}:{noradId:norad}),start:input.start,days:input.days,minElevation:input.minimum,acceptStale:input.acceptStale})}),onSuccess:r=>{if(guide?.stepTarget==='plan-calculate')guidePredictionId.current=r.data.id;else showResults();submittedTask.current=r.data.id;setStartIsNow(false);restored.current=r.data.id;cache.setQueryData(['prediction',r.data.id],r);setParams({sat:String(norad),task:r.data.id,...(replanId?{replan:replanId}:{}),...(mode==='group'?{group:groupSlug,batch:String(batchPage),size:String(batchSize)}:{})});setPage(1);setEventId('');cache.invalidateQueries({queryKey:['predictions']});}});
 const cancel=useMutation({mutationFn:()=>api(`/predictions/${taskId}/cancel`,{method:'POST'}),onSuccess:r=>{cache.setQueryData(['prediction',taskId],r);cache.invalidateQueries({queryKey:['predictions']});}});
 const stationAction=useMutation({mutationFn:({s,remove}:{s:any;remove?:boolean})=>api(`/stations/${s.id}`,{method:remove?'DELETE':'PATCH',body:remove?undefined:JSON.stringify({name:s.name,latitude:s.latitude,longitude:s.longitude,elevation_m:s.elevation_m,is_default:true})}),onSuccess:()=>cache.invalidateQueries({queryKey:['stations']})});
 function submitPrediction(quick=false){
  setQuickFeedback(quick);
  setClientError(null);
  if(create.isPending||active(data?.status)||savedPlanId)return;
  if(!currentStation){showConditions();setClientError(Error('请选择或新建观测站。'));return;}
  if(mode==='group'&&!batch.data?.list.length){setClientError(Error('请选择有对象的分组批次'));return;}
  const quality=satellite.data?.data.dataQuality;
  const stale=mode==='group'?batch.data.list.some((x:any)=>x.stale):quality&&quality.state!=='available';
  if(stale&&!window.confirm(mode==='group'?'本批存在陈旧或未来历元根数，预测误差可能增大，是否继续？':`根数历元：${quality.epoch}。该根数已陈旧或历元异常，预测误差可能增大，是否继续？`))return;
  const effective=quick||startIsNow?new Date().toISOString():toISO(start,zone);
  if(quick||startIsNow)setStart(localInput(effective,zone));
  if(quick){setDays(1);setMinimum(10);}
  create.mutate({acceptStale:!!stale,start:effective,days:quick?1:days,minimum:quick?10:minimum});
 }
 useEffect(()=>{
  if(!quickRequested.current||stations.isPending||satellite.isPending)return;
  if(stations.data?.list.length&&!stationId)return;
  quickRequested.current=false;
  if(stations.error||satellite.error){setQuickFeedback(true);showConditions();return;}
  submitPrediction(true);
 },[stations.isPending,stations.data,stations.error,satellite.isPending,satellite.error,stationId]);
 function showConditions(){
  showView('conditions');
 }
 function switchZone(value:string){if(start)setStart(localInput(toISO(start,zone),value));setZone(value);}
 function selectEvent(r:any){if(Date.parse(r.start)>Date.now())guide?.signal('future-pass');if(groupActive){setGroupSelected(r.satellite.noradId);setGroupRequestedEvent(r.id);clock.seek(Date.parse(r.start)-60000);}setEventId(r.id);setParams(p=>{const next=new URLSearchParams(p);next.set('event',r.id);return next;},{replace:true});}
 const replayTools=<>{clock.track&&<ReplayControls clock={clock} zone={zone}/>}{groupActive&&<section className="group-replay-panel" aria-label="整组回放状态"><div className="group-replay-toolbar"><div><strong>本批 {groupData?.renderedCount??'—'} / {basis.targets.length} 颗已载入</strong><span role="status">{groupCovered?`达到仰角 ${groupState?.aboveCount??'—'} 颗 · 最低 ${basis.minElevation}°`:groupWindow.isError?'该时刻点位加载失败':'正在载入该时刻点位…'}</span></div><Select label="回放卫星" value={String(groupSelected??'')} onChange={v=>selectGroupSatellite(Number(v))} options={basis.targets.map((t:any)=>({value:String(t.satellite.noradId),label:t.satellite.name,description:'NORAD '+t.satellite.noradId}))}/><label className="checkbox-label"><input type="checkbox" checked={onlyAbove} onChange={e=>setOnlyAbove(e.target.checked)}/>只看达到仰角要求</label></div>{groupWindow.isError&&<button onClick={()=>groupWindow.refetch()}>重试载入点位</button>}<div className="group-replay-legend"><span>灰：未达仰角</span><span>蓝：达到仰角</span><span>金：选中卫星</span></div>{groupState?.selected&&<p className="group-live-readout"><strong>{groupState.selected.name}</strong><span>当前仰角 {groupState.selected.elevation.toFixed(2)}°</span><span>方位 {groupState.selected.azimuth.toFixed(1)}°</span><span>高度 {groupState.selected.altitudeKm.toFixed(1)} km</span><span>距离 {groupState.selected.rangeKm.toFixed(1)} km</span></p>}{groupSelection.isSuccess&&!groupSelection.data?.data&&<p className="muted">该卫星在本次查询范围内没有达到仰角要求的过境，仍保留点位和当前窗口曲线。</p>}{groupData?.failed.length>0&&<details className="failed-targets"><summary>本时间段 {groupData.failed.length} 颗无法传播</summary>{groupData.failed.map((s:any)=><p key={s.noradId}>{s.noradId} · {s.name}</p>)}</details>}</section>}</>;
 const mapCanvas=<ObservationMap station={basis?.station||currentStation} event={event.data?.data} replay={groupActive?undefined:clock.track} replayTime={clock.track?clock.time:undefined} groupActive={groupActive} groupPaused={!clock.playing} groupData={groupData} groupSelected={groupSelected} onlyAbove={onlyAbove} onGroupSelect={selectGroupSatellite} onGroupState={setGroupState}/>;
 const selectedPassMapDetail=event.data?.data&&<section className="panel observation-detail">{event.data?.data?<><div className="section-heading"><h2>{event.data.data.satellite?.name||basis?.satellite.name||'过境详情'}</h2><span className="quality available">{time(event.data.data.start,zone).slice(0,5)}</span></div><div className="event-peak"><strong>{event.data.data.max_elevation.toFixed(1)}<small>°</small></strong><span>最高仰角</span></div><dl><dt>进入方位</dt><dd>{event.data.data.start_azimuth.toFixed(1)}°</dd><dt>离开方位</dt><dd>{event.data.data.end_azimuth.toFixed(1)}°</dd><dt>最高点距离</dt><dd>{event.data.data.peak_conditions.range_km.toFixed(0)} km</dd><dt>最高点太阳高度</dt><dd>{event.data.data.peak_conditions.sun_altitude.toFixed(1)}°</dd><dt>最高点卫星受光</dt><dd>{event.data.data.peak_conditions.sunlit?'受光':'地影中'}</dd></dl><p className="boundary-note">{event.data.data.continuous?'查询范围内持续高于阈值':event.data.data.partial_start||event.data.data.partial_end?'过境在查询边界截断':'完整过境'}</p></>:<div className="observation-empty"><MapPin size={32}/><p>{data?statusNames[data.status]:'选择观测站与卫星'}</p></div>}</section>;
 const mapVisual=<div className={`observation-visual ${event.data?.data?'has-event':''} ${groupActive?'is-group-replay':''}`}>{mapCanvas}{selectedPassMapDetail}</div>;
 const groupReplayAction=completed&&basis.kind==='group'?<button className="primary" onClick={startGroup} disabled={groupActive}>整组回放</button>:null;
 const eventActions=completed?<div className="event-actions">{!mobile&&groupReplayAction}<button onClick={()=>replay.mutate()} disabled={!event.data?.data||replay.isPending}>{replay.isPending?'正在准备回放…':basis.kind==='group'?'单星回放':'回放过境'}</button><button className="primary" disabled={!event.data?.data||Date.parse(event.data.data.start)<=Date.now()||!!savedPlanId} data-guide-target="plan-open" onClick={()=>{setPlanOpen(true);guide?.signal('plan-open')}}>{replanId?'更新计划':'保存观测计划'}</button></div>:null;
 const eventDetails=!completed?null:groupActive?<div className="event-expanded">{groupChart?<ElevationCurve event={groupChart} minimum={basis.minElevation} zone={zone} cursor={clock.time} sampled/>:<p className="muted">{groupWindow.isError?'当前窗口加载失败，可重新进入整组回放重试。':'正在准备所选卫星的当前窗口曲线…'}</p>}<div className="optical-windows"><h3>当前窗口仰角</h3><p>{groupSatellite?.name||'请选择卫星'}</p><small>蓝色点仅表示达到站点仰角要求，不保证肉眼可见。曲线与点位使用同一采样窗口（最多 20 分钟），随回放时间更新。</small></div></div>:<> {event.data?.data&&<div className="event-expanded"><ElevationCurve event={clock.track?{...event.data.data,start:clock.track.start,end:clock.track.end,curve:clock.track.samples.map((r:any)=>[r[0],r[7],r[8],r[9],r[10],r[11],r[4],r[5]])}:event.data.data} minimum={basis.minElevation} zone={zone} cursor={clock.track?clock.time:undefined}/><div className="optical-windows"><h3>潜在目视窗口</h3>{event.data.data.visible_windows.length?event.data.data.visible_windows.map((w:any,i:number)=><p key={i}>{time(w.start,zone)} — {time(w.end,zone)}</p>):<p>本次过境无符合条件的子窗口。</p>}<small>仰角 ≥ {basis.minElevation}°、太阳高度 &lt; −6°、卫星受光。不保证肉眼可见。</small></div></div>}</>;
 return <div className="observations"><div className="page-heading"><h1>观测规划</h1><GuideEntry/><Select className="timezone-select" label="显示时区" value={zone} onChange={switchZone} options={[{value:"sh",label:"UTC+8 · 北京时间"},{value:"utc",label:"UTC"}]}/></div>
 {params.get('evidenceRun')&&<VerificationBrief run={params.get('evidenceRun')!}/>}
 <details className="ai-result"><summary>比较观测方案</summary><ObservationComparison compare defaultQuery={String(norad)}/></details>
{mobile&&<div className="observation-view-nav animated-segments" ref={viewNavigation} role="group" aria-label="观测工作区">
  <button type="button" aria-pressed={view==='map'} onClick={()=>showView('map')}>地图</button>
  <button type="button" aria-pressed={view==='conditions'} onClick={showConditions}>条件</button>
  <button type="button" aria-pressed={view==='results'} onClick={showResults}>结果{active(data?.status)&&<span className="obs-running-dot" aria-label="计算中"/>}</button>
 </div>}<div className="observation-layout">{mobile&&<div className="mobile-observation-map" hidden={view!=='map'}>
  {!savedPlanId&&!replanId&&<div className="observation-quick">
   <div><strong>{mode==='single'?satellite.data?.data.name||`NORAD ${norad}`:'卫星分组'}</strong><span>{currentStation?.name||'尚未选择观测站'}{mode==='single'?' · 现在起 24 小时 · ≥ 10°':''}</span></div>
   {mode==='single'?<button className="primary" type="button" disabled={stations.isPending||!satellite.data||create.isPending||active(data?.status)} onClick={()=>submitPrediction(true)}>{create.isPending?'正在提交…':'一键观测'}</button>:<button type="button" onClick={showConditions}>设置分组</button>}
  </div>}
  {quickFeedback&&<ErrorBox error={stations.error||satellite.error||create.error||clientError}/>}
  {mapOpened&&<div className={`observation-visual ${groupActive?'is-group-replay':''}`}>{mapCanvas}</div>}{replayTools}{selectedPassMapDetail}
 </div>}<aside className="panel observation-conditions" hidden={mobile&&view!=='conditions'}>
 {mobile&&quickFeedback&&<ErrorBox error={stations.error||satellite.error||clientError}/>}
 <form id="observation-form" onSubmit={event=>{event.preventDefault();submitPrediction();}}>
 <div className="section-heading"><h2>观测站</h2>{!!stations.data?.list.length&&<button type="button" aria-label="新建观测站" onClick={()=>setEditor({})}><Plus size={18}/></button>}</div>{stations.data?.list.length?<Select label="选择观测站" value={stationId} onChange={setStationId} placeholder="选择观测站" options={stations.data.list.map((s:any)=>({value:s.id,label:s.name+(s.is_default?' · 默认':''),description:`${s.latitude.toFixed(2)}°, ${s.longitude.toFixed(2)}°`}))}/>:<button className="create-first-station" type="button" disabled={stations.isPending} onClick={()=>setEditor({})}><MapPin size={20}/><span>{stations.isPending?'正在读取…':'新建观测站'}</span><Plus size={16}/></button>}
 {stations.isSuccess&&basis&&!currentStation&&stationId===basis.station.id&&<p className="station-coordinate">该站点已删除，结果保留原站点快照。重新计算前请选择观测站。</p>}
 {currentStation&&<><p className="station-coordinate">{currentStation.latitude.toFixed(4)}°, {currentStation.longitude.toFixed(4)}° · {currentStation.elevation_m} m</p><div className="station-actions"><button type="button" aria-label="编辑观测站" onClick={()=>setEditor(currentStation)}><PencilSimple size={17}/></button><button type="button" aria-label="设为默认观测站" disabled={currentStation.is_default||stationAction.isPending} onClick={()=>stationAction.mutate({s:currentStation})}><Star size={17} weight={currentStation.is_default?'fill':'regular'}/></button><button type="button" aria-label="删除观测站" disabled={stationAction.isPending} onClick={()=>{if(window.confirm('删除观测站？已有预测会保留当时的站点快照。'))stationAction.mutate({s:currentStation,remove:true});}}><Trash size={17}/></button></div></>}
 <label>预测对象</label><div className="range-segments target-mode" role="group" aria-label="预测对象模式"><button type="button" aria-pressed={mode==='single'} disabled={!!savedPlanId} onClick={()=>setMode('single')}>单颗卫星</button><button type="button" aria-pressed={mode==='group'} disabled={!!(savedPlanId||replanId)} onClick={()=>setMode('group')}>卫星分组</button></div>
 {mode==='single'?<> <label htmlFor="sat-search">卫星</label><input id="sat-search" disabled={!!(savedPlanId||replanId)} placeholder="搜索名称或 NORAD 编号" value={keyword} onChange={e=>setKeyword(e.target.value)}/>{search&&<div className="sat-search-results">{options.data?.list.map((s:any)=><button type="button" key={s.noradId} onClick={()=>{setNorad(s.noradId);setKeyword('');setSearch('');}}>{s.name}<small>{s.noradId}</small></button>)}{options.data?.total===0&&<p>未找到卫星</p>}</div>}
 <div className="chosen-satellite"><strong>{satellite.data?.data.name||'正在读取卫星…'}</strong><span>NORAD {norad}</span></div>
</>:<div className="group-conditions"><label htmlFor="prediction-group">分组</label><Select id="prediction-group" label="预测分组" value={groupSlug} placeholder="选择卫星分组" onChange={v=>{setGroupSlug(v);setBatchPage(1);}} options={groups.data?.list.map((g:any)=>({value:g.slug,label:g.name,description:`${g.count} 颗`}))||[]}/><label>每批上限</label><Select label="批次数量" value={String(batchSize)} onChange={v=>{setBatchSize(Number(v));setBatchPage(1);}} options={[25,100,500].map(n=>({value:String(n),label:n+' 颗'}))}/>{batch.data&&<div className="batch-scope"><p>本批 {batch.data.list.length} / {batch.data.total} 颗</p><span>NORAD {batch.data.list[0]?.noradId??'—'} — {batch.data.list.at(-1)?.noradId??'—'}</span><div className="batch-pages"><button type="button" aria-label="上一批" disabled={batchPage<=1} onClick={()=>setBatchPage(batchPage-1)}>上一批</button><span>{batchPage} / {batch.data.pages}</span><button type="button" aria-label="下一批" disabled={batchPage>=batch.data.pages} onClick={()=>setBatchPage(batchPage+1)}>下一批</button></div><details><summary>本批对象</summary><ol>{batch.data.list.map((x:any)=><li key={x.noradId}>{x.noradId} · {x.name}</li>)}</ol></details></div>}<ErrorBox error={batch.error||groups.error}/></div>}
 <label htmlFor="prediction-start">开始时间 · {zone==='sh'?'UTC+8':'UTC'}</label><input id="prediction-start" type="datetime-local" required value={start} onChange={e=>{setStartIsNow(false);setStart(e.target.value);}}/><button className="text-button start-now" type="button" aria-pressed={startIsNow} onClick={()=>{setStartIsNow(true);setStart(localInput(new Date().toISOString(),zone));}}>设为当前时间</button>
 <label>预测范围</label><div className="range-segments" role="group" aria-label="预测范围">{[[1,'24 小时'],[3,'3 天'],[7,'7 天']].map(([value,label])=><button key={value} type="button" aria-pressed={days===value} onClick={()=>setDays(Number(value))}>{label}</button>)}</div><label htmlFor="prediction-elevation">最低仰角 °</label><input id="prediction-elevation" type="number" min={0} max={90} step="any" required value={minimum} onChange={e=>setMinimum(Number(e.target.value))}/>
 {guidePredictionStatus&&<p role="status" className="muted">{guidePredictionStatus}</p>}
 <ErrorBox error={stations.error||satellite.error||options.error||create.error||clientError||stationAction.error}/><button className="primary predict-submit" data-guide-target="plan-calculate" disabled={!currentStation||(mode==='single'?!satellite.data:!batch.data?.list.length)||create.isPending||active(data?.status)||!!savedPlanId}>{create.isPending?'正在提交…':'计算过境'}<ArrowRight/></button></form>
 <details className="prediction-history"><summary>历史计算</summary><ErrorBox error={history.error}/>{history.data?.list.map((t:any)=><button className={t.id===taskId?'selected':''} key={t.id} onClick={()=>{setParams({sat:String(t.basis.satellite.noradId),task:t.id,...(replanId?{replan:replanId}:{})});showResults();}}><strong>{t.basis.group?.name||t.basis.satellite.name}</strong><small>{t.basis.station.name} · {time(t.createdAt,zone)} · {statusNames[t.status]}</small></button>)}{history.data?.total===0&&<p className="muted">暂无计算记录</p>}</details></aside>
 <main className="observation-content" hidden={mobile&&view!=='results'}>{quickFeedback&&mobile&&view==='results'&&<ErrorBox error={create.error||clientError}/>}{replanId&&<p className="notice observation-warning">正在重算计划。计算完成后选择未来过境，点击“更新计划”查看新旧差异。</p>}{savedPlanId&&<div className="notice success">计划快照 v{savedPlan.data?.data.version} · <a href="/workspace">查看我的计划</a></div>}<ErrorBox error={savedPlan.error||replay.error||(groupActive&&(groupWindow.error||groupSelection.error))}/>{!mobile&&<>{replayTools}{mapVisual}</>}
 <section className="panel observation-results"><div className="section-heading"><h2>过境结果</h2>{data&&<span className={`task-status ${data.status}`} role="status">{statusNames[data.status]}{active(data.status)?` ${data.progress}%`:''}</span>}</div><ErrorBox error={task.error||results.error||event.error||cancel.error}/>
 {data&&<><div className="result-basis"><strong>{basis.group?.name||basis.satellite.name}</strong><span>{basis.station.name}</span><span>{time(basis.start,zone)} → {time(basis.end,zone)}</span><span>≥ {basis.minElevation}°</span></div>{dirty&&<p className="notice observation-warning" role="status">条件已修改，当前显示上次计算结果。</p>}{(data.freshness.stale||data.freshness.futureEpoch||data.freshness.orbitUpdated||data.freshness.windowEnded||basis.maxEpochDistanceHours>72)&&<p className="notice observation-warning">{data.freshness.windowEnded?'预测时间范围已结束。 ':''}{data.freshness.orbitUpdated?'轨道根数已有更新，请重新计算。 ':''}{data.freshness.stale?'计算依据的根数已陈旧。 ':''}{data.freshness.futureEpoch?'计算依据包含未来历元，请核对数据。 ':''}{basis.maxEpochDistanceHours>72?'部分预测时间距根数历元超过 72 小时，误差可能增大。':''}</p>}
 {active(data.status)&&<div className="task-progress"><progress aria-label="预测进度" value={data.progress} max={100}/><button disabled={cancel.isPending||data.status==='cancelling'} onClick={()=>cancel.mutate()}>取消计算</button></div>}
 {data.execution?.totalSatellites>1&&<p className="muted batch-progress">已完成 {data.execution.completedSatellites} / {data.execution.totalSatellites} 颗 · 缓存命中 {data.execution.cacheHits||0} 颗{data.execution.failures?.length?` · ${data.execution.failures.length} 颗传播失败`:''}</p>}{data.execution?.failures?.length>0&&<details className="failed-targets"><summary>传播失败对象</summary>{data.execution.failures.map((x:any)=><p key={x.noradId}>{x.noradId} · {x.name}</p>)}</details>}{data.status==='failed'&&<div className="notice error" role="alert">{data.errorCode==='WORKER_INTERRUPTED'?'计算被服务重启中断，请重新提交。':data.errorCode==='EPHEMERIS_UNAVAILABLE'?'本地星历不可用，请检查服务。':'轨道传播失败，请更换卫星或时间。'}</div>}{data.status==='cancelled'&&<p className="muted">服务已取消本次计算。</p>}
 {completed&&<>{mobile?(groupReplayAction&&<div className="event-actions">{groupReplayAction}</div>):<>{eventActions}{eventDetails}</>}
 <div className="results-toolbar"><label className="checkbox-label"><input type="checkbox" checked={visual} onChange={e=>{setVisual(e.target.checked);setPage(1);clearSelection();}}/>仅有潜在目视窗口</label><Select label="结果排序" value={sort} onChange={value=>{setSort(value);setPage(1);clearSelection();}} options={[{value:'time',label:'按进入时间'},{value:'elevation',label:'按最高仰角'}]}/></div>{mobile?<ul className="observation-event-list" aria-label="过境列表">{results.data?.list.map((r:any)=><li key={r.id}>
  <button type="button" aria-pressed={eventId===r.id} aria-label={`查看过境 ${r.id}`} data-guide-target={Date.parse(r.start)>Date.now()?'plan-pass':undefined} onClick={()=>selectEvent(r)}>
   <strong>{r.satellite?.name||basis.satellite.name}</strong><b>{r.max_elevation.toFixed(1)}°</b>
   <span>进入 {time(r.start,zone)}<br/>最高点 {time(r.peak,zone)}<br/>离开 {time(r.end,zone)}</span><small>{(r.duration_s/60).toFixed(1)} 分钟<br/>{r.visible_windows.length?`${r.visible_windows.length} 个目视窗口`:'无目视窗口'}</small>
  </button>
   {eventId===r.id&&<section className="mobile-selected-pass" aria-label="选中过境">
    {eventActions}
    <details className="mobile-pass-detail"><summary>仰角曲线与目视窗口</summary>{eventDetails}</details>
   </section>}
 </li>)}</ul>:<div className="table-scroll"><table><thead><tr><th>卫星</th><th>进入</th><th>最高点</th><th>离开</th><th>最高仰角</th><th>时长</th><th>潜在目视</th></tr></thead><tbody>{results.data?.list.map((r:any)=><tr key={r.id} className={eventId===r.id?'selected':''}><td>{r.satellite?.name||basis.satellite.name}</td><td><button className="text-button" aria-label={`查看过境 ${r.id}`} data-guide-target={Date.parse(r.start)>Date.now()?'plan-pass':undefined} onClick={()=>selectEvent(r)}>{time(r.start,zone)}</button></td><td>{time(r.peak,zone)}</td><td>{time(r.end,zone)}</td><td>{r.max_elevation.toFixed(1)}°</td><td>{(r.duration_s/60).toFixed(1)} min</td><td>{r.visible_windows.length?`${r.visible_windows.length} 个窗口`:'无'}</td></tr>)}</tbody></table></div>}{results.data?.total===0&&<div className="empty">{visual?'没有符合筛选条件的目视窗口。':'本次范围内无几何过境，可调整站点、时间或最低仰角。'}</div>}<div className="pagination"><span>{results.data?.total??0} 次过境</span><button disabled={page<=1} onClick={()=>{setPage(page-1);clearSelection();}}>上一页</button><span>{page} / {Math.max(1,Math.ceil((results.data?.total||0)/8))}</span><button disabled={page*8>=(results.data?.total||0)} onClick={()=>{setPage(page+1);clearSelection();}}>下一页</button></div>

 </>}
 {eventBasis&&<details className="calculation-basis"><summary>计算依据</summary><dl><dt>算法</dt><dd>{eventBasis.algorithm}</dd><dt>根数历元 UTC</dt><dd>{eventBasis.orbit.epoch}</dd><dt>采集时间 UTC</dt><dd>{eventBasis.orbit.fetchedAt}</dd><dt>来源</dt><dd>{eventBasis.orbit.source}</dd><dt>根数版本</dt><dd className="mono">{eventBasis.orbit.version}</dd><dt>站点快照</dt><dd>{eventBasis.station.latitude}°, {eventBasis.station.longitude}° / {eventBasis.station.elevation_m} m · WGS84</dd><dt>计算完成 UTC</dt><dd>{data.finishedAt||'尚未完成'}</dd>{event.data?.data?.computation&&<><dt>本事件计算 UTC</dt><dd>{event.data.data.computation.calculatedAt}{event.data.data.computation.fromCache?' · 复用缓存':''}</dd></>}</dl><p>{eventBasis.limitations}</p><p>方位角以正北为 0°，顺时针增加；曲线和地面投影来自同一次计算。</p><a className="button" href={`/api/predictions/${taskId}`} onClick={e=>{e.preventDefault();const blob=new Blob([JSON.stringify({task:data,event:event.data?.data,eventBasis},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`prediction-${taskId}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}>导出计算依据</a></details>}</>}
 {!data&&!task.isFetching&&<div className="empty results-empty">{!currentStation?'添加观测站后即可计算':'设置观测条件，计算未来过境'}</div>}
 </section></main></div>{planOpen&&event.data?.data&&<PlanDialog taskId={taskId} event={event.data.data} basis={basis} replanId={replanId||undefined} onClose={()=>setPlanOpen(false)}/>}{editor&&<StationEditor station={editor.id?editor:undefined} onClose={()=>setEditor(null)} onSaved={id=>{setStationId(id);setEditor(null);}}/>}</div>;
}
