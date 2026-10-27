# 01 · 竞品调研报告

> 项目：造物 Creature（AI 全模态创作平台）
> 调研时间：2026 年 10 月
> 文档状态：v1.0

## 1. 调研范围与方法

**调研对象**：国内外面向创作者的 AI 生成与创作平台，覆盖图像、视频、设计 Agent、写作、音乐五个方向，共 15 款产品。

**方法**：公开资料检索（官网、帮助中心、媒体报道、第三方评测、行业榜单），按"定位—功能—模型—计费—亮点—短板"六个维度拆解，再做横向矩阵对比。

**数据口径说明**：
- 用户规模口径差异很大（月活、注册用户、累计创作者、网站月访问量各不相同），本报告只用于判断量级，不做精确排名。
- 价格、积分规则、模型版本变化非常快，多家厂商的第三方报价彼此矛盾。表中价格只作参考，**正式定价前需到各家官网核实**。
- 部分资料来自厂商自家博客或竞品博客，已在正文中标注可信度。

## 2. 市场概览与七个关键趋势

### 趋势 1：底层模型同质化，"多模型聚合"成为标配

主流平台已普遍接入同一批模型：Seedance、Kling、Veo、Wan、Hailuo、Flux、GPT Image、Nano Banana 等。Higgsfield、Krea、OpenArt、Adobe Firefly（Partner Models）、LiblibAI 都在做多模型聚合。有评测直接指出：**只看模型列表来选平台已经没有意义**，差异转向工作流、一致性、编辑能力和价格。

**启示**：不自研基础大模型，做"模型网关 + 智能路由"，把精力放在工作流和体验上。

### 趋势 2：从"单次生成"走向"无限画布 + Agent"

- Lovart 以 ChatCanvas 对话式画布为核心，2.0 版本加入能记住偏好、接手周期性任务的个人设计 Agent。
- LiblibAI 于 2026 年 3 月推出 LibTV，把剧本、分镜、镜头控制、剪辑放在无限画布上，用节点式工作流串联，并把能力封装成 Skill 供外部 Agent 调用。
- 即梦提供智能画布（局部重绘、扩图、消除、抠图）。
- 行业共识："生成容易，修改难"。精细编辑（改图中文字、点选局部修改、拆图层）成为画布类产品的关键能力。

**启示**：画布是承载复杂创作的主界面；Agent 负责"规划 + 调度"，用户负责"决策 + 微调"。

### 趋势 3：一致性是商业化创作的门槛

- Higgsfield 的 Soul ID：用参考图定义可复用角色；Multi Reference 可同时锚定多个视觉参考。
- Vidu 主打多主体一致性，支持 3–7 张参考图。
- Kling 3.0 支持主体一致性、多镜头生成。
- Lovart Brand Kit：一次上传品牌字体、颜色、Logo，之后所有生成自动遵循。

**启示**：角色库 + 品牌套件是 P0 级资产能力，直接决定能否服务品牌方和短剧团队。

### 趋势 4：视频进入长时长、音画同步、多镜头阶段

- Kling 3.0（2026-02-05 发布）：最长 15 秒、原生多语种音频、多镜头、最高 4K；6 月推出更快更便宜的 3.0 Turbo。
- Higgsfield Cinema Studio 4.0（2026 年 8–9 月）：原生 4K、单次最长约 1 分钟。
- 即梦相继上线 Seedance 2.0（2026-02）与 Seedance 2.5（2026-07-31）。
- Runway 以 Gen-4.5 为默认模型，另有 Aleph 视频编辑模型。

### 趋势 5：AI 漫剧 / 短剧是增长最快的垂直场景

- DataEye 预测：2026 年国内 AI 剧漫剧市场规模约 400 亿元，同比增长 138%（另有机构预测约 240 亿元，口径不同）。
- 2026 年一季度上线微短剧约 12.8 万部，其中 AI 微短剧约 12.2 万部，占比超 95%。
- 制作报价从每分钟 5000 元跌至数百元，竞争重心转向内容质量。
- 字节小云雀支持 10 万字剧本上传，自动拆解人物关系、分镜与场景。

