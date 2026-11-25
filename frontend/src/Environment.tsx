import {useEffect,useRef,useState} from 'react';
import {useSearchParams} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {ArrowClockwise,ArrowUpRight,ChartLine,Sun,ShieldWarning,X,Database} from '@phosphor-icons/react';
import {api,saveDownload} from './api';
import {Select} from './components/Select';
import {useMobileLayout} from './mobileLayout';
import './environment.css';

const kinds:Record<string,string>={observation:'观测',forecast:'预测',warning:'官方预警／警报',notice:'官方通报'};
const bulletinNames:Record<string,string>={ALERT:'警报',WARNING:'预警',WATCH:'关注',SUMMARY:'摘要',NOTICE:'通报','CONTINUED ALERT':'持续警报','EXTENDED WARNING':'延长预警','CANCEL WARNING':'撤销预警','CANCEL WATCH':'撤销关注'};
const categories:Record<string,string>={flare:'太阳耀斑',cme:'日冕物质抛射',geomagnetic:'地磁活动',radiation:'辐射环境',radio:'射电活动',other:'其他'};
const states:Record<string,string>={available:'数据可用',stale:'数据过期',unknown:'状态未知'};
const fmt=(v?:string|null)=>v?new Date(v).toLocaleString('zh-CN',{hour12:false,timeZone:'UTC'})+' UTC':'未提供';
function MetricTime({label,value}:{label:string;value?:string|null}){
 const timestamp=value?new Date(value).toISOString():'';
 return <div className="weather-metric-time"><span>{label}</span>{timestamp?
  <time dateTime={value??undefined}><span>{timestamp.slice(0,10)}</span><span>{timestamp.slice(11,19)} UTC</span></time>:
  <span>未提供</span>}</div>;
}
const impact:Record<string,string>={flare:'耀斑可能影响日照侧高频无线电通信；实际影响取决于事件强度、频段与传播条件。',cme:'日冕物质抛射不等于已经抵达地球；是否影响地球需要结合传播预测和后续观测。',geomagnetic:'地磁活动可能影响卫星姿态、轨道阻力和导航精度；全球指标不能确定某地点已发生故障。',radiation:'高能粒子环境可能影响航天器电子设备与充电状态，单份通报不能确定某颗卫星受损。',radio:'射电活动可与太阳爆发相关；不能据此断言本地通信已中断。',other:'应结合原始通报、事件时效和实际设备观测判断影响。'};

function Trend({points,forecast,stale}:{points:any[];forecast?:boolean;stale:boolean}){
 const host=useRef<HTMLDivElement>(null),[width,setWidth]=useState(700),[hover,setHover]=useState<number|null>(null);
 const hasPoints=points.length>0;
 useEffect(()=>{
  const node=host.current;
  if(!node)return;
  const observer=new ResizeObserver(([entry])=>{
   if(entry.contentRect.width>0)setWidth(Math.round(entry.contentRect.width));
  });
  observer.observe(node);
  return()=>observer.disconnect();
 },[hasPoints]);
 if(!points.length)return <div className="weather-chart-empty"><ChartLine size={32}/><p>暂无{forecast?'预测':'观测'}数据</p><span>来源恢复后自动更新</span></div>;
 const begin=Date.parse(points[0].time),end=Date.parse(points.at(-1).time),left=28,right=12,base=146,chartWidth=width-left-right;
 const x=(t:string)=>left+(Date.parse(t)-begin)/Math.max(1,end-begin)*chartWidth,y=(v:number)=>base-v/9*132;
 const path=points.map((p,i)=>`${!i||Date.parse(p.time)-Date.parse(points[i-1].time)>4*3600000?'M':'L'}${x(p.time)},${y(p.kp)}`).join(' '),picked=hover===null?null:points[hover];
 return <div className={`weather-chart ${stale?'is-stale':''}`} ref={host}><svg viewBox={`0 0 ${width} 174`} role="img" aria-label={`${forecast?'预测':'观测'} Kp 趋势，${points.length} 个数据点，数值范围零至九`} onPointerMove={e=>{const r=e.currentTarget.getBoundingClientRect(),position=(e.clientX-r.left)*width/r.width,t=begin+Math.max(0,Math.min(1,(position-left)/chartWidth))*(end-begin);setHover(points.reduce((best,p,i)=>Math.abs(Date.parse(p.time)-t)<Math.abs(Date.parse(points[best].time)-t)?i:best,0));}} onPointerLeave={()=>setHover(null)}>
 {[0,3,5,7,9].map(v=><g key={v}><line x1={left} x2={width-right} y1={y(v)} y2={y(v)} stroke={v===5?'#a78a59':'#344b5e'} strokeDasharray={v===5?'4 4':undefined}/><text x={left-8} y={y(v)+4} textAnchor="end">{v}</text></g>)}
 <path d={path} fill="none" stroke={stale?'#8296a7':forecast?'#d5b57b':'#69c5ff'} strokeWidth={2.5} strokeDasharray={forecast?'7 5':undefined}/>
 {points.map((p,i)=><circle key={i} cx={x(p.time)} cy={y(p.kp)} r={hover===i?4.5:2} fill={forecast?'#d5b57b':'#69c5ff'}/>)}
 {(begin===end?[points[0]]:[points[0],points.at(-1)]).map((p,i)=><text key={i} x={x(p.time)} y={166} textAnchor={i?'end':'start'}>{new Date(p.time).toISOString().slice(5,16).replace('T',' ')} UTC</text>)}
 {picked&&<line x1={x(picked.time)} x2={x(picked.time)} y1={y(9)} y2={base} stroke="#cbd8e3" strokeDasharray="3 3"/>}</svg><p className="weather-chart-caption">{picked?`${fmt(picked.time)} · Kp ${picked.kp.toFixed(2)}`:forecast?'虚线为源站预测值':'实线为源站观测值；间隔超过四小时的缺口不连线'}</p><details className="weather-chart-table"><summary>查看数值</summary><div className="table-scroll"><table><thead><tr><th>时间 UTC</th><th>Kp</th><th>属性</th></tr></thead><tbody>{points.map((p,i)=><tr key={i}><td>{fmt(p.time)}</td><td>{p.kp.toFixed(2)}</td><td>{p.quality==='definitive'?'最终值':p.quality==='preliminary_nowcast'?'暂定值':kinds[p.kind]}</td></tr>)}</tbody></table></div></details></div>;
}

