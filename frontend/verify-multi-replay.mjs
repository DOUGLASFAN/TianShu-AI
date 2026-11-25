import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {writeFile} from 'node:fs/promises';
process.chdir(dirname(fileURLToPath(import.meta.url)));
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:'reduce'}),base='http://127.0.0.1:5174',report={date:'2026-11-15',checks:[],errors:[],screenshots:[]};
page.on('pageerror',e=>report.errors.push(e.message));page.on('dialog',d=>d.accept());
const assert=(v,m)=>{if(!v)throw Error(m);};
async function check(name,fn){await fn();report.checks.push({name,passed:true});console.log('PASS',name);}
async function choose(label,value){await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('listbox',{name:label,exact:true}).locator(`[role="option"][data-value="${value}"]`).click();}
let auth,task;
async function api(path,body){const r=await page.request.fetch(base+'/api'+path,{method:body?'POST':'GET',data:body,headers:{Authorization:'Bearer '+auth}});assert(r.ok(),path+' HTTP '+r.status()+': '+await r.text());return r.json();}
async function snapshot(){return page.evaluate(()=>({clock:window.replayDiagnostics,map:window.groupReplayDiagnostics,chart:Number(document.querySelector('.elevation-chart svg')?.dataset.clockTime)}));}
async function ready(){await page.waitForFunction(()=>window.groupReplayDiagnostics?.loadedCount>0&&!window.groupReplayDiagnostics?.loading);await page.locator('.elevation-chart svg').waitFor();}
async function seek(ms){await page.getByLabel('回放时间轴',{exact:true}).fill(String(ms));await ready();await page.waitForTimeout(150);}
try{
 const credentials={username:'multi_'+Date.now(),password:'Multi-'+crypto.randomUUID()};await page.request.post(base+'/api/auth/register',{data:credentials});auth=(await(await page.request.post(base+'/api/auth/login',{data:credentials,headers:{Origin:base}})).json()).accessToken;
 const station=(await api('/stations',{name:'北京',latitude:39.9,longitude:116.4,elevation_m:45})).data;
 const groups=(await api('/groups')).list;const beidou=groups.find(x=>x.slug==='beidou');assert(beidou,'Missing beidou group');
 task=(await api('/predictions/groups',{stationId:station.id,group:'beidou',size:100,start:new Date(Date.now()+10000).toISOString(),days:1,acceptStale:true})).data;
 for(let i=0;i<120;i++){task=(await api('/predictions/'+task.id)).data;if(task.status==='completed')break;assert(task.status!=='failed',JSON.stringify(task.execution));await page.waitForTimeout(1000);}assert(task.status==='completed','Prediction timed out');
 await page.goto(base+'/observations?task='+task.id);await page.getByRole('button',{name:'整组回放',exact:true}).waitFor();
 await check('entire_submitted_batch_not_only_event_page',async()=>{
  await page.getByRole('button',{name:'整组回放',exact:true}).click();await ready();await page.getByRole('button',{name:'暂停回放',exact:true}).click();await page.waitForTimeout(150);
  const s=await snapshot();assert(s.map.loadedCount===task.basis.targets.length&&s.map.loadedCount>8,'Batch truncated to event page');assert(s.clock.time===s.map.time&&s.clock.time===s.chart,'Clocks differ');report.batch={total:task.basis.targets.length,loaded:s.map.loadedCount};report.synchronization=s;
 });
 await check('changing_satellite_keeps_clock_and_curve_synchronized',async()=>{
  const before=await snapshot(),target=task.basis.targets.find(t=>t.satellite.noradId!==before.map.selectedNorad).satellite.noradId;
  await choose('回放卫星',target);await page.waitForFunction(id=>window.groupReplayDiagnostics?.selectedNorad===id,target);await page.waitForTimeout(200);
  const after=await snapshot();assert(after.clock.time===before.clock.time&&after.map.time===after.chart,'Selection reset clock');assert(after.map.selected.noradId===target,'Selection mismatch');
  const reference=(await api(`/predictions/${task.id}/group-replay/satellites/${target}?at=${encodeURIComponent(new Date(after.clock.time).toISOString())}`));assert(reference.basis.satellite.noradId===target,'Wrong saved root');
 });
 await check('geometric_filter_counts_and_map_click_selection',async()=>{
  await page.getByLabel('只看达到仰角要求',{exact:true}).check();await page.waitForTimeout(150);let state=await snapshot();assert(state.map.shownCount===state.map.aboveCount,'Geometric filter does not match count');
  await page.getByLabel('只看达到仰角要求',{exact:true}).uncheck();await page.locator('.observation-map').scrollIntoViewIfNeeded();await page.waitForTimeout(200);state=await snapshot();assert(state.map.shownCount===state.map.loadedCount,'Not all batch points restored');
  const box=await page.locator('.observation-map-canvas canvas').boundingBox();let picked=false;
  for(const candidate of state.map.pickCandidates.filter(x=>x.noradId!==state.map.selectedNorad)){
   await page.mouse.click(box.x+candidate.x,box.y+candidate.y);await page.waitForTimeout(250);const next=await snapshot();if(next.map.selectedNorad!==state.map.selectedNorad){assert(next.clock.time===state.clock.time,'Map pick reset clock');picked=true;report.mapPick={from:state.map.selectedNorad,to:next.map.selectedNorad};break;}
  }assert(picked,'No canvas satellite could be selected');
 });
 await check('seeking_across_windows_and_exact_query_endpoints',async()=>{
  await seek(Date.parse(task.basis.start)+3600000);let s=await snapshot();assert(s.map.time===s.clock.time&&s.chart===s.clock.time,'Seek clocks differ');assert(s.map.loadedCount===task.basis.targets.length,'Seek lost batch');
  const slider=page.getByLabel('回放时间轴',{exact:true});await slider.press('End');await ready();await page.waitForTimeout(200);s=await snapshot();assert(s.clock.time===Date.parse(task.basis.end)&&s.map.time===s.clock.time,'End boundary mismatch');
  await slider.press('Home');await ready();await page.waitForTimeout(150);s=await snapshot();assert(s.clock.time===Date.parse(task.basis.start)&&s.map.time===s.chart,'Home boundary mismatch');
  await page.getByRole('group',{name:'回放速度',exact:true}).getByRole('button',{name:'60×',exact:true}).click();await page.getByRole('button',{name:'播放回放',exact:true}).click();await page.waitForTimeout(900);await page.getByRole('button',{name:'暂停回放',exact:true}).click();await page.waitForTimeout(150);s=await snapshot();assert(s.clock.rate===60&&s.clock.time>Date.parse(task.basis.start)+10000,'Speed/play failed');assert(s.clock.time===s.map.time&&s.map.time===s.chart,'Pause clocks differ');
 });
 await check('failed_window_hides_old_points_without_extrapolation_and_retries',async()=>{
  const pattern='**/api/predictions/*/group-replay?*';await page.route(pattern,route=>route.abort('failed'));
  const target=Date.parse(task.basis.start)+7200000;await page.getByLabel('回放时间轴',{exact:true}).fill(String(target));
  await page.waitForFunction(()=>window.groupReplayDiagnostics?.loading&&window.groupReplayDiagnostics?.loadedCount===0);
  await page.getByRole('button',{name:'重试载入点位',exact:true}).waitFor({timeout:20000});let s=await snapshot();assert(s.clock.time===s.map.time&&s.map.selected===null,'Old points extrapolated during failure');
  await page.unroute(pattern);await page.getByRole('button',{name:'重试载入点位',exact:true}).click();await ready();await page.waitForTimeout(150);s=await snapshot();assert(s.map.loadedCount===task.basis.targets.length&&s.clock.time===s.map.time,'Retry did not restore same time and batch');
 });
 await check('responsive_layout_and_exit_resource_cleanup',async()=>{
  for(const width of [1920,1440,390]){await page.setViewportSize({width,height:1080});await page.waitForTimeout(250);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal page overflow '+width);await page.locator('.group-replay-panel').scrollIntoViewIfNeeded();const name=`phase6-multi-${width}.png`;await page.screenshot({path:'../docs/evidence/'+name,fullPage:true});report.screenshots.push(name);}
  await page.getByRole('button',{name:'回到当前',exact:true}).click();await page.waitForTimeout(250);const s=await snapshot();assert(!s.clock.active&&s.map.active===false,'Replay resources remain active');assert(Math.abs(s.clock.time-Date.now())<3000,'Did not return to real time');
 });
 await check('actual_500_target_task_and_simultaneous_map_batch',async()=>{
  await page.setViewportSize({width:1920,height:1080});
  const large=(await api('/predictions/groups',{stationId:station.id,group:'active',size:500,start:new Date(Date.now()+10000).toISOString(),days:1,acceptStale:true})).data;
  let value;
  for(let i=0;i<150;i++){value=(await api('/predictions/'+large.id)).data;if(value.status==='completed')break;assert(value.status!=='failed',JSON.stringify(value.execution));await page.waitForTimeout(1000);}assert(value.status==='completed','500 forecast timed out');
  await page.goto(base+'/observations?task='+large.id);await page.getByRole('button',{name:'整组回放',exact:true}).click();await ready();await page.getByRole('button',{name:'暂停回放',exact:true}).click();await page.waitForTimeout(200);
  const s=await snapshot();assert(s.map.totalCount===500&&s.map.loadedCount===500,'500 batch truncated');assert(s.clock.time===s.map.time&&s.map.time===s.chart,'500 clocks differ');
  report.largeBatch={taskId:large.id,loaded:s.map.loadedCount,above:s.map.aboveCount,execution:value.execution};
  await page.locator('.group-replay-panel').scrollIntoViewIfNeeded();await page.screenshot({path:'../docs/evidence/phase6-multi-500.png',fullPage:true});report.screenshots.push('phase6-multi-500.png');
  await page.getByRole('button',{name:'回到当前',exact:true}).click();
 });
 await check('zero_pass_batch_still_renders_all_satellites_and_curve',async()=>{
  const pole=(await api('/stations',{name:'北极验收站',latitude:90,longitude:0,elevation_m:0})).data;
  const empty=(await api('/predictions/groups',{stationId:pole.id,group:'beidou',size:100,start:new Date(Date.now()+10000).toISOString(),days:1,minElevation:90,acceptStale:true})).data;
  let value;for(let i=0;i<60;i++){value=(await api('/predictions/'+empty.id)).data;if(value.status==='completed')break;assert(value.status!=='failed','Empty batch failed');await page.waitForTimeout(1000);}assert(value.status==='completed','Empty batch timed out');
  const result=await api('/predictions/'+empty.id+'/results');assert(result.total===0,'Expected no polar zenith pass');
  await page.goto(base+'/observations?task='+empty.id);await page.getByRole('button',{name:'整组回放',exact:true}).click();await ready();await page.getByRole('button',{name:'暂停回放',exact:true}).click();await page.waitForTimeout(200);
  let s=await snapshot();assert(s.map.loadedCount===empty.basis.targets.length&&s.map.aboveCount===0,'No-pass batch vanished');assert(await page.getByText('该卫星在本次查询范围内没有达到仰角要求的过境，仍保留点位和当前窗口曲线。',{exact:true}).isVisible(),'Missing no-pass explanation');
  const selected=empty.basis.targets.at(-1).satellite.noradId;await choose('回放卫星',selected);await page.waitForFunction(id=>window.groupReplayDiagnostics.selectedNorad===id,selected);await page.waitForTimeout(200);s=await snapshot();assert(s.map.selected.noradId===selected&&s.clock.time===s.chart,'No-event selection/curve failed');
  report.zeroPass={taskId:empty.id,rendered:s.map.loadedCount,events:0};await page.getByRole('button',{name:'回到当前',exact:true}).click();
 });
 assert(!report.errors.length,report.errors.join(';'));report.allPassed=true;report.taskId=task.id;
}catch(e){report.failure=e.stack;await page.screenshot({path:'../docs/evidence/phase6-multi-failure.png',fullPage:true}).catch(()=>{});throw e;}
finally{await writeFile('../docs/evidence/phase6-multi-replay-browser-2026-11-15.json',JSON.stringify(report,null,2));await browser.close();}
