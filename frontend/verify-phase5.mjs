import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:1920,height:1080},reducedMotion:'reduce'}),page=await context.newPage();
const report={date:'2026-11-15',checks:[],screenshots:[],errors:[],renderer:'Edge headless / SwiftShader'},base='http://127.0.0.1:5174';
page.on('pageerror',e=>report.errors.push(e.message));
async function choose(label,value){await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('listbox',{name:label,exact:true}).locator(`[role="option"][data-value="${value}"]`).click();}
const assert=(condition,message)=>{if(!condition)throw Error(message);};
async function check(name,fn){await fn();report.checks.push({name,passed:true});console.log('PASS',name);}
let auth,taskId,firstStation;
async function request(path,options={}){const r=await page.request.fetch(base+'/api'+path,{...options,headers:{Authorization:'Bearer '+auth,...options.headers}});assert(r.ok(),`${path} HTTP ${r.status()}: ${await r.text()}`);return await r.json();}
try{
 await check('explore_to_observation_navigation',async()=>{
  const username='obs_'+Date.now(),password='Stage5-'+crypto.randomUUID();
  const reg=await page.request.post(base+'/api/auth/register',{data:{username,password}});assert(reg.ok(),'Registration failed');
  await page.goto(base+'/login');await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);
  const login=page.waitForResponse(r=>r.url().endsWith('/api/auth/login')&&r.status()===200);await page.getByRole('button',{name:'进入星巡'}).click();auth=(await(await login).json()).accessToken;
  await page.getByRole('link',{name:'预测过境',exact:true}).click();await page.waitForURL(/observations\?sat=25544/);await page.getByRole('heading',{name:'观测规划',exact:true}).waitFor();
 });
 await check('coordinate_station_creation_default_and_validation',async()=>{
  await page.getByRole('button',{name:'新建观测站',exact:true}).click();const dialog=page.getByRole('dialog');
  await dialog.getByLabel('名称',{exact:true}).fill('验收北京站');await dialog.getByLabel('纬度 °',{exact:true}).fill('91');await dialog.getByRole('button',{name:'保存观测站',exact:true}).click();assert(await dialog.isVisible(),'Invalid latitude accepted');
  await dialog.getByLabel('纬度 °',{exact:true}).fill('39.9');await dialog.getByLabel('经度 °',{exact:true}).fill('116.4');await dialog.getByLabel('海拔 m',{exact:true}).fill('45');
  await dialog.getByRole('button',{name:'保存观测站',exact:true}).click();await dialog.waitFor({state:'hidden'});firstStation=await page.getByRole('combobox',{name:'选择观测站',exact:true}).getAttribute('data-value');assert(firstStation,'No selected station');
  assert((await request('/stations')).list[0].is_default,'First station not default');
 });
 await check('globe_pick_cancel_and_edit',async()=>{
  await page.getByRole('button',{name:'新建观测站',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'地图选点',exact:true}).click();
  await page.waitForFunction(()=>window.observationMapDiagnostics?.active===2);const canvas=dialog.locator('canvas').first();await canvas.waitFor();await page.waitForTimeout(1000);const box=await canvas.boundingBox();await canvas.click({position:{x:box.width/2,y:box.height/2}});
  await page.waitForFunction(()=>window.observationMapDiagnostics.picks>0);assert(await dialog.getByLabel('纬度 °',{exact:true}).inputValue()!=='39.9','Pick did not update coordinate');
  page.once('dialog',d=>d.accept());await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});assert((await request('/stations')).total===1,'Cancelled candidate persisted');
  await page.getByRole('button',{name:'编辑观测站',exact:true}).click();await page.getByRole('dialog').getByLabel('名称',{exact:true}).fill('北京观测站');await page.getByRole('dialog').getByRole('button',{name:'保存观测站',exact:true}).click();await page.getByRole('dialog').waitFor({state:'hidden'});
  assert((await request('/stations')).list[0].name==='北京观测站','Station edit not saved');
 });
 await check('real_worker_seven_day_prediction_curve_and_sorting',async()=>{
  await page.getByRole('group',{name:'预测范围',exact:true}).getByRole('button',{name:'7 天',exact:true}).click();await page.getByRole('button',{name:'设为当前时间',exact:true}).click();
  page.on('dialog',d=>d.accept());const created=page.waitForResponse(r=>r.url().endsWith('/api/predictions')&&r.request().method()==='POST'&&r.status()===202);
  await page.getByRole('button',{name:'计算过境',exact:true}).click();taskId=(await(await created).json()).data.id;
  await page.locator('.task-status.completed').waitFor({timeout:60000});await page.locator('.elevation-chart svg').waitFor();
  const result=(await request('/predictions/'+taskId)).data;assert(result.total>8,'Expected seven-day result pagination');report.realTask={id:taskId,total:result.total,elapsedSeconds:(Date.parse(result.finishedAt)-Date.parse(result.startedAt))/1000};
  const first=await page.locator('tbody tr').first().innerText();await page.getByRole('button',{name:'下一页',exact:true}).click();await page.waitForTimeout(300);assert(await page.locator('tbody tr').first().innerText()!==first,'Pagination did not change');
  await choose('结果排序','elevation');await page.waitForTimeout(300);const results=(await request('/predictions/'+taskId+'/results?sort=elevation')).list;
  assert(results[0].max_elevation>=results[1].max_elevation,'Sort incorrect');await page.getByRole('button',{name:'查看过境 '+results[0].id,exact:true}).click();await page.locator('.elevation-chart svg').waitFor();
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'../docs/evidence/phase5-observations-1920x1080.png',fullPage:true});report.screenshots.push('phase5-observations-1920x1080.png');
 });
 await check('changed_conditions_timezone_visual_filter_and_provenance',async()=>{
  await page.getByLabel('最低仰角 °',{exact:true}).fill('20');await page.getByText('条件已修改，当前显示上次计算结果。',{exact:true}).waitFor();assert((await request('/predictions/'+taskId)).data.basis.minElevation===10,'Stored threshold changed');
  const before=await page.locator('.result-basis').innerText();await choose('显示时区','utc');const after=await page.locator('.result-basis').innerText();assert(before!==after,'Timezone display unchanged');
  await page.getByLabel('最低仰角 °',{exact:true}).fill('10');await page.getByLabel('仅有潜在目视窗口',{exact:true}).check();await page.waitForTimeout(400);assert((await request('/predictions/'+taskId+'/results?visual=true')).list.every(x=>x.visible_windows.length),'Visual filter incorrect');
  await page.locator('.calculation-basis summary').click();await page.getByText('计算完成 UTC',{exact:true}).waitFor();assert(await page.locator('.calculation-basis').innerText().then(x=>x.includes('不含亮度')),'Missing limitations');await page.getByRole('button',{name:'查看过境 '+(await request('/predictions/'+taskId+'/results?visual=true&sort=elevation')).list[0].id,exact:true}).click();
 });
 await check('responsive_layout_and_keyboard_editor',async()=>{
  for(const [width,height] of [[1440,900],[390,844]]){await page.setViewportSize({width,height});await page.waitForTimeout(500);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Horizontal overflow at '+width);const file=`phase5-observations-${width}x${height}.png`;await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'../docs/evidence/'+file,fullPage:true});report.screenshots.push(file);}
  await page.setViewportSize({width:1920,height:1080});await page.getByRole('button',{name:'新建观测站',exact:true}).click();await page.keyboard.type('键盘站');await page.keyboard.press('Tab');assert(await page.locator('#obs-latitude').evaluate(e=>e===document.activeElement),'Focus order incorrect');await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'hidden'});
 });
 await check('default_station_switch_delete_retains_prediction',async()=>{
  await page.getByRole('button',{name:'新建观测站',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('名称',{exact:true}).fill('临时站');await dialog.getByRole('button',{name:'保存观测站',exact:true}).click();await dialog.waitFor({state:'hidden'});
  await page.getByRole('button',{name:'设为默认观测站',exact:true}).click();await page.waitForTimeout(250);assert((await request('/stations')).list.find(s=>s.is_default).name==='临时站','Switch default failed');
  await page.getByRole('button',{name:'删除观测站',exact:true}).click();await page.waitForTimeout(350);assert((await request('/stations')).list[0].is_default,'Default fallback missing');
  await choose('选择观测站',firstStation);await page.getByRole('button',{name:'删除观测站',exact:true}).click();await page.waitForTimeout(350);assert((await request('/predictions/'+taskId)).data.basis.station.name==='北京观测站','Snapshot disappeared');
 });
 await check('queued_cancellation_and_history_restore',async()=>{
  const s=(await request('/stations',{method:'POST',data:{name:'取消验证站',latitude:39.9,longitude:116.4}})).data;
  const t=(await request('/predictions',{method:'POST',data:{stationId:s.id,noradId:25544,start:new Date(Date.now()+60000).toISOString(),days:7,minElevation:10,acceptStale:true}})).data;
  const cancelled=(await request('/predictions/'+t.id+'/cancel',{method:'POST'})).data;assert(['cancelled','cancelling'].includes(cancelled.status),'Cancellation response invalid');
  await page.goto(base+'/observations?task='+t.id);await page.getByText('服务已取消本次计算。',{exact:true}).waitFor({timeout:30000});await page.goto(base+'/observations?task='+taskId);await page.locator('.task-status.completed').waitFor();assert(await page.getByRole('group',{name:'预测范围',exact:true}).getByRole('button',{name:'7 天',exact:true}).getAttribute('aria-pressed')==='true','Query not restored');
 });
 await check('application_restart_persistence_and_scene_cleanup',async()=>{
  await promisify(execFile)('pwsh.exe',['-NoProfile','-Command','./scripts/stop.ps1 -KeepServices; ./scripts/start.ps1'],{cwd:'..',timeout:60000});
  await page.reload();await page.locator('.task-status.completed').waitFor({timeout:30000});assert((await request('/predictions/'+taskId)).data.total===report.realTask.total,'Results changed after restart');
  await page.getByRole('link',{name:'我的空间',exact:true}).click();await page.waitForTimeout(500);report.mapLifecycle=await page.evaluate(()=>({...window.observationMapDiagnostics}));assert(report.mapLifecycle.active===0,'Observation WebGL scene leaked');
 });
 assert(report.errors.length===0,'Browser errors: '+report.errors.join('; '));report.allPassed=true;
}catch(e){report.failure=e.stack;await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'../docs/evidence/phase5-failure.png',fullPage:true}).catch(()=>{});throw e;}
finally{await writeFile('../docs/evidence/phase5-browser-2026-11-15.json',JSON.stringify(report,null,2)+'\n');await browser.close();}
