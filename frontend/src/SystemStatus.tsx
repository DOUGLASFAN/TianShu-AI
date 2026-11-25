import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import {useEffect,useState} from 'react';
import {X} from '@phosphor-icons/react';
import {useAuth} from './auth';
import {api} from './api';
import './system-status.css';

export function SystemStatus(){
 const [dismissed,setDismissed]=useState(()=>{try{return sessionStorage.getItem('xingxu:status:dismissed')||'';}catch{return '';}});
 const auth=useAuth(),cache=useQueryClient();const status=useQuery({queryKey:['system-status'],queryFn:()=>api('/system/status'),refetchInterval:2000});
 const restore=useMutation({mutationFn:()=>api('/admin/demo',{method:'POST',body:JSON.stringify({enabled:false})}),onSuccess:()=>cache.invalidateQueries({queryKey:['system-status']})});
 const demo=status.data?.data.demo,phase=demo?.phase;
 useEffect(()=>{if(!phase)return;(window as any).starDemoPhase=phase;window.dispatchEvent(new CustomEvent('system:demo-phase',{detail:phase}));},[phase]);
 // Historical recovery results belong in source/task records, not a global alert.
 if(!['active','recovering'].includes(phase))return null;
 const identity=JSON.stringify([auth.user?.id,phase,demo.startedAt,demo.restoreRequestedAt]);
 const dismiss=()=>{setDismissed(identity);try{sessionStorage.setItem('xingxu:status:dismissed',identity);}catch{}};
 if(dismissed===identity)return phase==='active'?<aside className="system-status-chip" role="status">故障演示中<button onClick={()=>{setDismissed('');try{sessionStorage.removeItem('xingxu:status:dismissed');}catch{}}}>展开</button></aside>:null;
 return <aside className={`system-status-banner ${phase}`} role="status"><strong>{phase==='active'?'外部数据源故障演示中':'故障演示已关闭，正在检查来源'}</strong><span>{phase==='active'?'新外部请求将模拟失败，已有数据与本地计算保留。':'正在执行真实连通性与格式检查。'}</span>{auth.user?.role==='admin'&&phase==='active'&&<button disabled={restore.isPending} onClick={()=>restore.mutate()}>关闭演示并检查恢复</button>}{restore.error&&<span>{String(restore.error)}</span>}<button className="system-status-dismiss" aria-label="关闭状态提示" title="关闭状态提示" onClick={dismiss}><X size={18}/></button></aside>;
}