function EventDetail({id,onClose}:{id:string;onClose:()=>void}){
 const dialog=useRef<HTMLDialogElement>(null),focus=useRef(document.activeElement as HTMLElement|null),detail=useQuery({queryKey:['weather-event',id],queryFn:()=>api(`/environment/events/${id}`)}),event=detail.data?.data;
 useEffect(()=>{const previous=document.body.style.overflow;document.body.style.overflow='hidden';dialog.current?.showModal();return()=>{dialog.current?.close();document.body.style.overflow=previous;focus.current?.isConnected&&focus.current.focus();};},[]);
 return <dialog ref={dialog} className="weather-dialog" aria-labelledby="weather-detail-title" onCancel={e=>{e.preventDefault();onClose();}}><header><div><span>{event?kinds[event.kind]:'事件详情'}</span><h2 id="weather-detail-title">{event?.title||'正在读取事件'}</h2></div><button aria-label="关闭事件详情" onClick={onClose}><X size={20}/></button></header><div className="weather-dialog-body">{detail.error&&<p className="notice error" role="alert">{String(detail.error)}</p>}{event&&<><div className="weather-event-meta"><div><span>来源</span><strong>{event.sourceName}</strong></div><div><span>类别</span><strong>{categories[event.category]}</strong></div><div><span>发布时间</span><strong>{fmt(event.issuedAt)}</strong></div><div><span>发生时间</span><strong>{fmt(event.occurredAt)}</strong></div><div><span>采集时间</span><strong>{fmt(event.fetchedAt)}</strong></div><div><span>源站等级</span><strong>{event.officialScale||'来源未提供'}</strong></div></div>
 {event.kind==='warning'&&<p className="weather-detail-validity">{event.validity==='cancelled'?'该通报已撤销':event.validity==='expired'?'该通报已超出原文有效期':event.validity==='within_validity'?'仍处于原文给出的有效期；以源站后续更新为准':'原文未提供可解析的有效期，不据此判定当前仍在生效'}{event.validTo&&` · 截止 ${fmt(event.validTo)}`}</p>}
 {detail.data.source.state!=='available'&&<p className="notice observation-warning">该来源数据已过期或不可用，以下为保存的历史记录。</p>}
 <section className="weather-impact"><h3>影响解读</h3><p>{impact[event.category]}</p></section><div className="section-heading"><h3>源站原文</h3><a href={event.url} target="_blank" rel="noreferrer">打开来源<ArrowUpRight size={16}/></a></div><pre className="weather-original">{event.text||'该事件没有文字说明，详细字段见原始记录。'}</pre><details className="weather-raw"><summary>原始记录与采集依据</summary><p>采集记录 {event.runId}</p><pre>{JSON.stringify(detail.data.raw,null,2)}</pre></details></>}</div></dialog>;
}

