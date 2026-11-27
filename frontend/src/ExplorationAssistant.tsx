import {useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {api} from './api';
import './investigation.css';

type Action={intent:'search'|'observe'|'bookmarks'|'diagnose'|'unsupported';query:string;group:string;station:string;window:'now'|'tonight'|'next-day'};
type Station={id:string;name:string;lat:number;lng:number};
type Window={norad:number;name:string;start:string;end:string;peak:string;elevation:number;duration:number;optical:boolean;visibleNow:boolean;orbitEpoch:string};
type Results={start:string;end:string;targets:number;limited:boolean;scope:string;scenarios:{station:Station;minimum:number;windows:Window[];skipped:{norad:number;reason:string}[];total:number;opticalWindows:number}[]};
const blank:Action={intent:'search',query:'',group:'',station:'',window:'next-day'};
const groups=[['','全部目录'],['STATIONS','空间站'],['BEIDOU','北斗'],['GPS-OPS','GPS'],['GALILEO','伽利略']];

export function ObservationComparison({initial,defaultQuery='',onLocate,compare=false}:{
 initial?:Action;defaultQuery?:string;onLocate?:(norad:number,station:Station)=>void;compare?:boolean
}){
 const [query,setQuery]=useState(initial?.query??defaultQuery),[group,setGroup]=useState(initial?.group??'');
 const [station,setStation]=useState(initial?.station||''),[second,setSecond]=useState(''),[minimum,setMinimum]=useState(15),[other,setOther]=useState(30);
 const [window,setWindow]=useState<Action['window']>(initial?.window||'tonight');
 const [result,setResult]=useState<Results|null>(null),[issue,setIssue]=useState(''),[busy,setBusy]=useState(false);
 const [submittedNow,setSubmittedNow]=useState(false);
 const stations=useQuery({queryKey:['stations'],queryFn:()=>api<{list:{id:string;name:string}[]}>('/stations')});
 const defaults=stations.data?.list??[];
 async function run(){
  setBusy(true);setIssue('');setResult(null);setSubmittedNow(window==='now');
  try{setResult(await api<Results>('/exploration-assistant/observation',{
   method:'POST',body:JSON.stringify({query,group,window,scenarios:[
    {station:station||defaults[0]?.id,minimum},...(compare?[{station:second||station||defaults[0]?.id,minimum:other}]:[]),
   ]}),
  }))}catch(e){setIssue((e as {code?:string}).code==='AI_OBSERVATION_STATION'?'未找到唯一匹配的站点，请选用已有观测站。':String(e))}
  finally{setBusy(false)}
 }
 return <form className="ai-tool-form" onSubmit={e=>{e.preventDefault();void run()}}>
  <div className="ai-field-grid">
   <label>卫星名称或 NORAD<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="ISS；留空使用代表卫星"/></label>
   <label>星座<select value={group} onChange={e=>setGroup(e.target.value)}>{groups.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
   <label>观测站<input value={station} onChange={e=>setStation(e.target.value)} placeholder={defaults[0]?.name||'输入已有站名'} list="ai-stations"/></label>
   <label>最低仰角（°）<input type="number" min={0} max={85} value={minimum} onChange={e=>setMinimum(+e.target.value)}/></label>
   <label>时间范围<select value={window} onChange={e=>setWindow(e.target.value as Action['window'])}><option value="now">当前在站上空</option><option value="tonight">今晚（北京时间）</option><option value="next-day">未来 24 小时</option></select></label>
   {compare&&<><label>对照观测站<input value={second} onChange={e=>setSecond(e.target.value)} placeholder="留空使用同一站" list="ai-stations"/></label>
    <label>对照最低仰角（°）<input type="number" min={0} max={85} value={other} onChange={e=>setOther(+e.target.value)}/></label></>}
  </div>
  <datalist id="ai-stations">{defaults.map(s=><option key={s.id} value={s.name}/>)}</datalist>
  <button disabled={busy||(!station&&!defaults.length)}>{busy?'正在计算可见窗口…':compare?'比较两套方案':'计算观测窗口'}</button>
  {issue&&<p role="alert">{issue}</p>}
  {result&&<><p>{result.scope} 实际计算范围：{result.start} 至 {result.end}。</p>
   <div className="ai-field-grid">{result.scenarios.map((s,i)=>{
    const rows=submittedNow?s.windows.filter(w=>w.visibleNow):s.windows;
    return <section key={i} className="ai-result"><h4>{s.station.name} · 最低仰角 {s.minimum}°</h4>
     <p>{submittedNow?'当前满足仰角的窗口 '+rows.length:s.total+' 个过境窗口 · '+s.opticalWindows+' 个含潜在目视窗口'}</p>
     {rows.length===0&&<p>本次没有匹配窗口。</p>}
     {rows.slice(0,5).map(w=><article key={w.norad+w.start}><strong>{w.name}</strong>
      <p>{w.start} 至 {w.end} · {Math.round(w.duration)} 秒 · 最高 {w.elevation.toFixed(1)}°</p>
      <p>{w.optical?'存在潜在目视窗口':'仅几何过境'} · 根数历元 {w.orbitEpoch}</p>
      <div className="investigation-actions">
       {onLocate&&<button type="button" onClick={()=>onLocate(w.norad,s.station)}>在地球定位站点和卫星</button>}
       <Link to={'/observations?'+new URLSearchParams({sat:String(w.norad),station:s.station.id,min:String(s.minimum),draft:'1',from:new Date(result.start).toISOString().slice(0,19),tz:'utc',now:'0'})}>采用条件并生成可保存计划</Link>
      </div>
     </article>)}
     {s.skipped.length>0&&<p>跳过 {s.skipped.length} 颗：{[...new Set(s.skipped.map(x=>x.reason))].join('、')}</p>}
    </section>
   })}</div></>}
 </form>;
}

export function ExploreAssistant({apply,locate,diagnose,bookmarks}:{
 apply:(query:string,group:string)=>void;locate:(norad:number,station:Station)=>void;
 diagnose:()=>void;bookmarks:()=>void
}){
 const dialog=useRef<HTMLDialogElement>(null);
 const [text,setText]=useState(''),[action,setAction]=useState<Action|null>(null);
 const [model,setModel]=useState(''),[busy,setBusy]=useState(false),[issue,setIssue]=useState('');
 async function interpret(){
  setBusy(true);setIssue('');setAction(null);
  try{const result=await api<{action:Action;model:string}>('/exploration-assistant/interpret',{method:'POST',body:JSON.stringify({text})});setAction(result.action);setModel(result.model)}
  catch{setIssue('模型暂时不可用，请手动填写筛选或观测条件。');setAction(blank);setModel('')}
  finally{setBusy(false)}
 }
 function close(){dialog.current?.close()}
 return <>
  <button className="investigation-launch" onClick={()=>dialog.current?.showModal()} aria-haspopup="dialog">AI 探索指令</button>
  <dialog ref={dialog} className="investigation-dialog" aria-label="AI 探索指令">
   <div className="investigation-heading"><h2>AI 探索指令</h2><button onClick={close}>关闭</button></div>
   <label>你想找什么？<textarea rows={2} value={text} maxLength={400} onChange={e=>setText(e.target.value)} placeholder="今晚从北京能看到 ISS 吗？"/></label>
   <div className="investigation-actions">
    <button disabled={busy||text.trim().length<2} onClick={interpret}>{busy?'正在理解指令…':'生成可编辑动作'}</button>
    <button onClick={()=>{setAction({...blank,intent:'observe'});setModel('');setIssue('')}}>手动计算观测</button>
   </div>
   {issue&&<p role="alert">{issue}</p>}{model&&<p>动作由 {model} 解析，确认条件后执行。</p>}
   {action?.intent==='observe'&&<ObservationComparison key={JSON.stringify(action)} initial={action} onLocate={(norad,station)=>{locate(norad,station);close()}}/>}
   {action?.intent==='search'&&<div className="ai-field-grid">
    <label>名称或编号<input value={action.query} onChange={e=>setAction({...action,query:e.target.value})}/></label>
    <label>分组<select value={action.group} onChange={e=>setAction({...action,group:e.target.value})}>{groups.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
    <button onClick={()=>{apply(action.query,action.group.toLowerCase());close()}}>应用到地球和目录</button>
   </div>}
   {action?.intent==='diagnose'&&<button onClick={()=>{close();diagnose()}}>检查当前画面</button>}
   {action?.intent==='bookmarks'&&<button onClick={()=>{close();bookmarks()}}>打开当前时段的书签</button>}
   {action?.intent==='unsupported'&&<p>可以试试查找卫星、计算观测窗口、打开书签或检查画面。</p>}
  </dialog>
 </>;
}

export function CatalogSuggestions(){
 const [open,show]=useState(false),[text,setText]=useState(''),[action,setAction]=useState<Action>(),[status,setStatus]=useState('');
 async function interpret(){
  setStatus('正在提取观测目标…');
  try{const result=await api<{action:Action}>('/exploration-assistant/interpret',{method:'POST',body:JSON.stringify({text})});
      setAction(result.action);setStatus('已生成建议条件，请检查后计算。')}
  catch{setStatus('模型暂不可用，可以手动填写观测条件。')}
 }
 return <section className="panel"><button aria-expanded={open} onClick={()=>show(!open)}>按观测目标推荐卫星</button>
  {open&&<><label>观测目标<input value={text} maxLength={400} onChange={e=>setText(e.target.value)} placeholder="推荐今晚从北京适合观测的目标"/></label>
   <button disabled={text.trim().length<2} onClick={interpret}>提取目标</button><p role="status">{status}</p>
   <ObservationComparison key={JSON.stringify(action)} initial={action}/></>}
 </section>;
}