**启示**："剧本 → 分镜 → 角色 → 镜头 → 配音 → 剪辑"的一体化工作流有明确付费需求，适合作为第二阶段的垂直突破口。

### 趋势 6：积分制订阅是主流计费方式

几乎所有平台都采用"订阅档位 + 月度积分 + 加购积分包"，视频按秒计费，不同模型、分辨率、是否带音频消耗不同积分。常见痛点：积分不结转（Adobe、Runway 标准档）、消耗不透明、"无限"套餐条款复杂。

**启示**：生成前展示精确消耗、失败全额返还、支持积分有效期内结转，可以作为体验差异点。

### 趋势 7：国内合规持续收紧

- 《人工智能生成合成内容标识办法》及配套强制性国标自 2025 年 9 月 1 日起施行，要求显式标识 + 隐式标识（元数据）。
- 2026 年 4 月 28 日，国家网信办就 AI 内容标识落实不到位问题正式警告即梦 AI。
- 截至 2026 年 8 月 31 日，累计 1112 款生成式 AI 服务完成备案，731 款调用已备案模型的应用或功能完成登记。

**启示**：标识、内容审核、备案公示必须作为架构内建能力，不能上线后补。详见 [08-合规与内容安全](./08-compliance.md)。

## 3. 竞品分类

| 类别 | 代表产品 | 我们的关系 |
|---|---|---|
| 国内综合创作平台 | 即梦 AI、可灵 AI、LiblibAI / LibTV | **直接竞品**，争夺同一批国内创作者 |
| 设计 Agent | Lovart | **体验标杆**，学习 Agent + 画布交互 |
| 海外多模型聚合 | Higgsfield、Krea、OpenArt、Freepik | **模式参考**，学习聚合、路由与定价 |
| 海外专业工具 | Runway、Midjourney、Adobe Firefly、Canva AI | **能力参考**，学习编辑能力与专业工作流 |
| 垂类工具 | Suno（音乐）、豆包 / 笔灵（写作）、小云雀（漫剧） | **补位参考**，作为平台内子能力 |

## 4. 重点竞品拆解

### 4.1 即梦 AI（字节跳动 · 剪映团队）

| 维度 | 内容 |
|---|---|
| 定位 | 一站式 AI 图像 / 视频创作平台，与剪映、抖音生态打通 |
| 核心功能 | 文生图、图生图、智能画布（局部重绘 / 扩图 / 消除 / 抠图）、文生视频、图生视频、数字人与对口型 |
| 模型 | 自家 Seedream（图像）、Seedance 2.0 / 2.5（视频） |
| 计费 | 会员 + 积分；高级会员年卡标价 5199 元，618 新用户首年 2789 元（促销价）；免费用户每日刷新积分 |
| 规模 | 第三方称 2026 年 5 月月活约 3065 万（来源带推广性质）；AICPB 2026 年 6 月网站月访问 1083 万 |
| 亮点 | 模型自研、迭代快；剪映 / 抖音分发闭环；数字人能力成熟 |
| 短板 | 2026-04 因标识问题被网信办警告；高级会员价格高；对多模型、品牌一致性支持弱 |
| 可借鉴 | 智能画布的编辑工具集；数字人"一张图 + 一段音频"的极简流程 |

### 4.2 可灵 AI（快手）

| 维度 | 内容 |
|---|---|
| 定位 | 以视频生成为核心的 AI 创作平台，强调"人人都是导演" |
| 核心功能 | 文 / 图生视频、多镜头、主体一致性、动作参考、原生音频、图像生成 |
| 模型 | Kling 3.0 / 3.0 Omni（2026-02，文本 / 图像 / 音频 / 视频全模态输入）；3.0 Turbo（2026-06） |
| 计费 | 灵感值（积分）；每日登录送 66 灵感值；2024 年国内月卡 66 / 266 / 666 元三档（2026 年官方价未核实） |
| 规模 | 截至 2025 年 12 月，创作者超 6000 万，累计生成视频超 6 亿个；2026 年 Q2 收入超 8.5 亿元 |
| 亮点 | 视频质量与运动一致性一线；已验证规模化付费；API 被大量第三方平台集成 |
| 短板 | 新模型先给最高档会员，入门用户体验受限；编辑与后期能力较弱 |
| 可借鉴 | 每日签到送积分的留存机制；多镜头叙事能力 |

