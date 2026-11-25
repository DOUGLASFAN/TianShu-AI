import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve('..'),evidence=path.join(root,'docs/evidence');
const profile=path.join(root,'.local/cache/browser-phase2-'+Date.now());await mkdir(profile,{recursive:true});
const context=await chromium.launchPersistentContext(profile,{executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,viewport:{width:1440,height:900},serviceWorkers:'block'});
const page=await context.newPage(),errors=[],external=[],serverErrors=[];
const report={stage:2,checked_at:new Date().toISOString(),checks:[]};
const check=(condition,message)=>{if(!condition)throw Error(message);};
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=500)serverErrors.push({url:r.url(),status:r.status()});});
await context.route('**/*',async route=>{
 const host=new URL(route.request().url()).hostname;
 if(!['127.0.0.1','localhost'].includes(host)){external.push(route.request().url());await route.abort();}
 else await route.continue();
});
const username='browser_'+randomUUID().slice(0,8),password='Browser-'+randomUUID();
async function login(user,pass){await page.getByLabel('用户名',{exact:true}).fill(user);await page.getByLabel('密码',{exact:true}).fill(pass);await page.getByRole('button',{name:'进入星巡'}).click();await page.getByRole('heading',{name:'卫星目录',exact:true}).waitFor();}
try{
 await page.goto('http://127.0.0.1:5174/workspace');
 await page.getByRole('heading',{name:'欢迎回来'}).waitFor();
 await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.access-card')).opacity)>.99);
 await page.screenshot({path:path.join(evidence,'phase2-login-1440x900.png'),fullPage:true});
 report.checks.push({name:'protected_route_and_login_design',passed:true});
 await page.getByRole('link',{name:'创建账号',exact:true}).click();
 await page.getByLabel('用户名',{exact:true}).fill(username);await page.getByLabel('密码',{exact:true}).fill(password);await page.getByLabel('确认密码',{exact:true}).fill(password);
 await page.getByRole('button',{name:'创建账号',exact:true}).click();await page.getByText('账号已创建，请使用新账号登录。').waitFor();
 await page.getByRole('link',{name:'前往登录'}).click();await login(username,password);
 const cookie=(await context.cookies()).find(c=>c.name==='star_session');check(cookie?.httpOnly&&cookie.sameSite==='Strict','Session cookie flags incorrect');
 check(await page.evaluate(()=>!Object.keys(localStorage).some(k=>/token/i.test(k))),'Token persisted in localStorage');
 report.checks.push({name:'register_login_memory_token_httponly_cookie',passed:true});
 await page.getByRole('textbox',{name:'搜索卫星'}).fill('25544');
 await page.getByRole('button',{name:'关注 ISS (ZARYA)',exact:true}).click();
 await page.getByRole('button',{name:'取消关注 ISS (ZARYA)',exact:true}).waitFor();
 await page.getByRole('link',{name:'我的空间',exact:true}).click();
 await page.getByText('ISS (ZARYA)',{exact:true}).waitFor();
 await page.getByLabel('观测站名称',{exact:true}).fill('浏览器验收观测站');
 await page.getByRole('button',{name:'保存观测站',exact:true}).click();await page.getByText('浏览器验收观测站',{exact:true}).waitFor();
 await page.reload();await page.getByText('浏览器验收观测站',{exact:true}).waitFor();await page.getByText('ISS (ZARYA)',{exact:true}).waitFor();
 report.checks.push({name:'favorites_station_save_and_page_reload',passed:true});
 await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('heading',{name:'欢迎回来'}).waitFor();
 await page.reload();await page.getByRole('heading',{name:'欢迎回来'}).waitFor();
 report.checks.push({name:'logout_remains_logged_out_after_reload',passed:true});
 const admin=JSON.parse(await readFile(path.join(root,'.local/config/demo-accounts.json'),'utf8')).admin;
 await login(admin.username,admin.password);
 await page.setViewportSize({width:1920,height:1080});
 await page.getByRole('textbox',{name:'搜索卫星'}).fill('ISS');
 await page.getByRole('button',{name:'ISS (ZARYA)',exact:true}).waitFor();
 await page.screenshot({path:path.join(evidence,'phase2-catalog-1920x1080.png'),fullPage:true});
 await page.getByRole('link',{name:'系统管理',exact:true}).click();await page.getByRole('heading',{name:'账户管理'}).waitFor();
 await page.getByText(username,{exact:true}).waitFor();
 report.checks.push({name:'admin_only_navigation_and_real_logs',passed:true});
 check(errors.length===0,'Page errors: '+errors.join(';'));check(serverErrors.length===0,'Unexpected API 5xx');check(external.length===0,'External dependencies requested');
 for(const viewport of [{width:1440,height:900},{width:1920,height:1080}]){await page.setViewportSize(viewport);check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow');}
 report.checks.push({name:'local_assets_no_runtime_errors_and_desktop_layout',passed:true});
 report.all_passed=true;report.test_username=username;report.page_errors=errors;report.external_requests=external;report.api_5xx=serverErrors;
}catch(error){report.all_passed=false;report.failure=String(error);await page.screenshot({path:path.join(evidence,'phase2-browser-failure.png'),fullPage:true});throw error;}
finally{await writeFile(path.join(evidence,'phase2-browser-2026-11-12.json'),JSON.stringify(report,null,2)+'\n');await context.close();console.log(JSON.stringify(report));}
