import {useState,type FormEvent} from 'react';
import {Link} from 'react-router-dom';
import {api} from './api';
import './task-workflows.css';

export type TaskStation={id:string;name:string;lat:number;lng:number};
type Pass={norad:number;name:string;start:string;end:string;peak:string;elevation:number;optical:boolean;visibleNow:boolean;
 opticalPeriods?:{start:string;end:string}[];orbitEpoch:string;orbitSource:string;orbitVersion:string};
export type ObservationResult={start:string;end:string;targets:number;scope:string;
 scenarios:{station:TaskStation;minimum:number;windows:Pass[];skipped:{norad:number;reason:string}[];total:number;opticalWindows:number;truncated:boolean}[]};
export type ObservationTask={query:string;group:string;station:string;window:'now'|'tonight'|'next-day';minimum:number;fixed?:{start:string;end:string}};

export async function runObservation(task:ObservationTask){
 return api<ObservationResult>('/exploration-assistant/observation',{method:'POST',body:JSON.stringify({
  query:task.query,group:task.group,window:task.window,...task.fixed,
  scenarios:[{station:task.station,minimum:task.minimum}],
 })});
}

const beijing=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const local=(time:string)=>beijing.format(new Date(time));
const overlaps=(a:Pass,b:Pass)=>a.norad===b.norad&&Date.parse(a.start)<=Date.parse(b.end)&&Date.parse(b.start)<=Date.parse(a.end);

export function ObservationAnswer({task,result,previous,locate}:{
 task:ObservationTask;result:ObservationResult;previous:ObservationResult|null;locate:(norad:number,station:TaskStation)=>void
}){
 const scenario=result.scenarios[0], before=previous?.scenarios[0];
 const windows=task.window==='now'?scenario.windows.filter(w=>w.visibleNow):scenario.windows;
 const optical=task.window==='now'?windows.filter(w=>w.opticalPeriods?.some(p=>Date.parse(p.start)<=Date.parse(result.start)&&Date.parse(p.end)>=Date.parse(result.start))).length:scenario.opticalWindows;
 const removed=before?.windows.filter(w=>
  (task.window!=='now'||w.visibleNow)&&!scenario.skipped.some(s=>s.norad===w.norad)&&
  !scenario.windows.some(next=>overlaps(w,next)))??[];
 const compare=!!before&&!scenario.truncated&&!before.truncated&&previous?.start===result.start&&previous.end===result.end;
 const unavailable=result.targets===0||scenario.skipped.length>=result.targets;
 let answer=unavailable?'资料不足，暂时无法判断':
  optical?'有潜在目视窗口':windows.length?'有几何过境，但未发现潜在目视窗口':'这个时段没有达到条件的过境';
 if(task.window==='now'&&optical)answer='当前满足潜在目视条件';
 if(task.window==='now'&&!optical&&windows.length)answer='当前在几何可见范围，未同时满足目视条件';
 return <section className="workflow-result" aria-labelledby="observation-answer">
  <h3 id="observation-answer">{answer}</h3>
  <p>{scenario.station.name} · 最低仰角 {scenario.minimum}° · {local(result.start)} 至 {local(result.end)}（北京时间）</p>
  {compare&&<section className="workflow-compare" aria-label="追问对照">
   <strong>同一时段，仰角 {before?.minimum}° → {scenario.minimum}°</strong>
   <p>几何窗口 {before?.total} → {scenario.total}，潜在目视窗口 {before?.opticalWindows} → {scenario.opticalWindows}。</p>
   {removed.length>0&&<ul>{removed.map(w=><li key={w.norad+w.start}>{w.name} · {local(w.start)} 开始的窗口不再达到条件</li>)}</ul>}
  </section>}
  {scenario.skipped.length>0&&<p>有 {scenario.skipped.length} 颗因轨道或计算资料不足未纳入：{[...new Set(scenario.skipped.map(s=>s.reason))].join('、')}。</p>}
  <ul className="workflow-evidence">{windows.slice(0,6).map(w=><li key={w.norad+w.start}>
   <strong>{w.name} · 最高 {w.elevation.toFixed(1)}°</strong>
   <p>过境 {local(w.start)}–{local(w.end)}。{w.optical?(w.opticalPeriods||[]).map(p=>'潜在目视 '+local(p.start)+'–'+local(p.end)).join('；'):'这次未满足潜在目视条件。'}</p>
   <small>根数 {w.orbitSource} · {w.orbitEpoch}</small>
   <div className="investigation-actions"><button type="button" onClick={()=>locate(w.norad,scenario.station)}>在地球定位</button>
    <Link to={'/observations?'+new URLSearchParams({station:scenario.station.id,sat:String(w.norad),min:String(scenario.minimum),draft:'1',tz:'utc',
     from:new Date(result.start).toISOString().slice(0,19),now:'0'})}>带条件去观测规划</Link></div>
  </li>)}</ul>
  <details><summary>计算依据与限制</summary><p>{result.scope} 本次匹配 {result.targets} 颗。根数变化时，同一时段的重算也可能受资料更新影响。</p></details>
 </section>;
}

