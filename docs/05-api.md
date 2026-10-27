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
| 403 | `PHONE_BINDING_REQUIRED` | 未绑定手机号，不能使用生成功能 |
| 402 | `INSUFFICIENT_CREDITS` | 积分不足 |
| 403 | `PLAN_FEATURE_REQUIRED` | 当前套餐不支持该功能（如 4K），`details.required_plan` |
| 404 | `NOT_FOUND` | 资源不存在 |
| 409 | `IDEMPOTENCY_CONFLICT` | 相同幂等键但请求体不同 |
| 422 | `CONTENT_REJECTED` | 提示词或素材未通过审核，`details.reason_code` |
| 429 | `RATE_LIMITED` | 请求过于频繁 |
| 503 | `MODEL_UNAVAILABLE` | 所选模型及备选模型均不可用 |

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
| DELETE | `/me` | 申请注销账号 |

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
| POST | `/generations/{id}/cancel` | 取消排队中的任务 |
| POST | `/generations/{id}/retry` | 失败任务重试（新任务） |
| GET | `/generations/{id}/events` | SSE 推送任务进度（WebSocket 不可用时的降级） |
| POST | `/prompts/enhance` | 提示词 AI 润色 |

### 2.4 写作（流式）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/writing/completions` | 流式生成文本（SSE），按输出字数计费 |
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
| PATCH | `/canvases/{id}/share` | 分享设置 |
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
| GET | `/templates?category=&kind=&sort=` | 模板列表 |
| GET | `/templates/{id}` | 模板详情 |
| POST | `/templates/{id}/use` | 使用模板：单步模板直接创建任务；工作流模板创建画布 |
| POST | `/templates` | 发布模板（进入审核） |

### 2.10 社区

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/feed?tab=recommend\|latest\|following&type=` | 灵感广场 |
| POST | `/posts` | 发布作品到广场 |
| GET | `/posts/{id}` | 作品详情 |
| POST | `/posts/{id}/reactions` | 点赞 / 收藏 |
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

请求体：

```json
{
  "modality": "image",
  "operation": "generate",
  "prompt": "秋日午后的咖啡馆窗边，一杯枫糖拿铁，暖色逆光，胶片质感",
  "negative_prompt": "文字水印, 模糊",
  "references": [
    { "asset_id": "ast_01JBX0R8...", "role": "style", "weight": 0.6 }
  ],
  "params": {
    "aspect_ratio": "3:4",
    "resolution": "2k",
    "count": 4,
    "seed": null
  },
  "routing": { "strategy": "auto", "pinned_model": null },
  "context": {
    "project_id": "prj_01JBWZ...",
    "canvas_id": null,
    "brand_kit_id": "brd_01JBWQ...",
    "character_ids": []
  }
}
```

响应 `202 Accepted`：

```json
{
  "id": "tsk_01JBX3K9Q2M7",
  "status": "queued",
  "model": { "code": "seedream-4", "display_name": "Seedream 4.0", "tier": "advanced" },
  "routing_reason": "提示词包含写实光影与产品主体，推荐高级图像模型",
  "estimated_credits": 24,
  "queue": { "name": "p1", "position": 3, "eta_seconds": 18 },
  "created_at": "2026-10-26T08:00:00Z"
}
```

### 3.2 查询任务

`GET /v1/generations/tsk_01JBX3K9Q2M7`

```json
{
  "id": "tsk_01JBX3K9Q2M7",
  "status": "succeeded",
  "progress": 100,
  "model": { "code": "seedream-4", "display_name": "Seedream 4.0" },
  "estimated_credits": 24,
  "actual_credits": 24,
  "outputs": [
    {
      "asset_id": "ast_01JBX3MZ01",
      "kind": "image",
      "url": "https://cdn.creature.example/a/ast_01JBX3MZ01.webp?sig=...&exp=...",
      "thumb_url": "https://cdn.creature.example/t/ast_01JBX3MZ01.webp?sig=...",
      "width": 1536,
      "height": 2048,
      "aigc_label": { "explicit": true, "implicit": true, "content_id": "CRT-20261026-8F3K2" }
    }
  ],
  "timings": { "queued_ms": 4100, "running_ms": 11800, "post_ms": 900 },
  "created_at": "2026-10-26T08:00:00Z",
  "finished_at": "2026-10-26T08:00:17Z"
}
```

### 3.3 任务进度推送

WebSocket：`wss://api.creature.example/v1/ws?token=...`，连接后订阅：

```json
{ "op": "subscribe", "channel": "tasks" }
```

服务端事件：

```json
{ "type": "task.progress",  "task_id": "tsk_01JBX3K9Q2M7", "status": "running", "progress": 45, "stage": "generating" }
{ "type": "task.succeeded", "task_id": "tsk_01JBX3K9Q2M7", "outputs": [ { "asset_id": "ast_01JBX3MZ01", "thumb_url": "..." } ] }
{ "type": "task.failed",    "task_id": "tsk_01JBX3K9Q2M7", "error_code": "VENDOR_TIMEOUT", "refunded_credits": 24 }
{ "type": "credits.changed", "available": 1776, "frozen": 0 }
```

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

## 4. 开放 API（P2）

- 与内部接口共用 `/generations`、`/models`、`/assets`、`/templates/{id}/use`，使用 API Key 鉴权。
- 支持 `callback_url`：任务结束后以 HMAC-SHA256 签名回调（头 `X-Creature-Signature`）。
- 按企业账户积分扣费，独立限流配额。
- 同时提供 MCP Server，将生成、模板、资产检索能力以工具形式开放给外部 Agent。
