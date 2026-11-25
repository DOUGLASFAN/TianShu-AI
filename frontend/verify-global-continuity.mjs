import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:'reduce'}),base='http://127.0.0.1:5174',report={date:'2026-11-15',checks:[],errors:[],renderer:'Edge headless / software WebGL'};page.on('pageerror',e=>report.errors.push(e.message));
const assert=(v,m)=>{if(!v)throw Error(m);};
async function check(name,fn){await fn();report.checks.push({name,passed:true});console.log('PASS',name);}
const diagnostic=()=>page.evaluate(()=>({...window.starSceneDiagnostics}));
let actual,paused;
try{
 const credentials={username:'continuity_'+Date.now(),password:'Window-'+crypto.randomUUID()};await page.request.post(base+'/api/auth/register',{data:credentials});await page.request.post(base+'/api/auth/login',{data:credentials,headers:{Origin:base}});
 await page.goto(base+'/explore');await page.getByRole('button',{name:'全球总览',exact:true}).waitFor();
 await check('real_catalog_drag_and_zoom_remains_visible',async()=>{
  const response=page.waitForResponse(r=>r.url().endsWith('/api/explore/global')&&r.status()===200);await page.getByRole('button',{name:'全球总览',exact:true}).click();actual=await(await response).json();
  await page.waitForFunction(()=>window.starSceneDiagnostics.globalVisible===true);assert(actual.renderedCount>10000,'Not the real full catalogue');assert(Date.parse(actual.start)<Date.parse(actual.generatedAt)&&Date.parse(actual.end)>Date.parse(actual.generatedAt),'No server window overlap');
  const canvas=page.locator('.orbital-stage canvas').first(),box=await canvas.boundingBox();await page.mouse.move(box.x+box.width*.5,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.55,{steps:12});await page.mouse.up();await page.mouse.wheel(0,-150);
  for(let i=0;i<4;i++){await page.waitForTimeout(700);assert((await diagnostic()).globalVisible,'Catalogue disappeared while moving the camera');}
  report.actual={catalogCount:actual.catalogCount,renderedCount:actual.renderedCount,start:actual.start,end:actual.end,generatedAt:actual.generatedAt};await page.screenshot({path:'../docs/evidence/global-continuity-2026-11-15.png'});
 });
 await check('automatic_refresh_preserves_covering_previous_window',async()=>{
  await page.getByRole('button',{name:'暂停轨道',exact:true}).click();const text=await page.locator('.clock-display time').innerText();paused=Date.parse(text.replace(' UTC','Z').replace(' ','T'));
  const before=await diagnostic();await page.route('**/api/explore/global',async route=>{
   // Inject only timing for a deterministic handoff test; these are not numerical reference coordinates.
   const generated=new Date().toISOString();await route.fulfill({json:{...actual,start:new Date(paused+5000).toISOString(),end:new Date(paused+65000).toISOString(),generatedAt:generated,generatedTimestamp:Date.parse(generated)/1000,delivery:'database'}});
  });
  await page.waitForResponse(r=>r.url().endsWith('/api/explore/global')&&r.status()===200,{timeout:30000});await page.waitForFunction(()=>window.starSceneDiagnostics.globalWindowCount>=2);
  const after=await diagnostic();assert(after.globalVisible&&after.globalActiveStart===before.globalActiveStart,'Valid previous batch was discarded');assert(after.globalCollectionBuilds===before.globalCollectionBuilds,'Point collection rebuilt during refresh');assert(await page.getByText(/当前时间超出总览采样范围/).count()===0,'False time warning');report.syntheticTimeWindowInjection={before,after};
 });
 await check('switch_window_without_rebuild_and_no_extrapolation',async()=>{
  const before=await diagnostic();await page.getByText('精确时间',{exact:true}).click();await page.getByLabel('指定 UTC 时间',{exact:true}).fill(new Date(paused+10000).toISOString().slice(0,19));await page.getByRole('button',{name:'定位时间',exact:true}).click();
  await page.waitForFunction(start=>window.starSceneDiagnostics.globalActiveStart!==start,before.globalActiveStart);const after=await diagnostic();assert(after.globalVisible&&after.globalCollectionBuilds===before.globalCollectionBuilds,'Handoff recreated or hid catalogue');
  await page.getByLabel('采样时间轴',{exact:true}).press('End');await page.waitForFunction(()=>window.starSceneDiagnostics.globalVisible===false);await page.getByText(/当前时间超出总览采样范围/).waitFor();
  await page.getByRole('button',{name:'回到当前',exact:true}).click();await page.waitForFunction(()=>window.starSceneDiagnostics.globalVisible===true);await page.unroute('**/api/explore/global');
  await page.getByRole('button',{name:'全球总览',exact:true}).click();assert((await diagnostic()).globalPointCount===0,'Global disable did not release points');await page.locator('.app-header nav').getByRole('link',{name:'我的空间',exact:true}).click();await page.waitForFunction(()=>window.starSceneDiagnostics.active===0);
 });
 assert(!report.errors.length,'Browser errors: '+report.errors.join('; '));report.allPassed=true;
}catch(e){report.failure=e.stack;await page.screenshot({path:'../docs/evidence/global-continuity-failure.png'}).catch(()=>{});throw e;}
finally{await writeFile('../docs/evidence/global-continuity-2026-11-15.json',JSON.stringify(report,null,2));await browser.close();}
