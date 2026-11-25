# TianShu-AI

星巡 · 全球卫星态势与观测平台

## 分支开发

`main` 保存稳定版本，`develop` 汇集已验证的开发改动。每项功能或修复从最新的 `develop` 创建独立分支，验收后通过 Pull Request 合入 `develop`，发布时再将 `develop` 合入 `main`。

```powershell
git switch develop
git pull --ff-only
git switch -c feat/short-name
# 完成修改、验证并提交后
git push -u origin feat/short-name
```

本机环境与运行数据由启动脚本准备。交付 ZIP 及历史电影视角的 4K 原片保留在本机，历史原片的来源和校验信息见 [素材说明](frontend/public/space/cinema/README.md)。

## 本机演示账号

项目启动后，在登录页使用 `xingxu_demo`。密码见本机 `.local/config/showcase-account.json`。如果当前登录了个人账号，先在右上角退出，再登录演示账号。

1. 打开“我的空间”，展示收藏卫星、北京／上海／深圳三个演示站点，以及预先保存的过境计划。
2. 点任一计划的“回放”，再点“回放过境”，展示卫星、地面轨迹和仰角曲线。
3. 打开“观测规划 → 历史计算”，选“演示 · ISS 与天宫”，点“整组回放”。

首次准备，或答辩当天需要生成新的未来过境计划时，在项目根目录运行：

```powershell
backend/.venv/Scripts/python.exe -m backend.app.demo_seed
```

脚本使用本地目录的公开轨道根数计算过境。重跑不会重复创建当天的预测和计划，跨日运行生成新一批记录。历史计划保留回放能力。外网断开时，运行中的本机服务仍可回放这些记录，近地高清图依赖外部图源。当天实测详情见[演示数据检查](docs/evidence/showcase-data-2026-11-19.json)。

当前已完成阶段 0～10：卫星探索与实时链路、观测站、单星／分组预测与回放、版本化计划、真实时钟站内提醒、空间环境，以及真实统计态势大屏和管理中心。实际天气来源为 NOAA／GFZ；NASA DONKI 在本机仍不可达，页面明确显示未知。

- [阶段验收清单](docs/阶段验收清单.md)
- [需求文档](docs/星枢-产品需求文档.md)
- [阶段 1 验收报告与限制](docs/阶段1-可行性验证与验收报告.md)
- [阶段 2 验收报告](docs/阶段2-验收报告.md)
- [阶段 3 实现与验收](docs/阶段3-探索首页实现与验收.md)
- [阶段 4 实时与全球目录验收](docs/阶段4-实时数据与全球目录验收.md)
- [阶段 5 观测站与单星预测验收](docs/阶段5-观测站与单星预测验收.md)
- [阶段 6 分组预测、回放与计划验收](docs/阶段6-分组预测回放与计划验收.md)
- [阶段 7 站内提醒与空间环境验收](docs/阶段7-站内提醒与空间环境验收.md)
- [阶段 8 统计大屏与管理中心验收](docs/阶段8-统计大屏与管理中心验收.md)
- [阶段 9 综合验收与性能报告](docs/阶段9-综合验收报告.md)
- [阶段 10 部署与答辩交付](docs/阶段10-部署与答辩交付.md)
- [参考网站与视觉决策](docs/阶段3-参考网站与实现决策.md)
- [阶段 2 部署与启动说明](docs/阶段2-部署与启动说明.md)
- [接口与数据库说明](docs/阶段2-接口与数据库说明.md)

## 自定义轨迹采样

