# 09 · 上线准备

> 关联文档：[03 技术架构](./03-architecture.md) · [07 开发计划](./07-roadmap.md) · [deploy/](../deploy/)

本文记录 Sprint 5 完成的上线准备工作：staging 环境、监控与告警、限流防刷、对账演练与压测结果，以及公开上线前仍需完成的事项。

## 1. 运行模式

| 模式 | 设置 | 数据库 | 密钥 | 短信 / 支付 / 模型 | 用途 |
|---|---|---|---|---|---|
| development | 默认 | 内嵌 PGlite（可设 `DATABASE_URL`） | 开发默认值（启动告警） | Mock | 本地开发 |
| test | `NODE_ENV=test` | 内存 PGlite 或 `TEST_DATABASE_URL` | 开发默认值 | Mock | 自动化测试 |
| staging | `APP_ENV=staging` | 必须是 PostgreSQL | 必填，缺少拒绝启动 | 允许 Mock（启动告警） | 联调、压测、内部验收 |
| production | `NODE_ENV=production` | 必须是 PostgreSQL | 必填 | 必须接入真实服务，否则拒绝启动 | 线上 |

`COOKIE_SECURE` 控制刷新令牌 Cookie 是否只在 HTTPS 下发送（生产默认开启，本地 staging 走 http 时关闭）。

## 2. staging 环境

`deploy/docker-compose.yml` 启动 PostgreSQL 16、后端镜像与用户端镜像（nginx），使用方法见 [deploy/README.md](../deploy/README.md)。

- **后端镜像**（`apps/server/Dockerfile`）：多阶段构建，运行层只安装生产依赖；以 `node` 用户运行；内置健康检查 `/v1/healthz`；文件存储目录 `/data/files` 挂载持久卷；启动时自动执行数据库迁移。压缩后约 74 MB。
- **用户端镜像**（`apps/web/Dockerfile`）：构建接入后端的版本，nginx 提供静态文件（带哈希的资源长期缓存，`index.html` 不缓存），`/v1` 反向代理到后端；对服务端推送关闭缓冲、连接最长保持 1 小时；上传体积上限 21 MB；把 nginx 的 `$request_id` 作为 `X-Request-Id` 传给后端，便于串联日志。压缩后约 21 MB。
- **CI**：新增镜像构建任务，构建两个镜像后以 staging 配置启动编排并检查健康状态。

已在 staging 编排上跑通四组主要的浏览器端到端用例（登录、生成与失败返还、写作、音频、购买、参考图与首尾帧、上传、画布持久化与冲突、文件夹与下载、发布与复核、图像编辑），验证了经过 nginx 的上传、下载与服务端推送。

## 3. 监控指标

`GET /v1/metrics` 输出 Prometheus 文本格式。设置 `METRICS_TOKEN` 后需要 `Authorization: Bearer <token>`；staging / 生产未设置令牌时该接口返回 404。

| 指标 | 类型 | 说明 |
|---|---|---|
| `creature_http_requests_total{method,route,status}` | counter | 请求数，`route` 为路由模板（如 `/v1/generations/:id`），未匹配的路由统一为 `unmatched` |
| `creature_http_request_duration_seconds{method,route}` | histogram | 请求耗时 |
| `creature_tasks_finished_total{modality,status}` | counter | 结束的生成任务（succeeded / failed / blocked） |
| `creature_task_duration_seconds{modality}` | histogram | 任务从提交到结束的耗时（含排队） |
| `creature_tasks_in_flight{status}` | gauge | 排队中、生成中、后处理中的任务数 |
| `creature_model_calls_total{model,result}` | counter | 模型调用次数（含切换备选） |
| `creature_model_window_success_ratio{model}` / `creature_model_breaker_open{model}` | gauge | 网关 5 分钟窗口成功率、是否熔断 |
| `creature_reconcile_mismatches` / `creature_reconcile_last_success_timestamp_seconds` | gauge | 最近一次对账的不一致账户数与完成时间 |
| `process_resident_memory_bytes`、`nodejs_heap_used_bytes`、`process_uptime_seconds` | gauge | 进程资源 |

建议的告警规则（对应 [03 技术架构](./03-architecture.md) 第 8 节）：

```promql
# 任意模型熔断
max by (model) (creature_model_breaker_open) == 1
# 生成成功率 15 分钟内低于 90%
sum(rate(creature_tasks_finished_total{status="succeeded"}[15m])) / sum(rate(creature_tasks_finished_total[15m])) < 0.9
# 排队积压
creature_tasks_in_flight{status="queued"} > 500
# 接口 5xx 比例
sum(rate(creature_http_requests_total{status=~"5.."}[5m])) / sum(rate(creature_http_requests_total[5m])) > 0.01
# 提交接口 p95 超过 1 秒
histogram_quantile(0.95, sum by (le) (rate(creature_http_request_duration_seconds_bucket{route="/v1/generations",method="POST"}[5m]))) > 1
# 对账发现差异，或超过 26 小时没有完成对账
creature_reconcile_mismatches > 0
time() - creature_reconcile_last_success_timestamp_seconds > 26 * 3600
```

此外，每个请求输出一行访问日志（方法、路径、状态码、耗时、请求 ID、用户 ID，健康检查与指标接口除外），可由 `ACCESS_LOG=false` 关闭。

## 4. 安全与防刷

