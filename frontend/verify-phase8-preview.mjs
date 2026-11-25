import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
process.chdir(dirname(fileURLToPath(import.meta.url)));
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}),page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:'reduce'}),base='http://127.0.0.1:5174',report={checks:[],errors:[]};page.on('pageerror',e=>report.errors.push(e.message));
const assert=(v,m)=>{if(!v)throw Error(m);};
try{
 const credentials=JSON.parse(await readFile('../.local/config/demo-accounts.json','utf8')).admin;await page.request.post(base+'/api/auth/login',{data:credentials,headers:{Origin:base}});
 await page.goto(base+'/dashboard');await page.waitForFunction(()=>window.dashboardDiagnostics?.statsTotal>0&&window.starSceneDiagnostics?.sampleCount>0,{},{timeout:30000});await page.waitForTimeout(300);
 const layout=await page.evaluate(()=>[...document.querySelectorAll('.dashboard-metrics,.dashboard-main,.dashboard-ranking,.dashboard-footer,.dashboard-global-status')].map(el=>{const r=el.getBoundingClientRect();return {name:el.className,x:r.x,y:r.y,width:r.width,height:r.height,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight};}));
 const banner=layout.find(x=>x.name==='dashboard-global-status'),metrics=layout.find(x=>x.name==='dashboard-metrics');if(banner.height>0)assert(banner.y+banner.height<=metrics.y+1,'Banner covers metrics');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight),'Dashboard page scrolls');report.checks.push({name:'status_row_does_not_cover_dashboard',layout,passed:true});
 await page.screenshot({path:'../docs/evidence/phase8-dashboard-1920.png'});
 await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(250);await page.screenshot({path:'../docs/evidence/phase8-dashboard-1440.png'});
 await page.setViewportSize({width:1920,height:1080});await page.goto(base+'/admin');await page.locator('.admin-source-card').first().waitFor();await page.screenshot({path:'../docs/evidence/phase8-admin-sources-1920.png',fullPage:true});assert(await page.locator('.admin-source-card').count()===10,'Missing sources');report.checks.push({name:'final_live_admin_sources',passed:true});
 assert(!report.errors.length,report.errors.join(';'));report.allPassed=true;console.log('PASS final dashboard and admin preview');
}catch(e){report.failure=e.stack;throw e;}finally{await writeFile('../docs/evidence/phase8-final-preview-2026-11-15.json',JSON.stringify(report,null,2));await browser.close();}
