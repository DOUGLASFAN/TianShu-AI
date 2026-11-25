import {useEffect,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {Bell,Check,CheckCircle,ArrowRight} from '@phosphor-icons/react';
import {api,ApiError} from './api';
import './environment.css';

export function NotificationBell(){
 const cache=useQueryClient(),[connected,setConnected]=useState(false);
 const summary=useQuery({queryKey:['notification-summary'],queryFn:()=>api('/notifications?size=1'),refetchInterval:30000});
 useEffect(()=>{let stopped=false,ws:WebSocket|undefined,timer:ReturnType<typeof setTimeout>,attempt=0;
  async function connect(){try{const ticket=await api('/realtime/ticket',{method:'POST'});if(stopped)return;
   let stream='',seq=0;ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/realtime/ws`);
   ws.onopen=()=>ws?.send(JSON.stringify({type:'auth',ticket:ticket.ticket}));
   ws.onmessage=e=>{if(stopped)return;let m;try{m=JSON.parse(e.data);}catch{return;}
    if(m.streamId!==stream){if(m.type!=='snapshot')return;stream=m.streamId;seq=0;}if(m.seq<=seq)return;seq=m.seq;
    if(m.type==='heartbeat'){ws?.send(JSON.stringify({type:'pong'}));return;}
    if(m.type==='notifications'){setConnected(true);attempt=0;cache.setQueryData(['notification-summary'],m.data);cache.invalidateQueries({queryKey:['notification-list']});cache.invalidateQueries({queryKey:['plans']});cache.invalidateQueries({queryKey:['plan']});(window as any).notificationDiagnostics={...m.data,connected:true};}
   };
   ws.onclose=e=>{if(stopped)return;setConnected(false);if(e.code===4401){window.dispatchEvent(new Event('auth:expired'));return;}timer=setTimeout(connect,Math.min(30000,1000*2**Math.min(attempt++,5)));};ws.onerror=()=>ws?.close();
  }catch(error){if(stopped)return;setConnected(false);if(error instanceof ApiError&&error.code==='SESSION_INVALID')return;timer=setTimeout(connect,Math.min(30000,1000*2**Math.min(attempt++,5)));}}
  connect();return()=>{stopped=true;clearTimeout(timer);ws?.close();};
 },[cache]);
 const count=summary.data?.unread||0;
 return <Link className="notification-bell" to="/notifications" aria-label={`通知中心${count?'，'+count+' 条未读':''}`} title={connected?'通知中心':'通知中心 · 推送重连中，定时刷新'}><Bell size={21}/>{count>0&&<span>{count>99?'99+':count}</span>}<span className="sr-only" role="status" aria-live="polite">{count} 条未读通知</span></Link>;
}

const fmt=(v:string)=>new Date(v).toLocaleString('zh-CN',{hour12:false,timeZone:'Asia/Shanghai'})+' UTC+8';
export function Notifications(){
 const cache=useQueryClient(),[params,setParams]=useSearchParams(),unread=params.get('unread')==='1',page=Number(params.get('page'))||1;
 const list=useQuery({queryKey:['notification-list',unread,page],queryFn:()=>api(`/notifications?unread=${unread}&page=${page}`),refetchInterval:15000});
 function refresh(){cache.invalidateQueries({queryKey:['notification-list']});cache.invalidateQueries({queryKey:['notification-summary']});}
 const mark=useMutation({mutationFn:(id:string)=>api(`/notifications/${id}/read`,{method:'POST'}),onSuccess:refresh}),all=useMutation({mutationFn:()=>api('/notifications/read-all',{method:'POST'}),onSuccess:refresh});
 function change(key:string,value:string){setParams(p=>{const next=new URLSearchParams(p);next.set(key,value);if(key!=='page')next.delete('page');return next;});}
 return <div className="notifications-page"><div className="page-heading"><h1>通知中心</h1><button disabled={!list.data?.list.some((n:any)=>!n.readAt)||all.isPending} onClick={()=>all.mutate()}><CheckCircle size={18}/>全部已读</button></div>
 <div className="notification-tabs" role="group" aria-label="通知筛选"><button aria-pressed={!unread} onClick={()=>change('unread','0')}>全部</button><button aria-pressed={unread} onClick={()=>change('unread','1')}>未读 {list.data?.unread??0}</button></div>
 {(list.error||mark.error||all.error)&&<p className="notice error" role="alert">{String(list.error||mark.error||all.error)}</p>}
 <section className="panel notification-list" aria-label="站内通知">{list.isPending?<div className="empty">正在读取通知…</div>:list.data?.list.length?list.data.list.map((n:any)=><article key={n.id} className={`notification-row ${!n.readAt&&!n.revokedAt?'unread':''}`}><div className="notification-row-icon"><Bell size={22}/></div><div className="notification-row-main"><div className="notification-title"><h2>{n.data.satellite.name}</h2><span>{n.revokedAt?'此版本已撤销':n.readAt?'已读':'未读'}</span></div><p>{n.data.station} · 预计 {fmt(n.data.start)} 进入</p><small>提前 {n.data.threshold} 分钟提醒 · 计划 v{n.data.version}</small><time>产生于 {fmt(n.createdAt)}</time>{n.revokedAt&&<p className="muted">计划已取消或重算，请以当前计划为准。</p>}<div className="notification-row-actions">{n.planId?<Link className="button" to={`/workspace?plan=${n.planId}`} onClick={()=>{if(!n.readAt)mark.mutate(n.id);}}>查看计划<ArrowRight size={16}/></Link>:<span>原计划已删除</span>}{!n.readAt&&<button disabled={mark.isPending} onClick={()=>mark.mutate(n.id)}><Check size={16}/>标为已读</button>}</div></div></article>):<div className="notification-empty"><Bell size={34}/><h2>{unread?'暂无未读通知':'暂无通知'}</h2><Link to="/observations">前往观测规划<ArrowRight size={16}/></Link></div>}</section>
 {list.data?.total>10&&<div className="pagination"><button disabled={page<=1} onClick={()=>change('page',String(page-1))}>上一页</button><span>{page} / {Math.ceil(list.data.total/10)}</span><button disabled={page*10>=list.data.total} onClick={()=>change('page',String(page+1))}>下一页</button></div>}
 </div>;
}
