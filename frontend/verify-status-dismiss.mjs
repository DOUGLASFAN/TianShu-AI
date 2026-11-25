import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';import {fileURLToPath} from 'node:url';
process.chdir(dirname(fileURLToPath(import.meta.url)));
const base='http://127.0.0.1:5174',report={date:'2026-11-18',checks:[],errors:[]},browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}),page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});
const assert=(v,m)=>{if(!v)throw Error(m);};page.on('pageerror',e=>report.errors.push(e.message));
try{
 const credentials=JSON.parse(await readFile('../.local/config/demo-accounts.json','utf8')).admin;
 await page.request.post(base+'/api/auth/login',{data:credentials,headers:{Origin:base}});
 await page.goto(base+'/admin');await page.getByRole('heading',{name:'上次恢复检查',exact:true}).waitFor();
 assert(await page.locator('.system-status-banner').count()===0,'Historical state still blocks page');
 await page.screenshot({path:'../docs/evidence/status-history-admin-2026-11-18.png',fullPage:true});report.checks.push('真实历史结果在管理页保留，全局无横幅');
 await page.goto(base+'/explore');await page.waitForFunction(()=>window.starSceneDiagnostics?.frames>2);await page.screenshot({path:'../docs/evidence/status-explore-clear-2026-11-18.png'});assert(!await page.locator('.system-status-banner').count(),'Explore obstructed');report.checks.push('真实探索页不再被历史提示遮挡');
 let demo={phase:'recovering',startedAt:'2026-11-18T10:00:00Z',restoreRequestedAt:'2026-11-18T10:01:00Z'};
 await page.route('**/api/system/status',r=>r.fulfill({json:{data:{demo}}}));
 await page.locator('.system-status-banner.recovering').waitFor({timeout:6000});await page.getByRole('button',{name:'关闭状态提示',exact:true}).click();
 await page.waitForTimeout(2500);assert(!await page.locator('.system-status-banner').count(),'Polling resurrected dismissal');
 await page.reload();await page.waitForTimeout(2500);assert(!await page.locator('.system-status-banner').count(),'Reload resurrected dismissal');report.checks.push('恢复检查关闭后，轮询和刷新不重新弹出');
 demo={phase:'active',startedAt:'2026-11-18T10:02:00Z',restoreRequestedAt:''};await page.locator('.system-status-banner.active').waitFor({timeout:6000});await page.getByRole('button',{name:'关闭状态提示',exact:true}).click();await page.locator('.system-status-chip').waitFor();assert(!await page.locator('.system-status-banner').count(),'Active banner not collapsed');
 await page.getByRole('button',{name:'展开',exact:true}).click();await page.locator('.system-status-banner.active').waitFor();await page.getByRole('button',{name:'关闭状态提示',exact:true}).click();
 demo={...demo,startedAt:'2026-11-18T10:03:00Z'};await page.locator('.system-status-banner.active').waitFor({timeout:6000});report.checks.push('运行中演示收起后仍显式标记，可展开，新一轮演示重新提示');
 demo={phase:'degraded',startedAt:'2026-11-18T10:03:00Z'};await page.locator('.system-status-banner').waitFor({state:'detached',timeout:6000});assert(!await page.locator('.system-status-chip').count(),'Historical active chip stuck');report.checks.push('演示结束后自动移除全局提示，不改写后端恢复结果');
 assert(!report.errors.length,report.errors.join(';'));report.allPassed=true;console.log(JSON.stringify({passed:true,checks:report.checks.length}));
}catch(e){report.failure=e.stack;throw e;}finally{await writeFile('../docs/evidence/status-dismiss-2026-11-18.json',JSON.stringify(report,null,2));await browser.close();}
