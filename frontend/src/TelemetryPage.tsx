import {GuideEntry} from './InteractiveGuide';
import {InvestigationTask} from './TaskResults';
import {useSearchParams} from 'react-router-dom';
import {InvestigationEvidence,ImportMappingAssistant,ImportOriginalButton} from './InvestigationEvidence';
import type {SavedInvestigation} from './InvestigationShelf';
import {InvestigationPanel,useInvestigationRange,type InvestigationResult} from './InvestigationPanel';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api,saveDownload} from './api';
import {useAuth} from './auth';
import './telemetry.css';

type Asset={id:string;mission:string;norad:number;source:string;version:string;unit:string;cadenceSeconds?:boolean;coverageStart?:string;coverageEnd?:string;sha256:string;tle?:string;importProvenance?:unknown};
type Segment={channel:string;segment:string;start:string;end:string};
type Point={utc:string;record:number;value:number|null;raw:Record<string,string>};
type Report=Segment&{id:string;asset:Asset;input:{asset:string};points:Point[];used:number[];candidates:number[];missing:number[];duplicateTimes:string[];outOfOrder:number[];gaps:string[][];rule:{formula:string;threshold:number};stats:{count:number;mean:number;span:number;stdev:number;independentMean:number;verified:boolean};limitations:string;algorithm:string;objective:string;assessments?:{subject:string;status:string;basis:string}[];steps:unknown[];conversions:Record<string,number>;eventReviews?:Record<number,string>;review?:string};

function Orbit({position}:{position:{lng:number;lat:number;alt:number}}){
 const host=useRef<HTMLDivElement>(null),scene=useRef<any>(null),[ready,setReady]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  let active=true;
  import('./orbitScene').then(m=>m.loadRuntime()).then(()=>{
   if(!active||!host.current)return;
   const C=(window as any).Cesium;
   const viewer=new C.Viewer(host.current,{baseLayer:false,timeline:false,animation:false,geocoder:false,baseLayerPicker:false,sceneModePicker:false,homeButton:false,navigationHelpButton:false,fullscreenButton:false});
   scene.current=viewer;setReady(true);
  }).catch(e=>{if(active)setError(String(e))});
  return ()=>{active=false;scene.current?.destroy();scene.current=null};
 },[]);
 useEffect(()=>{if(!ready||!scene.current)return;const C=(window as any).Cesium,v=scene.current;
  const xyz=C.Cartesian3.fromDegrees(position.lng,position.lat,position.alt*1000);
  v.entities.removeAll();v.entities.add({position:xyz,point:{pixelSize:11,color:C.Color.CYAN}});
  v.camera.setView({destination:C.Cartesian3.fromDegrees(position.lng,position.lat,Math.max(5000000,position.alt*2000))});
 },[position,ready]);
 return <><div ref={host} style={{height:300}}/>{error}</>;
}

