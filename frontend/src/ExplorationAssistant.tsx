import {useInteractiveGuide} from './InteractiveGuide';
import {useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Link} from 'react-router-dom';
import {api} from './api';
import {ObservationAnswer,nextObservationPlan,runObservation,type ObservationTask,type ObservationResult} from './TaskResults';
import './investigation.css';

type Action={intent:'search'|'observe'|'bookmarks'|'diagnose'|'unsupported';query:string;group:string;station:string;window:'now'|'tonight'|'next-day'};
type Station={id:string;name:string;lat:number;lng:number};
type Window={norad:number;name:string;start:string;end:string;peak:string;elevation:number;duration:number;optical:boolean;visibleNow:boolean;orbitEpoch:string};
type Results={start:string;end:string;targets:number;limited:boolean;scope:string;scenarios:{station:Station;minimum:number;windows:Window[];skipped:{norad:number;reason:string}[];total:number;opticalWindows:number}[]};
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

export function ExploreAssistant({apply,locate,diagnose,bookmarks,selected}:{
 apply:(query:string,group:string)=>void;locate:(norad:number,station:Station)=>void;
 diagnose:()=>void;bookmarks:()=>void;selected:number
}){
 const dialog=useRef<HTMLDialogElement>(null),guide=useInteractiveGuide();
 const [text,setText]=useState(''),[action,setAction]=useState<Action|null>(null);
 const [busy,setBusy]=useState(false),[issue,setIssue]=useState('');
 const [task,setTask]=useState<ObservationTask|null>(null),[answer,showAnswer]=useState<ObservationResult|null>(null);
 const [prior,setPrior]=useState<ObservationResult|null>(null),[clarify,askStation]=useState<ObservationTask|null>(null);
 const [stationId,setStationId]=useState(''),[manual,showManual]=useState(false),[lastQuestion,setLastQuestion]=useState('');
 const [answeredQuestion,setAnsweredQuestion]=useState('');
 const stations=useQuery({queryKey:['stations'],enabled:!!clarify,queryFn:()=>api<{list:{id:string;name:string}[]}>('/stations')});
 function close(){dialog.current?.close()}
 async function calculate(next:ObservationTask,previous:ObservationResult|null,question:string){
  try{
   const result=await runObservation(next);
   setTask({...next,station:result.scenarios[0].station.id});setPrior(previous);showAnswer(result);
   setAnsweredQuestion(question);askStation(null);
   if(previous)guide?.signal('comparison',{planning:nextObservationPlan(result,previous)});
   else guide?.signal('observation');
  }catch(e){
   if((e as {code?:string}).code==='AI_OBSERVATION_STATION'){
    setStationId('');askStation(next);
   }else setIssue(String(e));
  }
 }
 async function submit(question:string){
  const q=question.trim();if(q.length<2||busy)return;
  setBusy(true);setLastQuestion(q);setText('');setIssue('');setAction(null);askStation(null);showManual(false);
  try{
   const angle=q.match(/(?:最低仰角|改成|提高到|降到|改为)[^0-9]{0,8}(\d+(?:\.\d+)?)\s*(?:°|度)?/);
   // A numeric-only change preserves the resolved object, station and exact epoch range.
   const fromPrevious=task&&answer&&angle&&!/明天|今晚|现在|换(?:成|到)(?!\s*\d)|NORAD|从.{1,20}(?:站|看|观测)/i.test(q);
   if(fromPrevious){
    const minimum=Number(angle[1]);
    if(minimum<0||minimum>85){setIssue('最低仰角需要在 0° 至 85° 之间。');return}
    await calculate({...task,minimum,fixed:{start:answer.start,end:answer.end}},answer,q);return;
   }
   const interpreted=await api<{action:Action}>('/exploration-assistant/interpret',{method:'POST',body:JSON.stringify({text:q})});
   const result=interpreted.action;
   if(result.intent==='observe'){
    const usesSelected=/这颗|当前卫星|所选/.test(q);
    const query=usesSelected?String(selected):result.query;
    const next:ObservationTask={query,group:usesSelected?'':result.group,station:result.station&&q.includes(result.station)?result.station:'',
     window:result.window,minimum:angle?Number(angle[1]):15};
    if(!Number.isFinite(next.minimum)||next.minimum<0||next.minimum>85){setIssue('最低仰角需要在 0° 至 85° 之间。');return}
    if(!next.station){setStationId('');askStation(next);return}
    await calculate(next,null,q);
   }else if(result.intent==='diagnose'){close();diagnose()}
   else if(result.intent==='bookmarks'){close();bookmarks()}
   else setAction(result);
  }catch{setIssue('暂时无法理解问题。可以重试，或手动填写观测条件。')}
  finally{setBusy(false)}
 }
 async function chooseStation(){
  if(!clarify||!stationId)return;
  setBusy(true);setIssue('');
  try{await calculate({...clarify,station:stationId},null,lastQuestion)}
  finally{setBusy(false)}
 }
 return <>
  <button className="investigation-launch" data-guide-target="assistant" onClick={()=>{dialog.current?.showModal();guide?.signal('assistant')}} aria-haspopup="dialog">AI 探索任务</button>
  <dialog ref={dialog} className="investigation-dialog task-drawer" aria-label="AI 探索任务">
   <header><h2>AI 探索任务</h2><button type="button" onClick={close}>关闭</button></header>
   <form className="task-composer" onSubmit={event=>{event.preventDefault();void submit(text)}}>
    <label>你想问什么？<textarea rows={2} value={text} maxLength={400} onChange={e=>setText(e.target.value)} placeholder={answer?'最低仰角改成 30° 呢？':'今晚从北京能看到 ISS 吗？'}/></label>
    <div className="investigation-actions"><button type="submit" disabled={busy||text.trim().length<2}>发送</button>
     {!answer&&<button type="button" data-guide-target="observe-example" disabled={busy} onClick={()=>submit('未来 24 小时从北京能看到 ISS 吗？')}>试问：未来 24 小时从北京能看到 ISS 吗？</button>}
     {answer&&<button type="button" data-guide-target="observe-compare" disabled={busy} onClick={()=>submit('最低仰角改成 30° 呢？')}>追问：最低仰角改成 30°</button>}
    </div>
   </form>
   {lastQuestion&&<p>当前问题：{lastQuestion}</p>}
   {busy&&<p role="status">正在理解问题并计算可见窗口…</p>}
   {issue&&<p role="alert">{issue}</p>}
   {clarify&&<div className="workflow-result">
    <label>请选择观测站<select value={stationId} onChange={e=>setStationId(e.target.value)}>
     <option value="">选择一个观测站</option>{stations.data?.list.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
    </select></label>
    <button type="button" onClick={chooseStation} disabled={!stationId||busy}>继续计算</button>
    {stations.data?.list.length===0&&<Link to="/workspace">去我的空间添加观测站</Link>}
   </div>}
   {answer&&task&&<>
    {lastQuestion!==answeredQuestion&&<p>以下是上一轮的结果：{answeredQuestion}</p>}
    <ObservationAnswer task={task} result={answer} previous={prior} locate={(norad,station)=>{locate(norad,station);close()}}/>
   </>}
   {action?.intent==='search'&&<div className="ai-field-grid">
    <label>名称或编号<input value={action.query} onChange={e=>setAction({...action,query:e.target.value})}/></label>
    <label>分组<select value={action.group} onChange={e=>setAction({...action,group:e.target.value})}>{groups.map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
    <button onClick={()=>{apply(action.query,action.group.toLowerCase());close()}}>应用到地球和目录</button>
   </div>}
   {action?.intent==='unsupported'&&<p>可以询问卫星观测窗口、查找卫星、查看书签或诊断地图。遥测证据请在选中记录后启动一键调查。</p>}
   <details open={manual} onToggle={e=>showManual(e.currentTarget.open)}><summary>手动设置观测条件</summary>
    {manual&&<ObservationComparison defaultQuery={String(selected)} onLocate={(norad,station)=>{locate(norad,station);close()}}/>}
   </details>
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
