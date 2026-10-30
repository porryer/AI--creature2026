# 05 · API 接口设计

> 风格：RESTful JSON + WebSocket / SSE 实时推送
> 契约：OpenAPI 3.1（`apps/server/openapi.yaml` 为唯一事实来源）
> 关联文档：[03 技术架构](./03-architecture.md) · [04 数据库设计](./04-database.md)

## 1. 通用约定

| 项 | 约定 |
|---|---|
| 基础路径 | `https://api.creature.example/v1` |
| 认证 | `Authorization: Bearer <access_token>`；开放 API 使用 `X-Api-Key` |
| 幂等 | 所有会产生扣费或资源的 `POST` 必须携带 `Idempotency-Key`（UUID），24 小时内相同键返回相同结果 |
| 分页 | 游标分页：`?limit=20&cursor=<opaque>`，响应 `{ data: [], next_cursor: "..." \| null }` |
| ID | 带类型前缀：`usr_` `tsk_` `ast_` `cvs_` `tpl_` `chr_` `brd_` `ord_` |
| 时间 | ISO 8601，UTC，如 `2026-10-26T08:00:00Z` |
| 限流 | 响应头 `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `Retry-After` |
| 追踪 | 响应头 `X-Request-Id`，与日志 / Trace 关联 |

### 1.1 统一错误格式

```json
{
  "error": {
    "code": "INSUFFICIENT_CREDITS",
    "message": "积分不足：本次需要 40 积分，当前可用 12 积分",
    "details": { "required": 40, "available": 12 },
    "request_id": "req_01JBX2..."
  }
}
```

### 1.2 错误码

| HTTP | code | 说明 |
|---|---|---|
| 400 | `INVALID_ARGUMENT` | 参数校验失败，`details.fields` 列出字段 |
| 401 | `UNAUTHENTICATED` | 未登录或令牌过期 |
| 403 | `PERMISSION_DENIED` | 无权访问该资源 |
| 403 | `ACCOUNT_SUSPENDED` | 账号已被后台冻结或封禁，客户端应退出登录 |
| 403 | `ACCOUNT_DELETING` | 账号在注销冷静期内（重新登录即撤销），客户端应退出登录 |
| 409 | `ACCOUNT_BUSY` | 有正在生成的任务，暂不能注销 |
| 403 | `PHONE_BINDING_REQUIRED` | 未绑定手机号，不能使用生成功能 |
| 402 | `INSUFFICIENT_CREDITS` | 积分不足 |
| 403 | `PLAN_FEATURE_REQUIRED` | 当前套餐不支持该功能（已实现：角色库与品牌套件），`details.required_plan` |
| 404 | `NOT_FOUND` | 资源不存在 |
| 409 | `IDEMPOTENCY_CONFLICT` | 相同幂等键但请求体不同 |
| 409 | `LIBRARY_LIMIT` | 角色或品牌套件数量已达套餐上限 |
| 422 | `CONTENT_REJECTED` | 提示词或素材未通过审核，`details.reason_code` |
| 429 | `RATE_LIMITED` | 请求过于频繁（验证码、上传、发布、举报的每日上限；生成任务每分钟提交次数与进行中任务数），附 `Retry-After` |
| 503 | `MODEL_UNAVAILABLE` | 所选模型及备选模型均不可用 |

### 1.3 实现状态（Sprint 1–12）

已实现（`apps/server`，带集成测试）：

| 分组 | 接口 |
|---|---|
| 认证 | `POST /auth/sms/send`、`POST /auth/sms/login`、`POST /auth/refresh`、`POST /auth/logout` |
| 用户 | `GET /me`（含 `role`）、`PATCH /me`、`GET /me/export`、`POST /me/deletion/code`、`DELETE /me`，见 3.13 |
| 模型 | `GET /models`、`POST /models/route` |
| 生成 | `POST /generations`（含图像编辑，见 3.1）、`GET /generations`、`GET /generations/{id}`、`POST /generations/{id}/cancel`（排队中取消；写作生成中为停止，见 3.3） |
| 推送 | `GET /events`（SSE，替代 3.3 节的 WebSocket，见下；写作任务流式输出 `task.delta`） |
| 资产 | `GET /assets?kind=&favorite=&q=&folder=`（`folder=none` 为未归档）、`GET /assets/{id}`、`PATCH /assets/{id}`、`DELETE /assets/{id}`（同时撤回广场发布）、`POST /assets/move`、`GET /assets/{id}/download`、`GET /files/{token}`（签名文件；带 `dl` 参数时以附件下载） |
| 文件夹 | `GET /asset-folders`（含作品数）、`POST /asset-folders`、`PATCH /asset-folders/{id}`、`DELETE /asset-folders/{id}`（作品移回未归档） |
| 上传 | `POST /assets/uploads`、`PUT /uploads/{id}?exp=&sig=`（签名地址，无需登录态）、`POST /assets/uploads/{id}/complete`，见 3.7 |
| 项目与画布 | `GET /projects`、`POST /projects`（同时创建画布）、`PATCH /projects/{id}`、`DELETE /projects/{id}`、`GET /canvases/latest`、`GET /canvases/{id}`、`PUT /canvases/{id}`，见 3.8；历史版本 `GET` / `POST /canvases/{id}/snapshots`、`GET /canvases/{id}/snapshots/{sid}`、`POST /canvases/{id}/snapshots/{sid}/restore`；分享 `GET` / `PUT` / `DELETE /canvases/{id}/share`、`GET /shared/canvases/{token}`（无需登录），见 3.14 |
| 社区 | `GET /feed?tab=recommend\|latest\|hot\|mine&kind=&cursor=`、`POST /posts`、`GET /posts/{id}`、`DELETE /posts/{id}`（作者撤回）、`PUT` / `DELETE /posts/{id}/like`、`POST /posts/{id}/remix`、`POST /reports`，见 3.9 |
| 角色与品牌 | `GET` / `POST /characters`、`GET` / `PATCH` / `DELETE /characters/{id}`、`GET` / `POST /brand-kits`、`GET` / `PATCH` / `DELETE /brand-kits/{id}`，生成时通过 `context` 引用，见 3.11 |
| 模板 | `GET /templates?category=&kind=`、`GET /templates/{id}`、`POST /templates/{id}/generate`、`POST /templates/{id}/use`、`PUT /templates/{id}/rating`，见 3.12 |
| 埋点 | `POST /analytics/events`（客户端界面行为），见 3.12 |
| 管理后台 | `GET /admin/overview`、`GET /admin/analytics?days=`、`GET /admin/models`、`GET /admin/review-queue`、`POST /admin/posts/{id}/decision`、`GET /admin/users`、`GET /admin/users/{id}`、`POST /admin/users/{id}/status`、`POST /admin/users/{id}/credits`、`GET /admin/reconcile`、`POST /admin/reconcile/run`（需 `role = admin`），见 3.10 |
| 积分 | `GET /credits/balance`、`GET /credits/ledger` |
| 订单 | `POST /orders`、`GET /orders/{id}`、`POST /orders/{id}/mock-pay`（仅 `PAYMENTS_MODE=mock`） |
| 运维 | `GET /healthz`、`GET /metrics`（Prometheus 文本，令牌保护，见 [09 上线准备](./09-launch-readiness.md)） |

其余接口（画布运行与分享、Agent、用户发布模板、评论与关注流、团队、支付回调、开放 API）按 [开发计划](./07-roadmap.md) 在后续 Sprint 实现。刷新令牌通过 httpOnly Cookie `crt_rt`（路径 `/v1/auth`）下发，前端不接触。

## 2. 接口清单

### 2.1 认证与用户

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/sms/send` | 发送验证码 `{ phone, scene: "login" }` |
| POST | `/auth/sms/login` | 验证码登录，返回令牌对 |
| POST | `/auth/wechat/qrcode` | 获取微信扫码登录二维码 |
| GET | `/auth/wechat/qrcode/{ticket}` | 轮询扫码状态 |
| POST | `/auth/refresh` | 刷新令牌 |
| POST | `/auth/logout` | 注销当前会话 |
| GET | `/me` | 当前用户信息、套餐、积分概要 |
| PATCH | `/me` | 修改昵称、头像、偏好 |
| DELETE | `/me` | 申请注销账号（短信验证，15 天冷静期） |
| POST | `/me/deletion/code` | 向绑定手机号发送注销确认验证码 |
| GET | `/me/export` | 导出个人信息副本（JSON 附件） |