登录后打开 [采样管理](http://127.0.0.1:5174/sampling)。演示账号可直接加载“演示 · ISS 与天宫两小时”。新建方案可设置固定北京时间或相对当前时间的区间、采样间隔及卫星列表。试算后可保存、导出 JSON，或在探索页拖动时间轴回放。使用当前目录中的轨道根数重新推算，历史计算结果可通过导出的 JSON 保留。

## 当前正式基础工程

本机环境已准备后，在根目录执行：

```powershell
./scripts/start.ps1
```

打开 [星巡登录页](http://127.0.0.1:5174/)。随机生成的 admin/student 口令位于本机 `.local/config/demo-accounts.json`，不在源码或文档中公开。停止用 `./scripts/stop.ps1`，数据保留。

首次运行先执行 `./scripts/prepare.ps1`。启动、备份和演示见[部署与答辩交付](docs/阶段10-部署与答辩交付.md)。已实际验证 Windows 原生新配置和 Compose CLI 配置。容器启动需在有 Docker Engine 的环境中验证。

以下保留阶段 1 独立技术验证页的运行方法，不代表正式界面的视觉完成。

## 首次准备（PowerShell，项目根目录）

已有 Node 24、Python 3.12 时：

```powershell
py -3.12 -m venv backend/.venv
backend/.venv/Scripts/python.exe -m pip install --cache-dir .local/cache/pip -r backend/requirements-phase1.lock.txt
npm.cmd ci --prefix prototypes/phase1 --cache D:/AIcode/BeiDouApp/.local/cache/npm
npm.cmd --prefix prototypes/phase1 run prepare-assets
backend/.venv/Scripts/python.exe scripts/prepare_phase1_samples.py --ephemeris-only
```

依赖与数据优先保存在 D 盘项目。首次安装需网络，完成后核心计算和基础地球不需要外部服务。完整目录缓存可选；缺少缓存时验证页仍展示仓库保留的 ISS、北斗 MEO、GOES GEO 三颗代表对象。

## 启动验证页

在项目根目录的一个终端启动后端：

```powershell
backend/.venv/Scripts/python.exe -m uvicorn backend.phase1.server:app --host 127.0.0.1 --port 8000
```

另一个终端启动前端：

```powershell
npm.cmd --prefix prototypes/phase1 run dev
```

打开 [本地验证页](http://127.0.0.1:5173/)。页面明确显示固定样本“时间推演”，不是实时遥测。仅监听本机，请勿把无鉴权的验证服务当作正式业务服务对外部署。

## 验证命令

```powershell
backend/.venv/Scripts/python.exe -m unittest discover -s tests -v
backend/.venv/Scripts/python.exe scripts/validate_phase1_calculations.py
npm.cmd --prefix prototypes/phase1 run build
```

前后端启动后，在 `prototypes/phase1` 目录执行 `node verify-browser.mjs` 可运行隔离的 Edge 无头验证。脚本使用 D 盘测试配置、软件 WebGL、阻断外部 HTTP；不修改用户浏览器资料，也不代表硬件显卡帧率。若 Edge 路径不同，需修改脚本中的 `executablePath`。

来源校验脚本与实际结果、版本、许可和已知限制见阶段报告。NASA/JPL DE421 通过 `skyfield-data` 包准备；使用 Skyfield 内置时间尺度，不使用包中已过期的 IERS 数据。

## 观测规划

运行后打开 http://127.0.0.1:5174/observations ，或在卫星详情中点击“预测过境”。创建观测站，选择目标与 24 小时／3 天／7 天范围后计算；历史计算可通过任务 URL 回查。需要独立 worker 运行，默认启动脚本已包含。潜在目视窗口不保证肉眼可见，具体计算边界见阶段 5 验收报告。

分组预测支持编号升序的 25／100／500 颗批次。完成后点击“整组回放”，整批卫星共用完整查询时间轴；选择卫星或点击点位联动详情、轨迹、地面投影与当前窗口曲线，切星保留时刻。可切换只看达到站点仰角要求的对象，无过境卫星仍可查看。“单星回放”聚焦一段事件，单星查询的入口仍为“回放过境”。结果可保存到“我的空间”。计划重算先展示差异，确认后才更新版本。回放不改变真实系统时间或提醒时间。

保存计划时选择提前 5／10／30 分钟，后台按真实时钟产生站内通知；右上角铃铛进入通知中心，可查看未读、全部已读和关联计划。取消及重算撤销旧版本提醒；服务关闭期间不保证送达，重启会标记错过并恢复未来提醒。站内通知持久化不代表用户已经阅读，不提供桌面／邮件／短信推送。

`/environment` 提供实际 Kp 观测与预测、趋势、官方通报筛选分页、详情及原始链接、来源时效和采集记录。来源失败保留上次有效数据，过期或缺失明确提示；全球空间天气不用于判断本地设备已故障。

`/dashboard` 为独立 1920×1080 等比大屏，显示活跃目录真实统计、覆盖率／未知项、三维地球、最新根数及观测站已保存预测榜单，可全屏、退出和暂停。发射趋势统计卫星颗数，分组之间不重复累计；用途缺失不按名称猜测。

管理员 `/admin` 提供来源状态、持久任务与采集日志、筛选分页／详情、手动刷新去重和限流、用户启停与审计。故障演示全局可见且保留本地计算；关闭后执行真实来源检查，失败结果不改成正常。硬件帧率与综合稳定性见[阶段 9 实测报告](docs/阶段9-综合验收报告.md)。

探索和观测地图已接入分级底图：缩近加载全球在线影像，“底图”入口可切换街道与地名；远景保留原有太空外观。在线来源不可用时回退本地地球，不提供离线街道细节。无需填写百度 Key；天地图为自有 Key 的可选适配器，当前尚未在线验收。配置、来源、使用边界与复查命令见[分级底图说明](docs/分级底图与近地浏览.md)。

2026-11-18 已优化公开图块为官方直连和浏览器缓存，失败时使用后端长连接回退。探索页“太空”入口提供银河星空、地月全景、月球近景、太阳系示意和返回地球；行星可点击近看。太阳系距离／尺寸已调整，银河为历史摄影，不影响轨道或观测预测。来源、实测与边界见[地图加速与太空场景验收](docs/地图加速与太空场景验收.md)。

2026-11-19 星空背景已更新为 NASA 8K 源星图导出的六面 2048px 贴图；“太空 → 电影视角 · 4K”播放 NASA 原版星系穿行动画，可暂停、跳转和全屏。电影与实时探索分开，退出恢复原画面。素材均在项目本地，使用来源和运行检查见[高清星空与电影视角试用](docs/高清星空与电影视角试用验收.md)。
