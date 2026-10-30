// 前后端共享的领域类型与 API 数据结构（与 docs/05-api.md 对应）

import type { TaskContextDTO } from './library';

export type Modality = 'image' | 'video' | 'text' | 'audio';
export type Tier = 'standard' | 'advanced' | 'flagship';
export type RoutingStrategy = 'auto' | 'cheap' | 'best';

export interface ModelInfo {
  code: string;
  name: string;
  vendor: string;
  /** 供应商适配器标识，模型网关据此选择适配器 */
  provider: string;
  modality: Modality;
  tier: Tier;
  quality: number; // 1–5
  speed: number; // 1–5
  /** 单价（积分）：图像 = 每张 · 1K；视频 = 每秒 · 720p；文本 = 每 2000 字；音频 = 每 300 字或每首 */
  price: number;
  unit: string;
  tags: string[];
  desc: string;
  maxDuration?: number;
  nativeAudio?: boolean;
  /** 只用于图像编辑，不参与生成路由，也不出现在模型选择里 */
  editOnly?: boolean;
}

/** 图像编辑工具：局部重绘、扩图、消除、抠图、超分 */
export type EditTool = 'inpaint' | 'outpaint' | 'erase' | 'cutout' | 'upscale';

/** 生成参数。不同模态只使用其中一部分字段 */
export interface GenerationParams {
  ratio?: string;
  resolution?: '1k' | '2k' | '4k' | '720p' | '1080p';
  count?: number;
  duration?: number;
  audio?: boolean;
  camera?: string;
  chars?: number;
  voice?: string;
  seconds?: number;
  /** 写作模板：xhs / script / ad / article / storyboard */
  template?: string;
  tone?: string;
  /** 文本编辑操作：改写 / 扩写 / 缩写 / 换语气 */
  transform?: string;
  /** 图像编辑工具（operation = edit） */
  tool?: EditTool;
  /** 超分倍数 */
  scale?: 2 | 4;
}

export type Operation = 'generate' | 'edit';

export type TaskStatus = 'queued' | 'running' | 'post_processing' | 'succeeded' | 'failed' | 'blocked' | 'canceled';

export interface OutputDTO {
  asset_id: string;
  kind: Modality;
  url: string;
  mime: string;
  width?: number;
  height?: number;
  duration_sec?: number;
  text?: string;
  content_id: string;
}

export interface TaskDTO {
  id: string;
  modality: Modality;
  operation: Operation;
  status: TaskStatus;
  progress: number;
  prompt: string;
  params: GenerationParams;
  model: { code: string; name: string; tier: Tier };
  routing_reason: string;
  estimated_credits: number;
  actual_credits: number | null;
  /** 生成时引用的角色与品牌套件（无引用时为 null） */
  context: TaskContextDTO | null;
  /** position：同一模态排队中的第几位（1 表示下一个处理）；前方超过 QUEUE_POSITION_CAP 个时为 QUEUE_POSITION_CAP + 1 */
  queue: { name: string; position: number | null };
  outputs: OutputDTO[];
  references: ReferenceDTO[];
  error: { code: string; message: string } | null;
  /** 写作任务被用户中途停止：outputs 为已生成的部分 */
  stopped: boolean;
  source: 'studio' | 'canvas' | 'agent' | 'template';
  created_at: string;
  finished_at: string | null;
}

export interface AssetDTO {
  id: string;
  kind: Modality;
  title: string;
  prompt: string;
  url: string;
  mime: string;
  width?: number;
  height?: number;
  duration_sec?: number;
  text?: string;
  content_id: string;
  favorite: boolean;
  model: string;
  task_id: string | null;
  /** generated：AI 生成（带 AI 标识）；uploaded：用户上传（不加标识） */
  source: 'generated' | 'uploaded';
  folder_id?: string | null;
  created_at: string;
}

export interface FolderDTO {
  id: string;
  name: string;
  asset_count: number;
  created_at: string;
}

export interface DownloadDTO {
  url: string;
  filename: string;
}

/** source：图像编辑的源图 */
export type ReferenceRole = 'style' | 'subject' | 'character' | 'first_frame' | 'last_frame' | 'source';

export interface ReferenceDTO {
  asset_id: string;
  role: ReferenceRole;
}

export interface UploadTicketDTO {
  upload_id: string;
  upload_url: string;
  method: 'PUT';
  headers: Record<string, string>;
  max_bytes: number;
  expires_at: string;
}

export interface BalanceDTO {
  available: number;
  frozen: number;
  expiring_soon: number;
}

export type LedgerType = 'grant' | 'freeze' | 'settle' | 'unfreeze' | 'refund' | 'expire' | 'adjust';

export interface LedgerEntryDTO {
  id: string;
  entry_type: LedgerType;
  delta_available: number;
  delta_frozen: number;
  balance_after: number;
  memo: string;
  task_id: string | null;
  created_at: string;
}

export interface MeDTO {
  id: string;
  nickname: string;
  phone_masked: string;
  plan: { code: string; name: string; expires_at: string | null };
  credits: BalanceDTO;
  /** admin 可进入管理后台 */
  role: 'user' | 'admin';
}

export interface OrderDTO {
  id: string;
  order_no: string;
  item_type: 'subscription' | 'credit_pack';
  item_ref: string;
  cycle: 'month' | 'year' | null;
  amount_fen: number;
  credits: number;
  status: 'pending' | 'paid' | 'closed';
  created_at: string;
  paid_at: string | null;
}