export function Environment(){
 const mobile=useMobileLayout();
 const [view,setView]=useState<'trend'|'events'|'sources'>('trend');
 const [params,setParams]=useSearchParams(),kind=params.get('kind')||'all',category=params.get('category')||'all',source=params.get('source')||'all',days=Number(params.get('days'))||7,page=Number(params.get('page'))||1,event=params.get('event')||'',hours=Number(params.get('hours'))||72;
 const overview=useQuery({queryKey:['weather-overview'],queryFn:()=>api('/environment'),refetchInterval:60000}),events=useQuery({queryKey:['weather-events',kind,category,source,days,page],queryFn:()=>api(`/environment/events?kind=${kind}&category=${category}&source=${source}&days=${days}&page=${page}`),refetchInterval:60000});
 const [sourceId,setSourceId]=useState('');const runs=useQuery({queryKey:['weather-runs',sourceId],queryFn:()=>api(`/environment/sources/${sourceId}/runs`),enabled:!!sourceId});
 function change(key:string,value:string){setParams(p=>{const n=new URLSearchParams(p);value?n.set(key,value):n.delete(key);if(!['page','event','hours'].includes(key))n.delete('page');return n;});}
 const data=overview.data?.data,observation=data?.observation,forecast=data?.forecast,sources=data?.sources||[],observedSource=sources.find((s:any)=>s.id===observation?.sourceId),forecastSource=sources.find((s:any)=>s.id==='noaa-forecast'),noticeSource=sources.find((s:any)=>s.id==='noaa-alerts');
 const points=(data?.trend||[]).filter((p:any)=>Date.parse(p.time)>=Date.parse(data.asOf)-hours*3600000);
 return <div className="environment-page" data-mobile-view={mobile?view:undefined}><div className="page-heading"><h1>空间环境</h1><button onClick={()=>{overview.refetch();events.refetch();}} disabled={overview.isFetching||events.isFetching}><ArrowClockwise size={17}/>刷新视图</button></div>
 {(overview.error||events.error)&&<p className="notice error" role="alert">{String(overview.error||events.error)}{data?'；保留上次读取结果。':''}</p>}
 <div className="weather-metrics">
  <section className="panel weather-metric">
   <h2 className="weather-metric-heading"><span><ChartLine size={17} aria-hidden="true"/>地磁观测</span><span className={`weather-state ${observation?.state||'unknown'}`}>{states[observation?.state||'unknown']}</span></h2>
   <div className="weather-metric-value">{observation?.latest?.kp.toFixed(2)??'—'}<small>Kp</small></div>
   <p>{observation?.label||'状态未知'}{observation?.latest?.quality==='preliminary_nowcast'?' · 暂定值':''}{observation?.state==='stale'?' · 保留值':''}</p>
   <MetricTime label="观测时刻" value={observation?.latest?.time}/>
   <small>{observedSource?.name||'等待有效来源'}</small>
  </section>
  <section className="panel weather-metric">
   <h2 className="weather-metric-heading"><span><Sun size={17} aria-hidden="true"/>地磁预测</span><span className={`weather-state ${forecast?.state||'unknown'}`}>{states[forecast?.state||'unknown']}</span></h2>
   <div className="weather-metric-value">{forecast?.peak?.kp.toFixed(2)??'—'}<small>Kp</small></div>
   <p>{forecast?.peak?'预测峰值':'暂无有效预测'}</p>
   <MetricTime label="峰值时刻" value={forecast?.peak?.time}/>
   <small>NOAA SWPC · 采集于 {fmt(forecastSource?.fetchedAt)} · 预测值不代表已发生</small>
  </section>
 <section className="panel weather-metric weather-notice-card"><div className="weather-metric-heading"><span><ShieldWarning size={19}/>官方空间天气通报</span><span className={`weather-state ${noticeSource?.state||'unknown'}`}>{states[noticeSource?.state||'unknown']}</span></div><div className="weather-metric-value">{data?.officialNoticeCount??'—'}<small>近 7 天通报</small></div><p>通报的发布时间与有效期，以原文为准。</p><time>采集于 {fmt(noticeSource?.fetchedAt)}</time><button className="text-button" onClick={()=>{if(mobile)setView('events');change('kind','warning');}}>查看官方预警／警报<ArrowUpRight size={16}/></button></section></div>
 {mobile&&<div className="weather-view-switch" role="group" aria-label="空间环境视图">
  <button type="button" aria-pressed={view==='trend'} onClick={()=>setView('trend')}>趋势</button>
  <button type="button" aria-pressed={view==='events'} onClick={()=>setView('events')}>通报</button>
  <button type="button" aria-pressed={view==='sources'} onClick={()=>setView('sources')}>来源</button>
 </div>}
 <section className="panel weather-trends"><div className="section-heading"><h2>地磁活动趋势</h2><div className="weather-period" role="group" aria-label="趋势范围">{[24,72].map(h=><button key={h} aria-pressed={hours===h} onClick={()=>change('hours',String(h))}>{h} 小时</button>)}</div></div><div className="weather-trend-grid"><div><div className="weather-subheading"><h3>观测</h3><span>{observedSource?.name||'暂无来源'}</span></div><Trend points={points} stale={observation?.state!=='available'}/></div><div><div className="weather-subheading"><h3>预测</h3><span>NOAA SWPC · 三小时采样</span></div><Trend points={forecast?.points||[]} forecast stale={forecast?.state!=='available'}/></div></div></section>
 <section className="panel weather-events"><div className="section-heading"><h2>事件与通报</h2><span>{events.data?.total??'—'} 条</span></div><div className="weather-filters"><Select label="事件属性" value={kind} onChange={v=>change('kind',v)} options={[{value:'all',label:'全部属性'},...Object.entries(kinds).map(([value,label])=>({value,label}))]}/><Select label="事件类别" value={category} onChange={v=>change('category',v)} options={[{value:'all',label:'全部类别'},...Object.entries(categories).map(([value,label])=>({value,label}))]}/><Select label="事件来源" value={source} onChange={v=>change('source',v)} options={[{value:'all',label:'全部来源'},...sources.filter((s:any)=>s.id.includes('alerts')||s.id.startsWith('donki')).map((s:any)=>({value:s.id,label:s.name}))]}/><Select label="事件时间范围" value={String(days)} onChange={v=>change('days',v)} options={[1,7,30].map(v=>({value:String(v),label:`最近 ${v} 天`}))}/></div>
 {events.isPending?<div className="empty">正在读取事件…</div>:events.data?.list.length?<div className="weather-event-list">{events.data.list.map((e:any)=><button key={e.id} className="weather-event-row" onClick={()=>change('event',e.id)}><span className={`weather-kind ${e.kind}`}>{kinds[e.kind]}</span><div><strong>{e.title}{e.officialScale&&<span>{e.officialScale}</span>}</strong><p>{e.sourceName} · {e.bulletinType?(bulletinNames[e.bulletinType]||'官方通报'):categories[e.category]}</p></div><time>{fmt(e.issuedAt||e.occurredAt)}<small>{e.issuedAt?'发布时间':'发生时间'}</small></time><ArrowUpRight size={18}/></button>)}</div>:<div className="empty">{mobile?'当前条件下暂无已采集记录。请切换到「来源」查看采集状态。':'当前条件下没有已采集记录；来源状态见下方。没有记录不代表没有空间天气活动。'}</div>}
 <div className="pagination"><span>按发布时间排序；未提供时使用发生时间</span><button disabled={page<=1} onClick={()=>change('page',String(page-1))}>上一页</button><span>{page} / {Math.max(1,Math.ceil((events.data?.total||0)/8))}</span><button disabled={page*8>=(events.data?.total||0)} onClick={()=>change('page',String(page+1))}>下一页</button></div></section>
 <section className="panel weather-sources"><div className="section-heading"><h2>数据来源</h2><Database size={20}/></div><div className="weather-source-grid">{sources.map((s:any)=><article key={s.id}><div><h3>{s.name}</h3><span className={`weather-state ${s.state}`}>{states[s.state]}</span></div><p>数据时刻 {fmt(s.sourceTime)}</p><p>采集时间 {fmt(s.fetchedAt)}</p>{s.usingLastGood&&<p className="weather-fallback">本次采集失败，保留上次有效数据</p>}{s.state==='unknown'&&<p className="weather-fallback">{s.lastAttemptStatus==='failed'?'来源暂不可达，尚无有效数据':'等待首次有效采集'}</p>}{s.license&&<small>{s.license}</small>}<div className="weather-source-actions"><a href={s.url} target="_blank" rel="noreferrer">来源<ArrowUpRight size={14}/></a><button className="text-button" onClick={()=>setSourceId(sourceId===s.id?'':s.id)}>采集记录</button>{s.runId&&<a href={`/api/environment/snapshots/${s.runId}/raw`} onClick={async e=>{e.preventDefault();try{await saveDownload(`/environment/snapshots/${s.runId}/raw`,`${s.id}.txt`);}catch(error){window.alert(String(error));}}}>保存原始数据</a>}</div>{sourceId===s.id&&<div className="weather-source-runs">{runs.isPending?'读取中…':runs.error?'采集记录读取失败':runs.data?.list.map((r:any)=><p key={r.id}>{r.status==='success'?'成功':r.status==='running'?'采集中':'失败'} · {fmt(r.startedAt)} · {r.records} 条 {r.errorCode||''}</p>)}</div>}</article>)}</div></section>
 <p className="weather-interpretation">{data?.interpretation||'空间天气指标用于解释全球环境，不用于判断本地设备故障。'}</p>{event&&<EventDetail id={event} onClose={()=>change('event','')}/>}</div>;
}
