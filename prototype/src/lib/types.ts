export type Modality = 'image' | 'video' | 'text' | 'audio';
export type Tier = 'standard' | 'advanced' | 'flagship';
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';
export type RoutingStrategy = 'auto' | 'cheap' | 'best';

export interface ModelInfo {
  code: string;
  name: string;
  vendor: string;
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
  enabled?: boolean;
}

export interface Output {
  id: string;
  kind: Modality;
  prompt: string;
  ratio: string;
  variant: number;
  durationSec?: number;
  text?: string;
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
  source: 'studio' | 'canvas' | 'agent' | 'template';
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
  folder?: string;
  text?: string;
}

export interface LedgerEntry {
  id: string;
  time: number;
  type: 'grant' | 'freeze' | 'settle' | 'refund' | 'expire';
  label: string;
  delta: number;
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

export interface TemplateStep {
  kind: Modality;
  title: string;
  credits: number;
}

export interface Template {
  id: string;
  title: string;
  desc: string;
  category: string;
  kind: 'single' | 'workflow';
  cover: string;
  ratio: string;
  uses: number;
  rating: number;
  author: string;
  official?: boolean;
  steps: TemplateStep[];
  prompt: string;
  modality: Modality;
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
