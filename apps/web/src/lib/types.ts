import type { Modality, ModelInfo, TaskContextDTO } from '@creature/shared';

export type { Modality, ModelInfo, RoutingStrategy, Tier } from '@creature/shared';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'canceled';

export interface Output {
  id: string;
  kind: Modality;
  prompt: string;
  ratio: string;
  variant: number;
  durationSec?: number;
  text?: string;
  /** 接入后端时为签名文件地址；离线模式为空，使用程序化占位图 */
  url?: string;
}

export interface Task {
  id: string;
  modality: Modality;
  prompt: string;
  model: ModelInfo;
  params: Record<string, string | number | boolean>;
  status: TaskStatus;
  progress: number;
  queuePos: number;
  credits: number;
  createdAt: number;
  outputs: Output[];
  error?: string;
  operation?: 'generate' | 'edit';
  /** 后端返回的路由说明（含自动切换备选模型的说明） */
  routingReason?: string;
  source: 'studio' | 'canvas' | 'agent' | 'template';
  /** 图像编辑任务的源图 */
  sourceAssetId?: string;
  /** 引用的角色与品牌套件（接入后端时） */
  context?: TaskContextDTO;
  count: number;
  /** 模拟用：排队时长与生成时长（毫秒） */
  queueMs: number;
  runMs: number;
  failAt?: number;
}

export interface Asset {
  id: string;
  kind: Modality;
  title: string;
  prompt: string;
  ratio: string;
  variant: number;
  createdAt: number;
  model: string;
  durationSec?: number;
  favorite?: boolean;
  /** 所在文件夹 ID */
  folder?: string;
  text?: string;
  url?: string;
  contentId?: string;
  /** uploaded：用户上传（不带 AI 标识） */
  source?: 'generated' | 'uploaded';
}

export interface Folder {
  id: string;
  name: string;
  /** 接入后端时为服务端统计的作品数（含尚未加载到本地的作品） */
  count?: number;
}

export interface LedgerEntry {
  id: string;
  time: number;
  type: 'grant' | 'freeze' | 'settle' | 'unfreeze' | 'refund' | 'expire' | 'adjust';
  label: string;
  /** 可用余额变动 */
  delta: number;
  /** 冻结余额变动 */
  frozenDelta?: number;
  balance: number;
}

export interface Post {
  id: string;
  title: string;
  prompt: string;
  author: string;
  kind: 'image' | 'video';
  ratio: string;
  likes: number;
  remix: number;
  model: string;
  tags: string[];
}

export interface Notice {
  id: string;
  time: number;
  kind: 'ok' | 'err' | 'info';
  title: string;
  body?: string;
  read?: boolean;
}

export interface Toast {
  id: string;
  kind: 'ok' | 'err' | 'info';
  text: string;
}