### 4.3 LiblibAI / LibTV（演语科技）

| 维度 | 内容 |
|---|---|
| 定位 | 国内最大的 AI 模型社区 + 一站式多模态创作平台；LibTV 面向专业视频创作者与 AI Agent |
| 核心功能 | 海量 LoRA / Checkpoint 模型库、在线 WebUI / ComfyUI 工作流、模型训练；LibTV 无限画布、节点式工作流、可保存为模板、Skill 接口 |
| 模型 | 社区模型 + 合作方模型（豆包、海螺、可灵、Kimi、PixVerse、生数、智谱等） |
| 计费 | 会员 + 算力积分（LibTV 定价未公开核实） |
| 规模 | 早期报道月活 400 万、总用户 2500 万；B+ 轮融资近 3 亿美元，投后估值超 20 亿美元；LibTV 首月出现单日收入超百万美元（公司口径） |
| 亮点 | 社区与创作者生态；模型训练与分享；工作流模板化；对 Agent 开放 |
| 短板 | 专业门槛偏高，新手学习成本大；网站流量有下滑迹象 |
| 可借鉴 | 模板 / 模型市场与创作者分成；把能力封装成 Skill 对外开放 |

### 4.4 Lovart（设计 Agent）

| 维度 | 内容 |
|---|---|
| 定位 | 端到端设计 Agent，自称服务 1000 万+ 创作者 |
| 核心功能 | ChatCanvas 对话式画布；MCoT 推理引擎同时探索多个方案；Touch Edit 单元素编辑；Brand Kit；2.0 加入个人设计 Agent Arti |
| 模型 | 调度 Seedance 2.0、Nano Banana Pro、Veo 3.1、Sora 2、Hailuo 2.3 等，输出图像 / 视频 / 3D |
| 计费 | 多个来源互相矛盾：发布稿为 Free 500 积分 / Starter $19 / Plus $32 / Pro $90（月付）；官方博客另有一套档位 |
| 亮点 | 自然语言驱动整套设计；多方案并行；精细化元素编辑；品牌一致性 |
| 短板 | 价格体系混乱；面向海外，中文与国内支付支持一般 |
| 可借鉴 | **Agent + 画布的交互范式是本项目的首要参考** |

### 4.5 Higgsfield（海外聚合 · 视频向）

- **定位**：面向内容创作者和营销团队的全能型图像 / 视频订阅平台。
- **功能**：Soul ID 角色一致性、Multi Reference、Cinema Studio（电影级镜头控制，4.0 支持原生 4K 与约 1 分钟生成、AI 选角、可复用场景、团队协作）、Marketing Studio、Genjutsu 动作迁移。
- **模型**：Seedance 2.0、Kling 3.0、Wan 2.6、Veo 3、Sora 2、Hailuo 02、Flux Kontext、GPT Image、Seedream 5.0 等 35+ 模型与工具。
- **计费**：$19–$129/月（自家博客口径）。
- **可借鉴**：以"场景化 Studio"包装模型能力，用户不必理解模型差异。

### 4.6 Krea

- **定位**：实时画布 + 多模型的创意工具。
- **功能**：实时生成画布、Krea Nodes（把模型和步骤串成可复用流水线）、最高 22K 超分、自定义风格模型训练。
- **计费**：Basic $9/月（5000 积分）、Pro $35/月（20000 积分）；免费版不含商用授权。
- **可借鉴**：节点工作流 + 超分 / 增强等"后处理"工具链。

### 4.7 OpenArt

