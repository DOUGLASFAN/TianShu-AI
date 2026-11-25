import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:'reduce'}),base='http://127.0.0.1:5174',errors=[],report={date:'2026-11-15',checks:[]};page.on('pageerror',e=>errors.push(e.message));
async function choose(label,value){await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('listbox',{name:label,exact:true}).locator(`[role="option"][data-value="${value}"]`).click();}
const assert=(value,message)=>{if(!value)throw Error(message);};
try{
 const credentials={username:'chart_'+Date.now(),password:'Check-'+crypto.randomUUID()};await page.request.post(base+'/api/auth/register',{data:credentials});
 const login=await page.request.post(base+'/api/auth/login',{data:credentials,headers:{Origin:base}});const token=(await login.json()).accessToken;
 async function api(path,body){const r=await page.request.fetch(base+'/api'+path,{method:body?'POST':'GET',data:body,headers:{Authorization:'Bearer '+token}});assert(r.ok(),path+' failed');return await r.json();}
 const station=(await api('/stations',{name:'北京观测站',latitude:39.9,longitude:116.4,elevation_m:45})).data;
 const task=(await api('/predictions',{stationId:station.id,noradId:25544,start:new Date().toISOString(),days:7,minElevation:10,acceptStale:true})).data;report.taskId=task.id;
 await page.goto(base+'/observations?task='+task.id);await page.locator('.task-status.completed').waitFor({timeout:30000});await page.locator('.elevation-chart svg').waitFor();
 await page.getByLabel('仅有潜在目视窗口',{exact:true}).check();await choose('结果排序','elevation');await page.waitForTimeout(600);
 for(const [width,height] of [[1920,1080],[1440,900],[390,844]]){
  await page.setViewportSize({width,height});await page.waitForTimeout(600);
  const chart=await page.locator('.elevation-chart svg').evaluate(svg=>{const text=svg.querySelector('text'),scale=svg.getScreenCTM().a;return {viewBox:svg.getAttribute('viewBox'),renderedFontPixels:parseFloat(getComputedStyle(text).fontSize)*scale};});
  assert(chart.renderedFontPixels>=10,'Unreadable chart labels at '+width);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Page overflow');
  await page.locator('.elevation-chart svg').hover();await page.locator('.elevation-chart p').filter({hasText:'当前'}).waitFor();
  await page.mouse.move(0,0);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`../docs/evidence/phase5-observations-${width}x${height}.png`,fullPage:true});
  report.checks.push({width,height,...chart,hover:true,passed:true});
 }
 await page.getByRole('link',{name:'我的空间',exact:true}).click();await page.waitForTimeout(300);assert(await page.evaluate(()=>window.observationMapDiagnostics.active===0),'Scene leaked');assert(!errors.length,'Browser errors');report.allPassed=true;
 console.log(JSON.stringify(report));
}finally{report.errors=errors;await writeFile('../docs/evidence/phase5-chart-responsive-2026-11-15.json',JSON.stringify(report,null,2));await browser.close();}
