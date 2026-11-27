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
 await (await step(mobile,'实际计算一次','observe-example')).click();
 await (await step(mobile,'改条件，比较两次计算','observe-compare')).click();
 const drawer=mobile.getByRole('dialog',{name:'AI 探索任务'});
 await drawer.getByLabel('追问对照').waitFor();
 await drawer.getByRole('complementary',{name:'练习完成'}).waitFor();
 assert.ok(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 evidence.push({viewport:390,lesson:'observation',allSteps:true,skipPersisted:true,keyboard:true,systemReducedMotion:true,
  sameWindowComparison:true,completionInDialog:true});
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
 await (await step(planner,'计算未来的过境','plan-calculate')).click();
 await (await step(planner,'选择一个未来窗口','plan-pass')).click();
 await (await step(planner,'打开保存选项','plan-open')).click();
 const confirmation=await step(planner,'确认保存计划','plan-confirm');
 const [savedResponse]=await Promise.all([planner.waitForResponse(response=>{
  const request=response.request();
  return request.method()==='POST'&&new URL(request.url()).pathname==='/api/plans';
 }),confirmation.click()]);
 assert.equal(savedResponse.status(),201);
 const planId=(await savedResponse.json()).data.id;
 await (await step(planner,'查看你保存的计划','plan-view')).click();
 await planner.getByRole('complementary',{name:'练习完成'}).waitFor();
 assert.equal(new URL(planner.url()).searchParams.get('plan'),planId);
 await planner.getByRole('heading',{name:/计划快照 v1/}).waitFor();
 evidence.push({viewport:390,lesson:'plan',allSteps:true,workerCompleted:true,planSavedAndOpened:true});
 await planner.close();

 const result={browser:'Edge',evidence};
 if(process.argv[2])writeFileSync(process.argv[2],JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result,null,2));
}finally{
 await browser.close();
}
