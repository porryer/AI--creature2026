# 造物 Creature

面向中文创作者与中小品牌团队的 **Agent 驱动 AI 全模态创作平台**：在一张无限画布上，用一句话完成文案、图像、视频、配音的整套内容生产。

## 仓库结构

| 目录 | 内容 |
|---|---|
| [`apps/web/`](./apps/web/) | 用户端（React 19 + TypeScript + Vite）。支持**离线演示模式**与**接入后端模式** |
| [`apps/server/`](./apps/server/) | 后端（NestJS 11 模块化单体）：登录、积分账务、模型网关、生成任务与 Worker、审核与 AI 标识、订单 |
| [`packages/shared/`](./packages/shared/) | 前后端共享：模型目录、积分计价、智能路由、套餐、API 类型 |
| [`docs/`](./docs/) | 竞品调研、PRD、技术架构、数据库、API、UI 规范、开发计划、合规方案 |

## 快速开始

需要 Node.js 22 及以上。开发环境无需安装数据库：后端默认使用内嵌的 PGlite（编译为 WebAssembly 的 PostgreSQL）。

```bash
npm install
npm run dev        # 后端 http://localhost:3000/v1 + 前端 http://localhost:5173
```

打开 <http://localhost:5173>，输入任意手机号获取验证码（开发环境不发短信，验证码会自动填入）即可登录。新用户获赠 100 积分，每日登录再送 20 积分。

只看界面、不启动后端：

```bash
npm run dev -w @creature/web          # 离线演示模式，数据全部在本地模拟
npm run build:demo -w @creature/web   # 输出单文件演示版 apps/web/dist-single/index.html
```

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run dev` | 同时启动后端与前端（前端经 Vite 代理访问 `/v1`） |
| `npm run typecheck` | 全部包类型检查 |
| `npm test` | 共享包与后端测试（后端默认跑在内存 PGlite 上） |
| `TEST_DATABASE_URL=postgres://… npm test -w @creature/server` | 后端测试跑在真实 PostgreSQL 上（每个测试应用使用独立 schema） |
| `npm run build` | 构建共享包、后端与前端 |

后端配置见 [`apps/server/.env.example`](./apps/server/.env.example)。生产环境必须提供 `DATABASE_URL` 与各项密钥，并接入真实的短信、支付与模型供应商（未接入时服务会拒绝启动，而不是静默降级）。

## 当前进度（Sprint 1–2）

**已完成并有测试覆盖**
- 手机号验证码登录（限流、错误次数上限）、JWT 访问令牌 + httpOnly Cookie 刷新令牌（轮换与重用检测）、每日赠送
- 积分账务：按批次发放、先过期先扣、冻结 → 结算 / 返还、只追加流水、幂等、四方对账；并发提交不超额
- 模型网关：统一请求、智能路由、可重试错误自动切换备选模型、按成功率熔断
- 生成任务：幂等提交、优先级队列、`FOR UPDATE SKIP LOCKED` 认领、卡死任务回收、失败 / 拦截 / 取消全额返还
- 内容安全：提示词与生成结果两道审核（规则实现，预留第三方接口）、显式 + 隐式 AI 标识（SVG / WAV / 文本）
- 文件：签名地址访问、沙箱 CSP；订单与模拟支付、订阅月度发放与到期降级；服务端推送（SSE）
- 素材上传：签名地址直传、文件头识别格式、大小上限、上传审核；上传素材不加 AI 标识
- 参考图：图生图（风格 / 主体 / 角色）、图生视频与首尾帧；校验失败不冻结积分
- 项目与画布：画布自动保存、刷新恢复、版本冲突处理；节点产物读取时按任务补全
- 前端：登录、四个创作工作台、画布与小造 Agent、项目、资产、会员积分全部接入真实接口

**尚未接入（需要外部账号或商务合同）**
- 真实模型供应商适配器（火山方舟、可灵、百炼等）：当前由 Mock 供应商按提示词生成真实的 SVG / WAV / 文本文件
- 短信服务商、微信 / 支付宝支付、对象存储（OSS）、第三方内容审核（含上传图像审核）

详见 [开发计划](./docs/07-roadmap.md) 与 [技术架构 · 当前实现](./docs/03-architecture.md#10-当前实现)。

## 文档

1. [竞品调研报告](./docs/01-competitive-analysis.md)
2. [产品需求文档](./docs/02-prd.md)
3. [技术架构设计](./docs/03-architecture.md)
4. [数据库设计](./docs/04-database.md)
5. [API 接口设计](./docs/05-api.md)
6. [UI 交互设计规范](./docs/06-ui-design.md)
7. [开发计划与里程碑](./docs/07-roadmap.md)
8. [合规与内容安全](./docs/08-compliance.md)