- **定位**：图像 / 视频 / 角色一体化平台。
- **功能**：Director、Smart Shot（基于提示词、模板、分镜的多步工作流，而非节点图）、角色一致性。
- **计费**：入门档约 $14/月（4000 积分），年付最多优惠 27%。
- **可借鉴**：对新手更友好的"模板化多步工作流"，与节点式工作流形成高低搭配。

### 4.8 Runway

- **定位**：专业视频生成与编辑。
- **功能**：Gen-4.5 视频生成、Aleph 2.0 视频编辑、图像与音频生成；同时提供 Veo 等第三方模型。
- **计费**：免费 125 积分（一次性）；Standard $15/月 625 积分；Pro 2250 积分；Max 积分可结转一次。Gen-4.5 每秒 12 积分，Aleph 2.0 每秒 28 积分，Veo 3.1 带音频每秒 40 积分。
- **可借鉴**：按秒计价、按模型差异化定价的透明价目表；团队共享积分池。

### 4.9 Midjourney

- **定位**：图像质量标杆。
- **功能**：V8.1（2026-04-30）；仅支持图生视频，5 秒起、最长可延展至 21 秒。
- **短板**：无多模型、视频能力弱。
- **可借鉴**：审美与风格参数体系（风格参考、个性化）。

### 4.10 Adobe Firefly

- **定位**：面向专业设计师的商业安全生成，与 Creative Cloud 打通。
- **功能**：Firefly 自有模型 + Partner Models（Gemini、GPT Image、FLUX、Ideogram、Runway、Luma、Topaz、ElevenLabs、Kling 等），Firefly Boards 灵感板。
- **计费**：生成积分，合作方模型按次 / 按秒单独计价（如 Gemini 图像 1K 20 积分、2K 40 积分）；付费档标准图像生成不限量；积分不结转。
- **注意**：商业安全承诺不覆盖合作方模型。
- **可借鉴**：自有模型与第三方模型分层计价；版权安全作为卖点。

### 4.11 Canva AI

- **定位**：大众设计平台的 AI 化。
- **功能**：15+ AI 工具，覆盖图像生成、修图、文案、演示文稿、视频；Dream Lab 由 Leonardo 提供，视频生成由 Veo 3 提供；有报道称 2026-09 起品牌改为 Canva AI 2.0。
- **计费**：AI 能力随 Canva Pro / Teams 订阅提供，不单独收费。
- **可借鉴**：模板生态 + 团队协作 + 品牌套件，降低大众用户门槛。

### 4.12 垂类参考

| 产品 | 方向 | 要点 |
|---|---|---|
| Suno | 音乐 | v5.5（2026-03）加入 Voices 声音克隆、Custom Models、My Taste；据报道 2026-09 发布 v6；免费版每日 50 积分且不可商用 |
| 豆包 / 笔灵 | 写作 | 豆包免费、中文语感好但长文结构弱；笔灵偏网文和公文模板；写作工具同质化严重，差异在模板是否贴合场景 |
| 小云雀 | AI 漫剧 | 10 万字长剧本上传，自动拆解人物、分镜、场景，可同步到抖音、红果短剧 |
| Vidu（生数） | 视频 | 3–7 张参考图的多主体一致性，擅长动漫风格 |
| 海螺 AI（MiniMax）/ 通义万相 | 视频 | 作为模型供给方被广泛集成；API 单价约 $0.07–0.1/秒（第三方报价） |

## 5. 功能对比矩阵

图例：● 完整支持　◐ 部分支持　○ 不支持 / 未见公开信息　— 不适用（未在国内提供服务）

> 矩阵根据 2026 年 10 月可查到的公开资料与评测整理，部分单元格是基于产品演示的判断，立项评审前建议逐项实测确认。

