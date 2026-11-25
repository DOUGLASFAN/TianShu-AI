import {chromium} from 'playwright';
import {readFile,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';import {fileURLToPath} from 'node:url';
process.chdir(dirname(fileURLToPath(import.meta.url)));
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}),page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'}),base='http://127.0.0.1:5174',report={checks:[],errors:[],tiles:[]};
page.on('pageerror',e=>report.errors.push(e.message));page.on('response',r=>{if(r.url().includes('/api/maps/tiles/'))report.tiles.push({tile:r.url().split('/api/maps/tiles/')[1],status:r.status()});});
const assert=(v,m)=>{if(!v)throw Error(m);};
try{
 const credentials=JSON.parse(await readFile('../.local/config/demo-accounts.json','utf8')).admin;const login=await page.request.post(base+'/api/auth/login',{data:credentials,headers:{Origin:base}});assert(login.ok(),'Login failed');
 await page.goto(base+'/');await page.waitForFunction(()=>Object.keys(window.basemapDiagnostics||{}).length>0);await page.waitForTimeout(1500);
 report.checks.push({name:'far-earth',diagnostic:await page.evaluate(()=>window.basemapDiagnostics)});
 await page.screenshot({path:'../docs/evidence/maps-space-1440.png'});
 await page.mouse.move(720,410);
 for(let i=0;i<7;i++){await page.mouse.wheel(0,-650);await page.waitForTimeout(500);}
 await page.waitForTimeout(20000);
 report.checks.push({name:'zoomed-earth',diagnostic:await page.evaluate(()=>window.basemapDiagnostics)});
 await page.locator('.basemap-control summary').click();await page.getByRole('button',{name:'街道',exact:true}).click();await page.waitForTimeout(20000);
 await page.screenshot({path:'../docs/evidence/maps-streets-1440.png'});
 report.checks.push({name:'streets',diagnostic:await page.evaluate(()=>window.basemapDiagnostics)});
 assert(report.tiles.some(x=>x.status===200),'No real map tiles received');
 await page.goto(base+'/observations');await page.getByRole('button',{name:'新建观测站',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'地图选点',exact:true}).click();
 await dialog.locator('#obs-latitude').fill('39.9087');await dialog.locator('#obs-longitude').fill('116.3975');
 await dialog.getByRole('button',{name:'定位观测站',exact:true}).click();
 const box=await dialog.locator('.observation-map-canvas').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
 for(let i=0;i<9;i++){await page.mouse.wheel(0,-650);await page.waitForTimeout(450);}
 await page.waitForFunction(()=>Object.values(window.basemapDiagnostics||{}).some(x=>x.levels?.imagery>=16),{},{timeout:45000});
 await page.waitForTimeout(12000);
 await dialog.locator('.basemap-control summary').click();await dialog.getByRole('checkbox',{name:'地名',exact:true}).uncheck();
 await dialog.locator('.basemap-control summary').click();await page.screenshot({path:'../docs/evidence/maps-beijing-detail-1440.png'});
 await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
 await page.waitForTimeout(200);const picked={lat:Number(await dialog.locator('#obs-latitude').inputValue()),lng:Number(await dialog.locator('#obs-longitude').inputValue())};report.picked=picked;
 assert(Math.abs(picked.lat-39.9087)<.003&&Math.abs(picked.lng-116.3975)<.003,'WGS84 pick drift');report.checks.push({name:'beijing-high-detail-and-wgs84-pick',picked,diagnostic:await page.evaluate(()=>window.basemapDiagnostics)});
 await page.route('**/api/maps/tiles/**',route=>route.abort());await dialog.locator('.basemap-control summary').click();await dialog.getByRole('button',{name:'街道',exact:true}).click();
 await dialog.getByText('在线地图不可用 · 本地地球',{exact:true}).waitFor({timeout:15000});await page.screenshot({path:'../docs/evidence/maps-offline-fallback-1440.png'});report.checks.push({name:'offline-fallback',passed:true});
 page.on('dialog',d=>d.accept());await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});await page.unroute('**/api/maps/tiles/**');
 await page.waitForTimeout(500);assert(await page.evaluate(()=>window.observationMapDiagnostics.active===1&&Object.keys(window.basemapDiagnostics).length===1),'Map viewer leaked after close');report.checks.push({name:'dialog-map-disposed',passed:true});
 assert(!report.errors.length,report.errors.join(';'));report.allPassed=true;console.log(JSON.stringify(report.checks));
}catch(e){report.failure=e.stack;throw e;}finally{await writeFile('../docs/evidence/maps-browser-2026-11-15.json',JSON.stringify(report,null,2));await browser.close();}