- **响应头**：接口统一返回 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer` 与 `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`；文件接口保留沙箱策略；启用 `COOKIE_SECURE` 时附加 HSTS。
- **生成提交限流**：每个用户每分钟最多 `GENERATION_RATE_PER_MIN`（默认 30）次、同时进行中的任务不超过 `MAX_INFLIGHT_TASKS`（默认 20），超出返回 `429 RATE_LIMITED` 与 `Retry-After`；幂等重放不计入。每分钟次数在进程内计数，多实例时每个实例单独计算（总量上限约为实例数倍），需要全局一致时换成 Redis。
- **账号状态**：被冻结或封禁的账号所有请求返回 `403 ACCOUNT_SUSPENDED`（见 Sprint 4）。
- **已有措施**：验证码按手机号限频与限次、刷新令牌轮换与重用检测、上传签名与格式校验、文件签名地址、输入与输出审核、后台操作审计。

## 5. 对账演练

- **定时对账**：后台维护任务每 `RECONCILE_INTERVAL_HOURS`（默认 24）小时执行一次全量对账，启动时若超过间隔会立即执行。用一条集合查询核对所有账户的"可用余额 = 流水可用增量 = 批次剩余"与"冻结余额 = 流水冻结增量 = 冻结明细"，并检查已结束的任务是否仍有冻结积分；结果写入 `reconcile_runs`，发现差异输出错误日志并在指标中体现。
- **后台**：管理后台"概览与审核"页底部展示最近的对账结果与差异明细，可手动触发（写审计日志）。
- **演练结果**：集成测试中人为篡改账户余额、插入已结束任务的冻结明细，两类异常都能被发现并定位到账户与任务；staging 上两轮共 15,000+ 次并发提交后对账，456 个账户全部一致、无残留冻结。

## 6. 压测

**环境**：单台 4 vCPU / 16 GB 的容器内同时运行 PostgreSQL、后端、nginx 与压测脚本（`scripts/loadtest.mjs`），请求经 nginx 转发；后端为 staging 配置（Mock 模型，Worker 同时在处理队列），压测时放开了按用户限流。数据会受到压测脚本占用 CPU 的影响，只用于发现瓶颈和对比，正式容量以 staging 硬件上的复测为准。

| 场景 | 后端实例 | 并发 | 吞吐 | p50 | p95 | p99 | 错误 | 压测后对账 |
|---|---|---|---|---|---|---|---|---|
| 提交生成任务（冻结积分 + 写任务） | 1 | 100 | 254 次/秒 | 385 ms | 462 ms | 597 ms | 0 | 206 个账户一致 |
| 提交生成任务 | 2 | 100 | 291 次/秒 | 341 ms | 651 ms | 790 ms | 0 | 456 个账户一致 |
| 读接口（用户信息、任务、作品、广场、流水轮询） | 1 | 100 | 652 次/秒 | 151 ms | 192 ms | 217 ms | 0 | — |

**分析**：

- 单实例时后端进程约占满 1 个 CPU 核（Node 单线程），是提交与读接口的瓶颈；nginx 与 PostgreSQL 各占约 1 核和 0.7 核。
- 两个实例时后端各约 55–60%，瓶颈转移到 PostgreSQL（约 2.2 核）。每次提交约 12 次顺序查询（幂等检查、限流计数、套餐、冻结积分的账户锁与批次、写任务、读回任务、推送余额）加一次事务提交。抽查了队列认领、进行中任务计数等查询的执行计划，均走索引、耗时在 1 ms 以内，问题在总量而不是单条慢查询。
- 并发提交 15,000+ 次没有出现死锁、超扣或余额不一致，说明"先锁账户、后锁批次"的加锁顺序与幂等设计在真实 PostgreSQL 上成立。

**达到 500 次/秒提交的路径**：数据库独立部署（4–8 vCPU）、后端 2–3 个实例；如仍不足，把提交链路中的只读查询（套餐、账户 ID）缓存到进程内，并把冻结与写任务合并为更少的往返。

## 7. 上线检查清单

| 事项 | 状态 | 说明 |
|---|---|---|
| staging 环境（容器镜像、编排、CI 冒烟） | ✅ | 本文第 2 节 |
| 监控指标与访问日志 | ✅ | 接入 Prometheus / 日志平台与告警通知渠道待运维配置 |
| 限流防刷、安全响应头 | ✅ | 多实例全局限流需 Redis |
| 定时对账与演练 | ✅ | |
| 压测与瓶颈分析 | ◐ | 需在 staging 硬件上复测 500 次/秒目标 |
| 多实例推送 | ☐ | 服务端推送目前在进程内分发，多实例时用户可能收不到其他实例 Worker 的进度。上线多实例前改为 PostgreSQL LISTEN/NOTIFY 或 Redis Pub/Sub |
| 真实模型供应商适配器 | ☐ | 需要供应商测试账号 |
| 第三方内容审核（文本、图像，含上传与生成结果） | ☐ | 公开内测前必须完成 |
| 短信服务商、微信 / 支付宝支付、发票 | ☐ | 生产配置下未接入时服务拒绝启动 |
| 对象存储（OSS）驱动 | ☐ | 当前为本地卷 |
| HTTPS 证书与域名、数据库备份与恢复演练 | ☐ | 部署平台侧完成 |
| 生成式 AI 服务备案与算法备案 | ☐ | 见 [08 合规](./08-compliance.md)，公开上线前必须完成 |
| 安全测试（渗透测试、依赖漏洞扫描） | ☐ | |
