import {useRef, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link, useNavigate} from 'react-router-dom';
import {api} from './api';
import './investigation.css';

type Bookmark = {id:string;time:string}&(
 {kind:'telemetry';run:string;mission:string;norad:number;record:number;orbit:boolean}
 | {kind:'pass';task:string;event:string;norad:number;visual:boolean}
 | {kind:'weather';category:string;source:string}
);

export function SmartBookmarks({start,end,formatTime}:{
 start?:string; end?:string; formatTime:(time:string)=>string
}){
 const dialog=useRef<HTMLDialogElement>(null);
 const navigate=useNavigate();
 const [open,setOpen]=useState(false),[all,setAll]=useState(false);
 const [busy,setBusy]=useState(false),[issue,setIssue]=useState('');
 const inRange=!all&&!!start&&!!end;
 const query=new URLSearchParams(inRange?{start:start!,end:end!}:{});
 const bookmarks=useQuery({
  queryKey:['investigation-bookmarks',query.toString()], enabled:open, refetchOnMount:'always',
  queryFn:()=>api<Bookmark[]>('/investigation/bookmarks?'+query),
 });
 async function openExample(){
  setBusy(true);setIssue('');
  try{
   const r=await api<{id:string;candidates:number[]}>('/telemetry/runs',{
    method:'POST',body:JSON.stringify({asset:'opssat-v2',channel:'CADC0872',segment:'8'}),
   });
   dialog.current?.close();
   navigate('/telemetry?run='+encodeURIComponent(r.id)+(r.candidates.length?'&record='+r.candidates[0]:''));
  }catch(error){setIssue(String(error))}
  finally{setBusy(false)}
 }
 return <>
  <button className="investigation-launch" type="button" aria-haspopup="dialog"
   onClick={()=>{setIssue('');dialog.current?.showModal();setOpen(true)}}>智能书签 · 异常调查</button>
  <dialog className="investigation-dialog" ref={dialog} aria-labelledby="bookmark-title" onClose={()=>setOpen(false)}>
   <div className="investigation-heading"><h2 id="bookmark-title">智能书签</h2><button type="button" onClick={()=>dialog.current?.close()}>关闭</button></div>
   <div className="investigation-example">
    <strong>试用公开案例</strong>
    <p>打开 OPS-SAT 片段 8，定位异常候选，然后在曲线上框选范围、复算并比较解释。</p>
    <button type="button" disabled={busy} onClick={openExample}>{busy?'正在打开…':'打开公开示例 · OPS-SAT 片段 8'}</button>
    {issue&&<p role="alert">{issue}</p>}
   </div>
   <h3>{all?'归档遥测候选':'当前时段的书签'}</h3>
   {start&&end&&<label className="investigation-archive-option"><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>查看所有时段的遥测候选</label>}
   {inRange&&<p>{formatTime(start!)} 至 {formatTime(end!)}</p>}
   {bookmarks.isFetching&&<p role="status">正在查找归档候选…</p>}
   {bookmarks.error&&<p role="alert">{bookmarks.error.message}</p>}
   {bookmarks.data?.length===0&&!bookmarks.isFetching&&<p>{inRange?'当前时段没有已收录的过境、空间环境记录或遥测候选。' :'暂无已归档的遥测候选。'}</p>}
   {bookmarks.data?.length?<ul className="bookmark-list">{bookmarks.data.map(item=><li key={item.kind+':'+item.id}>
    <time dateTime={item.time}>{formatTime(item.time)}</time>
    {item.kind==='telemetry'?<><strong>{item.mission} · 遥测候选 #{item.record}</strong><div className="investigation-actions">
     <Link to={'/telemetry?run='+item.run+'&record='+item.record} onClick={()=>dialog.current?.close()}>调查原始记录</Link>
     {item.orbit&&<Link to={'/explore?historical='+item.run+'&sat='+item.norad+'&at='+encodeURIComponent(item.time)} onClick={()=>dialog.current?.close()}>定位轨道回放</Link>}
    </div></>:item.kind==='pass'?<><strong>过境 · NORAD {item.norad}{item.visual?' · 具备目视条件':''}</strong><br/>
     <Link to={'/observations?task='+encodeURIComponent(item.task)+'&event='+encodeURIComponent(item.event)} onClick={()=>dialog.current?.close()}>查看过境结果</Link></>:<>
     <strong>空间环境 · {item.category}</strong><br/><Link to={'/environment?event='+encodeURIComponent(item.id)} onClick={()=>dialog.current?.close()}>查看来源记录</Link></>}
   </li>)}</ul>:null}
  </dialog>
 </>;
}
