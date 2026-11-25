import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const base = 'http://127.0.0.1:5174';
const output = resolve(process.argv[2] || '../.local/logs/mobile-layout');
const credentials = JSON.parse(await readFile(new URL('../.local/config/showcase-account.json', import.meta.url), 'utf8'));
const accounts = JSON.parse((await readFile(new URL('../.local/config/demo-accounts.json', import.meta.url), 'utf8')).replace(/^\uFEFF/, ''));
const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const report = {browser: browser.version(), pages: [], interactions: [], pageErrors: []};
await mkdir(output, {recursive: true});

function observe(page) {
  page.on('pageerror', error => {
    report.pageErrors.push({url: page.url(), stack: error.stack || error.message});
  });
}

async function login(page, creds) {
  const response = await page.request.post(base + '/api/auth/login', {
    data: {username: creds.username, password: creds.password},
    headers: {Origin: base},
  });
  assert(response.ok(), 'Login failed');
}

async function boxFits(page, locator, label) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  assert(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 &&
    box.y + box.height <= viewport.height + 1, label + ' exceeds the viewport');
  return box;
}

async function measure(page, route, selector) {
  await page.locator(selector).first().waitFor();
  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector('.dashboard-viewport');
    return {
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      dashboardWidth: canvas?.clientWidth,
      dashboardScrollWidth: canvas?.scrollWidth,
    };
  });
  assert(geometry.scrollWidth <= geometry.width + 1, route + ' has page-level horizontal overflow');
  if (geometry.dashboardWidth) {
    assert(geometry.dashboardScrollWidth <= geometry.dashboardWidth + 1, route + ' has horizontal overflow');
  }
  report.pages.push({route, viewport: page.viewportSize(), ...geometry});
}

async function screenshot(page, file) {
  await page.screenshot({path: resolve(output, file + '.png')});
}

async function checkMapViewport(page) {
  const map = await boxFits(page, page.getByRole('region', {name: '地球与轨道'}), 'Globe');
  await boxFits(page, page.getByRole('region', {name: '地图操作'}), 'Map controls');
  const scroll = await page.evaluate(() => {
    const shell = document.querySelector('.exploration-shell');
    const documentRoot = document.scrollingElement;
    return {document: documentRoot.scrollHeight - documentRoot.clientHeight, shell: shell.scrollHeight - shell.clientHeight, y: window.scrollY};
  });
  assert(scroll.document <= 1 && scroll.shell <= 1 && scroll.y === 0, 'Explore must stay within one phone viewport');
  return {mapHeight: map.height, scroll};
}

const routes = [
  ['explore', '.orbital-stage'], ['catalog', '.catalog-toolbar'], ['observations', '.observations'],
  ['sampling', '.sampling-page'], ['environment', '.environment-page'], ['workspace', '.plans-panel'],
  ['notifications', '.notifications-page'], ['dashboard', '.dashboard-earth'],
];

