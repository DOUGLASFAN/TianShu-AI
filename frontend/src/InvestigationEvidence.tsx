import {useId,useState} from 'react';
import {Link} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {api,saveDownload} from './api';
import './investigation.css';

type Archive={id:string;mission:string;source:string;coverageStart?:string;coverageEnd?:string};
type Dossier={name:string;norad:number;purpose:string|null;orbit:{epoch:string;source:string;version:string}|null;archives:Archive[];candidates:{run:string;channel:string;record:number}[]};
type Match={asset:string;segment:string;channel:string;start:string;source:string;curve:number[];correlation:number;labels:string[];review?:{run:string;note:string}};
type Context={start:string;end:string;entries:{kind:string;start:string;end?:string;source:string;label:string;state:string;link?:string}[];missing:string[]};
type Challenge={target:number|null;limitations:string;results:{name:string;included?:number;reason?:string;start?:string;end?:string;rules?:{name:string;targetHit:boolean;records:number[];threshold:number}[]}[]};
const sourceNames:Record<string,string>={telemetry:'遥测报告',orbit:'同期轨道',weather:'空间环境',observation:'地面观测'};

export function DossierGuide({norad}:{norad:number}){
 const [open,setOpen]=useState(false);
 const info=useQuery({queryKey:['dossier-guide',norad],enabled:open,queryFn:()=>api<Dossier>('/investigation-tools/satellites/'+norad)});
 return <section className="ai-result"><button type="button" aria-expanded={open} onClick={()=>setOpen(!open)}>任务档案导读</button>
  {open&&<>{info.isPending&&<p>正在生成导读…</p>}{info.error&&<p role="alert">{info.error.message}</p>}
   {info.data&&<><h4>{info.data.name} · NORAD {info.data.norad}</h4>
    <p>用途：{info.data.purpose||'目录缺少已登记的任务用途。'}</p>
    {info.data.orbit?<p>轨道历元 {info.data.orbit.epoch} · {info.data.orbit.source} · <Link to={'/explore?sat='+norad}>查看轨道</Link></p>:<p>目录暂无当前根数。历史根数可在遥测报告中查看。</p>}
    <p>可访问遥测档案 {info.data.archives.length} 份 · 已归档候选报告 {info.data.candidates.length} 份</p>
    {info.data.archives.map(a=><p key={a.id}><Link to={'/telemetry?asset='+encodeURIComponent(a.id)}>{a.mission} 遥测档案</Link> · {a.source} · {a.coverageStart||'时间待核对'} 至 {a.coverageEnd||'时间待核对'}</p>)}
    {info.data.candidates.map(c=><p key={c.run}><Link to={'/telemetry?run='+c.run+'&record='+c.record}>{c.channel} · 原始记录 #{c.record}</Link></p>)}</>}
  </>}
 </section>;
}

function Sparkline({points,label}:{points:number[];label:string}){
 const minimum=Math.min(...points),maximum=Math.max(...points);
 return <svg className="ai-spark" viewBox="0 0 300 60" role="img" aria-label={label}>
  <polyline fill="none" stroke="#78d0ff" strokeWidth="2" points={points.map((value,i)=>i*300/(points.length-1)+','+(54-(value-minimum)*48/(maximum-minimum||1))).join(' ')}/>
 </svg>;
}

export function InvestigationEvidence({run,norad,channel,show='all'}:{run:string;norad?:number;channel?:string;show?:'all'|'context'|'challenge'}){
 const [tool,pick]=useState<'similar'|'context'|'challenge'|null>(null);
 const result=useQuery({queryKey:['investigation-tool',run,tool],enabled:!!run&&!!tool,
  queryFn:()=>api<Context|Challenge|{matches:Match[];reference?:number[];reason:string}>('/investigation-tools/runs/'+encodeURIComponent(run)+'/'+tool)});
 const id=useId();
 return <section className="ai-result" aria-labelledby={id}><h3 id={id}>延伸调查</h3>
  <div className="investigation-actions">
   {show==='all'&&<button type="button" aria-pressed={tool==='similar'} onClick={()=>pick('similar')}>查找相似波形</button>}
   {show!=='challenge'&&<button type="button" aria-pressed={tool==='context'} onClick={()=>pick('context')}>同期资料对照</button>}
   {show!=='context'&&<button type="button" aria-pressed={tool==='challenge'} onClick={()=>pick('challenge')}>复算并寻找反证</button>}
   {show==='all'&&norad&&<Link to={'/observations?'+new URLSearchParams({sat:String(norad),verifyChannel:channel||'',evidenceRun:run})}>制定下一次验证观测</Link>}
  </div>
  {tool&&result.isFetching&&<p role="status">正在计算并查找证据…</p>}{result.error&&<p role="alert">{result.error.message}</p>}
  {result.data&&'matches' in result.data&&<>
   <p>{result.data.reason}</p>{!result.data.matches.length&&<p>没有符合条件的历史片段。</p>}
   {result.data.reference&&<Sparkline points={result.data.reference} label="参考片段标准化波形"/>}
   <div className="ai-field-grid">{result.data.matches.map(m=><article key={m.asset+m.segment} className="ai-result">
    <h4>片段 {m.segment} · 相关性 {m.correlation.toFixed(3)}</h4><Sparkline points={m.curve} label={'片段 '+m.segment+' 标准化波形'}/>
    <p>{m.start} · 来源 {m.source}</p><p>原始标签 {m.labels.join('、')} · 复核：{m.review?.note||'暂无记录'}</p>
    <Link to={m.review?'/telemetry?run='+m.review.run:'/telemetry?'+new URLSearchParams({asset:m.asset,channel:m.channel,segment:m.segment})}>查看片段与原始数据</Link>
   </article>)}</div>
  </>}
  {result.data&&'entries' in result.data&&<ContextTimeline context={result.data}/>}
  {result.data&&'results' in result.data&&<>
   <p>{result.data.limitations}</p>{result.data.target&&<Link to={'/telemetry?run='+run+'&record='+result.data.target}>查看目标记录 #{result.data.target}</Link>}
   <div className="ai-field-grid">{result.data.results.map(v=><article className="ai-result" key={v.name}>
    <h4>{v.name}</h4><p>{v.reason||v.included+' 条有效测量'}</p>{v.start&&<p>{v.start} 至 {v.end}</p>}
    {v.rules?.map(rule=><p key={rule.name}>{rule.name} · {rule.records.length} 条候选 · 阈值 {rule.threshold.toPrecision(4)}
     {result.data&&'results' in result.data&&result.data.target?' · 目标点'+(rule.targetHit?'命中':'未命中'):''}</p>)}
   </article>)}</div>
  </>}
 </section>;
}

function ContextTimeline({context}:{context:Context}){
 const start=Date.parse(context.start),width=Date.parse(context.end)-start||1;
 return <><p>{context.start} 至 {context.end}（UTC）</p>
  {context.missing.length>0&&<p>时段内缺少：{context.missing.map(x=>sourceNames[x]).join('、')}。</p>}
  <ul className="bookmark-list">{context.entries.map((e,i)=>{
   const left=Math.max(0,Math.min(100,100*(Date.parse(e.start)-start)/width));
   const right=Math.max(left,Math.min(100,100*(Date.parse(e.end||e.start)-start)/width));
   return <li key={e.kind+i}><strong>{sourceNames[e.kind]} · {e.label}</strong>
    <div className="ai-context-track" aria-hidden="true"><span style={{left:left+'%',width:(right-left)+'%'}}/></div>
    <p>{e.start}{e.end&&' 至 '+e.end} · {e.state} · {e.source}</p>{e.link&&<Link to={e.link}>查看来源记录</Link>}
   </li>;
  })}</ul>
 </>;
}

export function ReportEvidencePicker({show}:{show:'context'|'challenge'}){
 const [run,setRun]=useState('');
 const list=useQuery({queryKey:['telemetry-runs'],queryFn:()=>api<{id:string;mission:string;channel:string;start:string}[]>('/telemetry/runs')});
 return <details className="ai-result"><summary>{show==='context'?'按遥测报告查看同期对照':'检验报告结论是否稳健'}</summary>
  <label>选一份已归档报告<select value={run} onChange={e=>setRun(e.target.value)}>
   <option value="">请选择报告</option>{list.data?.map(r=><option key={r.id} value={r.id}>{r.mission} · {r.channel} · {r.start}</option>)}
  </select></label>
  {!list.data?.length&&<Link to="/telemetry">先生成一份遥测报告</Link>}
  {run&&<InvestigationEvidence key={run} run={run} show={show}/>}
 </details>;
}

export function VerificationBrief({run}:{run:string}){
 const evidence=useQuery({queryKey:['verification-brief',run],queryFn:()=>api<{
  norad:number;channel:string;priorities:{label:string;detail:string}[];source:string;catalogAvailable:boolean;limitation:string
 }>('/investigation-tools/runs/'+encodeURIComponent(run)+'/verification')});
 return <section className="ai-result">
  <h2>验证观测建议</h2>
  {evidence.isPending&&<p role="status">正在检查报告证据…</p>}
  {evidence.error&&<p role="alert">{evidence.error.message}</p>}
  {evidence.data&&<>
   <ul>{evidence.data.priorities.map(item=><li key={item.label}><strong>{item.label}</strong> · {item.detail}</li>)}</ul>
   <p>{evidence.data.limitation}</p>
   {!evidence.data.catalogAvailable&&<p>当前目录缺少该对象的新根数，无法计算它的未来过境窗口。可以回查历史轨道或改选有可用根数的对象演示。</p>}
  </>}
  <Link to={'/telemetry?run='+encodeURIComponent(run)}>查看提出验证需求的报告</Link>
 </section>;
}

const fields:Record<string,string>={timestamp:'时间戳',channel:'通道',segment:'片段',value:'测量值',unit:'单位',quality:'质量标记',sampling:'采样间隔'};
type MappingPreview={headers:string[];mapping:Record<string,string>;rows:Record<string,string>[];missing:boolean;model?:string;assistantNote?:string};

export function ImportMappingAssistant({saved}:{saved:(id:string)=>void}){
 const [file,setFile]=useState(''),[raw,setRaw]=useState(''),[preview,setPreview]=useState<MappingPreview|null>(null);
 const [mapping,modify]=useState<Record<string,string>>({}),[channel,setChannel]=useState(''),[status,setStatus]=useState(''),[busy,setBusy]=useState(false);
 const [confirmed,setConfirmed]=useState(false),[fresh,setFresh]=useState(false);
 const [meta,edit]=useState({mission:'',norad:'',source:'',version:'1',unit:'未提供'});
 async function request(commit:boolean,initial=false,assist=false){
  setBusy(true);setStatus('');
  try{
   const result=await api('/investigation-tools/import/'+(commit?'commit':'preview'),{method:'POST',body:JSON.stringify({
    raw,mapping:initial?{}:mapping,channel,assist,metadata:{...meta,norad:Number(meta.norad)},
   })});
   if(commit){saved(result.id);setStatus('已保存原件、确认映射和转换后的档案。')}
   else{setPreview(result);modify(result.mapping);setConfirmed(false);setFresh(!result.model&&!result.missing);if(result.model)setStatus('本机 '+result.model+' 补充了待确认建议，请更新转换预览。');else if(result.assistantNote)setStatus(result.assistantNote)}
  }catch{setStatus('转换失败。检查分隔符、字段映射、带时区的时间戳和数值格式。')}
  finally{setBusy(false)}
 }
 return <details className="ai-result"><summary>导入助手 · 字段映射</summary>
  <p>上传 UTF-8 CSV，核对建议列和转换预览，再导入。</p>
  <label>原始 CSV<input type="file" accept=".csv,text/csv" onChange={async e=>{
   const f=e.target.files?.[0];setRaw('');setPreview(null);setConfirmed(false);setFresh(false);
   if(!f)return;
   if(f.size>2000000){setStatus('文件不可超过 2 MB');return}
   try{setRaw(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await f.arrayBuffer()));setFile(f.name);setStatus('')}catch{setStatus('请选择 UTF-8 编码的 CSV')}
  }}/></label>{file&&raw&&<p>{file}</p>}
  <div className="investigation-actions"><button disabled={!raw||busy} onClick={()=>request(false,true)}>建议字段映射</button>
   <button disabled={!raw||busy} onClick={()=>request(false,true,true)}>让本机 AI 辅助识别列名</button></div>
  {preview&&<>
   <div className="ai-field-grid">{Object.entries(fields).map(([key,label])=><label key={key}>{label}
    <select value={mapping[key]||''} onChange={e=>{modify({...mapping,[key]:e.target.value});setConfirmed(false);setFresh(false)}}>
     <option value="">不映射</option>{preview.headers.map(h=><option key={h}>{h}</option>)}
    </select></label>)}
    <label>默认通道（文件无通道时）<input value={channel} onChange={e=>{setChannel(e.target.value);setConfirmed(false);setFresh(false)}}/></label>
   </div>
   <button disabled={busy} onClick={()=>request(false)}>更新转换预览</button>
   {preview.missing?<p>请确认时间戳、测量值和通道。</p>:<>
    <div className="table-scroll"><table><thead><tr>{Object.keys(preview.rows[0]||{}).map(k=><th key={k}>{fields[k]}</th>)}</tr></thead>
     <tbody>{preview.rows.map((r,i)=><tr key={i}>{Object.entries(r).map(([k,v])=><td key={k}>{v}</td>)}</tr>)}</tbody></table></div>
    <div className="ai-field-grid">{([['mission','任务名称'],['norad','NORAD 编号'],['source','来源与授权'],['version','版本'],['unit','登记单位']] as const).map(([k,label])=><label key={k}>{label}<input value={meta[k]} onChange={e=>edit({...meta,[k]:e.target.value})}/></label>)}</div>
    <label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核对转换预览和数据来源</label>
    <button disabled={busy||!fresh||!confirmed||!meta.mission||!meta.source||!/^\d+$/.test(meta.norad)} onClick={()=>request(true)}>确认并导入</button>
   </>}
  </>}{status&&<p role="status">{status}</p>}
 </details>;
}

export function ImportOriginalButton({asset}:{asset:string}){
 const [error,setError]=useState('');
 return <><button onClick={()=>saveDownload('/investigation-tools/imports/'+encodeURIComponent(asset)+'/original','original.csv').catch(e=>setError(String(e)))}>下载转换前原件</button>{error&&<p role="alert">{error}</p>}</>;
}
