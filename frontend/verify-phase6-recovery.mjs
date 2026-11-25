import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
process.chdir(dirname(fileURLToPath(import.meta.url)));
const run=promisify(execFile),base='http://127.0.0.1:8001',report={date:'2026-11-15'};
const assert=(v,m)=>{if(!v)throw Error(m);};let token;
async function api(path,body){const r=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:5174',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});const data=await r.json();assert(r.ok,path+' HTTP '+r.status);return data;}
try{
 const account={username:'recovery_'+Date.now(),password:'Recovery-'+crypto.randomUUID()};await api('/auth/register',account);token=(await api('/auth/login',account)).accessToken;
 const station=(await api('/stations',{name:'中断恢复验收站',latitude:39.9,longitude:116.4})).data;
 const task=(await api('/predictions/groups',{stationId:station.id,group:'active',size:25,start:new Date(Date.now()+60000).toISOString(),days:7,acceptStale:true})).data;report.taskId=task.id;
 const records=JSON.parse(await readFile('../.local/config/application-processes.json','utf8'));let children=[];
 for(let i=0;i<20&&!children.length;i++){
  const r=await run('pwsh.exe',['-NoProfile','-Command',`$all=@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^python' }); $owned=@(${records.worker.pid}); for($level=0;$level -lt 4;$level++){ $owned+=@($all | Where-Object { $_.ParentProcessId -in $owned } | ForEach-Object { $_.ProcessId }) }; @($all | Where-Object { $_.ProcessId -in $owned -and $_.CommandLine -like '*spawn_main*' } | Select-Object ProcessId,CreationDate) | ConvertTo-Json -Compress`]);
  const value=r.stdout.trim()?JSON.parse(r.stdout):[];children=Array.isArray(value)?value:[value];if(!children.length)await new Promise(resolve=>setTimeout(resolve,300));
 }
 assert(children.length>0,'Worker did not spawn a real calculation process');report.mathChildren=children;
 await run('pwsh.exe',['-NoProfile','-Command','./scripts/stop.ps1 -KeepServices; ./scripts/start.ps1'],{cwd:'..',timeout:60000});
 const ids=children.map(x=>x.ProcessId).join(',');const remaining=await run('pwsh.exe',['-NoProfile','-Command',`@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -in @(${ids}) } | Select-Object ProcessId,CreationDate) | ConvertTo-Json -Compress`]);
 const value=remaining.stdout.trim()?JSON.parse(remaining.stdout):[],current=Array.isArray(value)?value:[value];assert(!children.some(old=>current.some(row=>row.ProcessId===old.ProcessId&&row.CreationDate===old.CreationDate)),'Orphan math process remained');
 let result;
 for(let i=0;i<20;i++){result=(await api('/predictions/'+task.id)).data;if(result.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,300));}
 assert(result.status==='failed'&&result.errorCode==='WORKER_INTERRUPTED','Interrupted task was not recovered honestly');report.recoveredStatus=result.status;report.errorCode=result.errorCode;report.noOrphanMathProcesses=true;report.allPassed=true;
 console.log(JSON.stringify({passed:true,mathChildren:children.length,status:result.status,errorCode:result.errorCode}));
}catch(e){report.failure=e.stack;throw e;}
finally{await writeFile('../docs/evidence/phase6-worker-recovery-2026-11-15.json',JSON.stringify(report,null,2));}
