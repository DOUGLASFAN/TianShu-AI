import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {chromium} from 'playwright';

const base=process.env.GUIDE_TEST_URL||'http://127.0.0.1:5184';
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--enable-unsafe-swiftshader']});
const evidence=[];
const button=(page,name)=>page.getByRole('button',{name,exact:true});

async function enter(page){
 page.setDefaultTimeout(35000);
 await page.goto(base+'/login');
 await button(page,'游客体验').click();
}

async function step(page,name,tag){
 const card=page.locator('.guide-step');
 await card.getByRole('heading',{name,exact:true}).waitFor();
 const target=page.locator('[data-guide-target="'+tag+'"][data-guide-spotlight]');
 await target.waitFor();
 const c=await card.boundingBox(), t=await target.boundingBox();
 assert.ok(c.x+c.width<=t.x||t.x+t.width<=c.x||c.y+c.height<=t.y||t.y+t.height<=c.y,
  JSON.stringify({message:'Guide covers the action',tag,card:c,target:t}));
 return target;
}

try{
 const desktop=await browser.newPage({viewport:{width:1440,height:900}});
 await enter(desktop);
 await button(desktop,'开始新手引导').click();
 await desktop.getByRole('button',{name:/开始练习.*追查一条遥测异常/}).click();
 await (await step(desktop,'从地球打开书签','bookmarks')).click();
 await (await step(desktop,'打开公开示例','example')).click();
 await desktop.waitForURL(/telemetry\?run=.*record=716/);
 await step(desktop,'调查当前测量','investigate');
 await button(desktop,'稍后继续').click();
 await desktop.reload();
 const reportUrl=desktop.url();
 await button(desktop,'新手引导').click();
 await desktop.getByRole('button',{name:/继续上次练习/}).click();
 await (await step(desktop,'调查当前测量','investigate')).click();
 assert.equal(desktop.url(),reportUrl);
 await (await step(desktop,'把结论追到曲线','evidence')).click();
 await desktop.getByRole('complementary',{name:'练习完成'}).waitFor();
 assert.equal(await desktop.evaluate(()=>document.activeElement?.id),'telemetry-selected-record');
 await button(desktop,'选择其他练习').click();
 await desktop.getByRole('button',{name:/重新练习.*追查一条遥测异常/}).waitFor();
 evidence.push({viewport:1440,lesson:'anomaly',record:716,allSteps:true,resumedSameReportAfterReload:true,focusReturned:true,replayAvailable:true});
 await desktop.getByRole('dialog',{name:'新手引导'}).getByRole('button',{name:'关闭',exact:true}).click();
 const selectedIndex=Number(await desktop.getByLabel('片段时间轴').inputValue());
 await button(desktop,'框选调查').click();
 const endpoint=desktop.getByRole('slider',{name:/调查终点/});
 await endpoint.evaluate((input,value)=>{
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,String(value));
  input.dispatchEvent(new Event('input',{bubbles:true}));
 },selectedIndex+6);
 const selectionStart=await desktop.getByRole('slider',{name:/调查起点/}).getAttribute('aria-valuetext');
 const selectionEnd=await endpoint.getAttribute('aria-valuetext');
 assert.equal(await endpoint.inputValue(),String(selectedIndex+6));
 const [scopedResponse]=await Promise.all([desktop.waitForResponse(response=>
  response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/task-workflows/investigate'),
  button(desktop,'一键调查当前记录').click()]);
 const scoped=await scopedResponse.json();
 assert.equal(scoped.point.record,716);
 assert.equal(Date.parse(scoped.start),Date.parse(selectionStart));
 assert.equal(Date.parse(scoped.end),Date.parse(selectionEnd));
 await desktop.getByText('按时间查看同期证据',{exact:true}).click();
 await desktop.getByRole('link',{name:'回放同期轨道'}).click();
 await desktop.waitForURL(url=>url.pathname==='/explore'&&url.searchParams.get('at')===scoped.point.utc);
 const clock=desktop.locator('.clock-display time');
 await desktop.waitForFunction(utc=>Date.parse(document.querySelector('.clock-display time')?.dateTime)===Date.parse(utc),scoped.point.utc);
 assert.ok(await clock.isVisible());
 await desktop.getByRole('link',{name:'返回调查记录 #716'}).click();
 await desktop.locator('#telemetry-selected-record').filter({hasText:'#716'}).waitFor();
 assert.equal(await desktop.getByRole('slider',{name:/调查终点/}).getAttribute('aria-valuetext'),selectionEnd);
 await button(desktop,'一键调查当前记录').click();
 const [briefResponse]=await Promise.all([desktop.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/verification')),
  desktop.getByRole('link',{name:'制定这条记录的验证观测'}).click()]);
 const brief=await briefResponse.json();
 assert.equal(brief.point.record,716);
 assert.equal(brief.end,scoped.end);
 assert.equal(brief.quality.included,scoped.window.included);
 const next=desktop.getByRole('link',{name:'返回原始记录 #716'});
 await next.waitFor();
 if(brief.catalogAvailable){
  await button(desktop,'设置预测条件').click();
  await desktop.waitForFunction(()=>document.activeElement?.id==='observation-form');
 }else{
  await desktop.getByText(/目录暂无这个对象的可用轨道数据/).waitFor();
  assert.equal(await button(desktop,'设置预测条件').count(),0);
  assert.equal(await desktop.locator('#observation-form').count(),0);
  await desktop.getByRole('link',{name:'打开常规观测规划'}).waitFor();
 }
 await next.click();
 await desktop.locator('#telemetry-selected-record').filter({hasText:'#716'}).waitFor();
 assert.equal(await desktop.getByRole('slider',{name:/调查终点/}).getAttribute('aria-valuetext'),selectionEnd);
 evidence.push({viewport:1440,record:716,scopedContext:true,orbitAtRecordTime:true,scopeRestoredFromOrbit:true,
  verificationAtSameRecord:true,catalogAvailable:brief.catalogAvailable,scopeRestoredFromPlanning:true});
 await desktop.close();

 const mobile=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
 await enter(mobile);
 await button(mobile,'跳过').click();
 await mobile.reload();
 await button(mobile,'新手引导').waitFor();
 assert.equal(await button(mobile,'开始新手引导').count(),0);
 await button(mobile,'新手引导').click();
 await mobile.getByRole('button',{name:/开始练习.*用 AI 找观测窗口/}).click();
 const assistant=await step(mobile,'打开 AI 探索任务','assistant');
 assert.equal(await mobile.locator('.guide-step').evaluate(e=>getComputedStyle(e).animationName),'none');
 await button(mobile,'聚焦这一步').click();
 assert.ok(await assistant.evaluate(e=>document.activeElement===e));
 await mobile.keyboard.press('Enter');
 const requestObservation=response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/exploration-assistant/observation';
 const example=await step(mobile,'实际计算一次','observe-example');
 const [exampleResponse]=await Promise.all([mobile.waitForResponse(requestObservation),example.click()]);
 const compare=await step(mobile,'改条件，比较两次计算','observe-compare');
 const [comparisonResponse]=await Promise.all([mobile.waitForResponse(requestObservation),compare.click()]);
 const drawer=mobile.getByRole('dialog',{name:'AI 探索任务'});
 await drawer.getByLabel('追问对照').waitFor();
 const observationComplete=drawer.getByRole('complementary',{name:'练习完成'});
 await observationComplete.waitFor();
 assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 evidence.push({viewport:390,lesson:'observation',allSteps:true,skipPersisted:true,keyboard:true,systemReducedMotion:true,
  sameWindowComparison:true,completionInDialog:true});
 const original=await exampleResponse.json(),comparison=await comparisonResponse.json();
 const current=comparison.scenarios[0],previous=original.scenarios[0];
 const expected=current.windows.some(w=>Date.parse(w.start)>Date.now())?current:previous;
 const handoff=observationComplete.getByRole('button',{name:`继续做计划 · ${expected.minimum}°`});
 await handoff.click();
 await mobile.waitForURL(url=>url.pathname==='/observations');
 assert.equal(new URL(mobile.url()).searchParams.get('station'),expected.station.id);
 assert.equal(new URL(mobile.url()).searchParams.get('min'),String(expected.minimum));
 assert.equal(new URL(mobile.url()).searchParams.get('sat'),'25544');
 await step(mobile,'计算未来的过境','plan-calculate');
 await button(mobile,'稍后继续').click();
 await mobile.reload();
 await button(mobile,'新手引导').click();
 await button(mobile,'继续上次练习 · 把过境保存为观测计划').click();
 const calculation=await step(mobile,'计算未来的过境','plan-calculate');
 const [predictionResponse]=await Promise.all([mobile.waitForResponse(response=>
  response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/predictions'),calculation.click()]);
 assert.equal(predictionResponse.status(),202);
 const prediction=predictionResponse.request().postDataJSON();
 assert.equal(prediction.stationId,expected.station.id);
 assert.equal(prediction.noradId,25544);
 assert.equal(prediction.minElevation,expected.minimum);
 assert.equal(Math.floor(Date.parse(prediction.start)/1000),Math.floor(Date.parse(comparison.start)/1000));
 await (await step(mobile,'选择一个未来窗口','plan-pass')).click();
 await (await step(mobile,'打开保存选项','plan-open')).click();
 const confirmation=await step(mobile,'确认保存计划','plan-confirm');
 const [savedResponse]=await Promise.all([mobile.waitForResponse(response=>
  response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/plans'),confirmation.click()]);
 assert.equal(savedResponse.status(),201);
 const saved=(await savedResponse.json()).data;
 assert.equal(saved.snapshot.basis.satellite.noradId,prediction.noradId);
 assert.equal(saved.snapshot.basis.minElevation,prediction.minElevation);
 assert.equal(saved.snapshot.basis.station.id,prediction.stationId);
 await (await step(mobile,'查看你保存的计划','plan-view')).click();
 await mobile.getByRole('complementary',{name:'练习完成'}).waitFor();
 assert.equal(new URL(mobile.url()).searchParams.get('plan'),saved.id);
 await mobile.getByRole('heading',{name:/计划快照 v1/}).waitFor();
 evidence.push({viewport:390,lesson:'plan',allSteps:true,fromAIComparison:true,thresholdUsed:expected.minimum,
  resumedSameDraftAfterReload:true,matchingPredictionConditions:true,workerCompleted:true,planSavedAndOpened:true});
 await mobile.close();

 const settings=await browser.newPage({viewport:{width:320,height:800}});
 await enter(settings);
 await settings.goto(base+'/settings');
 await settings.getByRole('checkbox',{name:'减少探索动画'}).check();
 await button(settings,'新手引导').click();
 await settings.getByRole('button',{name:/开始练习.*追查一条遥测异常/}).click();
 const bookmarks=await step(settings,'从地球打开书签','bookmarks');
 assert.equal(await bookmarks.getAttribute('data-guide-spotlight'),'static');
 assert.equal(await settings.locator('.guide-step').evaluate(e=>getComputedStyle(e).animationName),'none');
 assert.ok(await settings.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await button(settings,'稍后继续').click();
 await settings.locator('[data-guide-target="bookmarks"]').click();
 await settings.getByRole('dialog',{name:'智能书签'}).waitFor();
 assert.equal(await settings.locator('.guide-step').count(),0);
 evidence.push({viewport:320,platformReducedMotion:true,realControlsWorkAfterPause:true,noHorizontalOverflow:true});
 await settings.close();

 const planner=await browser.newPage({viewport:{width:390,height:844}});
 await enter(planner);
 await button(planner,'开始新手引导').click();
 await planner.getByRole('button',{name:/开始练习.*把过境保存为观测计划/}).click();
 const calculateAgain=await step(planner,'计算未来的过境','plan-calculate');
 assert.equal(new URL(planner.url()).searchParams.get('sat'),'25544');
 await planner.getByLabel('最低仰角 °').fill('90');
 await calculateAgain.click();
 await planner.getByRole('status').filter({hasText:'没有可保存的未来过境'}).waitFor();
 await planner.getByLabel('最低仰角 °').fill('10');
 await calculateAgain.click();
 await step(planner,'选择一个未来窗口','plan-pass');
 evidence.push({viewport:390,standalonePlanEntry:true,adjustedConditionsAfterNoFuturePass:true});
 await planner.close();

 const result={browser:'Edge',evidence};
 if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
}finally{
 await browser.close();
}