### 2.2 模型与价目

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/models?modality=image` | 可用模型列表（含能力、积分价格、备案信息） |
| POST | `/models/route` | 智能路由预览：传入任务参数，返回推荐模型、备选、积分预估 |

### 2.3 生成任务

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/generations` | 创建生成任务 |
| GET | `/generations/{id}` | 查询任务详情 |
| GET | `/generations?status=&modality=&cursor=` | 历史任务列表 |
| POST | `/generations/{id}/cancel` | 取消排队中的任务；写作任务生成中时为停止（保留已生成的部分） |
| POST | `/generations/{id}/retry` | 失败任务重试（新任务） |
| GET | `/generations/{id}/events` | SSE 推送任务进度（WebSocket 不可用时的降级） |
| POST | `/prompts/enhance` | 提示词 AI 润色 |

### 2.4 写作（流式）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/writing/completions` | 流式生成文本（SSE），按输出字数计费。**当前实现**：写作仍通过 `POST /generations` 提交，输出经 `/events` 以 `task.delta` 推送（见 3.3），可多实例、可停止、复用排队与账务 |
| POST | `/writing/storyboard` | 剧本 → 结构化分镜表 |

### 2.5 资产

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/assets?kind=&folder_id=&q=&cursor=` | 资产列表；`q` 支持语义搜索 |
| GET | `/assets/{id}` | 资产详情（含生成参数） |
| POST | `/assets/uploads` | 申请上传（返回 OSS 直传签名） |
| POST | `/assets/uploads/{uploadId}/complete` | 上传完成，触发审核 |
| PATCH | `/assets/{id}` | 修改标签、文件夹、收藏 |
| DELETE | `/assets/{id}` | 删除 |
| GET | `/assets/{id}/download` | 获取带标识文件的签名下载 URL |
| CRUD | `/asset-folders` | 文件夹管理 |

### 2.6 角色与品牌

| 方法 | 路径 | 说明 |
|---|---|---|
| CRUD | `/characters` | 角色库 |
| POST | `/characters/{id}/train` | 训练角色 LoRA（扣积分） |
| CRUD | `/brand-kits` | 品牌套件 |

### 2.7 项目与画布

| 方法 | 路径 | 说明 |
|---|---|---|
| CRUD | `/projects` | 项目 |
| POST | `/projects/{id}/canvases` | 新建画布 |
| GET | `/canvases/{id}` | 获取最新快照 |
| PUT | `/canvases/{id}/snapshot` | 保存快照（非协作模式） |
| POST | `/canvases/{id}/estimate` | 估算运行指定节点所需积分 |
| POST | `/canvases/{id}/runs` | 运行节点 `{ node_ids: [], mode: "selected" \| "all" \| "stale" }` |
| GET | `/canvases/{id}/runs/{runId}` | 运行状态 |
| PATCH | `/canvases/{id}/share` | 分享设置（**当前实现**为 `PUT` / `DELETE`，见 3.14） |
| GET / POST | `/canvases/{id}/snapshots` | 历史版本列表 / 手动保存版本 |
| POST | `/canvases/{id}/snapshots/{sid}/restore` | 恢复到历史版本 |
| GET | `/shared/canvases/{token}` | 分享页（只读，无需登录） |
| WS | `/ws/canvas/{id}` | Yjs 协作通道 |

### 2.8 Agent

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/agent/sessions` | 创建会话 `{ canvas_id? }` |
| POST | `/agent/sessions/{id}/messages` | 发送消息，SSE 流式返回（文本 / 追问 / 计划卡片） |
| POST | `/agent/sessions/{id}/plans/{planId}/confirm` | 确认执行计划（可附带修改后的步骤） |
| POST | `/agent/sessions/{id}/plans/{planId}/cancel` | 取消计划或中止执行 |
| GET | `/agent/memories` | 查看 Agent 记忆 |
| DELETE | `/agent/memories/{id}` | 删除一条记忆 |

