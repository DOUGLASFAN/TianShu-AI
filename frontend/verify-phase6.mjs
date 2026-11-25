import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
process.chdir(dirname(fileURLToPath(import.meta.url)));
import {writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:'reduce'}),base='http://127.0.0.1:5174',report={date:'2026-11-15',checks:[],errors:[],screenshots:[]};page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',d=>d.accept());
const assert=(v,m)=>{if(!v)throw Error(m);};
async function check(name,fn){await fn();report.checks.push({name,passed:true});console.log('PASS',name);}
async function choose(label,value){await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('listbox',{name:label,exact:true}).locator(`[role="option"][data-value="${value}"]`).click();}
async function shot(name){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'../docs/evidence/'+name,fullPage:true});report.screenshots.push(name);}
let auth,taskId,planId,selected;
async function api(path,body){const r=await page.request.fetch(base+'/api'+path,{method:body?'POST':'GET',data:body,headers:{Authorization:'Bearer '+auth}});assert(r.ok(),path+' HTTP '+r.status()+': '+await r.text());return r.json();}
async function pickFuture(){const list=(await api('/predictions/'+taskId+'/results?size=50')).list;selected=list.find(x=>Date.parse(x.start)>Date.now()+30000);assert(selected,'No future event');let index=list.indexOf(selected);for(let i=0;i<Math.floor(index/8);i++)await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByRole('button',{name:'查看过境 '+selected.id,exact:true}).click();await page.locator('.elevation-chart svg').waitFor();}
try{
 const credentials={username:'phase6_'+Date.now(),password:'Phase6-'+crypto.randomUUID()};await page.request.post(base+'/api/auth/register',{data:credentials});auth=(await(await page.request.post(base+'/api/auth/login',{data:credentials,headers:{Origin:base}})).json()).accessToken;
 await api('/stations',{name:'北京观测站',latitude:39.9,longitude:116.4,elevation_m:45});
 await check('batch_preview_exact_submission_and_group_result',async()=>{
  await page.goto(base+'/observations');await page.getByRole('group',{name:'预测对象模式',exact:true}).getByRole('button',{name:'卫星分组',exact:true}).click();await choose('预测分组','stations');await choose('批次数量','25');
  await page.locator('.batch-scope').waitFor();await page.locator('.batch-scope summary').click();assert(await page.locator('.batch-scope li').count()>1,'No batch scope');
  const response=page.waitForResponse(r=>r.url().endsWith('/api/predictions/groups')&&r.status()===202);await page.getByRole('button',{name:'计算过境',exact:true}).click();const task=(await(await response).json()).data;taskId=task.id;
  const sent=JSON.parse((await response).request().postData());assert(sent.expectedNoradIds.length===task.basis.targets.length,'Scope differs from submitted IDs');report.group={id:taskId,count:task.basis.group.count,range:[task.basis.group.firstNorad,task.basis.group.lastNorad]};
  await page.locator('.task-status.completed').waitFor({timeout:120000});await pickFuture();const eventReference=await api(`/predictions/${taskId}/events/${selected.id}`);assert(eventReference.basis.satellite.noradId===selected.satellite.noradId,'Wrong event basis');await page.locator('.calculation-basis summary').click();assert((await page.locator('.calculation-basis').innerText()).includes(eventReference.basis.orbit.version),'Details show another satellite orbit');await page.locator('.calculation-basis summary').click();await shot('phase6-group-1920.png');
 });
 await check('replay_clock_satellite_projection_and_chart_sync',async()=>{
  await page.getByRole('button',{name:'单星回放',exact:true}).click();await page.getByRole('region',{name:'过境回放',exact:true}).waitFor();await page.waitForFunction(()=>window.replayMapDiagnostics?.position?.length===3);
  await page.getByRole('button',{name:'暂停回放',exact:true}).click();await page.waitForTimeout(100);const state=await page.evaluate(()=>({clock:window.replayDiagnostics,map:window.replayMapDiagnostics,chart:Number(document.querySelector('.elevation-chart svg').dataset.clockTime)}));
  assert(state.clock.time===state.map.time&&state.map.time===state.chart,'Replay clocks differ');assert(state.map.position.every(Number.isFinite),'Invalid map coordinates');report.replaySync=state;
  const slider=page.getByLabel('回放时间轴',{exact:true});await slider.press('End');await page.waitForTimeout(100);assert(await page.evaluate(()=>Math.abs(window.replayDiagnostics.time-Date.parse(window.replayDiagnostics.end))<1),'Keyboard seek failed');
  await page.getByRole('group',{name:'回放速度',exact:true}).getByRole('button',{name:'30×',exact:true}).click();assert(await page.evaluate(()=>window.replayDiagnostics.rate)===30,'Rate not changed');
  await page.getByRole('button',{name:'从头回放',exact:true}).click();await page.getByLabel('回放指定时间',{exact:true}).fill(new Date(Date.parse(state.clock.start)+15000+8*3600000).toISOString().slice(0,19));await page.getByRole('region',{name:'过境回放',exact:true}).getByRole('button',{name:'定位',exact:true}).click();
  await page.waitForTimeout(100);assert(await page.evaluate(()=>!window.replayDiagnostics.playing),'Input seek should pause');await shot('phase6-replay-1920.png');await page.getByRole('button',{name:'回到当前',exact:true}).click();assert(await page.getByRole('region',{name:'过境回放',exact:true}).count()===0,'Replay did not exit');await page.waitForFunction(()=>window.replayMapDiagnostics.position===null&&Math.abs(window.replayMapDiagnostics.time-Date.now())<2000);
 });
 await check('save_plan_snapshot_and_workspace_context',async()=>{
  await page.getByRole('button',{name:'保存观测计划',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('group',{name:'计划提醒提前',exact:true}).getByRole('button',{name:'30 分钟',exact:true}).click();await dialog.getByRole('checkbox').check();
  const response=page.waitForResponse(r=>r.url().endsWith('/api/plans')&&r.status()===201);await dialog.getByRole('button',{name:'确认保存计划',exact:true}).click();planId=(await(await response).json()).data.id;report.planId=planId;
  await dialog.getByRole('link',{name:'查看计划',exact:true}).click();await page.locator('.plan-snapshot').waitFor();assert((await api('/plans/'+planId)).data.version===1,'Wrong saved version');await shot('phase6-workspace-1920.png');
  await page.locator('.app-header nav').getByRole('link',{name:'观测规划',exact:true}).click();await page.locator('.task-status.completed').waitFor();assert(new URL(page.url()).searchParams.get('task')===taskId,'Task context lost');await page.waitForURL(url=>url.searchParams.get('event')===selected.id,{timeout:5000});await page.getByLabel('最低仰角 °',{exact:true}).fill('11');await page.locator('.app-header nav').getByRole('link',{name:'我的空间',exact:true}).click();await page.locator('.app-header nav').getByRole('link',{name:'观测规划',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#prediction-elevation')?.value==='11');await page.getByText('条件已修改，当前显示上次计算结果。',{exact:true}).waitFor();await page.getByLabel('最低仰角 °',{exact:true}).fill('10');
 });
 await check('saved_plan_replay_and_recalculation_confirmation',async()=>{
  await page.goto(base+'/observations?plan='+planId);await page.getByRole('button',{name:'回放过境',exact:true}).click();await page.getByRole('region',{name:'过境回放',exact:true}).waitFor();await page.getByRole('button',{name:'回到当前',exact:true}).click();
  await page.goto(base+'/workspace?plan='+planId);await page.locator('.plan-row-actions').getByRole('link',{name:'重新计算',exact:true}).first().click();await page.getByLabel('最低仰角 °',{exact:true}).fill('20');
  const response=page.waitForResponse(r=>r.url().endsWith('/api/predictions')&&r.status()===202);await page.getByRole('button',{name:'计算过境',exact:true}).click();taskId=(await(await response).json()).data.id;await page.locator('.task-status.completed').waitFor({timeout:60000});await pickFuture();
  await page.getByRole('button',{name:'更新计划',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'查看新旧差异',exact:true}).click();await page.getByRole('heading',{name:'确认重算差异',exact:true}).waitFor();assert((await api('/plans/'+planId)).data.version===1,'Preview already changed plan');await shot('phase6-plan-diff-1920.png');
  await dialog.getByRole('button',{name:'确认更新并启用计划',exact:true}).click();await dialog.getByRole('link',{name:'查看计划',exact:true}).click();assert((await api('/plans/'+planId)).data.version===2,'Confirmation did not update version');
 });
 await check('responsive_replay_and_plan_layout',async()=>{
  await page.goto(base+'/observations?plan='+planId);await page.getByRole('button',{name:'回放过境',exact:true}).click();await page.getByRole('region',{name:'过境回放',exact:true}).waitFor();await page.getByRole('button',{name:'暂停回放',exact:true}).click();
  for(const [width,height] of [[1440,900],[390,844]]){await page.setViewportSize({width,height});await page.waitForTimeout(300);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Replay page overflows '+width);await shot(`phase6-replay-${width}.png`);}
  await page.getByRole('button',{name:'回到当前',exact:true}).click();await page.setViewportSize({width:1920,height:1080});
 });
 await check('restart_persistence_cancel_and_reminder_version',async()=>{
  await promisify(execFile)('pwsh.exe',['-NoProfile','-Command','./scripts/stop.ps1 -KeepServices; ./scripts/start.ps1'],{cwd:'..',timeout:60000});await page.goto(base+'/workspace?plan='+planId);await page.locator('.plan-snapshot').waitFor({timeout:30000});assert((await api('/plans/'+planId)).data.version===2,'Plan did not survive restart');
  await page.locator('.plan-row-actions').getByRole('button',{name:'取消计划',exact:true}).first().click();await choose('计划状态筛选','cancelled');await page.waitForTimeout(300);const cancelled=(await api('/plans/'+planId)).data;assert(cancelled.status==='cancelled'&&cancelled.version===3&&cancelled.reminder.state==='cancelled','Cancellation did not revoke schedule');
 });
 assert(!report.errors.length,'Browser errors: '+report.errors.join('; '));report.allPassed=true;
}catch(e){report.failure=e.stack;await page.screenshot({path:'../docs/evidence/phase6-failure.png',fullPage:true}).catch(()=>{});throw e;}
finally{await writeFile('../docs/evidence/phase6-browser-2026-11-15.json',JSON.stringify(report,null,2));await browser.close();}