type Findings={run:string;mission:string;channel:string;version:string;source:string;start:string;end:string;verdict:string;
 point:{record:number;utc:string;value:number|null;quality?:string};usable:boolean;limitation:string;
 window?:{included:number;excluded:number[];quality:{missing:number;interpolated:number;flagged:number;unit:string};
 rules:{name:string;threshold:number;targetHit:boolean}[]}; warnings:string[];
 trials:{name:string;included?:number;reason?:string;rules?:{name:string;targetHit:boolean}[]}[];
 related:{asset:string;segment:string;channel:string;correlation:number;labels:string[]}[];
 context:{entries:{kind:string;source:string;label:string;state:string;link?:string}[];missing:string[]};
 nextSteps:string[]};
const contextNames:Record<string,string>={orbit:'同期轨道',weather:'空间环境',observation:'授权地面观测',telemetry:'遥测'};

export function InvestigationTask({run,record,start,end,onEvidence}:{run:string;record:number;start?:string;end?:string;onEvidence?:(record:number)=>void}){
 const [result,setResult]=useState<Findings|null>(null),[error,fail]=useState(''),[busy,pending]=useState(false);
 const [request,setRequest]=useState('');
 const taskScope=[run,record,start,end].join('|'), stale=!!result&&request!==taskScope;
 async function execute(e:FormEvent){
  e.preventDefault();pending(true);fail('');setResult(null);setRequest(taskScope);
  try{setResult(await api<Findings>('/task-workflows/investigate',{method:'POST',body:JSON.stringify({run,record,start,end})}))}
  catch(err){fail(String(err))}
  finally{pending(false)}
 }
 return <section className="workflow-result workflow-investigation" aria-label="异常调查任务">
  <form onSubmit={execute}>
   <button type="submit" disabled={busy}>{busy?'正在核对质量、复算规则并查同期证据…':'一键调查当前记录'}</button>
   <p>本次目标 #{record} · {start&&end?'使用曲线框选范围':'使用整份归档报告'}</p>
  </form>
  {error&&<p role="alert">{error}</p>}
  {stale&&<p role="status">记录或选区已改变。重新调查可查看新结论。</p>}
  {result&&!stale&&<div aria-live="polite">
   <h3>{result.verdict}</h3>
   <p>{result.mission} · {result.channel} · #{result.point.record} · {result.point.utc} · 测量 {result.point.value??'缺测'}</p>
   {onEvidence?<button type="button" onClick={()=>onEvidence(result.point.record)}>回到曲线证据</button>:<Link to={'/telemetry?run='+encodeURIComponent(run)+'&record='+record}>打开曲线原始证据</Link>}
   <h4>下一步查什么</h4><ol>{result.nextSteps.map(step=><li key={step}>{step}</li>)}</ol>
   {result.window&&<p>选区有效 {result.window.included} 条，排除 {result.window.excluded.length} 条。{result.window.rules.map(r=>r.name+' '+(r.targetHit?'标记':'未标记')+'目标点').join('；')}。</p>}
   <details open><summary>规则与反证</summary>
    {result.window&&<p>单位 {result.window.quality.unit} · 缺测 {result.window.quality.missing} · 补点 {result.window.quality.interpolated} · 待核验 {result.window.quality.flagged}</p>}
    <ul>{result.trials.map(t=><li key={t.name}>{t.name} · {t.reason||t.included+' 条有效点 · '+(t.rules||[]).map(r=>r.name+(r.targetHit?'命中':'未命中')).join(' / ')}</li>)}</ul>
   </details>
   <details><summary>同期记录与相似片段</summary>
    {result.context.missing.length>0&&<p>缺少 {result.context.missing.map(k=>contextNames[k]||k).join('、')}。</p>}
    <ul>{result.context.entries.map((item,index)=><li key={index}>{contextNames[item.kind]} · {item.state} · {item.source} {item.link&&<Link to={item.link}>打开资料</Link>}</li>)}</ul>
    <p>相似片段基于整段归档波形，用于找对照。</p>
    <ul>{result.related.map(r=><li key={r.asset+r.segment}><Link to={'/telemetry?'+new URLSearchParams({asset:r.asset,segment:r.segment,channel:r.channel})}>片段 {r.segment}</Link> · 相关系数 {r.correlation.toFixed(3)} · 原始标签 {r.labels.join(' / ')}</li>)}</ul>
   </details>
   {result.warnings.map(message=><p key={message} role="status">{message}</p>)}
   <p>{result.limitation}</p><small>冻结档案 {result.version.slice(0,12)} · {result.source}</small>
  </div>}
 </section>;
}
