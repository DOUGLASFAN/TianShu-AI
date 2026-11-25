import {chromium} from 'playwright';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
const report={stage:3,checkedAt:new Date().toISOString(),checks:[],screenshots:[],errors:[],externalRequests:[],api5xx:[]};
const assert=(condition,message)=>{if(!condition)throw Error(message);};
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
page.on('pageerror',e=>report.errors.push(e.message));
page.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=500)report.api5xx.push({url:r.url(),status:r.status()});});
await context.route('**/*',r=>{if(!['127.0.0.1','localhost'].includes(new URL(r.request().url()).hostname)){report.externalRequests.push(r.request().url());return r.abort();}return r.continue();});
async function check(name,fn){await fn();report.checks.push({name,passed:true});console.log('PASS',name);}
async function ready(){await page.getByRole('button',{name:'定位',exact:true}).waitFor();await page.waitForFunction(()=>window.starSceneDiagnostics?.frames>8,{},{timeout:60000});await page.waitForFunction(()=>!document.querySelector('.target-actions button')?.disabled,{},{timeout:30000});}
async function select(id,name){await page.getByRole('textbox',{name:'搜索卫星'}).fill(String(id));await page.getByRole('button',{name:'选择 '+name,exact:true}).click();await page.waitForFunction(id=>window.starSceneDiagnostics?.selected===id,id);}
try{
 await check('register_and_authenticated_explorer',async()=>{
  const username='phase3_'+randomUUID().slice(0,8),password='Orbit-'+randomUUID();
  await page.goto('http://127.0.0.1:5174/register');await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByLabel('确认密码',{exact:true}).fill(password);await page.getByRole('button',{name:'创建账号',exact:true}).click();await page.getByRole('link',{name:'前往登录'}).click();
  await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'进入星巡'}).click();await ready();report.testUsername=username;
 });
 await check('three_desktop_sizes_and_local_8k_globe',async()=>{
  await select(25544,'ISS (ZARYA)');await ready();
  for(const [width,height]of [[1440,900],[1920,1080],[2560,1440]]){
   await page.setViewportSize({width,height});await page.waitForTimeout(1500);
   const layout=await page.evaluate(()=>{const boxes=[...document.querySelectorAll('.orbit-directory,.orbital-stage,.orbit-detail,.orbit-timebar')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};});return {boxes,scroll:document.documentElement.scrollHeight,view:innerHeight};});
   assert(layout.scroll<=height+1,'Unexpected whole-page scroll at '+width);assert(layout.boxes.every(b=>b.left>=0&&b.right<=width+1&&b.top>=0&&b.bottom<=height+1),'Clipped panels at '+width);
   const file=`phase3-explore-${width}x${height}.png`;await page.screenshot({path:'../docs/evidence/'+file});report.screenshots.push(file);
  }
  const diagnostics=await page.evaluate(()=>window.starSceneDiagnostics);assert(diagnostics.textureDimensions.every(d=>d[0]===8192&&d[1]===4096),'Textures are not 8K');assert(diagnostics.sampleCount>0&&diagnostics.active===1,'Scene not real/active');
 });
 await page.setViewportSize({width:1440,height:900});
 await check('catalog_filters_pagination_and_empty_state',async()=>{
  await page.getByRole('button',{name:'清空搜索'}).click();await page.getByRole('button',{name:'下一页卫星'}).click();await page.waitForURL(/page=2/);
  await page.getByLabel('目录分组',{exact:true}).selectOption('beidou');await page.waitForURL(/group=beidou/);await page.waitForTimeout(500);assert((await page.locator('.directory-count b').innerText()).includes('54'),'Group total mismatch');
  await page.getByLabel('目录分组',{exact:true}).selectOption('');await page.getByRole('textbox',{name:'搜索卫星'}).fill('no_such_orbit_'+randomUUID());await page.getByText('未找到匹配的卫星',{exact:true}).waitFor();
  await select(25544,'ISS (ZARYA)');await ready();
 });
 await check('locate_follow_drag_exit_and_home',async()=>{
  await page.getByRole('button',{name:'定位',exact:true}).click();await page.waitForTimeout(1400);await page.getByRole('button',{name:'持续跟踪',exact:true}).click();await page.waitForFunction(()=>window.starSceneDiagnostics.tracking===true);
  const box=await page.locator('.orbit-globe canvas').boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.58,box.y+box.height*.53,{steps:8});await page.mouse.up();await page.waitForFunction(()=>window.starSceneDiagnostics.tracking===false);
  await page.getByRole('button',{name:'全球视角',exact:true}).click();
 });
 await check('favorite_saved_and_restored_after_reload',async()=>{
  await page.getByRole('button',{name:'关注卫星',exact:true}).click();await page.getByRole('button',{name:'已加入关注',exact:true}).waitFor();await page.reload();await ready();await page.getByRole('button',{name:'已加入关注',exact:true}).waitFor();
 });
 await check('rapid_selection_late_response_cannot_replace_latest',async()=>{
  await page.route(/\/api\/(satellites\/20580$|explore\/satellites\/20580\/trajectory)/,async route=>{await new Promise(resolve=>setTimeout(resolve,1800));await route.continue().catch(()=>{});});
  await select(20580,'HST');await select(48274,'CSS (TIANHE)');await page.waitForTimeout(2400);await ready();
  assert(await page.locator('.satellite-identity h2').innerText()==='CSS (TIANHE)','Late detail replaced latest satellite');assert(await page.evaluate(()=>window.starSceneDiagnostics.selected)===48274,'Late sample replaced selected satellite');
  await page.unroute(/\/api\/(satellites\/20580$|explore\/satellites\/20580\/trajectory)/);
 });
 await check('pause_speed_exact_time_and_no_extrapolation',async()=>{
  await select(25544,'ISS (ZARYA)');await ready();await page.getByLabel('轨道播放倍率').selectOption('30');await page.getByRole('button',{name:'暂停轨道',exact:true}).click();await page.getByText('暂停查看',{exact:true}).waitFor();
  const slider=page.getByRole('slider',{name:'采样时间轴'});await slider.focus();await page.keyboard.press('End');await page.getByText('采样范围已结束',{exact:true}).waitFor({timeout:10000});
  await page.waitForFunction(()=>document.querySelector('[data-testid=altitude]')?.textContent?.includes('—'));assert(await page.getByRole('button',{name:'定位',exact:true}).isDisabled(),'Out-of-range target remains actionable');
  await page.getByRole('button',{name:'回到当前',exact:true}).click();await ready();await page.locator('summary').filter({hasText:'精确时间'}).click();await page.getByLabel('指定 UTC 时间').fill(new Date().toISOString().slice(0,19));await page.getByRole('button',{name:'定位时间',exact:true}).click();await page.getByText('暂停查看',{exact:true}).waitFor();await page.locator('summary').filter({hasText:'精确时间'}).click();
  await page.getByRole('button',{name:'回到当前',exact:true}).click();
 });
 await check('failure_and_recovery_are_visible',async()=>{
  await page.route(/\/api\/explore\/satellites\/20580\/trajectory/,r=>r.fulfill({status:422,contentType:'application/json',body:JSON.stringify({error:{code:'ORBIT_PROPAGATION_FAILED',message:'该卫星当前无法传播'},requestId:'phase3-failure'})}));
  // New sampling version ensures this checks a network failure, not a valid cache hit.
  const refreshed=page.waitForResponse(r=>r.url().includes('/api/explore/scene')&&r.status()===200);
  await page.getByRole('button',{name:'刷新采样',exact:true}).click();await refreshed;await page.waitForTimeout(300);
  await page.getByRole('textbox',{name:'搜索卫星'}).fill('20580');await page.getByRole('button',{name:'选择 HST',exact:true}).click();await page.getByText('该卫星当前无法传播',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'定位',exact:true}).isDisabled(),'Failed trajectory still actionable');
  await page.unroute(/\/api\/explore\/satellites\/20580\/trajectory/);await page.locator('.orbit-detail').getByRole('button',{name:'重新尝试',exact:true}).click();await ready();
 });
 await check('pure_view_and_route_resource_release',async()=>{
  await page.getByRole('button',{name:'纯净视图',exact:true}).click();assert(!await page.locator('.orbit-directory').isVisible(),'Pure view does not hide panels');await page.getByRole('button',{name:'恢复面板',exact:true}).click();
  for(let i=0;i<3;i++){
   await page.getByRole('link',{name:'我的空间',exact:true}).click();await page.waitForFunction(()=>window.starSceneDiagnostics.active===0);
   await page.getByRole('link',{name:'卫星探索',exact:true}).click();await ready();assert(await page.locator('.satellite-identity h2').innerText()==='HST','Route lost selection');
  }
  const d=await page.evaluate(()=>window.starSceneDiagnostics);assert(d.active===1&&d.created-d.destroyed===1,'Viewer resources leaked');report.resourceDiagnostics=d;
 });
 await check('reduced_motion_and_keyboard_controls',async()=>{
  await page.emulateMedia({reducedMotion:'reduce'});await ready();const input=page.getByRole('checkbox',{name:'减少动态效果（系统）'});assert(await input.isChecked()&&await input.isDisabled(),'System reduced motion ignored');
  assert(await page.locator('.orbit-directory').evaluate(e=>getComputedStyle(e).animationName)==='none','Reduced-motion panel still animates');
  await page.getByRole('button',{name:'定位',exact:true}).focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'全球视角',exact:true}).focus();await page.keyboard.press('Enter');
  await page.setViewportSize({width:960,height:640});await page.waitForTimeout(500);assert(await page.getByRole('button',{name:'回到当前',exact:true}).isVisible(),'Short viewport lost controls');
 });
 await check('earth_rotation_cloud_toggle_and_night_view',async()=>{
  await page.setViewportSize({width:1920,height:1080});await page.getByRole('button',{name:'全球视角',exact:true}).click();
  const clouds=page.getByRole('button',{name:'切换云层',exact:true});await clouds.click();assert(await clouds.getAttribute('aria-pressed')==='false','Cloud control failed');
  const box=await page.locator('.orbit-globe canvas').boundingBox();
  for(let i=0;i<2;i++){await page.mouse.move(box.x+box.width*.7,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.25,box.y+box.height*.5,{steps:16});await page.mouse.up();}
  await page.waitForTimeout(1500);await page.screenshot({path:'../docs/evidence/phase3-earth-rotated-night.png'});report.screenshots.push('phase3-earth-rotated-night.png');
 });
 assert(report.errors.length===0,'Page runtime errors');assert(report.api5xx.length===0,'API 5xx');assert(report.externalRequests.length===0,'External dependency found');report.allPassed=true;
}catch(error){report.allPassed=false;report.failure=error.message;await page.screenshot({path:'../docs/evidence/phase3-browser-failure.png'}).catch(()=>{});console.error(error);process.exitCode=1;}
finally{await writeFile('../docs/evidence/phase3-browser-2026-11-12.json',JSON.stringify(report,null,2)+'\n');await browser.close();}
