import {ResearchTasks} from './ResearchTasks';
import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api,saveDownload} from './api';

export function TrustedPage(){
 const experiments=useQuery({queryKey:['research-experiments'],queryFn:()=>api<Record<string,unknown>>('/trusted/experiments')});
 const archive=useQuery({queryKey:['trusted-checks'],queryFn:()=>api<{id:string;status:string;reason:string}[]>('/trusted/checks')});
 const history=useQuery({queryKey:['telemetry-runs'],queryFn:()=>api<{id:string;channel:string;start:string}[]>('/telemetry/runs')});
 const [left,L]=useState(''),[right,R]=useState(''),[claim,C]=useState(''),[output,O]=useState(''),[evidence,link]=useState<{run:string;record:number}[]>([]),[error,E]=useState('');
 async function call(path:string,body:unknown){try{const r=await api('/trusted/'+path,{method:'POST',body:JSON.stringify(body)});O(JSON.stringify(r,null,2));void archive.refetch();link(r.used?.length?[{run:r.report,record:r.used[0]}]:(r.pairs?.length?[{run:r.inputs[0],record:r.pairs[0].leftRecord},{run:r.inputs[1],record:r.pairs[0].rightRecord}]:[]));E('')}catch(e){E(String(e));O('')}}
 const options=history.data?.map(h=><option key={h.id} value={h.id}>{h.channel} · {h.start} · {h.id.slice(0,8)}</option>);
 async function template(){try{const r=await api('/telemetry/runs/'+left);C(JSON.stringify({report:r.id,norad:r.asset.norad,channel:r.channel,start:r.start,end:r.end,metric:'count',value:r.stats.count,unit:'个',citation:r.id+'#stats.count'},null,2));E('')}catch(e){E(String(e))}}
 const result=output?JSON.parse(output):null;
 return <main className="telemetry"><h1>可信分析</h1><p>选择已归档的报告，比对同一通道的测量，或核验一条引用统计值的结论。</p>
 {history.data?.length===0&&<p><a className="button" href="/telemetry">先生成一份历史遥测报告</a></p>}<label>主报告<select aria-label="主报告" value={left} onChange={e=>{L(e.target.value);C('');O('')}}><option value="">请选择</option>{options}</select></label>
 <label>对照报告<select aria-label="对照报告" value={right} onChange={e=>R(e.target.value)}><option value="">请选择另一来源</option>{options}</select></label>
 <button disabled={!left||!right} onClick={()=>call('compare',{left,right})}>比较来源</button>
 <button disabled={!left} onClick={template}>从主报告填写核验字段</button><label>待核验结论（JSON）<textarea rows={12} value={claim} onChange={e=>C(e.target.value)}/></label>
 <button disabled={!claim} onClick={()=>{try{void call('check',JSON.parse(claim))}catch{E('请输入有效 JSON')}}}>核验结论</button>
 <p role="alert">{error||history.error?.message}</p>{output&&<section><h2>核验结果 · {result.status}</h2><p>{result.reason}</p>{result.verifiedValue!==undefined&&<p>复算值 {result.verifiedValue} {result.unit}</p>}{result.aligned!==undefined&&<p>对齐 {result.aligned} 个时刻，发现 {result.different} 处差异。</p>}{evidence.map(ref=><p key={ref.run}><a href={'/telemetry?run='+ref.run+'&record='+ref.record}>查看原始记录 #{ref.record} 与完整计算样本</a></p>)}<details><summary>原值、输入与证据</summary><pre>{output}</pre></details></section>}<details><summary>已保存的核验</summary>{archive.data?.map(item=><button key={item.id} onClick={()=>{O(JSON.stringify(item,null,2));link([])}}>{item.status} · {item.id.slice(0,8)}</button>)}</details><ResearchTasks report={left}/><section><h2>TianShu-Bench</h2><details><summary>实验结果与评分口径</summary><pre>{JSON.stringify(experiments.data,null,2)}</pre></details>{[['detection','异常检测'],['evidence','证据核验'],['models','模型对照']].map(([k,name])=><button key={k} onClick={()=>saveDownload('/trusted/experiments/'+k+'/download',k+'-experiment.zip').catch(e=>E(String(e)))}>导出{name}实验包</button>)}</section></main>;
}
