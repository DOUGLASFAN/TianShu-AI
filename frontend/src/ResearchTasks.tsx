import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from './api';

const states:Record<string,string>={completed:'已完成',running:'运行中',queued:'排队中',review:'需人工复核',interrupted:'已中断',cancelled:'已取消'};
type Step={tool:string;elapsed:number;model?:string;result?:{text?:string;statements?:{text:string;citation:string}[]}};
type Job={id:string;state:string;attempt:number;steps:Step[];issue:string};
export function ResearchTasks({report}:{report:string}){
 const [outcome,setOutcome]=useState('report');
 const [provider,select]=useState('form'),[request,edit]=useState('核对样本质量，检查异常候选并总结证据'),[id,open]=useState(''),[error,fail]=useState('');
 const models=useQuery({queryKey:['research-models'],queryFn:()=>api<{models:{provider:string;model:string;configured:boolean}[]}>('/research/tools')});
 const list=useQuery({queryKey:['research-jobs'],queryFn:()=>api<Job[]>('/research/jobs')});
 const job=useQuery({queryKey:['research-job',id],enabled:!!id,queryFn:()=>api<Job>('/research/jobs/'+id),refetchInterval:q=>!q.state.data||['queued','running'].includes(q.state.data.state)?1000:false});
 async function send(action:string){
  try{const r=action==='submit'?await api('/research/jobs',{method:'POST',body:JSON.stringify({report,request,provider,outcome})}):await api('/research/jobs/'+id+'/'+action,{method:'POST'});open(r.id);await list.refetch();if(r.id===id)await job.refetch();fail('')}catch(e){fail(String(e))}
 }
 return <section><h2>科研分析任务</h2><label>执行方式<select value={provider} onChange={e=>select(e.target.value)}><option value="form">固定分析流程</option>{models.data?.models.map(m=><option key={m.provider} value={m.provider} disabled={!m.configured}>{m.provider==='deepseek-cloud'?'DeepSeek 官方 API':m.provider} · {m.model||'未配置'}</option>)}</select></label><label>交付内容<select value={outcome} onChange={e=>setOutcome(e.target.value)}><option value="report">含可回查证据的报告</option><option value="analysis">仅所选工具的分析结果</option></select></label><label>分析请求<textarea value={request} maxLength={600} onChange={e=>edit(e.target.value)}/></label><button disabled={!report||!request.trim()} onClick={()=>send('submit')}>分析主报告</button>
 <details><summary>历史任务</summary>{list.data?.map(j=><button key={j.id} onClick={()=>open(j.id)}>{j.id.slice(0,8)}</button>)}</details>
 {job.data&&<><p>任务 {job.data.id.slice(0,8)} · {states[job.data.state]||job.data.state} · 第 {job.data.attempt} 次</p><p>{job.data.issue}</p><ol>{job.data.steps.map((s,i)=><li key={i}>{s.tool} · {s.elapsed.toFixed(3)} 秒 {s.model||''}{s.result?.text&&<p>{s.result.text}</p>}{s.result?.statements?.map((v,j)=><p key={j}>{v.text} <a href={'/telemetry?run='+v.citation.split('#')[0]}>查看证据</a></p>)}</li>)}</ol><details><summary>工具输出与运行记录</summary><pre>{JSON.stringify(job.data,null,2)}</pre></details>{['queued','running'].includes(job.data.state)&&<button onClick={()=>send('cancel')}>取消</button>}{['review','interrupted'].includes(job.data.state)&&job.data.attempt<3&&<button onClick={()=>send('retry')}>重试</button>}
 <button onClick={()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(job.data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='research-'+id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}}>导出任务记录</button></>}<p role="alert">{error||job.error?.message}</p></section>
}