| 能力 | 即梦 | 可灵 | Liblib/LibTV | Lovart | Higgsfield | Krea | Runway | Firefly | Canva | **造物（规划）** |
|---|---|---|---|---|---|---|---|---|---|---|
| 文生图 / 图生图 | ● | ● | ● | ● | ● | ● | ● | ● | ● | ● |
| 文 / 图生视频 | ● | ● | ● | ● | ● | ● | ● | ● | ◐ | ● |
| 原生音频视频 | ● | ● | ◐ | ◐ | ● | ◐ | ● | ◐ | ○ | ● |
| AI 写作 / 剧本 | ○ | ○ | ◐ | ◐ | ○ | ○ | ○ | ○ | ● | ● |
| 配音 / 音乐 | ◐ | ◐ | ◐ | ○ | ◐ | ○ | ● | ● | ◐ | ● |
| 多模型聚合 | ○ | ○ | ● | ● | ● | ● | ◐ | ● | ◐ | ● |
| 智能路由（按质量 / 成本自动选模型） | ○ | ○ | ○ | ◐ | ○ | ○ | ○ | ○ | ○ | ● |
| 无限画布 | ◐ | ○ | ● | ● | ○ | ● | ◐ | ● | ● | ● |
| 节点式工作流 | ○ | ○ | ● | ○ | ○ | ● | ◐ | ○ | ○ | ● |
| 创作 Agent | ◐ | ○ | ● | ● | ○ | ○ | ○ | ○ | ◐ | ● |
| 角色一致性库 | ◐ | ● | ● | ◐ | ● | ◐ | ◐ | ○ | ○ | ● |
| 品牌套件 | ○ | ○ | ○ | ● | ○ | ◐ | ○ | ◐ | ● | ● |
| 局部编辑 / 图层拆分 | ● | ◐ | ● | ● | ◐ | ● | ● | ● | ● | ● |
| 模板 / 工作流市场 | ◐ | ◐ | ● | ○ | ◐ | ◐ | ○ | ○ | ● | ● |
| 社区与灵感广场 | ● | ● | ● | ◐ | ◐ | ◐ | ○ | ◐ | ◐ | ● |
| 团队协作 | ○ | ○ | ◐ | ◐ | ● | ● | ● | ● | ● | ● |
| 开放 API / Skill | ◐ | ● | ● | ◐ | ◐ | ◐ | ● | ● | ◐ | ● |
| 国内合规（标识 / 备案公示） | ◐ | ● | ● | — | — | — | — | — | — | ● |

## 6. 定价对比（参考价，需核实）

| 产品 | 免费额度 | 入门档 | 中档 | 高档 | 视频计价示例 |
|---|---|---|---|---|---|
| 即梦 AI | 每日刷新积分 | — | — | 高级年卡 5199 元（促销首年 2789 元） | 按模型 / 时长动态消耗 |
| 可灵 AI | 每日 66 灵感值 | 66 元/月（2024） | 266 元/月 | 666 元/月 | 按秒 + 分辨率 |
| Runway | 一次性 125 积分 | $15/月 · 625 | Pro · 2250 | Max（积分可结转一次） | Gen-4.5：12 积分/秒 |
| Krea | 有，不可商用 | $9/月 · 5000 | $35/月 · 20000 | Business / Max | 视频模型高档位开放 |
| OpenArt | 有 | ~$14/月 · 4000 | Plus / Pro | Wonder | — |
| Lovart | 500 积分（新用户） | $19/月 · 2000 | $32/月 · 3500 | $90/月 · 11000 | — |
| Higgsfield | — | $19/月 | — | $129/月 | — |
| Adobe Firefly | 有 | $9.99 · 2000 | $19.99 | $49.99 · 10000 / $199.99 · 50000 | 合作方视频按秒计 |
| Suno | 每日 50 积分（不可商用） | ~$8–10/月 | — | ~$30/月 | — |

**结论**：国际入门档集中在 $9–19/月，国内入门档集中在 39–69 元/月。积分单价差异大，用户难以横向比较，"生成前明确告知消耗"本身就是卖点。

## 7. 目标用户痛点（综合评测与社区反馈）

