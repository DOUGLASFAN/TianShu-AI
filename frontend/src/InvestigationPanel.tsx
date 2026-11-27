import {InvestigationShelf} from './InvestigationShelf';
import {useRef, useState, type PointerEvent} from 'react';
import {api} from './api';
import './investigation.css';

type Point = {utc:string;record:number};
type Hypothesis = {id:string;title:string;status:string;support:string;against:string;records:number[]};
export type InvestigationResult = {start:string;end:string;included:number;model:string|null;aiIssue?:string;
 quality?:{missing:number;interpolated:number;flagged:number;duplicateTimes:number;unit:string;conversions:Record<string,number>};
 rules:{name:string;threshold:number;records:number[];targetHit:boolean;zeroSpread:boolean}[];
 hypotheses:Hypothesis[];target:number|null;baselineHit:boolean|null;windowChanged:boolean};
type Range = [number,number];

export function useInvestigationRange(points:Point[],left:number,width:number,initial?:string[]){
 const [enabled,setEnabled]=useState(!!initial);
 const [range,update]=useState<Range>(()=>{const a=points.findIndex(p=>p.utc===initial?.[0]),b=points.findIndex(p=>p.utc===initial?.[1]);return a>=0&&b>=a?[a,b]:[0,points.length-1]});
 const anchor=useRef<number|null>(null);
 function nearest(e:PointerEvent<SVGSVGElement>){
  const svg=e.currentTarget, matrix=svg.getScreenCTM();
  if(!matrix)return 0;
  const position=new DOMPoint(e.clientX,e.clientY).matrixTransform(matrix.inverse()).x;
  const time=left+Math.max(0,Math.min(1,(position-10)/780))*width;
  let best=0, distance=Infinity;
  points.forEach((p,i)=>{const gap=Math.abs(Date.parse(p.utc)-time);if(gap<distance){best=i;distance=gap}});
  return best;
 }
 function drag(e:PointerEvent<SVGSVGElement>){
  if(anchor.current===null)return;
  const i=nearest(e);update([Math.min(i,anchor.current),Math.max(i,anchor.current)]);
 }
 return {enabled,setEnabled,range,update,handlers:{
  onPointerDown(e:PointerEvent<SVGSVGElement>){
   if(!enabled||e.button!==0||!e.isPrimary)return;
   anchor.current=nearest(e);e.currentTarget.setPointerCapture(e.pointerId);drag(e);
  },
  onPointerMove(e:PointerEvent<SVGSVGElement>){if(e.isPrimary)drag(e)},
  onPointerUp(e:PointerEvent<SVGSVGElement>){if(e.isPrimary){drag(e);anchor.current=null}},
  onPointerCancel(){anchor.current=null},
  onLostPointerCapture(){anchor.current=null},
 }};
}

export function InvestigationPanel({run,points,range,update,target,seek,restored}:{
 run:string;points:Point[];range:Range;update:(r:Range)=>void;target:number;seek:(i:number)=>void;restored?:InvestigationResult;
}){
 const [result,setResult]=useState<InvestigationResult|null>(restored||null),[issue,setIssue]=useState(''),[busy,setBusy]=useState(false);
 const start=points[range[0]].utc,end=points[range[1]].utc;
 const stale=result&&(Date.parse(result.start)!==Date.parse(start)||Date.parse(result.end)!==Date.parse(end));
 async function investigate(ai:boolean){
  setBusy(true);setIssue('');setResult(null);
  try{setResult(await api<InvestigationResult>('/investigation/runs/'+encodeURIComponent(run),{
   method:'POST',body:JSON.stringify({start,end,target,ai}),
  }))}
  catch(error){setIssue(String(error))}
  finally{setBusy(false)}
 }
 function go(record:number){const i=points.findIndex(p=>p.record===record);if(i>=0)seek(i)}
 return <div className="investigation-panel">
  <h3>框选调查</h3>
  <InvestigationShelf capture={()=>({path:'/telemetry',report:run,query:new URLSearchParams({run,record:String(target)}).toString(),
   selection:[start,end],investigation:stale?undefined:result||undefined})}/>
  <p>在曲线上拖动选区，也可以用下面两个控件调整时间。</p>
  <div className="investigation-range">
   <label>调查起点 <time>{start}</time><input type="range" min={0} max={points.length-1} value={range[0]}
    aria-valuetext={start} onChange={e=>update([Math.min(+e.target.value,range[1]),range[1]])}/></label>
   <label>调查终点 <time>{end}</time><input type="range" min={0} max={points.length-1} value={range[1]}
    aria-valuetext={end} onChange={e=>update([range[0],Math.max(+e.target.value,range[0])])}/></label>
  </div>
  <div className="investigation-actions">
   <button type="button" onClick={()=>update([0,points.length-1])}>恢复整段</button>
   <button type="button" disabled={busy||range[1]-range[0]<2} onClick={()=>investigate(false)}>复算并比较解释</button>
   <button type="button" disabled={busy||range[1]-range[0]<2} onClick={()=>investigate(true)}>AI 排列复核顺序</button>
  </div>
  {busy&&<p role="status">正在调查所选范围…</p>}
  {issue&&<p role="alert">{issue}</p>}
  {stale&&<p role="status">选区已调整，请重新复算。</p>}
  {result&&!stale&&<>
   <h4>两种规则 · {result.included} 个有效点</h4>
   {result.quality&&<p>缺值 {result.quality.missing} · 补点 {result.quality.interpolated} · 待核验 {result.quality.flagged} · 重复记录 {result.quality.duplicateTimes} · 单位 {result.quality.unit}
    {Object.keys(result.quality.conversions).length>0&&' · 换算：'+Object.entries(result.quality.conversions).map(([name,factor])=>name+' × '+factor).join('、')}</p>}
   <ul>{result.rules.map(rule=><li key={rule.name}>{rule.name}：阈值 {rule.threshold.toPrecision(4)}，候选 {rule.records.length} 条
    {result.target!==null?'，记录 #'+result.target+(rule.targetHit?' 命中':' 未命中'):''}{rule.zeroSpread?'，离散度为零':''}</li>)}</ul>
   {result.windowChanged&&<p>当前选区改变了目标点的 MAD 判断。</p>}
   {result.model&&<p>复核顺序由 {result.model} 建议。</p>}{result.aiIssue&&<p role="status">{result.aiIssue}</p>}
   <div className="hypothesis-grid">{result.hypotheses.map(h=><article key={h.id}>
    <h4>{h.title}</h4><strong>{h.status}</strong><p>{h.support}</p><p>{h.against}</p>
    <div className="investigation-actions">{h.records.map(record=><button type="button" key={record} onClick={()=>go(record)}>原始记录 #{record}</button>)}</div>
   </article>)}</div>
  </>}
 </div>;
}
