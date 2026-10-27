// 前后端共享的领域类型与 API 数据结构（与 docs/05-api.md 对应）

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
}

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
  queue: { name: string; position: number | null };
  outputs: OutputDTO[];
  references: ReferenceDTO[];
  error: { code: string; message: string } | null;
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
  created_at: string;
}

export type ReferenceRole = 'style' | 'subject' | 'character' | 'first_frame' | 'last_frame';

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
  | { type: 'credits.changed'; credits: BalanceDTO };