| # | 痛点 | 典型表现 | 竞品现状 |
|---|---|---|---|
| P1 | 多工具来回切换 | 写剧本用 A、出图用 B、做视频用 C、配音用 D，素材靠手动搬运 | 少数平台覆盖全链路 |
| P2 | 生成容易，修改难 | 一处不满意只能整体重抽，抽卡成本高 | Lovart、即梦在补局部编辑 |
| P3 | 一致性差 | 同一角色、同一产品在多张图 / 多个镜头中走形 | 视频平台在补，品牌维度少 |
| P4 | 不知道该用哪个模型 | 模型名称多、更新快，新手难以判断 | 聚合平台把选择权完全交给用户 |
| P5 | 成本不可预期 | 积分消耗不透明、失败也扣费、积分过期 | 普遍存在 |
| P6 | 商用与合规顾虑 | 是否可商用、标识怎么加、肖像与声音授权 | 海外产品基本不覆盖国内合规 |
| P7 | 团队协作弱 | 素材散落在个人账号，无法共享品牌资产和积分 | 海外较好，国内较弱 |

## 8. 机会点与差异化定位

### 8.1 定位

**造物 Creature：面向中文创作者与中小品牌团队的"Agent 驱动"全模态创作平台。**

一句话：*说出想法，造物帮你规划、生成、修改、交付整套内容。*

### 8.2 差异化策略

| 策略 | 对应痛点 | 做法 |
|---|---|---|
| **一张画布完成全链路** | P1 | 文案、图像、视频、配音、音乐都是画布上的节点，上游输出自动作为下游输入 |
| **创作 Agent「小造」** | P1 P4 | 自然语言描述目标 → Agent 生成执行计划（含积分预估）→ 用户确认后批量执行 → 逐节点可改 |
| **智能模型路由** | P4 P5 | 默认"自动"模式按质量 / 速度 / 成本推荐模型；专业用户可手动指定 |
| **资产一致性中心** | P3 | 角色库、产品库、品牌套件，任何生成节点都可一键引用 |
| **局部编辑优先** | P2 | 圈选重绘、文字直改、图层拆分、视频片段重生成 |
| **透明计费** | P5 | 生成前精确展示消耗；失败、审核拦截全额返还；订阅积分可结转一个周期 |
| **合规内建** | P6 | 显式 + 隐式标识自动添加；备案信息公示；商用授权随套餐清晰说明 |
| **团队空间** | P7 | 共享资产、共享积分池、角色权限、评论审阅 |
| **模板市场与分成** | 生态 | 创作者可发布工作流模板，被使用时获得积分分成 |

### 8.3 不做什么（第一阶段）

- 不自研基础生成大模型（成本高、周期长，且同质化）。
- 不做本地客户端 WebUI / 模型训练平台（LiblibAI 的主场，门槛高）。
- 不做通用聊天助手（写作能力只服务于创作链路）。

## 9. 资料来源

