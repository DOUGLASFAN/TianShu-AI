import {chromium} from 'playwright';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
process.chdir(dirname(fileURLToPath(import.meta.url)));
const command=promisify(execFile),base='http://127.0.0.1:5174',browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:'reduce'}),report={date:'2026-11-15',checks:[],errors:[],screenshots:[]};page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',d=>d.accept());
const assert=(v,m)=>{if(!v)throw Error(m);};async function check(name,fn){await fn();report.checks.push({name,passed:true});console.log('PASS',name);}
let auth,username='phase7_'+Date.now(),taskId,eventId,fixture;
async function api(path,body){const r=await page.request.fetch(base+'/api'+path,{method:body?'POST':'GET',data:body,headers:{Authorization:'Bearer '+auth}});assert(r.ok(),path+' HTTP '+r.status());return r.json();}
async function choose(label,value){await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('listbox',{name:label,exact:true}).locator(`[role="option"][data-value="${value}"]`).click();}
async function seed(delay,threshold=10,label='调度验收'){const r=await command('../backend/.venv/Scripts/python.exe',['../scripts/phase7_acceptance_fixture.py',username,'--delay',String(delay),'--threshold',String(threshold),'--label',label],{cwd:process.cwd(),timeout:10000});return JSON.parse(r.stdout);}
async function shot(name){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'../docs/evidence/'+name,fullPage:true});report.screenshots.push(name);}
try{
 const credentials={username,password:'Phase7-'+crypto.randomUUID()};await page.request.post(base+'/api/auth/register',{data:credentials});auth=(await(await page.request.post(base+'/api/auth/login',{data:credentials,headers:{Origin:base}})).json()).accessToken;
 await check('live_weather_sources_trends_and_semantics',async()=>{
  await page.goto(base+'/environment');await page.locator('.weather-source-grid article').first().waitFor();const overview=(await api('/environment')).data;assert(overview.sources.length===6,'Source coverage');assert(overview.observation.latest&&overview.trend.length>3,'No observed data');assert(overview.forecast.points.every(p=>p.kind==='forecast'),'Forecast has observations');assert(await page.locator('.weather-trend-grid svg').count()===2,'Missing charts');
  report.sources=overview.sources;report.latest=overview.observation;await page.getByRole('group',{name:'趋势范围',exact:true}).getByRole('button',{name:'24 小时',exact:true}).click();assert(new URL(page.url()).searchParams.get('hours')==='24','Trend context not in URL');
 });
 await check('weather_filter_pagination_detail_and_raw_download',async()=>{
  await choose('事件类别','radiation');await choose('事件时间范围','30');await page.waitForTimeout(300);const filtered=await api('/environment/events?category=radiation&days=30');assert(filtered.total>8,'Need real pagination');await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForTimeout(250);assert(new URL(page.url()).searchParams.get('page')==='2','Pagination URL lost');
  await page.locator('.weather-event-row').first().click();const dialog=page.getByRole('dialog');await dialog.locator('.weather-original').waitFor();assert(await dialog.getByText('发布时间',{exact:true}).isVisible()&&await dialog.getByText('发生时间',{exact:true}).isVisible(),'Time meanings missing');assert((await dialog.locator('a').first().getAttribute('href')).startsWith('https://services.swpc.noaa.gov/'),'Wrong source');await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert(new URL(page.url()).searchParams.get('page')==='2'&&new URL(page.url()).searchParams.get('category')==='radiation','Closing detail lost list context');
  const download=page.waitForEvent('download');await page.locator('.weather-source-grid article').first().getByRole('link',{name:'保存原始数据',exact:true}).click();const file=await download;assert(file.suggestedFilename().endsWith('.txt'),'Raw download failed');
 });
 await check('weather_sources_history_and_read_failure_fallback',async()=>{
  await page.locator('.weather-source-grid article').first().getByRole('button',{name:'采集记录',exact:true}).click();await page.locator('.weather-source-runs p').first().waitFor();
  await page.route('**/api/environment',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'ACCEPTANCE_FAILURE',message:'验收注入的视图读取失败'}})}));await page.getByRole('button',{name:'刷新视图',exact:true}).click();await page.getByRole('alert').filter({hasText:'保留上次读取结果'}).waitFor();assert((await page.locator('.weather-metric-value').first().innerText()).includes(String(report.latest.latest.kp.toFixed(2))),'Last view was discarded');await page.unroute('**/api/environment');await page.getByRole('button',{name:'刷新视图',exact:true}).click();await page.waitForTimeout(300);
 });
 await check('weather_responsive_layout_and_stable_navigation',async()=>{
  for(const [width,height] of [[1920,1080],[1440,900],[390,844]]){await page.setViewportSize({width,height});await page.waitForTimeout(200);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Weather overflow '+width);await shot(`phase7-environment-${width}.png`);await page.locator('.weather-event-row').first().click();const d=page.getByRole('dialog'),box=await d.boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=height+1,'Weather dialog overflow '+width);await page.keyboard.press('Escape');}
  await page.setViewportSize({width:1920,height:1080});let baseline;for(const url of ['/environment','/notifications','/catalog','/observations','/workspace']){await page.goto(base+url);await page.locator('.app-header').waitFor();const h=await page.locator('.app-header').evaluate(el=>({height:el.getBoundingClientRect().height,brand:el.querySelector('.brand').getBoundingClientRect().height,nav:[...el.querySelectorAll('nav a')].map(a=>{const r=a.getBoundingClientRect();return [a.textContent,r.x,r.width,r.height];})}));if(!baseline)baseline=JSON.stringify(h);assert(JSON.stringify(h)===baseline,'Header changed at '+url);}
 });
 await check('real_worker_notification_during_future_replay_and_ws_without_focus_theft',async()=>{
  const station=(await api('/stations',{name:'提醒验收站',latitude:39.9,longitude:116.4,elevation_m:40})).data;
  let task=(await api('/predictions',{stationId:station.id,noradId:25544,start:new Date(Date.now()+120000).toISOString(),days:3,acceptStale:true})).data;taskId=task.id;
  for(let i=0;i<60;i++){task=(await api('/predictions/'+taskId)).data;if(task.status==='completed')break;assert(task.status!=='failed','Prediction failed');await page.waitForTimeout(500);}assert(task.status==='completed','Prediction timeout');
  eventId=(await api('/predictions/'+taskId+'/results')).list[0].id;await page.goto(base+`/observations?task=${taskId}&event=${eventId}`);await page.getByRole('button',{name:'回放过境',exact:true}).click();await page.getByRole('button',{name:'暂停回放',exact:true}).click();const slider=page.getByLabel('回放时间轴',{exact:true});await slider.press('End');
  fixture=await seed(15);await slider.focus();const before=(await api('/notifications')).total;await page.waitForTimeout(1500);assert((await api('/notifications')).total===before,'Replay prematurely delivered reminder');
  await page.waitForFunction(()=>window.notificationDiagnostics?.unread===1,{},{timeout:25000});assert(await slider.evaluate(el=>el===document.activeElement),'Push stole input focus');const list=await api('/notifications');assert(list.total===1&&list.list[0].planId===fixture.id,'Wrong notification or duplicate');report.notification={...list.list[0],acceptanceFixture:true};await page.waitForTimeout(2500);assert((await api('/notifications')).total===1,'Repeated notification');
 });
 await check('notification_center_read_all_link_and_cancellation_revoke',async()=>{
  await page.getByRole('link',{name:/^通知中心/}).click();await page.locator('.notification-row').waitFor();await page.getByRole('button',{name:'标为已读',exact:true}).first().click();await page.waitForTimeout(250);assert((await api('/notifications')).unread===0,'Read failed');await page.locator('.notification-row').first().getByRole('link',{name:'查看计划',exact:true}).click();await page.locator('.plan-snapshot').waitFor();assert(new URL(page.url()).searchParams.get('plan')===fixture.id,'Plan link lost target');
  const second=await seed(2,5,'取消验收');await page.waitForFunction(()=>window.notificationDiagnostics?.unread===1,{},{timeout:10000});await api('/plans/'+second.id+'/cancel',{expectedVersion:1});await page.waitForFunction(()=>window.notificationDiagnostics?.unread===0,{},{timeout:10000});const notifications=await api('/notifications');assert(notifications.list.find(n=>n.planId===second.id).revokedAt,'Cancelled version not revoked');
  await page.goto(base+'/notifications');await page.getByRole('button',{name:'全部已读',exact:true}).click();await page.waitForTimeout(250);assert((await api('/notifications')).list.every(n=>n.readAt),'Read all did not persist');await shot('phase7-notifications-1920.png');
 });
 await check('restart_marks_overdue_and_restores_future_reminders',async()=>{
  await command('pwsh.exe',['-NoProfile','-Command','./scripts/stop.ps1 -KeepServices'],{cwd:'..',timeout:30000});
  const missed=await seed(-10,10,'重启错过验收'),future=await seed(40,30,'重启未来验收');await command('pwsh.exe',['-NoProfile','-Command','./scripts/start.ps1'],{cwd:'..',timeout:60000});
  const m=(await api('/plans/'+missed.id)).data;assert(m.reminder.state==='missed','Overdue restart did not mark missed');assert(!(await api('/notifications')).list.some(n=>n.planId===missed.id),'Missed reminder was delivered');const f=(await api('/plans/'+future.id)).data;assert(['pending','sent'].includes(f.reminder.state),'Future schedule not restored');
  await page.goto(base+'/notifications');await page.locator('.notification-list').waitFor();await page.waitForFunction(()=>window.notificationDiagnostics?.unread===1,{},{timeout:50000});const first=(await api('/notifications')).list.find(n=>n.planId===future.id);assert(first&&Date.parse(first.createdAt)>=Date.parse(future.dueAt),'Future reminder dispatched before threshold');report.restart={missed:missed.id,future:future.id,futureDeliveredAt:first.createdAt,initialFutureState:f.reminder.state};
 });
 await check('notification_mobile_layout_and_session_persistence',async()=>{
  for(const width of [1440,390]){await page.setViewportSize({width,height:900});await page.waitForTimeout(200);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Notification overflow');await shot(`phase7-notifications-${width}.png`);}await page.reload();await page.locator('.notification-row').first().waitFor();assert((await api('/notifications')).total===3,'Notification persistence lost');
 });
 assert(!report.errors.length,'Browser errors '+report.errors.join(';'));report.allPassed=true;
}catch(e){report.failure=e.stack;await page.screenshot({path:'../docs/evidence/phase7-failure.png',fullPage:true}).catch(()=>{});throw e;}
finally{await writeFile('../docs/evidence/phase7-browser-2026-11-15.json',JSON.stringify(report,null,2));await browser.close();}