function Result({r,replace,saved}:{r:Report;replace:(r:Report)=>void;saved?:SavedInvestigation}){
 const [params]=useSearchParams();
 const [cursor,seek]=useState(()=>Math.max(0,r.points.findIndex(p=>p.record===Number(params.get('record'))))),[note,setNote]=useState(r.review||''),[status,setStatus]=useState('');
 const [playing,play]=useState(false),[zoom,setZoom]=useState(1);
 useEffect(()=>{if(!playing)return;if(cursor>=r.points.length-1){play(false);return}
  const timer=setTimeout(()=>seek(cursor+1),750);return ()=>clearTimeout(timer);
 },[playing,cursor,r.points.length]);
 const p=r.points[cursor],values=r.points.flatMap(x=>x.value===null?[]:[x.value]);
 const min=Math.min(...values),max=Math.max(...values),begin=Date.parse(r.start),duration=Date.parse(r.end)-begin;
 const width=(duration||1)/zoom, left=Math.max(begin,Math.min(begin+duration-width,Date.parse(p.utc)-width/2));
 const [initialRange]=useState(()=>{
  if(saved?.selection)return saved.selection;
  const start=Date.parse(params.get('start')||''),end=Date.parse(params.get('end')||'');
  if(!(begin<=start&&start<=Date.parse(p.utc)&&Date.parse(p.utc)<=end&&end<=begin+duration))return;
  const selected=r.points.filter(q=>start<=Date.parse(q.utc)&&Date.parse(q.utc)<=end);
  const first=selected[0],last=selected.at(-1);
  if(first&&last)return [first.utc,last.utc];
 });
 const selection=useInvestigationRange(r.points,left,width,initialRange);
 const x=(q:Point)=>10+780*(Date.parse(q.utc)-left)/width;
 const y=(q:Point)=>150-140*((q.value??min)-min)/(max-min||1);
 const pos=useQuery({queryKey:['historical-position',r.input.asset,p.utc],queryFn:()=>api('/telemetry/assets/'+r.input.asset+'/position?time='+encodeURIComponent(p.utc)),enabled:!!r.asset.tle,retry:false});
 function download(){
  const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([JSON.stringify({...r,review:r.review||''},null,2)],{type:'application/json'}));link.download='telemetry-'+r.id.slice(0,12)+'.json';link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);
 }
 return <section><h2>{r.asset.mission} · {r.channel} · 片段 {r.segment}</h2><p>{r.objective}</p><p>{r.start} 至 {r.end} · 单位 {r.asset.unit}</p>
 <label>曲线缩放<select value={zoom} onChange={e=>setZoom(+e.target.value)}>{[1,2,4,8].map(z=><option key={z} value={z}>{z}×</option>)}</select></label><button type="button" aria-pressed={selection.enabled} onClick={()=>{selection.setEnabled(!selection.enabled);play(false)}}>{selection.enabled?'结束框选':'框选调查'}</button>
 <svg className={selection.enabled?'telemetry-chart-select':undefined} {...selection.handlers} viewBox="0 0 800 165" role="img" aria-label="遥测时间序列，橙色为候选点">
 {selection.enabled&&<rect x={x(r.points[selection.range[0]])} y="0" width={Math.max(2,x(r.points[selection.range[1]])-x(r.points[selection.range[0]]))} height="165" fill="#6abbe8" opacity=".22" pointerEvents="none"/>}<path fill="none" stroke="#6abbe8" d={r.points.map((q,i)=>q.value===null?'':((!i||r.points[i-1].value===null||r.gaps.some(g=>g[1]===q.utc))?'M':'L')+x(q)+' '+y(q)).join(' ')}/>{r.points.map((q,i)=>q.value===null?null:<circle key={q.record} cx={x(q)} cy={y(q)} r={i===cursor?6:3} fill={r.candidates.includes(q.record)?'#ffb55c':'#90d4f2'} onClick={()=>{if(!selection.enabled)seek(i)}}/>)}<line x1={x(p)} x2={x(p)} y1="0" y2="160" stroke="white"/></svg>
 {selection.enabled&&<InvestigationPanel run={r.id} points={r.points} range={selection.range} update={selection.update} target={p.record} seek={seek} restored={saved?.investigation as InvestigationResult|undefined}/>}
 <button onClick={()=>{if(cursor===r.points.length-1)seek(0);play(!playing)}}>{playing?'暂停':'播放历史片段'}</button><label>片段时间轴<input type="range" min="0" max={r.points.length-1} value={cursor} onChange={e=>seek(+e.target.value)}/></label>
 <p id="telemetry-selected-record" tabIndex={-1}>{p.utc} · 原始记录 #{p.record} · {("quality" in p)?String(p.quality):"原始测量"} · {p.value??'缺测'}</p><details><summary>原始字段</summary><pre>{JSON.stringify(p.raw,null,2)}</pre></details>
 <InvestigationTask run={r.id} norad={r.asset.norad} record={p.record}
  start={selection.enabled?r.points[selection.range[0]].utc:undefined}
  end={selection.enabled?r.points[selection.range[1]].utc:undefined}
  onEvidence={record=>{const i=r.points.findIndex(item=>item.record===record);if(i>=0)seek(i);
   document.getElementById('telemetry-selected-record')?.focus();}}/>
 <p>有效样本 {r.stats.count} · 均值 {r.stats.mean} · 标准差 {r.stats.stdev} · 极差 {r.stats.span}</p>
 <p>独立复算 {r.stats.independentMean} · {r.stats.verified?'均值已核验':'复算冲突'}</p>
 <p>缺值 {r.missing.length} · 重复时刻 {r.duplicateTimes.length} · 乱序 {r.outOfOrder.length} · 采样间断 {('cadenceSeconds' in r.asset && r.asset.cadenceSeconds)?r.gaps.length:'缺少已核验采样间隔'}</p>
 <details><summary>质量记录与计算样本</summary><pre>{JSON.stringify({missing:r.missing,duplicates:r.duplicateTimes,disorder:r.outOfOrder,gaps:r.gaps,used:r.used},null,2)}</pre></details>
 <h3>异常候选 · {r.candidates.length}</h3><p>{r.rule.formula} · 阈值 {r.rule.threshold}</p><select aria-label="定位候选记录" value={r.candidates.includes(p.record)?p.record:''} onChange={e=>{const i=r.points.findIndex(q=>q.record===+e.target.value);if(i>=0)seek(i)}}><option value="">选择候选记录</option>{r.candidates.map(n=><option key={n} value={n}>记录 #{n}</option>)}</select>
 {r.assessments?.map(a=><p key={a.subject}>{a.subject} · {a.status} · {a.basis}</p>)}<details><summary>计算过程与单位换算</summary><pre>{JSON.stringify({steps:r.steps,conversions:r.conversions},null,2)}</pre></details><p>{r.limitations}</p><h3>同期轨道</h3>{pos.data?.ecef_m?<><Orbit position={pos.data}/><a className="button" href={'/explore?historical='+r.id+'&sat='+r.asset.norad+'&at='+encodeURIComponent(p.utc)}>在卫星探索中回放此时刻</a><p>历元 {pos.data.epoch} · {pos.data.source}</p></>:<p>{pos.error?.message||pos.data?.reason||(r.asset.tle?'正在推算位置':'缺少同期历史根数，位置证据不足')}</p>}
  {r.candidates.includes(p.record)&&<details><summary>当前候选复核 · #{p.record}</summary><p>{r.eventReviews?.[p.record]||'待人工确认'}</p><form key={p.record} onSubmit={async e=>{e.preventDefault();const note=String(new FormData(e.currentTarget).get('note')||'');try{await api('/telemetry/runs/'+r.id+'/events/'+p.record+'/review',{method:'PUT',body:JSON.stringify({note})});replace({...r,eventReviews:{...r.eventReviews,[p.record]:note}})}catch(err){setStatus(String(err))}}}><label>事件意见<textarea name="note" required maxLength={2000}/></label><button>保存事件意见</button></form></details>}
 <InvestigationEvidence run={r.id} norad={r.asset.norad} channel={r.channel}/><label>人工复核<textarea value={note} onChange={e=>setNote(e.target.value)}/></label><button disabled={!note.trim()} onClick={async()=>{try{await api('/telemetry/runs/'+r.id+'/review',{method:'PUT',body:JSON.stringify({note})});replace({...r,review:note});setStatus('复核已保存')}catch(e){setStatus(String(e))}}}>保存复核</button>
 <button onClick={async()=>{try{replace(await api('/telemetry/runs/'+r.id+'/replay',{method:'POST'}));setStatus('复跑摘要一致')}catch(e){setStatus(String(e))}}}>按原版本复跑</button><button onClick={download}>导出复盘报告</button><p role="status">{status}</p></section>;
}

export function TelemetryPage(){
 const {user}=useAuth(),cache=useQueryClient(),[params]=useSearchParams();
 const runId=params.get('run'),assetParam=params.get('asset'),segmentParam=params.get('segment'),channelParam=params.get('channel'),sessionId=params.get('session');
 const saved=useQuery({queryKey:['investigation-session',sessionId],enabled:!!sessionId,
  queryFn:()=>api<SavedInvestigation>('/investigation-tools/sessions/'+encodeURIComponent(sessionId!))});
 const [day,setDay]=useState(''),[goal,setGoal]=useState('历史片段异常候选复核');
 const [key,pick]=useState('opssat-v2'),[index,select]=useState(0),[start,setStart]=useState(''),[end,setEnd]=useState(''),[filter,search]=useState(''),[r,show]=useState<Report|null>(null),[error,fail]=useState('');
 useEffect(()=>{if(assetParam&&!runId){pick(assetParam);select(0);show(null)}},[assetParam,runId]);
 useEffect(()=>{if(!runId)return;
  let active=true;api<Report>('/telemetry/runs/'+encodeURIComponent(runId)).then(value=>{if(active){pick(value.input.asset);show(value)}}).catch(e=>{if(active)fail(String(e))});return()=>{active=false}
 },[runId]);
 const failed=useQuery({queryKey:['telemetry-failures'],queryFn:()=>api<unknown[]>('/telemetry/failures')});
 const assets=useQuery({queryKey:['telemetry-assets'],queryFn:()=>api<Asset[]>('/telemetry/assets')});
 const matches=(assets.data||[]).filter(a=>(a.mission+' '+a.norad).toLowerCase().includes(filter.toLowerCase())&&(!day||(!!a.coverageStart&&!!a.coverageEnd&&a.coverageStart.slice(0,10)<=day&&day<=a.coverageEnd.slice(0,10))));
 const info=useQuery({queryKey:['telemetry-detail',key],queryFn:()=>api<{meta:Asset;segments:Segment[]}>('/telemetry/assets/'+key)});
 useEffect(()=>{if(assetParam===key&&segmentParam&&info.data){
  const i=info.data.segments.findIndex(s=>s.segment===segmentParam&&(!channelParam||s.channel===channelParam));
  if(i>=0)select(i);
 }},[assetParam,key,segmentParam,channelParam,info.data]);
 const history=useQuery({queryKey:['telemetry-runs'],queryFn:()=>api<{id:string;channel:string;start:string;end:string;mission:string;norad:number}[]>('/telemetry/runs')});
 function reset(){select(0);setStart('');setEnd('');show(null);fail('')}
 async function run(){const seg=info.data?.segments[index];if(!seg)return;
 try{show(await api('/telemetry/runs',{method:'POST',body:JSON.stringify({asset:key,channel:seg.channel,segment:seg.segment,start:start||null,end:end||null,objective:goal})}));await history.refetch();fail('')}catch(e){await failed.refetch();fail(String(e))}}
 async function upload(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=new FormData(e.currentTarget);
 try{const file=form.get('file') as File;if(file.size>2000000)throw Error('文件上限 2 MB');const bytes=await file.arrayBuffer();const actual=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
 const {id}=await api('/telemetry/assets',{method:'POST',body:JSON.stringify({...Object.fromEntries(form),file:undefined,cadenceSeconds:form.has('cadenceSeconds'),content:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),sha256:form.get('sha256')||actual,norad:Number(form.get('norad'))})});await cache.invalidateQueries({queryKey:['telemetry-assets']});pick(id);reset()}catch(err){fail(String(err))}}
 return <main className="telemetry"><div className="telemetry-guide-header"><h1>历史遥测复盘</h1><GuideEntry/></div><section><label>查找任务或编号<input value={filter} onChange={e=>search(e.target.value)}/></label><label>覆盖日期（UTC）<input type="date" value={day} onChange={e=>setDay(e.target.value)}/></label>{(filter||day)&&<div>{matches.length?matches.map(a=><button key={a.id} onClick={()=>{pick(a.id);reset()}}>{a.mission} · {a.version}</button>):'无匹配档案'}</div>}<label>数据档案<select value={key} onChange={e=>{pick(e.target.value);reset()}}>{assets.data?.filter(a=>a.id===key||(a.mission+' '+a.norad).includes(filter)).map(a=><option key={a.id} value={a.id}>{a.mission} · {a.norad} · {a.version}</option>)}</select></label>
 {info.data&&<><details><summary>来源、版本与使用限制</summary><pre>{JSON.stringify(info.data.meta,null,2)}</pre></details><button onClick={()=>saveDownload('/telemetry/assets/'+key+'/original','telemetry-original.csv').catch(e=>fail(String(e)))}>下载原始记录</button>{info.data.meta.importProvenance!=null&&<ImportOriginalButton asset={key}/>}<p>来源 {info.data.meta.source} · 单位 {info.data.meta.unit}</p><label>通道及覆盖时间<select value={index} onChange={e=>{select(+e.target.value);setStart('');setEnd('');show(null)}}>{info.data.segments.map((s,i)=><option key={i} value={i}>{s.channel} / {s.segment} · {s.start} 至 {s.end}</option>)}</select></label><div className="time-fields"><label>开始时间<input placeholder="默认片段起点，或填写 ISO 时区时间" value={start} onChange={e=>setStart(e.target.value)}/></label><label>结束时间<input placeholder="默认片段终点" value={end} onChange={e=>setEnd(e.target.value)}/></label></div><details><summary>导入质量与采集时段</summary><pre>{JSON.stringify(info.data.segments[index],null,2)}</pre></details><label>分析目标<input value={goal} maxLength={180} onChange={e=>setGoal(e.target.value)}/></label><button disabled={!goal.trim()} onClick={run}>分析所选时间窗</button></>}</section>
 {!user?.isGuest&&<ImportMappingAssistant saved={id=>{void cache.invalidateQueries({queryKey:['telemetry-assets']});pick(id);reset()}}/>}
 {!user?.isGuest&&<details><summary>导入私有档案</summary><form onSubmit={upload}><p>UTF-8 CSV，每行包含 timestamp、channel、segment、value，时间须带时区。</p><label>档案类型<select name="kind"><option value="telemetry">遥测</option><option value="observation">授权地面观测</option></select></label><label>观测站标识（观测档案必填）<input name="station"/></label><label><input type="checkbox" name="cadenceSeconds"/>sampling 列表示采样间隔秒数</label>{[['mission','任务名称'],['norad','NORAD 编号'],['source','档案来源与授权'],['version','版本'],['unit','测量单位'],['sha256','来源 SHA-256（可选）'],['orbitSource','同期 TLE 来源（可选）']].map(([k,label])=><label key={k}>{label}<input name={k} required={!['sha256','orbitSource'].includes(k)}/></label>)}<label>同期 TLE（三行，可选）<textarea name="tle"/></label><input type="file" name="file" accept=".csv" required/><button>导入</button></form></details>}
 <details><summary>分析失败记录</summary><pre>{JSON.stringify(failed.data||[],null,2)}</pre></details><details><summary>历史报告</summary>{history.data?.filter(h=>(h.mission+" "+h.norad+" "+h.channel).toLowerCase().includes(filter.toLowerCase())&&(!day||(h.start.slice(0,10)<=day&&day<=h.end.slice(0,10)))).map(h=><button key={h.id} onClick={async()=>{try{show(await api('/telemetry/runs/'+h.id));fail('')}catch(e){fail(String(e))}}}>{h.mission} · {h.channel} · {h.start}</button>)}</details>
 <p role="alert">{error||info.error?.message||assets.error?.message||history.error?.message}</p>{saved.error&&<p role="alert">{saved.error.message}</p>}{r&&<Result key={[r.id,params.get('record'),params.get('start'),params.get('end'),saved.data?.report===r.id?saved.data.id:''].join(':')} r={r} replace={show} saved={saved.data?.report===r.id?saved.data:undefined}/>}</main>;
}
