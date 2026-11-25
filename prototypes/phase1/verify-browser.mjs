import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('../..'), evidence=path.join(root,'docs/evidence');
await mkdir(path.join(root,'.local/cache/browser-phase1'),{recursive:true});
const browser=await chromium.launchPersistentContext(path.join(root,'.local/cache/browser-phase1'),{
  executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless:true,
  viewport:{width:1440,height:900}, args:['--use-angle=swiftshader'], serviceWorkers:'block'
});
const page=await browser.newPage(), external=[], errors=[], requests=[];
page.on('pageerror', e=>errors.push(e.message));
await browser.route('**/*',async route=>{
  const u=new URL(route.request().url());
  requests.push(u.href);
  if (!['127.0.0.1','localhost'].includes(u.hostname)) {external.push(u.href);await route.abort();}
  else await route.continue();
});
const require=(condition,msg)=>{if(!condition)throw Error(msg);};
const report={checked_at:new Date().toISOString(),browser:'installed Edge, isolated D-drive profile',
  mode:'headless software WebGL; all non-local HTTP blocked before cold page load',checks:[]};
try{
  await page.goto('http://127.0.0.1:5173/',{waitUntil:'networkidle',timeout:60000});
  await page.waitForFunction(()=>window.phase1Diagnostics?.entityCount>0 && window.phase1Diagnostics.frames>10,{timeout:60000});
  await page.getByRole('button',{name:'全球视角',exact:true}).waitFor({state:'visible'});
  await page.screenshot({path:path.join(evidence,'phase1-globe-1440x900.png'),fullPage:true});
  const initial=await page.evaluate(()=>({...window.phase1Diagnostics}));
  require(initial.activeViewers===1 && initial.webgl && initial.entityCount>=3,'Globe did not initialize');
  require(external.length===0,'Unexpected external resource dependency');
  report.checks.push({name:'cold_start_external_network_blocked',passed:true,diagnostics:initial,external_requests:external});
  const before=await page.locator('time').textContent();
  await page.waitForFunction(t=>document.querySelector('time')?.textContent!==t,before,{timeout:5000});
  report.checks.push({name:'simulation_clock_advances',passed:true});
  await page.getByRole('button',{name:'BEIDOU-3 M1',exact:false}).click();
  await page.waitForFunction(()=>window.phase1Diagnostics.selected===43001);
  await page.getByRole('button',{name:'定位卫星',exact:true}).click();
  await page.getByRole('button',{name:'跟踪卫星',exact:true}).click();
  await page.getByRole('button',{name:'退出跟踪',exact:true}).waitFor();
  await page.getByRole('button',{name:'退出跟踪',exact:true}).click();
  await page.getByRole('button',{name:'全球视角',exact:true}).click();
  report.checks.push({name:'select_locate_track_exit',passed:true});
  await page.getByRole('button',{name:'暂停',exact:true}).click();
  await page.waitForTimeout(1100);
  const paused=await page.locator('time').textContent();
  await page.waitForTimeout(1300);
  require(await page.locator('time').textContent()===paused,'Clock did not pause');
  await page.getByRole('button',{name:'播放',exact:true}).click();
  report.checks.push({name:'pause_resume',passed:true});
  for(let i=0;i<3;i++){
    await page.getByRole('button',{name:'重建场景',exact:true}).click();
    await page.waitForFunction(n=>window.phase1Diagnostics.created===n && window.phase1Diagnostics.activeViewers===1,i+2,{timeout:30000});
    await page.getByRole('button',{name:'全球视角',exact:true}).waitFor({state:'visible'});
  }
  const final=await page.evaluate(()=>({...window.phase1Diagnostics}));
  require(final.created===4 && final.destroyed===3 && final.activeViewers===1,'Viewer resource leak');
  require(errors.length===0,'Browser runtime errors: '+errors.join(';'));
  report.checks.push({name:'three_rebuilds_release_viewer',passed:true,diagnostics:final});
  for(const viewport of [{width:1920,height:1080},{width:1440,height:900}]){
    await page.setViewportSize(viewport);
    require(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal layout overflow');
  }
  report.checks.push({name:'desktop_layout',passed:true});
  report.local_resource_requests=requests.length;report.external_requests=external;report.page_errors=errors;report.all_passed=true;
}catch(error){report.all_passed=false;report.failure=String(error);await page.screenshot({path:path.join(evidence,'phase1-browser-failure.png'),fullPage:true});throw error;}
finally{
  await writeFile(path.join(evidence,'phase1-browser-2026-11-12.json'),JSON.stringify(report,null,2)+'\n');
  await browser.close();
  console.log(JSON.stringify(report));
}
