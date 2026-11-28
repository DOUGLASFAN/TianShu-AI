import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {api} from './api';
import type {Findings} from './TaskResults';

export type SavedInvestigation={id:string;path:'/explore'|'/telemetry';query:string;camera?:number[];report?:string;selection?:string[];investigation?:unknown;workflow?:Findings};

export function InvestigationShelf({capture}:{capture?:()=>Omit<SavedInvestigation,'id'>}){
 const [open,toggle]=useState(false),[message,status]=useState(''),[busy,pending]=useState(false);
 const [filter,setFilter]=useState('');
 const saved=useQuery({queryKey:['saved-investigations'],enabled:open,queryFn:()=>api<SavedInvestigation[]>('/investigation-tools/sessions')});
 const term=filter.toLowerCase().trim();
 const matches=saved.data?.filter(s=>!term||[s.id,s.workflow?.mission,s.workflow?.channel,s.workflow?.point.record,s.workflow?.verdict]
  .filter(Boolean).join(' ').toLowerCase().includes(term));
 async function save(){
  if(!capture)return;
  pending(true);status('');
  try{
   await api('/investigation-tools/sessions',{method:'POST',body:JSON.stringify(capture())});
   status('调查现场已保存。');toggle(true);void saved.refetch();
  }catch(e){status(String(e))}
  finally{pending(false)}
 }
 return <section className="ai-shelf">
  <div className="investigation-actions">{capture&&<button type="button" disabled={busy} onClick={save}>保存调查现场</button>}
   <button type="button" aria-expanded={open} onClick={()=>toggle(!open)}>调查记录</button></div>
  {message&&<p role="status">{message}</p>}
  {open&&<>{saved.isPending&&<p>正在读取…</p>}{saved.error&&<p role="alert">{saved.error.message}</p>}
   {saved.data?.length===0&&<p>还没有保存的调查现场。</p>}
   {!!saved.data?.length&&<label>查找近期调查<input type="search" value={filter} onChange={e=>setFilter(e.target.value)} placeholder="任务、通道或记录号"/></label>}
   {term&&matches?.length===0&&<p role="status">没有找到匹配的调查。</p>}
   <ul>{matches?.map(s=><li key={s.id}><Link to={s.path+'?'+new URLSearchParams({...Object.fromEntries(new URLSearchParams(s.query)),session:s.id})}>
    {s.workflow?`${s.workflow.mission} · ${s.workflow.channel} · 记录 #${s.workflow.point.record}`:`恢复${s.path==='/explore'?'地图现场':'遥测调查'} · ${s.id.slice(0,8)}`}
   </Link>{s.workflow&&<p>{s.workflow.verdict}</p>}</li>)}</ul></>}
 </section>;
}