### 2.9 模板

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/templates?category=&kind=` | 模板列表（附使用次数、评分与预估积分） |
| GET | `/templates/{id}` | 模板详情 |
| POST | `/templates/{id}/generate` | 单步模板：填写输入后创建生成任务（幂等键同 `/generations`） |
| POST | `/templates/{id}/use` | 工作流模板：记录一次使用（画布由前端按步骤生成） |
| PUT | `/templates/{id}/rating` | 评分 1–5，用过才能评 |
| POST | `/templates` | 发布模板（进入审核，P1） |

### 2.10 社区

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/feed?tab=recommend\|latest\|hot\|mine\|following&kind=` | 灵感广场（`following` 待做） |
| POST | `/posts` | 发布作品到广场 |
| GET | `/posts/{id}` | 作品详情 |
| PUT / DELETE | `/posts/{id}/like` | 点赞 / 取消点赞（幂等） |
| POST | `/posts/{id}/remix` | 做同款（返回预填参数） |
| CRUD | `/posts/{id}/comments` | 评论 |
| POST | `/reports` | 举报 |

### 2.11 计费

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plans` | 套餐列表 |
| GET | `/credits/balance` | 积分余额（可用 / 冻结 / 即将过期） |
| GET | `/credits/ledger?cursor=` | 积分明细 |
| POST | `/orders` | 创建订单 `{ item_type, item_ref, cycle, pay_channel }` |
| GET | `/orders/{id}` | 订单状态 |
| POST | `/subscriptions/{id}/cancel-renewal` | 取消自动续费 |
| POST | `/webhooks/pay/wechat` | 微信支付回调（验签） |
| POST | `/webhooks/pay/alipay` | 支付宝回调（验签） |

### 2.12 团队

| 方法 | 路径 | 说明 |
|---|---|---|
| CRUD | `/teams` | 团队 |
| POST | `/teams/{id}/invitations` | 邀请成员（链接 / 手机号） |
| PATCH | `/teams/{id}/members/{userId}` | 修改角色、积分上限 |
| DELETE | `/teams/{id}/members/{userId}` | 移除成员 |

### 2.13 内部接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/internal/vendors/{provider}/callback` | 供应商异步回调（IP 白名单 + 签名） |
| — | `/admin/*` | 管理后台接口，独立鉴权与审计 |

## 3. 关键接口详解

### 3.1 创建生成任务

`POST /v1/generations`

请求头：

```http
Authorization: Bearer eyJhbGciOi...
Idempotency-Key: 3f1c8a52-6c1e-4f43-9a51-2b7f0c0d9e11
Content-Type: application/json
```

请求体（`params` 字段与 `packages/shared` 的 `GenerationParams` 一致，未知字段会被拒绝）：

```json
{
  "modality": "image",
  "operation": "generate",
  "prompt": "秋日午后的咖啡馆窗边，一杯枫糖拿铁，暖色逆光，胶片质感",
  "params": {
    "ratio": "3:4",
    "resolution": "2k",
    "count": 4
  },
  "routing": { "strategy": "auto", "pinned_model": null },
  "source": "studio"
}
```

| 模态 | 可用参数 |
|---|---|
| image | `ratio`、`resolution`（1k / 2k / 4k）、`count`（1–12，工作台界面提供 1–4） |
| video | `ratio`、`resolution`（720p / 1080p）、`duration`（秒，超过模型上限时自动截断）、`audio`（原生音频，仅支持的模型生效）、`camera` |
| text | `template`（xhs / script / ad / article / storyboard）、`tone`、`chars`；`operation: "edit"` 时用 `transform`（改写 / 扩写 / 缩写 / 换语气） |
| audio | 配音：`chars`、`voice`、`seconds`；配乐：`pinned_model: "creature-music"` + `seconds` |

