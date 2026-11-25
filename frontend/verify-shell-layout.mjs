import {chromium} from 'playwright';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1920,height:1080},reducedMotion:'no-preference'}),base='http://127.0.0.1:5174',report={date:'2026-11-15',headers:[],dialogs:[],errors:[]};page.on('pageerror',e=>report.errors.push(e.message));
const assert=(condition,message)=>{if(!condition)throw Error(message);};
async function header(){return page.locator('.app-header').evaluate(el=>{const rect=x=>{const r=x.getBoundingClientRect();return {x:r.x,y:r.y+scrollY,width:r.width,height:r.height};};return {header:rect(el),brand:rect(el.querySelector('.brand')),nav:[...el.querySelectorAll('nav a')].map(x=>({...rect(x),x:rect(x).x+el.querySelector('nav').scrollLeft})),brandFont:getComputedStyle(el.querySelector('.brand b')).fontSize,accountFont:getComputedStyle(el.querySelector('.account')).fontSize};});}
try{
 const credentials={username:'layout_'+Date.now(),password:'Layout-'+crypto.randomUUID()};await page.request.post(base+'/api/auth/register',{data:credentials});await page.request.post(base+'/api/auth/login',{data:credentials,headers:{Origin:base}});
 await page.goto(base+'/observations');await page.getByRole('button',{name:'新建观测站',exact:true}).waitFor();
 for(const [width,height] of [[1920,1080],[1440,900],[390,844]]){
  await page.setViewportSize({width,height});await page.evaluate(()=>scrollTo(0,0));await page.getByRole('button',{name:'新建观测站',exact:true}).click();const dialog=page.getByRole('dialog');await page.waitForTimeout(400);const box=await dialog.boundingBox(),map=await dialog.locator('.observation-map').boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height,'Dialog overflow');assert(Math.abs(box.x+box.width/2-width/2)<10,'Off-center dialog');if(width===1920)assert(box.width>=1190&&map.height>=419,'Large dialog not enlarged');if(width===1440)assert(box.width>=1110&&map.height>=359,'Desktop dialog not enlarged');report.dialogs.push({viewport:{width,height},dialog:box,map});await page.screenshot({path:`../docs/evidence/shell-dialog-${width}-2026-11-15.png`});await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 }
 for(const [width,height] of [[1920,1080],[1440,900],[390,844]]){
  await page.setViewportSize({width,height});let baseline;
  for(const name of ['卫星探索','卫星目录','观测规划','我的空间','卫星探索']){
   const nav=page.getByRole('navigation',{name:'主要导航'}),link=nav.getByRole('link',{name,exact:true});
   if(!await link.isVisible()&&await nav.getByRole('button',{name:'更多',exact:true}).isVisible())await nav.getByRole('button',{name:'更多',exact:true}).click();
   await link.click();await page.waitForTimeout(250);const current=await header();if(!baseline)baseline=current;assert(JSON.stringify(current)===JSON.stringify(baseline),'Header geometry changed on '+name+' at '+width+' '+JSON.stringify({baseline,current}));report.headers.push({width,route:name,...current});
  }
 }
 await page.setViewportSize({width:1920,height:1080});await page.getByRole('link',{name:'预测过境',exact:true}).waitFor();const boxes=await page.locator('.satellite-actions').evaluate(el=>[...el.querySelectorAll('button,a')].map(x=>{const r=x.getBoundingClientRect();return {text:x.textContent,x:r.x,y:r.y+scrollY,width:r.width,height:r.height};}));assert(boxes.length===4,'Action count changed');assert(Math.abs(boxes[0].y-boxes[1].y)<1&&Math.abs(boxes[2].y-boxes[3].y)<1,'Actions are not two rows');assert(boxes[2].y-(boxes[0].y+boxes[0].height)>=25,'Actions still crowded');report.actions=boxes;await page.screenshot({path:'../docs/evidence/shell-actions-2026-11-15.png'});
 assert(!report.errors.length,'Browser errors');report.allPassed=true;console.log(JSON.stringify({passed:true,headerComparisons:report.headers.length,dialogSizes:report.dialogs.map(x=>x.dialog.width)}));
}catch(e){report.failure=e.stack;throw e;}
finally{await writeFile('../docs/evidence/shell-layout-2026-11-15.json',JSON.stringify(report,null,2));await browser.close();}
