# 项目审查与分支交付

日期：2026-11-27。分支：`codex/v0.3.0-project-review`。

## 审查范围与结果

检查版本分支、工作区改动、阶段清单、产品需求与下一版本规划，重点追踪前端请求配置、登录恢复、游客认证、地图与实时连接。此次为当前改动及认证链路审查，不代表全部业务或云端重新验收。

- 修复高优先级回归：新增配置将后端地址固定为云端 IP，本地页面的 API、地图和 WebSocket 都会访问该服务器。统一为同源 `/api`，WebSocket 根据当前页面自动选择 ws/wss 和主机。本机继续由 Vite 代理，生产环境由 Nginx 代理。
- 修复高优先级回归：未提交的恢复逻辑先调用 `/auth/me`，再设置内存 Token，请求缺少 Authorization；同时 `credentials: omit` 阻断原有 Cookie 恢复。恢复原有 HttpOnly Cookie 会话恢复及内存 Token 机制，不引入 localStorage Token 持久化。
- 保留已有登录页文案、样式、云端部署记录、两份研发规划及站点配置。云端记录是已有工作区证据，此次未重新部署或复测云端。
- 从 `origin/version/v0.3.0` 创建新分支，接入既有游客功能提交，再恢复未提交改动；未合并到版本分支或 main。

## 验证

1. `npm.cmd --prefix frontend run build`：TypeScript 与 Vite 生产构建通过；存在大于 500 kB 的分块提示，未在本次扩大优化范围。
2. `backend/.venv/Scripts/python.exe scripts/verify_phase2_backend.py --stage 2 --date 2026-11-27`：隔离 PostgreSQL 数据库及 Redis DB 15，24 项通过，覆盖注册、登录、Cookie 恢复、退出撤销、游客期限/隔离与权限等。首次尝试因服务未就绪连接超时；项目内服务恢复启动后重跑通过。未清空应用数据库。见 [JUnit](./phase2-backend-2026-11-27.xml) 与 [隔离环境](./phase2-test-environment-2026-11-27.json)。测试依赖存在 Starlette/httpx 弃用提示。
3. Edge headless + Playwright，临时 Vite 端口 5176，拦截 API 响应的前端专项检查：API 为 `/api`、WebSocket 为当前站点的 `/api/realtime/ws`；实际请求同时携带 HttpOnly 测试 Cookie 与 Bearer 测试 Token；未持久化 Token，所有 API 请求均留在本机。此检查使用模拟响应，与上述真实数据库后端回归分开。
4. 扫描 88 个构建 JavaScript/HTML 文件中的本机已知配置密钥：泄漏 0；测试凭据仅为固定占位值。
5. `git diff --check`：通过。

## 进度边界

关联既有 S02-08 认证壳与 S04-02 实时链路的局部修复；阶段 0～10 的 85/85、11/11 总览保持不变。本次不启动规划中的遥测研发阶段，也不把规划文档当作运行功能完成。Docker 容器实测、外部采集来源及云端首屏性能仍沿用各自验收记录中的限制。
