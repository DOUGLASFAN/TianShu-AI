import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const report={stage:4,checkedAt:new Date().toISOString(),checks:[],errors:[],wsConnections:0};
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:1920,height:1080}}),page=await context.newPage();
page.on('pageerror',e=>report.errors.push(e.message));page.on('websocket',()=>report.wsConnections++);
await page.addInitScript(()=>{const Native=window.WebSocket;window.WebSocket=class extends Native{constructor(...args){super(...args);window.testSocket=this;}};});
const assert=(condition,message)=>{if(!condition)throw Error(message);};
async function check(name,fn){await fn();report.checks.push({name,passed:true});console.log('PASS',name);}
try{
 await check('ticket_handshake_and_initial_snapshot',async()=>{
  await page.goto('http://127.0.0.1:5174/login');const account=JSON.parse(await readFile('../.local/config/demo-accounts.json','utf8')).student;
  await page.getByLabel('用户名',{exact:true}).fill(account.username);await page.getByLabel('密码',{exact:true}).fill(account.password);await page.getByRole('button',{name:'进入星巡'}).click();
  await page.getByText('实时连接：已连接',{exact:true}).waitFor();await page.waitForFunction(()=>window.starSceneDiagnostics?.frames>8,{},{timeout:60000});
  report.initialLive=await page.evaluate(()=>({...window.liveDiagnostics}));
 });
 await check('out_of_order_frame_ignored',async()=>{
  const before=await page.evaluate(()=>({...window.liveDiagnostics}));
  await page.evaluate(()=>{const d=window.liveDiagnostics;window.testSocket.onmessage(new MessageEvent('message',{data:JSON.stringify({type:'status',streamId:d.streamId,seq:d.seq,data:{serverTime:'1900-01-01'}})}));});
  const after=await page.evaluate(()=>({...window.liveDiagnostics}));assert(after.ignoredFrames===before.ignoredFrames+1&&after.seq===before.seq,'Old frame was accepted');
 });
 await check('metadata_filters_and_unknown_purpose',async()=>{
  await page.getByText('更多筛选',{exact:true}).click();await page.getByLabel('用途',{exact:true}).selectOption('unknown');await page.waitForURL(/use=unknown/);
  await page.getByLabel('轨道类型',{exact:true}).selectOption('GEO');await page.waitForURL(/orbit=GEO/);await page.waitForTimeout(400);
  assert(await page.locator('.directory-count b').innerText()!=='—','No filtered total');await page.getByLabel('轨道类型',{exact:true}).selectOption('');await page.getByLabel('用途',{exact:true}).selectOption('');await page.getByText('更多筛选',{exact:true}).click();
 });
 let globalData;
 await check('full_catalog_overview_and_first_performance',async()=>{
  const response=page.waitForResponse(r=>r.url().includes('/api/explore/global')&&r.status()===200);const started=Date.now();
  await page.getByRole('button',{name:'全球总览',exact:true}).click();globalData=await(await response).json();
  await page.waitForFunction(n=>window.starSceneDiagnostics?.globalPointCount===n,globalData.renderedCount,{timeout:60000});
  assert(globalData.renderedCount>10000&&!globalData.truncated,'Full catalog was not drawn');
  const before=await page.evaluate(()=>({frames:window.starSceneDiagnostics.frames,time:performance.now(),dpr:devicePixelRatio,hardwareConcurrency:navigator.hardwareConcurrency,userAgent:navigator.userAgent}));
  await page.waitForTimeout(8000);const after=await page.evaluate(()=>({frames:window.starSceneDiagnostics.frames,time:performance.now()}));
  report.performance={pointCount:globalData.renderedCount,catalogCount:globalData.catalogCount,computeMs:globalData.computeMs,loadMs:Date.now()-started-8000,payloadBytes:Buffer.byteLength(JSON.stringify(globalData)),renderFrames:after.frames-before.frames,elapsedMs:after.time-before.time,observedFps:(after.frames-before.frames)*1000/(after.time-before.time),browser:before,renderer:'Edge headless / SwiftShader software WebGL; not hardware acceptance'};
  await page.screenshot({path:'../docs/evidence/phase4-global-1920x1080.png'});
 });
 await check('api_restart_reconnect_and_new_snapshot',async()=>{
  const initial=await page.evaluate(()=>window.liveDiagnostics.connections);
  const command=`$ErrorActionPreference='Stop'; $r=Get-Content .local/config/application-processes.json -Raw|ConvertFrom-Json; $p=Get-Process -Id $r.api.pid; $t=[datetimeoffset]$r.api.startedAt; if([math]::Abs(($p.StartTime.ToUniversalTime()-$t.UtcDateTime).TotalSeconds)-gt 1){throw 'API identity changed'}; Stop-Process -Id $p.Id; & ./scripts/start.ps1`;
  await promisify(execFile)('pwsh.exe',['-NoProfile','-Command',command],{cwd:'..',timeout:60000});
  await page.waitForFunction(n=>window.liveDiagnostics.connections>n,initial,{timeout:60000});await page.getByText('实时连接：已连接',{exact:true}).waitFor();
  report.reconnectedLive=await page.evaluate(()=>({...window.liveDiagnostics}));assert(report.reconnectedLive.streamId!==report.initialLive.streamId,'Snapshot stream did not reset');
 });
 await check('historic_snapshot_does_not_extrapolate',async()=>{
  const historic={...globalData,delivery:'snapshot',databaseUnavailable:true,generatedAt:new Date(Date.now()-3600000).toISOString(),start:new Date(Date.now()-3600000).toISOString(),end:new Date(Date.now()-3500000).toISOString()};
  await page.route(/\/api\/explore\/global/,r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(historic)}));
  await page.getByRole('button',{name:'全球总览',exact:true}).click();await page.getByRole('button',{name:'全球总览',exact:true}).click();
  await page.getByText(/数据库暂不可用，显示/).waitFor();await page.waitForFunction(()=>window.starSceneDiagnostics.globalVisible===false);
  await page.unroute(/\/api\/explore\/global/);await page.getByRole('button',{name:'全球总览',exact:true}).click();
 });
 await check('independent_status_and_resource_cleanup',async()=>{
  await page.getByText('数据状态',{exact:true}).click();await page.getByText(/ISS 外部位置：/).waitFor();await page.getByText('数据状态',{exact:true}).click();
  await page.getByRole('link',{name:'我的空间',exact:true}).click();await page.waitForFunction(()=>window.starSceneDiagnostics.active===0);report.finalDiagnostics=await page.evaluate(()=>window.starSceneDiagnostics);
 });
 assert(report.errors.length===0,'Runtime errors: '+report.errors.join(';'));report.allPassed=true;
}catch(error){report.allPassed=false;report.failure=error.message;process.exitCode=1;console.error(error);await page.screenshot({path:'../docs/evidence/phase4-browser-failure.png'}).catch(()=>{});}
finally{await writeFile('../docs/evidence/phase4-browser-2026-11-12.json',JSON.stringify(report,null,2)+'\n');await browser.close();}
