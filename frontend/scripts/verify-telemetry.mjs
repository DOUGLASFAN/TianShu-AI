import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {createServer} from 'vite';
const api=spawn('backend/.venv/Scripts/python.exe',['-m','uvicorn','backend.app.main:app','--host','127.0.0.1','--port','8028'],{cwd:'..',windowsHide:true,env:{...process.env,STAR_ALLOWED_ORIGINS:'http://127.0.0.1:5178'},stdio:'ignore'});
const server=await createServer({server:{port:5178,strictPort:true,host:'127.0.0.1',proxy:{'/api':{target:'http://127.0.0.1:8028',ws:true}}}});await server.listen();
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage();page.setDefaultTimeout(20000);
 for(let i=0;i<60;i++){if(await fetch('http://127.0.0.1:8028/api/health/live').then(r=>r.ok).catch(()=>false))break;await new Promise(r=>setTimeout(r,250))}
 await page.goto('http://127.0.0.1:5178/login');await page.getByRole('button',{name:'游客体验'}).click();await page.waitForURL('**/explore');
 await page.goto('http://127.0.0.1:5178/telemetry');await page.getByLabel('通道及覆盖时间').selectOption('2');
 await page.getByRole('button',{name:'分析所选时间窗'}).click();await page.getByText('均值已核验',{exact:false}).waitFor();await page.locator('.telemetry .cesium-widget canvas').waitFor();
 const waitPosition=page.waitForResponse(r=>r.url().includes('/position?')&&r.status()===200);
 await page.getByLabel('定位候选记录').selectOption('716');const pos=await (await waitPosition).json();assert.equal(pos.noradId,44878);
 await page.getByText('原始记录 #716',{exact:false}).waitFor();await page.getByLabel('曲线缩放').selectOption('4');
 await page.getByRole('button',{name:'按原版本复跑'}).click();await page.getByText('复跑摘要一致').waitFor();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出复盘报告'}).click();
 const report=JSON.parse(readFileSync(await (await download).path(),'utf8'));assert.deepEqual(report.candidates,[716]);assert.equal(report.stats.count,400);
 await page.goto('http://127.0.0.1:5178/observations');await page.getByText('观测规划',{exact:true}).first().waitFor({state:'attached'});
 const result={browser:'Edge',realApi:true,guest:true,segment:report.segment,sourceSha256:report.asset.sha256,candidate:716,samples:report.stats.count,utc:pos.time,orbitEpoch:pos.epoch,coordinates:pos.ecef_m,orbitCanvas:true,zoom:4,rerun:true,reportExport:true,observationsRoute:page.url()};
 writeFileSync('../docs/evidence/telemetry-browser-2026-11-27.json',JSON.stringify(result,null,2)+'\n');console.log('PASS',report.id);
}finally{await browser.close();await server.close();api.kill()}