参考图 `references`：`[{ "asset_id": "ast_…", "role": "subject" }]`，最多 4 张，必须是自己未删除的图像资产（上传或生成的均可）。

| 模态 | 可用 `role` |
|---|---|
| image | `style`（取色调与质感）、`subject`（保留商品 / 主体外观）、`character`（保持人物一致） |
| video | `first_frame`、`last_frame`（各至多 1 张） |

参考图不改变计价；校验失败返回 `400`，不会冻结积分。

引用角色与品牌套件 `context`：`{ "character_ids": ["chr_…"], "brand_kit_id": "bk_…", "place_logo": true }`，见 3.11。

**图像编辑**：`modality: "image"`、`operation: "edit"`，`references` 只能有一张 `role: "source"` 的源图（本人的图像资产，上传素材也可以），固定由编辑模型 `creature-edit` 处理（指定其他模型返回 `400`，不切换备选模型），按次计费：

| `params.tool` | 说明 | 其他参数 | 积分 |
|---|---|---|---|
| `inpaint` 局部重绘 | 涂抹区域内按描述重新生成 | 必填 `prompt` 与 `mask` | 2 |
| `outpaint` 扩图 | 向四周延展到新比例 | 必填 `params.ratio`（与原图不同），`prompt` 选填 | 2 |
| `erase` 消除 | 去掉涂抹区域的物体并补全背景 | 必填 `mask` | 2 |
| `cutout` 抠图 | 保留主体，背景透明 | — | 2 |
| `upscale` 超分 | 放大并增强细节 | `params.scale`：2（默认）或 4，放大后边长不超过 8192 | 2 / 4 |

`mask` 为 PNG data URL（黑底，白色为要修改的区域，约 730 KB 以内），服务端以私有文件保存，不对外提供访问地址。`prompt` 省略时任务名为"工具 · 源图标题"。编辑结果属于生成内容，同样添加显式与隐式 AI 标识（包括对上传素材的编辑）。

响应 `202 Accepted`：

```json
{
  "id": "tsk_01JBX3K9Q2M7",
  "status": "queued",
  "model": { "code": "seedream-4", "name": "Seedream 4.0", "tier": "advanced" },
  "routing_reason": "提示词包含写实光影与产品主体，推荐高级图像模型",
  "estimated_credits": 24,
  "queue": { "name": "p1", "position": 3, "eta_seconds": 18 },
  "created_at": "2026-10-26T08:00:00Z"
}
```

`queue.position` 是同一模态排队中的第几位（1 表示下一个处理；各模态的 Worker 槽位独立，只数同一模态的任务），最多精确到前方 1000 个，超过时为 1001。

### 3.2 查询任务

`GET /v1/generations/tsk_01JBX3K9Q2M7`

```json
{
  "id": "tsk_01JBX3K9Q2M7",
  "status": "succeeded",
  "progress": 100,
  "model": { "code": "seedream-4", "name": "Seedream 4.0", "tier": "advanced" },
  "estimated_credits": 24,
  "actual_credits": 24,
  "outputs": [
    {
      "asset_id": "ast_0mvq0qbk1000a0f3c9e1b2d4",
      "kind": "image",
      "url": "/v1/files/cHVibGljL3Vzcl8w…?exp=1793073302&sig=y04vTg1_…",
      "mime": "image/svg+xml",
      "width": 1152,
      "height": 1536,
      "content_id": "CRT-20261027-3FD0DEBA"
    }
  ],
  "error": null,
  "source": "studio",
  "created_at": "2026-10-26T08:00:00Z",
  "finished_at": "2026-10-26T08:00:17Z"
}
```

### 3.3 任务进度推送

当前实现为 SSE：`GET /v1/events?access_token=<访问令牌>`（浏览器 EventSource 无法设置请求头，因此令牌放在查询参数中；令牌 2 小时过期，前端刷新后自动重连）。每 25 秒发送一次 `ping` 事件保活。默认事件的 `data` 为：

```json
{ "type": "task.progress",  "task": { "id": "tsk_…", "status": "running", "progress": 45, "…": "…" } }
{ "type": "task.succeeded", "task": { "id": "tsk_…", "status": "succeeded", "outputs": [ { "asset_id": "ast_…", "url": "/v1/files/…", "content_id": "CRT-20261027-3FD0DEBA" } ] } }
{ "type": "task.failed",    "task": { "id": "tsk_…", "status": "failed", "error": { "code": "ALL_MODELS_FAILED", "message": "…已返还 12 积分" } } }
{ "type": "task.delta",     "task_id": "tsk_…", "offset": 120, "text": "秋天是饮品消费的拐点……" }
{ "type": "credits.changed", "credits": { "available": 1776, "frozen": 0, "expiring_soon": 20 } }
{ "type": "sync" }
```

**写作流式输出**：写作任务（`modality = text`、`operation = generate`）的输出按约 120 ms 合并推送一次 `task.delta`，`text` 是从第 `offset` 个字符开始的文本。跨实例推送可能乱序，客户端按 `offset` 拼接（不连续的片段先暂存）；`offset` 为 0 表示重新开始（主模型失败、切换了备选模型）。每次推送前对已生成的全文审核，命中拦截时立即中止生成，任务以 `blocked`（`CONTENT_BLOCKED`）结束并全额返还，未通过的文字不会推送，客户端应清除已显示的部分。任务结束时以 `task.succeeded` 中的完整结果为准（末尾附 AI 生成标识）。