try {
  const phone = await browser.newPage({viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true,
    deviceScaleFactor: 1, reducedMotion: 'reduce'});
  observe(phone);
  await phone.goto(base + '/login');
  await measure(phone, 'login', '.access-card');
  await phone.getByLabel('用户名').fill(credentials.username);
  await phone.getByLabel('密码', {exact: true}).fill(credentials.password);
  await phone.getByRole('button', {name: '显示密码'}).tap();
  assert.equal(await phone.locator('#password').getAttribute('type'), 'text');
  await phone.getByRole('button', {name: '隐藏密码'}).tap();
  await phone.getByRole('button', {name: '进入星巡'}).tap();
  await phone.waitForURL('**/explore');
  const nav = phone.getByRole('navigation', {name: '主要导航'});
  const more = nav.getByRole('button', {name: '更多'});
  await more.waitFor();
  assert.equal(await nav.getByRole('link').count(), 3);
  await more.tap();
  assert.equal(await nav.getByRole('link').count(), 7);
  await phone.keyboard.press('Escape');
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  await more.tap();
  await phone.locator('.app-header .brand').tap();
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  report.interactions.push('登录、密码显隐、更多导航、Escape 和外部点按关闭');

  const globe = phone.getByRole('region', {name: '地球与轨道'});
  await globe.locator('canvas').first().waitFor();
  await phone.waitForFunction(() => !document.querySelector('button[aria-label="全球视角"]')?.disabled);
  await phone.locator('.mobile-selected-satellite').getByText(/ISS/).waitFor();
  const firstScreen = await checkMapViewport(phone);
  for (const name of ['找卫星', '所选卫星', '实时态势', '轨迹回放', '全球总览']) {
    const box = await boxFits(phone, phone.getByRole('button', {name, exact: true}), name);
    assert(box.height >= 44, name + ' needs a 44 px touch target');
  }
  await phone.locator('.mobile-live-time time').filter({hasText: /UTC\+8/}).waitFor();
  await phone.locator('.app-header').getByRole('link', {name: '设置', exact: true}).tap();
  await phone.waitForURL('**/settings');
  const timeZone = phone.getByRole('combobox', {name: '默认显示时区'});
  const mapType=phone.getByRole('combobox', {name:'底图类型'});
  await phone.getByRole('checkbox', {name:'显示地名'}).uncheck();
  await mapType.tap();
  await phone.getByRole('option', {name:'街道',exact:true}).tap();
  await timeZone.tap();
  await phone.getByRole('option', {name: '协调世界时（UTC）'}).tap();
  await screenshot(phone, 'settings-390');
  await nav.getByRole('link', {name: '卫星探索'}).tap();
  await phone.locator('.mobile-live-time time').filter({hasText: / UTC$/}).waitFor();
  await phone.waitForFunction(()=>Object.values(window.basemapDiagnostics||{}).some(value=>value.mode==='streets'&&!value.labels));

  await phone.locator('.app-header').getByRole('link', {name: '设置', exact: true}).tap();
  await mapType.tap();
  await phone.getByRole('option', {name:'影像',exact:true}).tap();
  await phone.getByRole('checkbox', {name:'显示地名'}).check();

  await timeZone.tap();
  await phone.getByRole('option', {name: '北京时间（UTC+8）'}).tap();
  await nav.getByRole('link', {name: '卫星探索'}).tap();
  await globe.locator('canvas').first().waitFor();
  report.interactions.push('首页时钟、独立设置页和时区持久化');
  report.firstScreen = firstScreen;
  await screenshot(phone, 'explore-390');
  await phone.getByRole('button', {name: '纯净视图'}).tap();
  assert.equal(await phone.getByRole('button', {name: '纯净视图'}).getAttribute('aria-pressed'), 'true');
  assert.equal(await phone.getByRole('button', {name: '找卫星'}).count(), 0);
  await phone.getByRole('button', {name: '纯净视图'}).tap();
  await phone.getByRole('button', {name: '轨迹回放', exact: true}).tap();
  const timeline = phone.getByRole('slider', {name: '采样时间轴'});
  await phone.waitForFunction(() => document.querySelector('input[aria-label="采样时间轴"]')?.disabled === false);
  const initialTime = await timeline.inputValue();
  await timeline.tap({position: {x: 16, y: 16}});
  await phone.waitForFunction(time => document.querySelector('input[aria-label="采样时间轴"]').value !== time, initialTime);
  await phone.getByRole('combobox', {name: '轨道播放倍率'}).selectOption('60');
  await checkMapViewport(phone);
  await screenshot(phone, 'replay-390');
  await phone.getByRole('button', {name: '定位回放时间'}).tap();
  const settings = phone.getByRole('dialog', {name: '时间与数据'});
  const toolColumns = await settings.locator('.mobile-time-pane').evaluate(el => ({
    summary: el.querySelector('.timebar-description').getBoundingClientRect().left,
    actions: el.querySelector('.timebar-tools > details').getBoundingClientRect().left,
  }));
  assert(Math.abs(toolColumns.summary - toolColumns.actions) < 1);
  await screenshot(phone, 'time-settings-390');
  await settings.getByText('精确时间', {exact: true}).tap();
  assert.equal(await settings.locator('#exact-time').isVisible(), true);
  assert.equal(await phone.getByText('数据状态', {exact: true}).count(), 0);
  assert.equal(await globe.getByText('图像来源', {exact: true}).count(), 0);
  await settings.getByRole('button', {name: '关闭面板'}).tap();
  await settings.waitFor({state: 'hidden'});
  await phone.getByRole('button', {name: '实时态势', exact: true}).tap();
  assert.equal(await globe.locator('.basemap-control').count(), 0);
  const spaceMenu=globe.locator('.space-control');
  await spaceMenu.locator('summary').tap();
  await spaceMenu.getByRole('button', {name:'太阳系示意'}).waitFor();
  assert.equal(await spaceMenu.getByRole('button').count(), 4);
  assert.equal(await spaceMenu.getByText('场景说明', {exact:true}).count(), 0);
  await spaceMenu.locator('summary').tap();
  await phone.getByRole('button', {name: '找卫星'}).tap();
  const finder = phone.getByRole('dialog', {name: '找卫星'});
  await finder.getByRole('combobox', {name: '目录分组'}).tap();
  const dialogOptions = finder.getByRole('listbox', {name: '目录分组'});
  await dialogOptions.waitFor();
  await dialogOptions.getByRole('option', {name: '全部公开活跃目录'}).tap();
  const search = finder.getByRole('textbox', {name: '搜索卫星'});
  await search.fill('39084');
  const result = finder.getByRole('button', {name: '选择 LANDSAT 8', exact: true});
  await result.waitFor();
  await boxFits(phone, finder, 'Search sheet');
  await screenshot(phone, 'search-390');
  await result.tap();
  const details = phone.getByRole('complementary', {name: '卫星详情'});
  const detailSheet = phone.getByRole('dialog', {name: '卫星详情'});
  await details.getByRole('heading', {name: 'LANDSAT 8'}).waitFor();
  assert.equal(await detailSheet.getByRole('heading', {name: '卫星详情', exact: true}).evaluate(el => document.activeElement === el), true);
  assert.equal(await details.locator('.satellite-preview canvas').count(), 0);
  await boxFits(phone, details.getByRole('button', {name: '定位', exact: true}), 'Locate');
  await screenshot(phone, 'detail-390');
  await detailSheet.getByRole('button', {name: '返回找卫星'}).tap();
  assert.equal(await search.inputValue(), '39084');
  assert.equal(await result.evaluate(el => document.activeElement === el), true);
  await result.tap();
  await details.getByRole('button', {name: '定位', exact: true}).tap();
  await detailSheet.waitFor({state: 'hidden'});
  assert.equal(await globe.evaluate(el => document.activeElement === el), true);
  const activeCanvas = await globe.locator('canvas').first().elementHandle();
  await phone.waitForFunction(() => !!window.starSceneDiagnostics?.selectedScreenPoint?.());
  const point = await phone.evaluate(() => {
    const rect = document.querySelector('.orbit-globe canvas').getBoundingClientRect();
    const coords = window.starSceneDiagnostics.selectedScreenPoint();
    return {x: rect.left + coords.x, y: rect.top + coords.y};
  });
  await phone.touchscreen.tap(point.x, point.y);
  await detailSheet.waitFor();
  await details.getByRole('heading', {name: 'LANDSAT 8'}).waitFor();
  assert.equal(await detailSheet.getByRole('button', {name: '返回找卫星'}).count(), 0);
  await detailSheet.getByRole('button', {name: '关闭面板'}).tap();
  assert.equal(await activeCanvas.evaluate(el => el === document.querySelector('.orbit-globe canvas')), true);
  await checkMapViewport(phone);
  await phone.getByRole('button', {name: '所选卫星'}).tap();
  await details.getByRole('button', {name: '持续跟踪'}).tap();
  await globe.getByRole('button', {name: '退出跟踪'}).tap();
  await phone.getByRole('button', {name: '找卫星'}).tap();
  await finder.waitFor();
  await phone.keyboard.press('Escape');
  await finder.waitFor({state: 'hidden'});
  assert.equal(await phone.getByRole('button', {name: '找卫星'}).evaluate(el => document.activeElement === el), true);
  await phone.getByRole('button', {name: '所选卫星'}).tap();
  await details.getByRole('link', {name: '预测过境'}).tap();
  await phone.waitForURL('**/observations?sat=39084*');
  report.interactions.push('一屏地图、原位定位与跟踪、搜索与详情往返、关闭恢复焦点、纯净视图、回放与设置');

  const observationMap = phone.locator('.mobile-observation-map .observation-map');
  await observationMap.waitFor();
  await boxFits(phone, observationMap, 'Observation map on first screen');
  await boxFits(phone, phone.getByRole('button', {name: '一键观测'}), 'Quick observation');
  assert.equal(await phone.locator('#observation-form').isVisible(), false);
  await observationMap.locator('canvas').waitFor();
  await screenshot(phone, 'observations-390');
  const observationViews = phone.getByRole('group', {name: '观测工作区'});
  await observationViews.getByRole('button', {name: '条件'}).tap();
  const newStation = phone.getByRole('button', {name: '新建观测站', exact: true});
  await newStation.tap();
  const station = phone.getByRole('dialog');
  await station.waitFor();
  report.stationDialog = await boxFits(phone, station, 'Station dialog');
  await phone.getByRole('button', {name: '关闭观测站编辑'}).tap();
  await station.waitFor({state: 'hidden'});
  await phone.getByText('历史计算', {exact: true}).tap();
  await phone.locator('.prediction-history button').first().tap();
  await phone.locator('.observation-content').waitFor();
  assert.equal(await observationViews.getByRole('button', {name: '结果'}).getAttribute('aria-pressed'), 'true');
  await observationViews.getByRole('button', {name: '条件'}).tap();
  assert.equal(await phone.locator('.observation-conditions').isVisible(), true);

  await phone.goto(base + '/catalog');
  await phone.locator('.catalog-mobile-list li').first().waitFor();
  const catalogGroup = phone.getByRole('combobox', {name: '卫星分组'});
  await catalogGroup.tap();
  await phone.getByRole('listbox', {name: '卫星分组'}).waitFor();
  await screenshot(phone, 'catalog-390');
  await phone.getByRole('option', {name: '全部已导入记录'}).tap();
  const directorySearch = phone.getByRole('textbox', {name: '搜索卫星'});
  await directorySearch.fill('25544');
  await phone.getByRole('button', {name: /^ISS/}).first().tap();
  const archive = phone.getByRole('dialog', {name: '卫星档案'});
  await archive.waitFor();
  await boxFits(phone, archive, 'Catalog archive');
  await archive.getByRole('heading', {name: /ISS/}).waitFor();
  await archive.getByRole('button', {name: '关闭档案'}).tap();
  await archive.waitFor({state: 'hidden'});
  const isPrediction = req => new URL(req.url()).pathname === '/api/predictions' && req.method() === 'POST';
  let submissions = 0;
  phone.on('request', req => {if (isPrediction(req)) submissions++;});
  const requestedAt = Date.now();
  const predicted = phone.waitForResponse(response => isPrediction(response.request()));
  await phone.getByRole('list', {name: '卫星列表'}).getByRole('link', {name: '观测', exact: true}).tap();
  const prediction = await predicted;
  assert(prediction.ok(), 'Quick observation must be accepted by the backend');
  const payload = prediction.request().postDataJSON();
  const stationsResponse = await phone.request.get(base + '/api/stations', {
    headers: {Authorization: prediction.request().headers().authorization},
  });
  assert(stationsResponse.ok());
  const {list: stations} = await stationsResponse.json();
  const preferred = stations.find(value => value.is_default) || stations[0];
  assert.equal(payload.stationId, preferred.id);
  assert.equal(payload.noradId, 25544);
  assert.equal(payload.days, 1);
  assert.equal(payload.minElevation, 10);
  assert(Math.abs(Date.parse(payload.start) - requestedAt) < 30000, 'Predict from the current time');
  await phone.waitForURL(url => url.searchParams.has('task'));
  await phone.locator('.task-status.completed').waitFor({timeout: 45000});
  await phone.reload();
  await phone.locator('.task-status.completed').waitFor();
  assert.equal(submissions, 1);
  assert.equal(await phone.locator('.observation-event-list').isVisible(), true);
  const row = phone.locator('.observation-event-list > li').first();
  await row.locator(':scope > button').tap();
  const selectedPass = row.getByRole('region', {name: '选中过境'});
  await selectedPass.getByText('仰角曲线与目视窗口').tap();
  await selectedPass.locator('.elevation-chart svg').waitFor();
  await selectedPass.getByText('仰角曲线与目视窗口').tap();
  await screenshot(phone, 'observation-results-390');
  const chosenEvent = new URL(phone.url()).searchParams.get('event');
  await selectedPass.getByRole('button', {name: '回放过境', exact: true}).tap();
  await phone.getByRole('region', {name: '过境回放'}).waitFor();
  assert.equal(await observationViews.getByRole('button', {name: '地图'}).getAttribute('aria-pressed'), 'true');
  await observationViews.getByRole('button', {name: '结果'}).tap();
  assert.equal(new URL(phone.url()).searchParams.get('event'), chosenEvent);
  report.quickObservation = {status: prediction.status(), noradId: payload.noradId, days: payload.days,
    minimumElevation: payload.minElevation, preferredStation: true, completedBeforeReload: true, submissions};
  report.interactions.push('目录一键观测实际提交并完成，使用默认站与预设条件，刷新不重复提交');

  await phone.goto(base + '/sampling');
  const library = phone.getByRole('region', {name: /我的方案/});
  const editor = phone.getByRole('dialog', {name: '新建方案'});
  const create = library.getByRole('button', {name: '新建方案', exact: true});
  await create.waitFor();
  assert.equal(await editor.count(), 0);
  assert.equal(await phone.getByRole('link', {name: '实时探索', exact: true}).count(), 0);
  await create.tap();
  await editor.getByRole('button', {name: '选择卫星', exact: true}).tap();
  const picker = phone.getByRole('dialog', {name: '选择卫星'});
  await picker.waitFor();
  report.samplingPicker = await boxFits(phone, picker, 'Sampling picker');
  await picker.getByRole('searchbox', {name: '搜索全部卫星'}).fill('25544');
  const iss = picker.getByRole('button', {name: /25544/}).first();
  await iss.waitFor();
  if (await iss.getAttribute('aria-pressed') === 'true') await iss.tap();
  await iss.tap();
  assert.equal(await iss.getAttribute('aria-pressed'), 'true');
  await picker.getByRole('button', {name: '应用选择'}).tap();
  await picker.waitFor({state: 'hidden'});
  await editor.getByRole('button', {name: /^移除卫星 25544/}).waitFor();
  await editor.getByRole('button', {name: '关闭方案窗口'}).tap();
  await editor.waitFor({state: 'hidden'});
  report.interactions.push('观测站编辑弹窗、目录档案面板、采样新建弹窗和选星草稿');

  await phone.goto(base + '/environment');
  const weatherViews = phone.getByRole('group', {name: '空间环境视图'});
  await weatherViews.waitFor();
  await phone.waitForFunction(() => {
    const svg = document.querySelector('.weather-chart svg');
    return svg && Math.abs(svg.viewBox.baseVal.width - svg.getBoundingClientRect().width) <= 1;
  });
  assert.equal(await phone.locator('.weather-events').isVisible(), false);
  await screenshot(phone, 'environment-390');
  await phone.getByRole('button', {name: '查看官方预警／警报'}).tap();
  assert.equal(await weatherViews.getByRole('button', {name: '通报'}).getAttribute('aria-pressed'), 'true');
  assert.equal(await phone.locator('.weather-events').isVisible(), true);
  assert.equal(await phone.locator('.weather-trends').isVisible(), false);
  await weatherViews.getByRole('button', {name: '来源'}).tap();
  assert.equal(await phone.locator('.weather-sources').isVisible(), true);
  await phone.getByRole('button', {name: '采集记录'}).first().tap();
  await phone.locator('.weather-source-runs').first().waitFor();
  await weatherViews.getByRole('button', {name: '趋势'}).tap();
  assert.equal(await phone.locator('.weather-sources').isVisible(), false);
  report.interactions.push('空间环境各视图、通报快捷入口、响应式图表及采集记录');

  await phone.goto(base + '/dashboard');
  await phone.waitForFunction(() => window.dashboardDiagnostics?.statsTotal > 0);
  await phone.waitForFunction(() => /km/.test(document.querySelector('.dashboard-telemetry strong')?.textContent || ''));
  await phone.evaluate(() => document.querySelector('.dashboard-viewport').scrollTo(0, 0));
  await screenshot(phone, 'dashboard-390');
  const dashboard = phone.locator('.dashboard-viewport');
  assert(await dashboard.evaluate(el => el.scrollHeight > el.clientHeight));
  assert.equal(await phone.locator('.dashboard-canvas').evaluate(el => getComputedStyle(el).transform), 'none');
  await phone.getByRole('button', {name: '统计口径'}).tap();
  await phone.getByRole('heading', {name: '统计口径'}).waitFor();
  await phone.getByRole('button', {name: '关闭', exact: true}).tap();
  await phone.getByRole('link', {name: '返回探索'}).tap();
  await phone.waitForURL('**/explore');
  report.interactions.push('移动端态势大屏滚动、读取统计口径、返回探索');

  for (const [width, height] of [[320, 568], [390, 844], [430, 932], [844, 390]]) {
    await phone.setViewportSize({width, height});
    for (const [route, selector] of routes) {
      await phone.goto(base + '/' + route);
      await measure(phone, route, selector);
      if (route === 'explore') {
        report.pages.at(-1).mapViewport = await checkMapViewport(phone);
        await phone.getByRole('button', {name: '找卫星'}).tap();
        await boxFits(phone, phone.getByRole('dialog', {name: '找卫星'}), 'Responsive search sheet');
        await phone.getByRole('button', {name: '关闭面板'}).tap();
      }
    }
  }
  await phone.setViewportSize({width: 390, height: 844});
  const emptyStations = route => route.fulfill({json: {list: [], total: 0}});
  await phone.route('**/api/stations', emptyStations);
  await phone.goto(base + '/observations?sat=25544');
  await phone.getByRole('button', {name: '一键观测'}).tap();
  await phone.locator('.observation-conditions').getByRole('alert').getByText('请选择或新建观测站。').first().waitFor();
  await phone.getByRole('button', {name: '新建观测站', exact: true}).waitFor();
  assert.equal(submissions, 1);
  report.quickObservation.missingStationHandled = true;
  await phone.unroute('**/api/stations', emptyStations);
  const admin = await browser.newPage({viewport: {width: 320, height: 568}, hasTouch: true, isMobile: true});
  observe(admin);
  await login(admin, typeof accounts.admin === 'string' ? {username: 'admin', password: accounts.admin} : accounts.admin);
  await admin.goto(base + '/catalog');
  await admin.getByRole('button', {name: '更多'}).tap();
  await admin.getByRole('link', {name: '系统管理'}).tap();
  await measure(admin, 'admin', '.admin-source-grid');
  await admin.getByRole('button', {name: '用户管理'}).tap();
  await measure(admin, 'admin users', '.admin-user-tools');

  const desktop = await browser.newPage({viewport: {width: 1920, height: 1080}, reducedMotion: 'reduce'});
  observe(desktop);
  await login(desktop, credentials);
  await desktop.goto(base + '/explore');
  const desktopNav = desktop.getByRole('navigation', {name: '主要导航'});
  await desktopNav.getByRole('link', {name: '我的空间'}).waitFor();
  assert.equal(await desktopNav.getByRole('link').count(), 7);
  assert.equal(await desktopNav.getByRole('button', {name: '更多'}).count(), 0);
  const layout = await desktop.locator('.explorer').evaluate(el => {
    const coords = selector => {
      const box = el.querySelector(selector).getBoundingClientRect();
      return {x: box.x, y: box.y, width: box.width};
    };
    return ['.orbit-directory', '.orbital-stage', '.orbit-detail', '.orbit-timebar'].map(coords);
  });
  assert(layout[0].x < layout[1].x && layout[1].x < layout[2].x);
  assert.equal(layout[0].y, layout[2].y);
  assert(layout[3].y > layout[2].y);
  await desktopNav.getByRole('link', {name: '态势大屏'}).click();
  const presentation = await boxFits(desktop, desktop.locator('.dashboard-canvas'), 'Desktop dashboard');
  assert.equal(presentation.width, 1920);
  assert.equal(presentation.height, 1080);
  report.desktop = {exploration: layout, presentation};
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
  console.log(JSON.stringify({passed: report.passed, pages: report.pages.length, flows: report.interactions.length}));
} catch (error) {
  report.failure = String(error.stack || error);
  throw error;
} finally {
  await writeFile(resolve(output, 'mobile-layout.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
