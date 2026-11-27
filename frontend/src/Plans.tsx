import {useInteractiveGuide} from './InteractiveGuide';
import {useEffect,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from './api';
import {ArrowRight, CalendarBlank} from '@phosphor-icons/react';
import {Select} from './components/Select';
import './observations.css';
const names:Record<string,string>={upcoming:'即将开始',ongoing:'正在过境',ended:'已结束',cancelled:'已取消'};
export function Plans(){
 const guide=useInteractiveGuide();
 const cache=useQueryClient(),[params]=useSearchParams(),[selected,setSelected]=useState(params.get('plan')||''),[filter,setFilter]=useState('all'),[page,setPage]=useState(1);
 const plans=useQuery({queryKey:['plans',filter,page],queryFn:()=>api(`/plans?status=${filter}&page=${page}&size=6`)}),detail=useQuery({queryKey:['plan',selected],queryFn:()=>api(`/plans/${selected}`),enabled:!!selected,refetchInterval:15000});
 const cancel=useMutation({mutationFn:(p:any)=>api(`/plans/${p.id}/cancel`,{method:'POST',body:JSON.stringify({expectedVersion:p.version})}),onSuccess:()=>{cache.invalidateQueries({queryKey:['plans']});cache.invalidateQueries({queryKey:['plan',selected]});}});
 const cachedTotal=cache.getQueryData<{total:number}>(['plans','all',1])?.total??0;
 const showFilter=filter!=='all'||(plans.data?.total??cachedTotal)>0;
 const fmt=(v:string)=>new Date(v).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})+' UTC+8';const p=detail.data?.data;
 useEffect(()=>{if(p?.id&&p.id===params.get('plan'))guide?.signal('plan-viewed',p.id)},[p,guide,params]);
 return <section className="panel plans-panel" aria-labelledby="workspace-plans"><div className="section-heading"><h2 id="workspace-plans">观测计划</h2>{showFilter&&<Select label="计划状态筛选" value={filter} onChange={value=>{setFilter(value);setPage(1);}} options={[{value:'all',label:'全部计划'},...Object.entries(names).map(([value,label])=>({value,label}))]}/>}</div>
 {(plans.error||detail.error||cancel.error)&&<div className="notice error" role="alert">{String(plans.error||detail.error||cancel.error)}</div>}
 {plans.data?.list.map((item:any)=><article className={`plan-row ${selected===item.id?'selected':''}`} key={item.id}><button className="text-button" onClick={()=>setSelected(selected===item.id?'':item.id)}><strong>{item.snapshot.basis.satellite.name}</strong><span>{item.snapshot.basis.station.name} · {fmt(item.start)}</span></button><span className="plan-state">{names[item.status]} · v{item.version}</span><div className="plan-row-actions"><Link className="button" to={`/observations?plan=${item.id}`}>回放</Link><Link className="button" to={`/observations?replan=${item.id}&sat=${item.snapshot.basis.satellite.noradId}&station=${item.snapshot.basis.station.id}&min=${item.snapshot.basis.minElevation}&days=${item.snapshot.basis.days}&now=1`}>重新计算</Link>{item.status!=='cancelled'&&<button disabled={cancel.isPending} onClick={()=>{if(window.confirm('取消该计划并撤销尚未触发的提醒时间？'))cancel.mutate(item);}}>取消计划</button>}</div></article>)}
 {plans.isPending&&<p role="status">正在读取计划…</p>}
 {plans.data?.total===0&&<div className="utility-empty"><CalendarBlank size={22} aria-hidden="true"/>
  <p>{filter==='all'?'暂无观测计划':`暂无「${names[filter]}」的计划`}</p>
  {filter==='all'&&<Link className="button" to="/observations">前往观测规划 <ArrowRight size={15} aria-hidden="true"/></Link>}
 </div>}
 {plans.data?.total>6&&<div className="pagination"><span>{plans.data.total} 项计划</span><button disabled={page===1} onClick={()=>setPage(page-1)}>上一页</button><span>{page}</span><button disabled={page*6>=plans.data.total} onClick={()=>setPage(page+1)}>下一页</button></div>}
 {p&&<div className="plan-snapshot"><h3>{p.snapshot.basis.satellite.name} · 计划快照 v{p.version}</h3><p>{fmt(p.start)} — {fmt(p.end)} · {p.snapshot.basis.station.name}</p><p className="muted">站点：{p.snapshot.basis.station.latitude}°, {p.snapshot.basis.station.longitude}° / {p.snapshot.basis.station.elevation_m} m；最低仰角 {p.snapshot.basis.minElevation}°。提醒时间：{p.reminder?fmt(p.reminder.dueAt):'—'}（{p.reminder?.state==='sent'?'已生成通知':p.reminder?.state==='pending'?'待触发':p.reminder?.state==='missed'?'已错过':'已撤销'}）。</p><details><summary>版本记录与计算依据</summary><p className="muted">{p.snapshot.basis.algorithm} · 根数历元 {p.snapshot.basis.orbit.epoch}</p>{detail.data.versions.map((v:any)=><p className="muted" key={v.version}>v{v.version} · {fmt(v.createdAt)} · {({created:'创建',cancelled:'取消',recalculated:'重算确认'} as any)[v.data.action]}</p>)}</details></div>}
 </section>;
}
