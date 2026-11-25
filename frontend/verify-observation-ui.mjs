import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:'reduce'}),base='http://127.0.0.1:5174',report={date:'2026-11-15',checks:[],screenshots:[],errors:[]};page.on('pageerror',e=>report.errors.push(e.message));
const assert=(value,message)=>{if(!value)throw Error(message);};
async function check(name,fn){await fn();report.checks.push({name,passed:true});console.log('PASS',name);}
async function shot(name){await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'../docs/evidence/'+name,fullPage:true});report.screenshots.push(name);}
let auth,taskId;
async function api(path,body){const r=await page.request.fetch(base+'/api'+path,{method:body?'POST':'GET',data:body,headers:{Authorization:'Bearer '+auth}});assert(r.ok(),path+' HTTP '+r.status());return r.json();}
try{
 const credentials={username:'ui_'+Date.now(),password:'Visual-'+crypto.randomUUID()};await page.request.post(base+'/api/auth/register',{data:credentials});const login=await page.request.post(base+'/api/auth/login',{data:credentials,headers:{Origin:base}});auth=(await login.json()).accessToken;
 await check('empty_layout_and_actionable_station_creation',async()=>{
  await page.goto(base+'/observations');await page.getByRole('button',{name:'新建观测站',exact:true}).waitFor();assert(await page.locator('.observation-detail').count()===0,'Empty detail panel still visible');assert(await page.locator('select').count()===0,'Native selects remain');
  await page.waitForFunction(()=>window.observationMapDiagnostics?.active===1);await page.waitForTimeout(500);await shot('observation-ui-empty-1920.png');
 });
 await check('centered_dialog_scroll_lock_and_focus',async()=>{
  await page.getByRole('button',{name:'新建观测站',exact:true}).click();const d=page.getByRole('dialog');const box=await d.boundingBox();assert(Math.abs(box.x+box.width/2-960)<2&&Math.abs(box.y+box.height/2-540)<2,'Dialog is not centered');assert(await page.evaluate(()=>getComputedStyle(document.body).overflow)==='hidden','Body not locked');assert(await d.getByLabel('名称',{exact:true}).evaluate(e=>e===document.activeElement),'Name not focused');
  await page.waitForTimeout(600);await shot('observation-ui-dialog-1920.png');
  await d.getByLabel('名称',{exact:true}).fill('北京观测站');await d.getByRole('button',{name:'保存观测站',exact:true}).click();await d.waitFor({state:'hidden'});assert(await page.evaluate(()=>getComputedStyle(document.body).overflow)!=='hidden','Body remained locked');
 });
 await check('custom_menu_keyboard_escape_and_outside_click',async()=>{
  const combo=page.getByRole('combobox',{name:'显示时区',exact:true});await combo.focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');assert(await combo.getAttribute('data-value')==='utc','Keyboard selection failed');
  await combo.click();const popup=page.getByRole('listbox',{name:'显示时区',exact:true});assert(await popup.evaluate(e=>getComputedStyle(e).backgroundColor)==='rgb(18, 34, 50)','Menu theme incorrect');const p=await popup.boundingBox();assert(p.x>=0&&p.x+p.width<=1920&&p.y>=0&&p.y+p.height<=1080,'Menu outside viewport');await shot('observation-ui-menu-1920.png');
  await page.keyboard.press('Escape');assert(await popup.count()===0,'Escape did not close');assert(await combo.evaluate(e=>e===document.activeElement),'Focus not preserved');await combo.click();await page.getByRole('heading',{name:'观测规划',exact:true}).click();assert(await popup.count()===0,'Outside click did not close');await combo.focus();await page.keyboard.press('Enter');await page.keyboard.press('Tab');assert(await popup.count()===0,'Tab did not close menu');
 });
 await check('range_selection_and_live_start_submission',async()=>{
  const group=page.getByRole('group',{name:'预测范围',exact:true});await group.getByRole('button',{name:'3 天',exact:true}).click();assert(await group.locator('[aria-pressed=true]').count()===1,'Range not exclusive');await group.getByRole('button',{name:'7 天',exact:true}).click();
  page.on('dialog',d=>d.accept());const pending=page.waitForResponse(r=>r.url().endsWith('/api/predictions')&&r.status()===202);await page.getByRole('button',{name:'计算过境',exact:true}).click();const created=(await(await pending).json()).data;taskId=created.id;assert(Math.abs(Date.now()-Date.parse(created.basis.start))<5000,'Current-time submission used old form time');
  await page.locator('.task-status.completed').waitFor({timeout:30000});await page.locator('.elevation-chart svg').waitFor();const curve=await page.locator('.elevation-chart').boundingBox(),table=await page.locator('.table-scroll').boundingBox();assert(curve.y<table.y,'Curve remains below results');await shot('observation-ui-result-1920.png');
 });
 await check('responsive_dialog_and_menus_1440_390',async()=>{
  for(const [width,height] of [[1440,900],[390,844]]){
   await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await page.waitForTimeout(400);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Page overflow');
   const combo=page.getByRole('combobox',{name:'显示时区',exact:true});await combo.click();const popup=await page.getByRole('listbox').boundingBox();assert(popup.x>=0&&popup.x+popup.width<=width&&popup.y>=0&&popup.y+popup.height<=height,'Menu overflow');await page.keyboard.press('Escape');
   await page.getByRole('button',{name:'新建观测站',exact:true}).click();const d=page.getByRole('dialog'),box=await d.boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height,'Dialog overflow');assert(Math.abs(box.x+box.width/2-width/2)<2,'Dialog off center');await shot(`observation-ui-dialog-${width}.png`);await page.keyboard.press('Escape');await d.waitFor({state:'hidden'});await shot(`observation-ui-result-${width}.png`);
  }
 });
 await check('visual_filter_preserves_snapshot_and_curve_hover',async()=>{
  await page.setViewportSize({width:1920,height:1080});await page.getByLabel('仅有潜在目视窗口',{exact:true}).check();await page.getByRole('combobox',{name:'结果排序',exact:true}).click();await page.getByRole('option',{name:'按最高仰角',exact:true}).click();await page.waitForTimeout(300);
  assert((await api('/predictions/'+taskId)).data.basis.days===7,'Conditions changed stored task');
  const event=(await api('/predictions/'+taskId+'/results?sort=elevation&visual=true')).list[0];assert(event,'No visible events for fixture');await page.getByRole('button',{name:'查看过境 '+event.id,exact:true}).click();await page.locator('.elevation-chart svg').hover();await page.locator('.elevation-chart p').filter({hasText:'当前'}).waitFor();
 });
 await check('explore_action_alignment_and_scene_cleanup',async()=>{
  await page.getByRole('link',{name:'卫星探索',exact:true}).click();await page.getByRole('link',{name:'预测过境',exact:true}).waitFor();await page.waitForTimeout(400);
  const predict=await page.getByRole('link',{name:'预测过境',exact:true}).boundingBox(),favorite=await page.getByRole('button',{name:'关注卫星',exact:true}).boundingBox();const camera=await page.locator('.target-actions button').first().boundingBox(),follow=await page.locator('.target-actions button').nth(1).boundingBox();assert(Math.abs(predict.x-camera.x)<1&&Math.abs(predict.width-camera.width)<1&&Math.abs(favorite.x-follow.x)<1&&Math.abs(predict.y-favorite.y)<1,'Action grid does not align');assert(await page.evaluate(()=>window.observationMapDiagnostics.active===0),'Observation map leaked');await shot('observation-ui-explore-actions.png');
 });
 assert(!report.errors.length,'Browser errors: '+report.errors.join('; '));report.allPassed=true;
}catch(e){report.failure=e.stack;await page.screenshot({path:'../docs/evidence/observation-ui-failure.png',fullPage:true}).catch(()=>{});throw e;}
finally{await writeFile('../docs/evidence/observation-ui-review-2026-11-15.json',JSON.stringify(report,null,2));await browser.close();}