export interface CanvasNodeDTO {
  id: string;
  kind: Modality;
  title: string;
  prompt: string;
  x: number;
  y: number;
  modelCode: string;
  params: Record<string, string | number | boolean>;
  count: number;
  status: string;
  taskId?: string;
  /** 节点被修改后，上一次运行的任务（继续展示其产物） */
  prevTaskId?: string;
  /** 只在读取时由服务端按任务补全，保存时会被忽略 */
  outputs?: OutputDTO[];
}

export interface CanvasDocDTO {
  nodes: CanvasNodeDTO[];
  edges: { id: string; from: string; to: string }[];
  messages: Record<string, unknown>[];
  viewport?: { x: number; y: number; k: number };
}

export interface CanvasDTO {
  id: string;
  project_id: string;
  name: string;
  version: number;
  updated_at: string;
  doc: CanvasDocDTO;
}

export interface ProjectDTO {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  canvases: { id: string; name: string; node_count: number; updated_at: string }[];
}

// ---------- 灵感广场 ----------

export type FeedTab = 'recommend' | 'latest' | 'hot' | 'mine';
export type PostStatus = 'reviewing' | 'published' | 'hidden' | 'removed';
export type ReportReason = 'porn' | 'violence' | 'politics' | 'infringement' | 'ad' | 'other';

export const REPORT_REASONS: Record<ReportReason, string> = {
  porn: '色情低俗',
  violence: '暴力血腥',
  politics: '政治敏感',
  infringement: '侵权（肖像 / 版权 / 商标）',
  ad: '广告引流',
  other: '其他',
};

export interface PostDTO {
  id: string;
  kind: 'image' | 'video';
  title: string;
  /** 作者选择不公开提示词时为 null（作者本人仍可见） */
  prompt: string | null;
  tags: string[];
  author: { id: string; nickname: string };
  model: string;
  url: string;
  width?: number;
  height?: number;
  duration_sec?: number;
  content_id: string;
  like_count: number;
  remix_count: number;
  liked: boolean;
  mine: boolean;
  status: PostStatus;
  published_at: string | null;
  created_at: string;
}

/** 做同款：预填到创作工作台的内容 */
export interface RemixDTO {
  modality: 'image' | 'video';
  prompt: string;
  params: GenerationParams;
  model_code: string | null;
}

// ---------- 管理后台 ----------

export interface AdminOverviewDTO {
  users_total: number;
  users_new_today: number;
  tasks_today: number;
  success_rate_today: number | null;
  revenue_today_fen: number;
  credits_consumed_today: number;
  queue: { queued: number; running: number };
  pending_reviews: number;
  /** 近 14 天每日任务数，最后一项为今天 */
  trend: { date: string; tasks: number; succeeded: number }[];
}

export interface AdminModelDTO {
  code: string;
  name: string;
  modality: Modality;
  enabled: boolean;
  breaker_open: boolean;
  /** 网关 5 分钟窗口 */
  window_samples: number;
  window_success_rate: number | null;
  /** 近 24 小时任务统计 */
  tasks_24h: number;
  success_rate_24h: number | null;
  p95_sec_24h: number | null;
}

export type UserStatus = 'active' | 'frozen' | 'banned';

export interface AdminUserDTO {
  id: string;
  nickname: string;
  phone_masked: string;
  status: UserStatus;
  role: 'user' | 'admin';
  plan: { code: string; name: string; expires_at: string | null };
  credits: { available: number; frozen: number };
  tasks_total: number;
  created_at: string;
}

export interface AdminUserDetailDTO extends AdminUserDTO {
  stats: { tasks_succeeded: number; tasks_failed: number; assets: number; posts: number; reports_received: number };
  ledger: LedgerEntryDTO[];
  recent_tasks: { id: string; modality: Modality; prompt: string; status: TaskStatus; credits: number; created_at: string }[];
  audit: { action: string; actor_nickname: string; detail: Record<string, unknown>; created_at: string }[];
}

/** 全量对账记录：余额 / 流水 / 批次 / 冻结明细四方核对，以及已结束任务的残留冻结 */
export interface ReconcileRunDTO {
  id: string;
  trigger: 'schedule' | 'manual';
  triggered_by: string | null;
  started_at: string;
  finished_at: string | null;
  accounts: number;
  mismatches: number;
  stale_holds: number;
  details: {
    accounts?: { account_id: string; owner_id: string; available: number; frozen: number; ledger_available: number; ledger_frozen: number; grants_remaining: number; holds: number }[];
    holds?: { task_id: string; status: string; amount: number }[];
  };
}

export interface ReviewItemDTO {
  post: PostDTO;
  /** reviewing：发布时机审存疑；reported：被举报 */
  reason: 'reviewing' | 'reported';
  machine_labels: string[];
  reports: { reason: ReportReason; count: number }[];
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown>; request_id?: string };
}

/** 服务端推送事件（SSE） */
export type ServerEvent =
  | { type: 'task.progress'; task: TaskDTO }
  | { type: 'task.succeeded'; task: TaskDTO }
  | { type: 'task.failed'; task: TaskDTO }
  /** 写作任务的流式输出：从第 offset 个字符起的文本（推送可能乱序，按 offset 拼接；模型切换时 offset 回到 0） */
  | { type: 'task.delta'; task_id: string; offset: number; text: string }
  | { type: 'credits.changed'; credits: BalanceDTO }
  /** 推送可能有遗漏（如服务端事件监听重连）：客户端应重新拉取进行中的任务与余额 */
  | { type: 'sync' };

/** 排队位置最多精确计数到前方这么多个任务，超过时显示为"前方 1000+ 个" */
export const QUEUE_POSITION_CAP = 1000;
