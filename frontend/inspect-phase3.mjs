import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--enable-webgl','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR',e.message.slice(0,700));});page.on('console',m=>{if(m.type()==='error'){errors.push(m.text().slice(0,1800));console.log('CONSOLE ERROR',m.text().slice(0,700));}});
await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
try{
 await page.goto('http://127.0.0.1:5174/login');const a=JSON.parse(await readFile('../.local/config/demo-accounts.json','utf8')).student;
 await page.getByLabel('用户名',{exact:true}).fill(a.username);await page.getByLabel('密码',{exact:true}).fill(a.password);await page.getByRole('button',{name:'进入星巡'}).click();
 await page.getByRole('heading',{name:'卫星',exact:true}).waitFor();
 await page.waitForFunction(()=>window.starSceneDiagnostics?.frames>15,{},{timeout:30000}).catch(()=>{});await page.waitForTimeout(2500);
 await page.getByRole('textbox',{name:'搜索卫星'}).fill('25544');await page.getByRole('button',{name:'选择 ISS (ZARYA)',exact:true}).waitFor();
 for(let i=0;i<3;i++){
  await page.getByRole('link',{name:'我的空间',exact:true}).click();await page.waitForFunction(()=>window.starSceneDiagnostics.active===0);
  await page.getByRole('link',{name:'卫星探索',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.target-actions button')?.disabled,{},{timeout:15000});
  console.log('Viewer reconstruction',i+1,await page.evaluate(()=>({active:window.starSceneDiagnostics.active,created:window.starSceneDiagnostics.created,destroyed:window.starSceneDiagnostics.destroyed,errors:window.starSceneDiagnostics.errors})));
 }
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(1500);await page.waitForFunction(()=>!document.querySelector('.target-actions button')?.disabled,{},{timeout:15000});
 await page.screenshot({path:'../docs/evidence/phase3-working-1440x900.png'});
 console.log(JSON.stringify({errors,diagnostics:await page.evaluate(()=>window.starSceneDiagnostics),body:(await page.locator('body').innerText()).slice(-1500)},null,2));
}finally{await browser.close();}