- [36氪：2026 高性价比 AI 创作推荐，即梦好用吗](https://36kr.com/p/3858084184864387)
- [CSDN：2026 年 AI 视频生成三强平台实测](https://blog.csdn.net/dayuOK6307/article/details/162426289)
- [品玩：LiblibAI 400 万月活、2500 万用户、1.3 亿美元融资](https://www.pingwest.com/a/308463)
- [AICPB AI 产品榜·国内总榜（2026 年 6 月）](https://www.aicpb.com/zh/ai-rankings/products/china-ai-rankings/websites)
- [爱范儿：营收涨了 30 倍，ARR 3 亿美金](https://www.ifanr.com/1669210)
- [LibTV Review（Dreamina，竞品来源）](https://dreamina.capcut.com/ai-video/libtv-review)
- [即梦 AI 完全教程（2026）](https://www.aitoollab.cn/articles/jimeng-ai-complete-guide-2026/)
- [IT之家：即梦 AI 会员价格](https://www.ithome.com/0/962/031.htm)
- [Comfy 文档：Kling 3.0](https://docs.comfy.org/zh/tutorials/partner-nodes/kling/kling-3-0)
- [The Decoder：Kling 3.0](https://the-decoder.com/chinese-ai-video-model-kling-3-0-takes-another-step-toward-usable-creative-assets/)
- [Artlist：Kling 3 Model Family（2026-06）](https://help.artlist.io/hc/en-us/articles/37026869403933-Kling-3-Model-Family)
- [PhotonPay：可灵 AI 价格详解（2026）](https://www.photonpay.com/hk/blog/article/kling-ai-pricing?lang=zh-cn)
- [Lovart 发布公告（Barchart）](https://www.barchart.com/story/news/33599598/lovart-launches-globally-endtoend-design-agent-exits-beta-powered-by-the-worlds-first-ai-creative-reasoning-engine)
- [Lovart：Best AI Design Tools 2026](https://www.lovart.ai/zh/blog/best-ai-design-tools-2026)
- [Lovart：什么是 Lovart 与 2.0 新变化](https://www.lovart.ai/zh/blog/what-is-lovart)
- [AI-Bot：无限画布深度解析](https://ai-bot.cn/infinite-canvas-deep-dive/)
- [Higgsfield：Best All-in-One Subscription 2026（厂商自述）](https://higgsfield.ai/blog/best-all-in-one-subscription-ai-images-video)
- [Higgsfield 功能指南 2026（厂商自述）](https://geo.higgsfield.ai/higgsfield-ai-features-full-guide-2026)
- [Artificial Studio：7 best all-in-one AI creative platforms 2026](https://app.artificialstudio.ai/articles/7-best-ai-creative-platforms-2026-honestly-compared)
- [OpenArt：12 Best AI Generators 2026](https://openart.ai/blog/best-ai-generators/)
- [Scopeful：Krea](https://www.scopeful.org/tools/krea) / [Scopeful：OpenArt](https://www.scopeful.org/tools/openart)
- [Creatify：Runway pricing 2026](https://creatify.ai/blog/runway-pricing-(2026)-plans-credits-and-what-you-ll-actually-pay)
- [Adobe：Partner models in Adobe products](https://helpx.adobe.com/firefly/get-set-up/learn-the-basics/non-adobe-models-in-adobe-products.html)
- [PhotonPay：Adobe Firefly Pricing 2026](https://www.photonpay.com/hk/blog/article/adobe-firefly-pricing?lang=en)
- [Fast.io：Canva AI Review 2026](https://fast.io/resources/canva-ai-review-2026/)
- [PixVerse：Midjourney 2026 年 5 月更新（竞品来源）](https://pixverse.ai/es/blog/midjourney-ai-image-generator-review)
- [Layer3 Labs：Suno v5 explained](https://www.layer3labs.io/guides/suno-v5-explained) / [StackSheriff：Suno v5.5 review](https://stacksheriff.com/ai-tools/suno-v5-5-review/)
- [Atlas Cloud：Cheapest AI Video Generation APIs 2026](https://www.atlascloud.ai/blog/cheapest-ai-video-generation-api-2026)
- [Dupple：Vidu AI review（2026-07）](https://dupple.com/reviews/vidu-ai)
- [36氪：AI 剧漫剧市场](https://eu.36kr.com/zh/p/4033847265548165) / [澎湃新闻：AI 漫剧](https://www.thepaper.cn/newsDetail_forward_33323655)
- [B 站专栏：2026 年十大 AI 短剧 / 漫剧创作平台](https://www.bilibili.com/read/cv50570311)
- [国家网信办：人工智能生成合成内容标识办法](https://www.cac.gov.cn/2025-03/14/c_1743654685899683.htm)
- [普华永道：标识办法解读](https://www.pwccn.com/zh/tmt/method-identifying-synthetic-content-generated-ai-sep2025.pdf)
- [君合法评：生成式 AI 备案与登记实务](https://junhe.com/law-reviews/2974)
- [同花顺：生成式 AI 服务备案统计](https://news.10jqka.com.cn/20260629/c677812837.shtml)