**停止**：写作任务生成中调用 `POST /generations/{id}/cancel` 返回 `200` 与当前任务（`status` 仍为 `running`）；处理该任务的实例（经跨实例控制消息，另每秒检查一次停止标记兜底）结束生成，保留已生成的部分，任务以 `succeeded` 结束、`stopped: true`，按实际字数结算；还没有任何输出时按取消处理并全额返还。写作按实际输出字数计费（每 2000 字 1 积分，不超过预估）。

`task` 字段与 `GET /generations/{id}` 的返回结构相同。推送不保证送达：`sync` 表示服务端的事件监听刚刚重连、期间的事件可能丢失，客户端应重新拉取进行中的任务与余额；客户端自己的连接断开重连后也应同样处理（前端在每次重连成功时执行）。多个后端实例时，用户的推送连接与处理任务的 Worker 可以在不同实例上（见 [09 上线准备 · 多实例部署](./09-launch-readiness.md#7-多实例部署)）。画布多人协作上线时再引入 WebSocket（Yjs 协作通道）。

### 3.4 Agent 对话（SSE）

`POST /v1/agent/sessions/{id}/messages`

```json
{ "content": "为咖啡品牌做秋季上新物料：3 张小红书海报 + 1 条 15 秒抖音短视频", "attachments": [] }
```

SSE 响应流：

```text
event: message.delta
data: {"text":"好的，我先读取了你的品牌套件「山野咖啡」……"}

event: plan
data: {
  "plan_id": "pln_01JBX4",
  "title": "秋季上新物料",
  "steps": [
    {"id":"s1","tool":"write_text","title":"撰写海报文案与视频脚本","model":"qwen-max","credits":1,"depends_on":[]},
    {"id":"s2","tool":"generate_image","title":"主视觉海报 ×3","model":"seedream-4","params":{"aspect_ratio":"3:4","count":3,"resolution":"2k"},"credits":18,"depends_on":["s1"]},
    {"id":"s3","tool":"generate_video","title":"15 秒产品短片","model":"wan-2.6","params":{"duration_sec":15,"resolution":"1080p","native_audio":false},"credits":240,"depends_on":["s1","s2"]},
    {"id":"s4","tool":"generate_speech","title":"旁白配音","model":"tts-warm-female","credits":1,"depends_on":["s1"]}
  ],
  "estimated_credits": 260,
  "estimated_seconds": 180,
  "requires_confirmation": true
}

event: done
data: {"session_status":"awaiting_confirm"}
```

确认执行：`POST /v1/agent/sessions/{id}/plans/pln_01JBX4/confirm`

```json
{ "steps_override": [ { "id": "s3", "params": { "duration_sec": 10 } } ] }
```

执行过程中继续通过 WebSocket 推送 `agent.step.started` / `agent.step.succeeded` / `agent.completed` 事件，画布节点同步更新。

### 3.5 运行画布节点

`POST /v1/canvases/cvs_01JBX5/runs`

```json
{ "node_ids": ["n_img_1", "n_vid_1"], "mode": "selected", "max_credits": 300 }
```

响应：

```json
{
  "run_id": "run_01JBX6",
  "order": [["n_img_1"], ["n_vid_1"]],
  "estimated_credits": 246,
  "tasks": [
    { "node_id": "n_img_1", "task_id": "tsk_01JBX6A" },
    { "node_id": "n_vid_1", "task_id": null, "waiting_for": ["n_img_1"] }
  ]
}
```

若预估超过 `max_credits` 返回 `402 INSUFFICIENT_CREDITS` 或 `400 INVALID_ARGUMENT`（`details.reason = "exceeds_max_credits"`）。

### 3.6 创建订单

`POST /v1/orders`

```json
{ "item_type": "subscription", "item_ref": "pro", "cycle": "year", "pay_channel": "wechat" }
```

响应：

```json
{
  "id": "ord_01JBX7",
  "order_no": "CR20261026080012345",
  "amount_fen": 94800,
  "pay": { "channel": "wechat", "code_url": "weixin://wxpay/bizpayurl?pr=xxxx", "expires_at": "2026-10-26T08:15:00Z" },
  "status": "pending"
}
```

前端展示二维码并轮询 `GET /v1/orders/{id}`，或等待 WebSocket `order.paid` 事件。

### 3.7 素材上传

三步完成。`upload_url` 在本地存储驱动下指向 API 自身，在对象存储驱动下是存储桶的预签名地址（浏览器直传，存储桶需允许本站跨域），客户端处理方式相同：

1. `POST /v1/assets/uploads` `{ "filename": "新品.png", "mime": "image/png", "size": 482133 }` → `201`
   `{ "upload_id": "upl_…", "upload_url": "/v1/uploads/upl_…?exp=…&sig=…", "method": "PUT", "headers": { "content-type": "image/png" }, "max_bytes": 482133, "expires_at": "…" }`。
   支持 PNG / JPEG / WebP，单个 ≤ 20 MB，每人每天 200 次。
2. `PUT {upload_url}`，带上 `headers`，请求体为文件内容，且必须恰好是声明的 `size` 字节 → `2xx`（本地驱动 `204`，对象存储 `200`）。签名错误或过期 `403`。本地驱动：超过声明大小 `413`、文件头识别出的格式与声明不符 `400`、重复上传 `409 UPLOAD_CLOSED`；对象存储：大小或 `content-type` 与签名不符 `403`。
3. `POST /v1/assets/uploads/{upload_id}/complete` → `200` 返回资产（`source: "uploaded"`，不加 AI 标识）。未上传 `409 UPLOAD_INCOMPLETE`；对象存储驱动在此校验文件头，与声明不符 `400`（文件被删除，可在有效期内重新上传）；审核不通过 `422 CONTENT_REJECTED`（留审核记录，不生成资产）；重复调用返回同一资产。

文件地址 `/v1/files/...` 在对象存储驱动下返回 `302`，跳转到有效期相同的存储桶预签名地址（`<img>`、下载链接会自动跟随）。

### 3.8 保存画布

`PUT /v1/canvases/cvs_…`

```json
{
  "version": 7,
  "name": "秋季上新物料",
  "doc": {
    "nodes": [{ "id": "n1", "kind": "image", "title": "主视觉", "prompt": "…", "x": 40, "y": 60, "modelCode": "seedream-4", "params": { "ratio": "3:4" }, "count": 2, "status": "succeeded", "taskId": "tsk_…" }],
    "edges": [{ "id": "e1", "from": "n0", "to": "n1" }],
    "messages": [],
    "viewport": { "x": 40, "y": 90, "k": 0.9 }
  }
}
```

- 成功返回 `{ "version": 8, "updated_at": "…" }`；`version` 与服务端不一致返回 `409 CANVAS_VERSION_CONFLICT`（`details.current_version`），客户端应重新读取后再保存。
- 节点的 `outputs` 等未知字段不会保存；`GET` 时服务端按 `taskId` 补全最新状态与签名产物地址。修改过、尚未重跑的节点可带 `prevTaskId`，读取时继续展示上一次的产物。
- 文档上限 1 MB、500 个节点、2000 条连线、300 条对话；重复节点 ID、连线指向不存在的节点返回 `400`。

### 3.9 灵感广场

- **发布** `POST /v1/posts` `{ "asset_id": "ast_…", "title": "秋天的第一杯", "tags": ["咖啡"], "show_prompt": true }`：只能发布自己的 AI 生成图像 / 视频（上传素材 `400`）；同一作品重复发布返回已有那条；每人每天 20 条。发布时快照提示词、模型与参数。机审命中拦截词返回 `422 CONTENT_REJECTED`，命中复核词（公众人物、功效宣传等）`status = "reviewing"`，只有作者可见，人工通过后进入广场。
- **列表** `GET /v1/feed`：`recommend` 按互动数与发布时长衰减排序，`latest` 按发布时间，`hot` 按点赞数，`mine` 为自己的全部发布（含审核中、已隐藏）。`cursor` 为上一页返回的 `next_cursor`。作者关闭 `show_prompt` 时他人看到的 `prompt` 为 `null`。
- **做同款** `POST /v1/posts/{id}/remix` 返回 `{ modality, prompt, params, model_code }`（提示词未公开时为空字符串），每人只计一次，作者自己不计。
- **举报** `POST /v1/reports` `{ "target_type": "post", "target_id": "pst_…", "reason": "infringement", "detail": "…" }`，`reason` 为 `porn / violence / politics / infringement / ad / other`。只能举报广场上可见的他人作品；同一人对同一作品只记一次；累计 3 人举报自动隐藏，进入后台复核；每人每天 20 次。

### 3.10 管理后台

`ADMIN_PHONES` 中的手机号登录时授予 `role = admin`；每次请求都会重新校验角色。

- `GET /v1/admin/overview`：今日任务数与成功率、今日收入、今日消耗积分、队列长度、待复核数、近 14 天每日任务（按北京时间）。
- `GET /v1/admin/models`：每个模型的网关 5 分钟窗口（样本数、成功率、是否熔断）与近 24 小时任务数、成功率、P95 耗时。
- `GET /v1/admin/review-queue`：审核中、被举报隐藏或有未处理举报的作品，附机审标签与举报原因统计；审核员可看到未公开的提示词。
- `POST /v1/admin/posts/{id}/decision` `{ "action": "approve" | "remove", "note": "…" }`：通过时发布并驳回举报（举报计数清零），下架时隐藏并将举报标记为成立；每次处理写一条人工审核记录与审计日志。
- `GET /v1/admin/users?q=&status=&cursor=`：`q` 可以是完整手机号（按 HMAC 索引精确匹配）、手机号后 4 位、昵称片段或用户 ID。`GET /v1/admin/users/{id}` 返回积分、任务与发布统计、最近 20 条积分流水、最近 10 个任务和针对该用户的操作记录。
- `POST /v1/admin/users/{id}/status` `{ "status": "active" | "frozen" | "banned", "reason": "…" }`：冻结 / 封禁时吊销该用户全部刷新令牌，访问令牌在所有实例上立即失效（返回 `403 ACCOUNT_SUSPENDED`；跨实例通知丢失时最迟 10 秒），也无法再登录；不能修改自己或其他管理员。
- `POST /v1/admin/users/{id}/credits` `{ "delta": 50, "reason": "生成异常补偿", "request_id": "…" }`：增加时发放一年有效的积分批次，扣减时按到期顺序扣除，可用余额不足返回 `400`；单次不超过 100000，同一 `request_id` 只生效一次；流水类型为 `adjust`，用户在自己的积分明细中可见。
- `GET /v1/admin/reconcile`：最近 10 次全量对账（账户数、不一致账户数、已结束任务的残留冻结数与明细）；`POST /v1/admin/reconcile/run` 立即执行一次（只读核对，写审计日志）。

### 3.11 角色库与品牌套件

专业版、团队版功能（配额：专业版 20 个角色 / 5 个品牌套件，团队版 50 / 20）。其他套餐或套餐过期时，列表照常返回（`quota.limit` 为 0，已有内容可以查看与删除），新建、修改与生成时引用返回 `403 PLAN_FEATURE_REQUIRED`（`details.required_plan: "pro"`）；超出配额 `409 LIBRARY_LIMIT`。名称、描述、调性、字体、禁用元素等文字过审，不通过 `422 CONTENT_REJECTED`。

**角色** `POST /v1/characters`

```json
{
  "name": "林夏",
  "description": "25 岁生活方式博主，短发、圆框眼镜、米色风衣",
  "likeness": "none",
  "consent_asset_id": null,
  "refs": [{ "asset_id": "ast_…", "view": "front" }, { "asset_id": "ast_…", "view": "side" }, { "asset_id": "ast_…" }]
}
```

- `refs`：3–8 张本人未删除的图像资产（上传或生成的均可，不能重复），`view` 可选 `front / side / back / full_body / expression`。
- `likeness`：`none` 虚构角色 / 品牌 IP、`self` 本人肖像、`authorized` 他人肖像；`authorized` 必须附 `consent_asset_id`（本人上传的授权书图片）。
- 返回 `CharacterDTO`：`refs` 带签名地址（已删除的资产不再列出）、`used_count` 被生成引用的次数。`PATCH` 只改传入的字段，传 `refs` 时整体替换。`GET /v1/characters` 返回 `{ data, quota: { used, limit } }`。

**品牌套件** `POST /v1/brand-kits`

```json
{
  "name": "山野咖啡",
  "tone": "温暖、自然、有手作感",
  "colors": [{ "name": "焦糖", "hex": "#B5652B" }, { "name": "松针", "hex": "#2F5D46" }],
  "fonts": ["思源宋体 · 标题"],
  "banned": ["冷色调", "塑料质感"],
  "logos": [{ "asset_id": "ast_…", "variant": "primary" }]
}
```

标准色最多 8 个（`#RRGGBB`，保存为大写）、字体 4 个、禁用元素 12 个、Logo 3 个版本（`primary / light / dark / mono` 各一个）。

**生成时引用**：`POST /v1/generations` 的 `context`。

| 字段 | 说明 |
|---|---|
| `character_ids` | 最多 2 个角色，仅图像与视频。每个角色按 正面 → 全身 → 侧面 → 表情 → 背面 的顺序取 3 张参考图（`role: "character"`，同一角色的参考图在适配器中分为一组）随请求传给模型 |
| `brand_kit_id` | 图像、视频与写作。品牌调性与禁用元素注入提示词；图像与视频另注入标准色（并作为调色板传给适配器），图像注入字体 |
| `place_logo` | 仅图像，品牌套件需有 Logo：主 Logo 作为参考图（`role: "logo"`）传给模型，提示词要求放在画面右上角（右下角留给"AI 生成"显式标识） |

校验在冻结积分之前完成，非法引用返回 `400`；编辑任务不能带 `context`。任务创建时保存角色与品牌套件的快照，之后修改或删除不影响已提交的任务；任务的 `prompt` 仍是用户原始提示词，注入后的完整提示词与原始提示词一起过审。任务返回 `context: { characters: [{ id, name }], brand_kit: { id, name } | null, place_logo }`。角色 LoRA 训练（`POST /characters/{id}/train`）尚未实现。

### 3.12 官方模板与数据埋点

**模板目录**在 `packages/shared/src/templates.ts`（20 个单步模板、6 个工作流模板），前后端共用；数据库只保存使用与评分（`template_stats`、`template_uses`、`template_ratings`）。列表项为 `TemplateDTO`：目录字段加 `uses`、`rating: { avg, count }`、`my_rating`、`used_by_me`、`estimated_credits`（按模板默认参数与价目估算）。

`POST /v1/templates/{id}/generate`（需 `Idempotency-Key`）

```json
{ "values": { "product": "山野枫糖拿铁" }, "images": { "photo": "ast_…" } }
```

- 必填项缺失 `400`（"请填写商品" / "请上传商品图"），文字超过长度上限 `400`；选填项留空时使用示例值。
- 服务端渲染提示词后走与 `POST /generations` 相同的链路（审核、冻结积分、排队），任务 `source = "template"` 并记录 `template_id`；图片输入作为参考图（按模板定义的 `role`），配音模板按文字长度计费。普通生成接口不能自称来自模板。
- 相同幂等键重放返回 `200` 与原任务，不重复计数；工作流模板调用此接口返回 `400`（请在画布中使用）。
- `POST /templates/{id}/use` 只用于工作流模板；`PUT /templates/{id}/rating { "score": 1–5 }` 需要用过该模板（`403`），重复评分覆盖。

**埋点**：事件写入 `analytics_events`（`source = server | client`）。服务端记录 `prompt_submit`、`task_succeeded` / `task_failed`、`asset_export`（`channel: download | publish`）、`order_paid`、`template_use`；客户端只能通过 `POST /v1/analytics/events { "events": [...] }`（`202 { accepted }`）上报白名单内的界面行为：`page_view`、`paywall_shown`、`agent_plan_shown`、`agent_plan_confirmed`、`asset_export`（`channel: copy | share`），属性严格校验，每次最多 20 条，每人每分钟 300 条（`429 RATE_LIMITED`）。前端攒批发送，失败直接丢弃。

**数据看板** `GET /v1/admin/analytics?days=7`（1–90）：

| 字段 | 说明 |
|---|---|
| `funnel` | 活跃 → 提交 → 生成成功 → 二次操作（成功后再次提交）→ 导出（下载、复制、分享或发布），去重用户数 |
| `north_star` | 最近 8 周每周被导出的不同作品数（周一起算，北京时间） |
| `events` | 各事件次数（按来源） |
| `templates` | 热门模板的使用次数与人数 |
| `paywall` | 看到付费墙的用户数、其中付费的用户数、订单数与金额 |

### 3.13 个人信息权利：导出与注销

**导出** `GET /v1/me/export`：返回 JSON 附件（`creature-personal-data-YYYY-MM-DD.json`），包含 `account`（含完整手机号）、`credits`（余额与全部流水）、`orders`、`generations`（提示词、参数、状态、积分）、`assets`（未删除的作品，`url` 2 小时内有效）、`posts`、`characters`、`brand_kits`、`projects`、`template_ratings`。每人每天 5 次（`429 RATE_LIMITED`），每次写审计日志。

**注销**：
1. `POST /v1/me/deletion/code` 向账号绑定的手机号发送验证码（与登录验证码共用频率限制）。
2. `DELETE /v1/me { "code": "123456" }` → `200 { status: "deleting", requested_at, delete_after }`。有排队或生成中的任务时 `409 ACCOUNT_BUSY`。成功后所有会话立即吊销，原访问令牌在所有实例上返回 `403 ACCOUNT_DELETING`。
3. 冷静期（15 天）内用该手机号登录即撤销注销，登录响应 `deletion_canceled: true`。
4. 冷静期满后由维护任务匿名化（多实例 `SKIP LOCKED` 认领）：昵称改为"已注销用户"、清除手机号（同一手机号可重新注册为新账号）、套餐重置；作品标记删除并清除标题与正文（文件由存储清理立即删除，不等宽限期；内容编号保留以便追溯）；广场发布撤回、点赞删除并重算计数；角色、品牌套件、项目删除并清空内容，画布文档清空；埋点事件解除关联。生成记录（合规留存）、订单与积分流水保留但不再能关联到个人；肖像授权材料按合规要求保留。已注销或注销中的账号不能在后台修改状态。

### 3.14 画布历史版本与分享链接

**历史版本**（`CanvasSnapshotDTO`：`id, version, node_count, reason, label, created_at`）：
- 自动：保存画布时，若距上一个版本超过 10 分钟，先把被覆盖的内容记为 `auto` 版本（空画布不记），最多保留 50 个；
- 手动：`POST /canvases/{id}/snapshots { "label": "给客户的初稿" }` → `201`，记录当前内容，最多保留 30 个；
- 查看：`GET /canvases/{id}/snapshots/{sid}` 返回与 `GET /canvases/{id}` 相同结构（产物按任务补全）；
- 恢复：`POST /canvases/{id}/snapshots/{sid}/restore { "version": 当前版本号 }` → `200` 恢复后的画布（版本号 + 1）；恢复前的内容自动记为 `restore` 版本，可以再恢复回来；版本号不一致 `409 CANVAS_VERSION_CONFLICT`。

**分享链接**：
- `PUT /canvases/{id}/share { "show_prompts": false }` → `CanvasShareDTO { token, path: "/#s/<token>", show_prompts, view_count, created_at }`。每个画布最多一个有效链接，重复调用返回同一链接并更新 `show_prompts`；`DELETE` 关闭后原链接立即失效，再次分享生成新链接。
- `GET /shared/canvases/{token}`（无需登录，`Cache-Control: no-store`、`X-Robots-Tag: noindex`）→ `SharedCanvasDTO`：画布名、作者昵称、节点（类型、标题、位置、状态、产物）、连线与视口。不含小造对话、模型与参数；提示词只在 `show_prompts` 为 `true` 时返回。产物地址为带 AI 显式标识的交付文件（2 小时有效）。链接已关闭、项目已删除或作者账号不可用（冻结、封禁、注销中）时返回 `404`。每次访问计入 `view_count`。
- 注销账号匿名化时删除全部历史版本并关闭分享。

## 4. 开放 API（P2）

- 与内部接口共用 `/generations`、`/models`、`/assets`、`/templates/{id}/use`，使用 API Key 鉴权。
- 支持 `callback_url`：任务结束后以 HMAC-SHA256 签名回调（头 `X-Creature-Signature`）。
- 按企业账户积分扣费，独立限流配额。
- 同时提供 MCP Server，将生成、模板、资产检索能力以工具形式开放给外部 Agent。
