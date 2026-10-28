import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import {
  editLabel,
  estimateCredits,
  mockTransform,
  mockWriting,
  modelByCode,
  TIER_LABEL,
  type AssetDTO,
  type FolderDTO,
  type GenerationParams,
  type LedgerEntryDTO,
  type MeDTO,
  type OutputDTO,
  type ReferenceRole,
  type ServerEvent,
  type TaskDTO,
  type TransformKind,
} from '@creature/shared';
import { api, ApiError, BACKEND, onAccountSuspended, refresh, subscribeEvents } from './api';
import { INITIAL_ASSETS, INITIAL_LEDGER, NOW } from './mock';
import type { Asset, Folder, LedgerEntry, Modality, ModelInfo, Notice, Output, Task, Toast } from './types';

// 全局状态：积分账户、生成任务、资产、积分流水、通知。
// mock 模式：任务进度在本地按时间模拟（离线演示）；
// api 模式：任务提交到后端，进度与积分变化通过服务端推送（SSE）同步。

export type Theme = 'system' | 'dark' | 'light';
export type AuthState = 'pending' | 'anon' | 'authed';

export interface Handoff {
  to: 'studio' | 'canvas';
  prompt?: string;
  mode?: Modality;
  autostart?: boolean;
  agentPrompt?: string;
  templateId?: string;
  firstFrame?: Asset;
  /** 打开指定画布（项目页进入） */
  canvasId?: string;
  /** 做同款：沿用原作的参数与模型 */
  params?: GenerationParams;
  modelCode?: string | null;
}

export interface Profile {
  nickname: string;
  phoneMasked: string;
  planCode: string;
  planName: string;
  planExpiresAt: string | null;
  role: 'user' | 'admin';
}

interface State {
  auth: AuthState;
  profile: Profile | null;
  available: number;
  frozen: number;
  expiringSoon: number;
  tasks: Task[];
  assets: Asset[];
  /** 资产列表的下一页游标（api 模式） */
  assetsCursor: string | null;
  folders: Folder[];
  ledger: LedgerEntry[];
  notices: Notice[];
  toasts: Toast[];
  handoff: Handoff | null;
  theme: Theme;
  viewer: Asset | null;
  /** 正在图像编辑器中编辑的作品 */
  editing: Asset | null;
}

type Action =
  | { type: 'add_task'; task: Task; ledger?: LedgerEntry }
  | { type: 'upsert_task'; task: Task }
  | { type: 'patch_task'; id: string; patch: Partial<Task> }
  | { type: 'finish_task'; id: string; ok: boolean; outputs: Task['outputs']; assets: Asset[]; error?: string }
  | { type: 'grant'; credits: number; label: string }
  | { type: 'set_credits'; available: number; frozen: number; expiringSoon: number }
  | { type: 'set_ledger'; ledger: LedgerEntry[] }
  | { type: 'hydrate'; profile: Profile; available: number; frozen: number; expiringSoon: number; tasks: Task[]; assets: Asset[]; assetsCursor: string | null; folders: Folder[]; ledger: LedgerEntry[] }
  | { type: 'more_assets'; assets: Asset[]; cursor?: string | null }
  | { type: 'set_folders'; folders: Folder[] }
  | { type: 'auth'; auth: AuthState }
  | { type: 'reset' }
  | { type: 'add_assets'; assets: Asset[] }
  | { type: 'patch_asset'; id: string; patch: Partial<Asset> }
  | { type: 'remove_assets'; ids: string[] }
  | { type: 'toast'; toast: Toast }
  | { type: 'dismiss'; id: string }
  | { type: 'notice'; notice: Notice }
  | { type: 'read_notices' }
  | { type: 'handoff'; handoff: Handoff | null }
  | { type: 'theme'; theme: Theme }
  | { type: 'viewer'; asset: Asset | null }
  | { type: 'editing'; asset: Asset | null };

let seq = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

const MOD_WORDS = ['违规', '血腥', '暴恐', '色情'];
const KIND_LABEL: Record<Modality, string> = { image: '图像', video: '视频', text: '文本', audio: '音频' };
/** 已结束的任务状态：之后的推送不再触发提示 */
const DONE_STATUSES: readonly string[] = ['succeeded', 'failed', 'blocked', 'canceled'];

// ---------- 后端数据 → 前端模型 ----------

export function taskFromDTO(d: TaskDTO): Task {
  const count = d.outputs.length || Number(d.params.count ?? 1);
  return {
    id: d.id,
    modality: d.modality,
    operation: d.operation,
    prompt: d.prompt,
    model: modelByCode(d.model.code),
    params: d.params as Task['params'],
    status: d.status === 'post_processing' ? 'running' : d.status,
    progress: d.progress,
    queuePos: d.queue.position ?? 0,
    credits: d.actual_credits ?? d.estimated_credits,
    createdAt: Date.parse(d.created_at),
    outputs: d.outputs.map((o, i) => outputFromDTO(o, i, d.prompt, d.params.ratio)),
    error: d.error?.message,
    routingReason: d.routing_reason,
    source: d.source,
    sourceAssetId: d.references?.find((r) => r.role === 'source')?.asset_id,
    count,
    queueMs: 0,
    runMs: 0,
  };
}

export function outputFromDTO(o: OutputDTO, i: number, prompt: string, ratio?: unknown): Output {
  return {
    id: o.asset_id,
    kind: o.kind,
    prompt,
    ratio: String(ratio ?? (o.width && o.height ? `${o.width}:${o.height}` : '1:1')),
    variant: i,
    durationSec: o.duration_sec,
    text: o.text,
    url: o.url,
  };
}

export function assetFromDTO(a: AssetDTO): Asset {
  return {
    id: a.id,
    kind: a.kind,
    title: a.title,
    prompt: a.prompt,
    ratio: a.width && a.height ? simplifyRatio(a.width, a.height) : '1:1',
    variant: 0,
    createdAt: Date.parse(a.created_at),
    model: a.model,
    durationSec: a.duration_sec,
    favorite: a.favorite,
    text: a.text,
    url: a.url,
    contentId: a.content_id,
    source: a.source,
    folder: a.folder_id ?? undefined,
  };
}

const folderFromDTO = (f: FolderDTO): Folder => ({ id: f.id, name: f.name, count: f.asset_count });

/** 把宽高换算成最接近的常用比例 */
export function simplifyRatio(w: number, h: number): string {
  const known = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'];
  const r = w / h;
  return known.reduce((best, k) => {
    const [a, b] = k.split(':').map(Number);
    const [ba, bb] = best.split(':').map(Number);
    return Math.abs(a / b - r) < Math.abs(ba / bb - r) ? k : best;
  }, '1:1');
}

const ledgerFromDTO = (e: LedgerEntryDTO): LedgerEntry => ({
  id: e.id,
  time: Date.parse(e.created_at),
  type: e.entry_type,
  label: e.memo,
  delta: e.delta_available,
  frozenDelta: e.delta_frozen,
  balance: e.balance_after,
});

const profileFromDTO = (m: MeDTO): Profile => ({ nickname: m.nickname, phoneMasked: m.phone_masked, planCode: m.plan.code, planName: m.plan.name, planExpiresAt: m.plan.expires_at, role: m.role });

export function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : '网络异常，请检查网络后重试';
}

// ---------- reducer ----------

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'add_task': {
      const frozen = a.task.status === 'blocked' ? 0 : a.task.credits;
      return {
        ...s,
        tasks: [a.task, ...s.tasks],
        available: s.available - frozen,
        frozen: s.frozen + frozen,
        ledger: a.ledger ? [a.ledger, ...s.ledger] : s.ledger,
      };
    }
    case 'upsert_task': {
      const exists = s.tasks.some((t) => t.id === a.task.id);
      return { ...s, tasks: exists ? s.tasks.map((t) => (t.id === a.task.id ? { ...a.task, source: t.source ?? a.task.source } : t)) : [a.task, ...s.tasks] };
    }
    case 'patch_task':
      return { ...s, tasks: s.tasks.map((t) => (t.id === a.id ? { ...t, ...a.patch } : t)) };
    case 'finish_task': {
      const t = s.tasks.find((x) => x.id === a.id);
      if (!t) return s;
      const tasks = s.tasks.map((x) =>
        x.id === a.id ? { ...x, status: a.ok ? ('succeeded' as const) : ('failed' as const), progress: a.ok ? 100 : x.progress, outputs: a.outputs, error: a.error } : x,
      );
      if (a.ok) {
        // 冻结转结算：流水中的冻结记录改为结算
        const ledger = s.ledger.map((l) => (l.id === `lg_${t.id}` ? { ...l, type: 'settle' as const, label: l.label.replace('冻结 · ', '') } : l));
        return { ...s, tasks, frozen: s.frozen - t.credits, ledger, assets: [...a.assets, ...s.assets] };
      }
      const balance = s.available + t.credits;
      return {
        ...s,
        tasks,
        frozen: s.frozen - t.credits,
        available: balance,
        ledger: [{ id: uid('lg'), time: Date.now(), type: 'refund', label: `生成失败返还 · ${t.model.name}`, delta: t.credits, balance }, ...s.ledger],
      };
    }
    case 'grant': {
      const balance = s.available + a.credits;
      return { ...s, available: balance, ledger: [{ id: uid('lg'), time: Date.now(), type: 'grant', label: a.label, delta: a.credits, balance }, ...s.ledger] };
    }
    case 'set_credits':
      return { ...s, available: a.available, frozen: a.frozen, expiringSoon: a.expiringSoon };
    case 'set_ledger':
      return { ...s, ledger: a.ledger };
    case 'hydrate':
      return {
        ...s,
        auth: 'authed',
        profile: a.profile,
        available: a.available,
        frozen: a.frozen,
        expiringSoon: a.expiringSoon,
        tasks: a.tasks,
        assets: a.assets,
        assetsCursor: a.assetsCursor,
        folders: a.folders,
        ledger: a.ledger,
        notices: [],
      };
    case 'more_assets': {
      // 合并按条件拉取的作品（翻页、按文件夹或搜索），已有的以服务端数据为准
      const incoming = new Map(a.assets.map((x) => [x.id, x]));
      const merged = s.assets.map((x) => incoming.get(x.id) ?? x);
      const known = new Set(s.assets.map((x) => x.id));
      return { ...s, assets: [...merged, ...a.assets.filter((x) => !known.has(x.id))], assetsCursor: a.cursor === undefined ? s.assetsCursor : a.cursor };
    }
    case 'set_folders':
      return { ...s, folders: a.folders };
    case 'auth':
      return { ...s, auth: a.auth };
    case 'reset':
      return { ...s, auth: 'anon', profile: null, available: 0, frozen: 0, expiringSoon: 0, tasks: [], assets: [], assetsCursor: null, folders: [], ledger: [], notices: [], viewer: null, editing: null };
    case 'add_assets': {
      const ids = new Set(s.assets.map((x) => x.id));
      return { ...s, assets: [...a.assets.filter((x) => !ids.has(x.id)), ...s.assets] };
    }
    case 'patch_asset':
      return {
        ...s,
        assets: s.assets.map((x) => (x.id === a.id ? { ...x, ...a.patch } : x)),
        viewer: s.viewer?.id === a.id ? { ...s.viewer, ...a.patch } : s.viewer,
      };
    case 'remove_assets':
      return { ...s, assets: s.assets.filter((x) => !a.ids.includes(x.id)) };
    case 'toast':
      return { ...s, toasts: [...s.toasts.slice(-3), a.toast] };
    case 'dismiss':
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
    case 'notice':
      return { ...s, notices: [a.notice, ...s.notices].slice(0, 30) };
    case 'read_notices':
      return { ...s, notices: s.notices.map((n) => ({ ...n, read: true })) };
    case 'handoff':
      return { ...s, handoff: a.handoff };
    case 'theme':
      return { ...s, theme: a.theme };
    case 'viewer':
      return { ...s, viewer: a.asset };
    case 'editing':
      return { ...s, editing: a.asset, viewer: a.asset ? null : s.viewer };
  }
}

// ---------- 离线演示数据 ----------

function seedTasks(): Task[] {
  const mk = (id: string, prompt: string, code: string, params: Task['params'], count: number, ago: number, modality: Modality): Task => {
    const model = modelByCode(code);
    return {
      id,
      modality,
      prompt,
      model,
      params,
      status: 'succeeded',
      progress: 100,
      queuePos: 0,
      credits: estimateCredits(model, params),
      createdAt: NOW - ago,
      outputs: Array.from({ length: count }, (_, i) => ({ id: `${id}_${i}`, kind: modality, prompt, ratio: String(params.ratio ?? '3:4'), variant: i, durationSec: modality === 'video' ? Number(params.duration) : undefined })),
      source: 'studio',
      count,
      queueMs: 0,
      runMs: 0,
    };
  };
  return [
    mk('seed_img_1', '秋日午后的咖啡馆窗边，一杯枫糖拿铁，暖色逆光，胶片质感，浅景深', 'seedream-4', { ratio: '3:4', resolution: '2k', count: 4 }, 4, 2 * 3600_000, 'image'),
    mk('seed_vid_1', '秋日咖啡馆，镜头缓慢推进到冒着热气的拿铁，落叶飘过窗外', 'kling-3.0', { ratio: '9:16', resolution: '1080p', duration: 10 }, 1, 3 * 3600_000, 'video'),
  ];
}

function loadTheme(): Theme {
  try {
    const v = localStorage.getItem('creature-theme');
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

const mockInitial = (): State => ({
  auth: 'authed',
  profile: { nickname: '林夏', phoneMasked: '138****8000', planCode: 'pro', planName: '专业版', planExpiresAt: null, role: 'admin' },
  available: 1268,
  frozen: 0,
  expiringSoon: 20,
  tasks: seedTasks(),
  assets: INITIAL_ASSETS,
  assetsCursor: null,
  // 演示数据里文件夹 ID 与名称相同
  folders: [...new Set(INITIAL_ASSETS.map((a) => a.folder).filter((f): f is string => !!f))].map((f) => ({ id: f, name: f })),
  ledger: INITIAL_LEDGER,
  notices: [
    { id: 'n1', time: NOW - 2 * 3600_000, kind: 'ok', title: '图像生成完成', body: '枫糖拿铁 · 4 张', read: true },
    { id: 'n2', time: NOW - 3 * 3600_000, kind: 'err', title: '视频生成失败，已返还 80 积分', body: '海螺 Hailuo 2.3 供应商超时', read: true },
    { id: 'n3', time: NOW - 5 * 24 * 3600_000, kind: 'info', title: '积分将于 3 天后过期', body: '每日赠送积分 20', read: true },
  ],
  toasts: [],
  handoff: null,
  theme: loadTheme(),
  viewer: null,
  editing: null,
});

const apiInitial = (): State => ({
  auth: 'pending',
  profile: null,
  available: 0,
  frozen: 0,
  expiringSoon: 0,
  tasks: [],
  assets: [],
  assetsCursor: null,
  folders: [],
  ledger: [],
  notices: [],
  toasts: [],
  handoff: null,
  theme: loadTheme(),
  viewer: null,
  editing: null,
});

// ---------- Provider ----------

export interface SubmitSpec {
  modality: Modality;
  prompt: string;
  model: ModelInfo;
  params: Task['params'];
  count?: number;
  source?: Task['source'];
  operation?: 'generate' | 'edit';
  /** 参考图（仅接入后端时生效）：资产 ID 与用途 */
  references?: { assetId: string; role: ReferenceRole }[];
  /** 图像编辑的涂抹区域（PNG data URL） */
  mask?: string;
  /** 图像编辑的源图：离线演示用它渲染结果 */
  editSource?: Asset;
}

export interface PurchaseItem {
  item_type: 'subscription' | 'credit_pack';
  item_ref: string;
  cycle?: 'month' | 'year';
  credits: number;
  title: string;
}

interface Ctx {
  state: State;
  mode: 'api' | 'mock';
  /** 提交生成任务，返回任务 ID；失败时提示原因并返回 null */
  submit: (spec: SubmitSpec) => Promise<string | null>;
  cancelTask: (id: string) => Promise<void>;
  /** 上传图片到资产库；离线模式只在本地预览 */
  uploadImage: (file: File) => Promise<Asset | null>;
  purchase: (item: PurchaseItem) => Promise<boolean>;
  login: (phone: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismiss: (id: string) => void;
  patchAsset: (id: string, patch: Partial<Asset>) => void;
  removeAssets: (ids: string[]) => Promise<void>;
  /** 拉取更多作品并合并到本地（翻页、按文件夹或关键词） */
  fetchAssets: (f?: { more?: boolean; folder?: string; q?: string }) => Promise<void>;
  createFolder: (name: string) => Promise<Folder | null>;
  renameFolder: (id: string, name: string) => Promise<boolean>;
  deleteFolder: (id: string) => Promise<boolean>;
  /** 移动到文件夹；folderId 为 null 时移出文件夹 */
  moveAssets: (ids: string[], folderId: string | null) => Promise<boolean>;
  /** 下载作品（生成作品带 AI 标识） */
  downloadAsset: (a: Asset) => Promise<void>;
  setHandoff: (h: Handoff | null) => void;
  setTheme: (t: Theme) => void;
  openViewer: (a: Asset | null) => void;
  /** 打开图像编辑器（会关闭作品详情） */
  openEditor: (a: Asset | null) => void;
  readNotices: () => void;
}

const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, BACKEND === 'api' ? apiInitial : mockInitial);
  const ref = useRef(state);
  ref.current = state;
  const editSources = useRef(new Map<string, Asset>());

  const toast = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = uid('t');
    dispatch({ type: 'toast', toast: { id, kind, text } });
    window.setTimeout(() => dispatch({ type: 'dismiss', id }), kind === 'err' ? 6000 : 3200);
  }, []);

  const notice = useCallback((kind: Notice['kind'], title: string, body?: string) => {
    dispatch({ type: 'notice', notice: { id: uid('n'), time: Date.now(), kind, title, body } });
  }, []);

  // ---------- api 模式：登录态、数据加载与服务端推送 ----------

  const hydrate = useCallback(async () => {
    dispatch({ type: 'hydrate', ...(await snapshot()) });
  }, []);

  const ledgerTimer = useRef<number>(0);
  const onServerEvent = useCallback(
    (e: ServerEvent) => {
      if (e.type === 'sync') return;
      if (e.type === 'credits.changed') {
        dispatch({ type: 'set_credits', available: e.credits.available, frozen: e.credits.frozen, expiringSoon: e.credits.expiring_soon });
        window.clearTimeout(ledgerTimer.current);
        ledgerTimer.current = window.setTimeout(() => void api.ledger().then((l) => dispatch({ type: 'set_ledger', ledger: l.data.map(ledgerFromDTO) }), () => undefined), 400);
        return;
      }
      const task = taskFromDTO(e.task);
      const known = ref.current.tasks.find((t) => t.id === task.id);
      const wasDone = known && DONE_STATUSES.includes(known.status);
      dispatch({ type: 'upsert_task', task });
      if (wasDone) return;
      const quiet = task.source === 'canvas' || task.source === 'agent';
      if (e.type === 'task.succeeded') {
        dispatch({ type: 'add_assets', assets: e.task.outputs.map((o, i) => ({ ...assetFromDTO({ ...o, id: o.asset_id, title: `${task.prompt.slice(0, 16)}${e.task.outputs.length > 1 ? ` · ${i + 1}` : ''}`, prompt: task.prompt, favorite: false, model: task.model.name, task_id: task.id, source: 'generated', created_at: new Date().toISOString() }), ratio: String(task.params.ratio ?? '1:1') })) });
        if (!quiet) toast(`${KIND_LABEL[task.modality]}生成完成 · 消耗 ${task.credits} 积分`);
        notice('ok', `${KIND_LABEL[task.modality]}生成完成`, `${task.prompt.slice(0, 18)} · ${task.outputs.length} 个结果`);
      } else if (e.type === 'task.failed') {
        if (task.status === 'canceled') return;
        if (!quiet) toast(task.error ?? '生成失败，积分已返还', 'err');
        notice('err', task.status === 'blocked' ? '内容未通过审核，积分已返还' : '生成失败，积分已返还', task.model.name);
      }
    },
    [toast, notice],
  );

  /** 推送可能有遗漏（断线重连、服务端事件监听重连）：重新拉取余额与进行中的任务，按普通事件处理 */
  const resync = useCallback(async (handle: (e: ServerEvent) => void) => {
    const pending = new Set(ref.current.tasks.filter((t) => !DONE_STATUSES.includes(t.status)).map((t) => t.id));
    const [balance, page] = await Promise.all([api.balance(), pending.size ? api.generations() : null]);
    handle({ type: 'credits.changed', credits: balance });
    for (const dto of page?.data ?? []) {
      if (!pending.has(dto.id)) continue;
      handle({ type: dto.status === 'succeeded' ? 'task.succeeded' : DONE_STATUSES.includes(dto.status) ? 'task.failed' : 'task.progress', task: dto });
    }
  }, []);

  useEffect(() => {
    if (BACKEND !== 'api') return;
    let alive = true;
    void (async () => {
      if (!(await refresh())) return alive && dispatch({ type: 'auth', auth: 'anon' });
      try {
        await hydrate();
      } catch {
        if (alive) dispatch({ type: 'auth', auth: 'anon' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [hydrate]);

  useEffect(() => {
    if (BACKEND !== 'api' || state.auth !== 'authed') return;
    return subscribeEvents((e) => (e.type === 'sync' ? void resync(onServerEvent).catch(() => undefined) : onServerEvent(e)));
  }, [state.auth, onServerEvent, resync]);

  // 账号被后台限制：退回登录页
  useEffect(() => {
    if (BACKEND !== 'api') return;
    return onAccountSuspended(() => {
      if (ref.current.auth !== 'authed') return;
      dispatch({ type: 'reset' });
      toast('账号已被限制使用，如有疑问请联系客服', 'err');
    });
  }, [toast]);

  // ---------- 提交任务 ----------

  const submit = useCallback(
    async (spec: SubmitSpec): Promise<string | null> => {
      const count = spec.count ?? Number(spec.params.count ?? 1);
      if (BACKEND === 'api') {
        try {
          const dto = await api.createGeneration(
            {
              modality: spec.modality,
              operation: spec.operation ?? 'generate',
              prompt: spec.prompt,
              params: { ...spec.params, ...(spec.modality === 'image' ? { count } : {}) },
              // 固定使用界面上展示的模型（智能路由已在前端用同一套共享规则算出），保证提交前看到的积分与实际一致
              routing: { strategy: 'auto', pinned_model: spec.model.code },
              source: spec.source ?? 'studio',
              references: spec.references?.map((r) => ({ asset_id: r.assetId, role: r.role })),
              mask: spec.mask,
            },
            uid('idem-'),
          );
          dispatch({ type: 'upsert_task', task: taskFromDTO(dto) });
          return dto.id;
        } catch (e) {
          toast(errorText(e), 'err');
          return null;
        }
      }

      const credits = estimateCredits(spec.model, spec.params);
      if (credits > ref.current.available) {
        toast(`积分不足：需要 ${credits} 积分，当前可用 ${ref.current.available}`, 'err');
        return null;
      }
      const id = uid('tsk_');
      const blocked = MOD_WORDS.some((w) => spec.prompt.includes(w));
      const slow = spec.modality === 'video' ? 2.6 : spec.modality === 'audio' ? 1.2 : 1;
      const task: Task = {
        id,
        modality: spec.modality,
        operation: spec.operation ?? 'generate',
        prompt: spec.prompt,
        model: spec.model,
        params: spec.params,
        status: blocked ? 'blocked' : 'queued',
        progress: 0,
        queuePos: blocked ? 0 : 1 + Math.floor(Math.random() * 3),
        credits,
        createdAt: Date.now(),
        outputs: [],
        source: spec.source ?? 'studio',
        sourceAssetId: spec.references?.find((r) => r.role === 'source')?.assetId,
        count,
        queueMs: 900 + Math.random() * 900,
        runMs: (3200 + Math.random() * 2400) * slow * (spec.model.speed >= 4 ? 0.8 : 1.15),
        failAt: spec.prompt.includes('失败') ? 0.6 : undefined,
        error: blocked ? '提示词可能违反社区规范，未生成，积分未扣除' : undefined,
      };
      const spec2 = spec.modality === 'image' ? `${String(spec.params.resolution ?? '1k').toUpperCase()} ×${count}` : spec.modality === 'video' ? `${spec.params.duration} 秒 ${spec.params.resolution}` : TIER_LABEL[spec.model.tier];
      const ledger: LedgerEntry | undefined = blocked
        ? undefined
        : {
            id: `lg_${id}`,
            time: Date.now(),
            type: 'freeze',
            label: spec.params.tool
              ? `冻结 · 图像编辑 · ${editLabel(spec.params as GenerationParams)}`
              : `冻结 · ${{ image: '图像生成', video: '视频生成', text: '写作', audio: '音频生成' }[spec.modality]} · ${spec.model.name} · ${spec2}`,
            delta: -credits,
            balance: ref.current.available - credits,
          };
      if (spec.editSource) editSources.current.set(id, spec.editSource);
      dispatch({ type: 'add_task', task, ledger });
      if (blocked) toast('内容可能违反社区规范，未生成，积分未扣除', 'err');
      return id;
    },
    [toast],
  );

  // mock 模式：任务进度按时间模拟
  useEffect(() => {
    if (BACKEND !== 'mock') return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const t of ref.current.tasks) {
        if (t.status !== 'queued' && t.status !== 'running') continue;
        const elapsed = now - t.createdAt;
        if (elapsed < t.queueMs) {
          const pos = Math.max(1, Math.ceil(t.queuePos * (1 - elapsed / t.queueMs)));
          if (pos !== t.queuePos) dispatch({ type: 'patch_task', id: t.id, patch: { queuePos: pos } });
          continue;
        }
        const p = Math.min(1, (elapsed - t.queueMs) / t.runMs);
        if (t.failAt && p >= t.failAt) {
          dispatch({ type: 'finish_task', id: t.id, ok: false, outputs: [], assets: [], error: '供应商超时，已自动切换备选模型重试 1 次仍失败' });
          toast(`生成失败，已返还 ${t.credits} 积分`, 'err');
          notice('err', `生成失败，已返还 ${t.credits} 积分`, t.model.name);
          continue;
        }
        if (p >= 1) {
          const text =
            t.modality === 'text' ? (t.operation === 'edit' ? mockTransform((t.params.transform as TransformKind) ?? '改写', t.prompt) : mockWriting(t.params.template as string | undefined, t.prompt, t.params.tone as string | undefined)) : undefined;
          // 离线演示的图像编辑：沿用源图画面（扩图时换成目标比例）
          const src = t.operation === 'edit' && t.modality === 'image' ? editSources.current.get(t.id) : undefined;
          const outputs = Array.from({ length: t.count }, (_, i) => ({
            id: `${t.id}_${i}`,
            kind: t.modality,
            prompt: src ? src.prompt : t.prompt,
            url: src?.url,
            ratio: String(t.params.ratio ?? src?.ratio ?? (t.modality === 'audio' ? '1:1' : '3:4')),
            variant: src ? src.variant : i,
            durationSec: t.modality === 'video' ? Number(t.params.duration) : t.modality === 'audio' ? Number(t.params.seconds ?? 12) : undefined,
            text,
          }));
          const assets: Asset[] = outputs.map((o, i) => ({
            id: o.id,
            kind: o.kind,
            title: `${t.prompt.slice(0, 14)}${t.prompt.length > 14 ? '…' : ''}${t.count > 1 ? ` · ${i + 1}` : ''}`,
            prompt: t.prompt,
            ratio: o.ratio,
            variant: o.variant,
            createdAt: now,
            model: t.model.name,
            durationSec: o.durationSec,
            text,
          }));
          dispatch({ type: 'finish_task', id: t.id, ok: true, outputs, assets });
          if (t.source === 'studio' || t.source === 'template') toast(`${KIND_LABEL[t.modality]}生成完成 · 消耗 ${t.credits} 积分`);
          notice('ok', `${KIND_LABEL[t.modality]}生成完成`, `${t.prompt.slice(0, 18)} · ${t.count} 个结果`);
          continue;
        }
        const progress = Math.round(p * 100);
        if (t.status !== 'running' || Math.abs(progress - t.progress) >= 2) dispatch({ type: 'patch_task', id: t.id, patch: { status: 'running', progress, queuePos: 0 } });
      }
    }, 300);
    return () => window.clearInterval(timer);
  }, [toast, notice]);

  // 首次加载且为"跟随系统"时不改动根元素，保留宿主页面已设置的主题
  const themeTouched = useRef(false);
  useEffect(() => {
    if (!themeTouched.current) {
      themeTouched.current = true;
      if (state.theme === 'system') return;
    }
    const root = document.documentElement;
    if (state.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', state.theme);
    try {
      localStorage.setItem('creature-theme', state.theme);
    } catch {
      /* 存储不可用时忽略 */
    }
  }, [state.theme]);

  const value = useMemo<Ctx>(
    () => ({
      state,
      mode: BACKEND,
      submit,
      toast,
      async cancelTask(id) {
        if (BACKEND === 'api') {
          try {
            dispatch({ type: 'upsert_task', task: taskFromDTO(await api.cancelGeneration(id)) });
            toast('已取消，积分已返还');
          } catch (e) {
            toast(errorText(e), 'err');
          }
          return;
        }
        dispatch({ type: 'finish_task', id, ok: false, outputs: [], assets: [], error: '已取消' });
        dispatch({ type: 'patch_task', id, patch: { status: 'canceled' } });
        toast('已取消，积分已返还');
      },
      async uploadImage(file) {
        if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
          toast('仅支持 PNG、JPEG、WebP 图片', 'err');
          return null;
        }
        if (file.size > 20 * 1024 * 1024) {
          toast('单个文件不能超过 20 MB', 'err');
          return null;
        }
        if (BACKEND === 'mock') {
          const asset: Asset = { id: uid('upl_'), kind: 'image', title: file.name.replace(/\.[a-z0-9]+$/i, ''), prompt: '', ratio: '1:1', variant: 0, createdAt: Date.now(), model: '本地上传', url: URL.createObjectURL(file), source: 'uploaded' };
          dispatch({ type: 'add_assets', assets: [asset] });
          return asset;
        }
        try {
          const asset = assetFromDTO(await api.uploadImage(file));
          dispatch({ type: 'add_assets', assets: [asset] });
          return asset;
        } catch (e) {
          toast(errorText(e), 'err');
          return null;
        }
      },
      async purchase(item) {
        if (BACKEND === 'mock') {
          dispatch({ type: 'grant', credits: item.credits, label: `${item.title} · 到账` });
          toast(`支付成功，${item.credits} 积分已到账`);
          return true;
        }
        try {
          const order = await api.createOrder(item.item_type === 'subscription' ? { item_type: 'subscription', item_ref: item.item_ref, cycle: item.cycle ?? 'month' } : { item_type: 'credit_pack', item_ref: item.item_ref });
          await api.mockPay(order.id);
          dispatch({ type: 'hydrate', ...(await snapshot()) });
          toast(`支付成功，${order.credits} 积分已到账`);
          return true;
        } catch (e) {
          toast(errorText(e), 'err');
          return false;
        }
      },
      async login(phone, code) {
        await api.login(phone, code);
        await hydrate();
      },
      async logout() {
        await api.logout();
        dispatch({ type: 'reset' });
      },
      dismiss: (id) => dispatch({ type: 'dismiss', id }),
      patchAsset(id, patch) {
        const before = ref.current.assets.find((a) => a.id === id);
        dispatch({ type: 'patch_asset', id, patch });
        if (BACKEND === 'api' && (patch.favorite !== undefined || patch.title !== undefined)) {
          api.updateAsset(id, { favorite: patch.favorite, title: patch.title }).catch((e) => {
            if (before) dispatch({ type: 'patch_asset', id, patch: { favorite: before.favorite, title: before.title } });
            toast(errorText(e), 'err');
          });
        }
      },
      async removeAssets(ids) {
        if (BACKEND === 'api') {
          const results = await Promise.allSettled(ids.map((id) => api.deleteAsset(id)));
          const ok = ids.filter((_, i) => results[i].status === 'fulfilled');
          dispatch({ type: 'remove_assets', ids: ok });
          if (ok.length < ids.length) toast(`有 ${ids.length - ok.length} 个作品删除失败，请重试`, 'err');
          return;
        }
        dispatch({ type: 'remove_assets', ids });
      },
      async fetchAssets(f = {}) {
        if (BACKEND !== 'api') return;
        if (f.more && !ref.current.assetsCursor) return;
        try {
          const page = await api.assets({ cursor: f.more ? ref.current.assetsCursor : undefined, folder: f.folder, q: f.q });
          dispatch({ type: 'more_assets', assets: page.data.map(assetFromDTO), cursor: f.more ? page.next_cursor : undefined });
        } catch (e) {
          toast(errorText(e), 'err');
        }
      },
      async createFolder(name) {
        const n = name.trim();
        if (!n) return null;
        if (BACKEND === 'mock') {
          if (ref.current.folders.some((f) => f.name === n)) {
            toast(`已有名为「${n}」的文件夹`, 'err');
            return null;
          }
          const f = { id: n, name: n };
          dispatch({ type: 'set_folders', folders: [...ref.current.folders, f] });
          return f;
        }
        try {
          const f = folderFromDTO(await api.createFolder(n));
          dispatch({ type: 'set_folders', folders: [...ref.current.folders, f] });
          return f;
        } catch (e) {
          toast(errorText(e), 'err');
          return null;
        }
      },
      async renameFolder(id, name) {
        const n = name.trim();
        if (!n) return false;
        try {
          if (BACKEND === 'api') await api.renameFolder(id, n);
          dispatch({ type: 'set_folders', folders: ref.current.folders.map((f) => (f.id === id ? { ...f, name: n } : f)) });
          return true;
        } catch (e) {
          toast(errorText(e), 'err');
          return false;
        }
      },
      async deleteFolder(id) {
        try {
          if (BACKEND === 'api') await api.deleteFolder(id);
          dispatch({ type: 'set_folders', folders: ref.current.folders.filter((f) => f.id !== id) });
          for (const a of ref.current.assets) if (a.folder === id) dispatch({ type: 'patch_asset', id: a.id, patch: { folder: undefined } });
          return true;
        } catch (e) {
          toast(errorText(e), 'err');
          return false;
        }
      },
      async moveAssets(ids, folderId) {
        try {
          if (BACKEND === 'api') await api.moveAssets(ids, folderId);
          for (const id of ids) dispatch({ type: 'patch_asset', id, patch: { folder: folderId ?? undefined } });
          if (BACKEND === 'api') dispatch({ type: 'set_folders', folders: (await api.folders()).data.map(folderFromDTO) });
          return true;
        } catch (e) {
          toast(errorText(e), 'err');
          return false;
        }
      },
      async downloadAsset(a) {
        if (BACKEND === 'mock' || !a.url) {
          toast(a.source === 'uploaded' ? '已开始下载（离线演示）' : '已开始下载 · 文件含显式与隐式 AI 标识（离线演示）', 'info');
          return;
        }
        try {
          const d = await api.downloadAsset(a.id);
          // 服务端以附件形式返回，浏览器直接保存文件
          const link = document.createElement('a');
          link.href = d.url;
          link.download = d.filename;
          document.body.appendChild(link);
          link.click();
          link.remove();
          toast(a.source === 'uploaded' ? `已开始下载「${d.filename}」` : `已开始下载「${d.filename}」· 含 AI 标识`);
        } catch (e) {
          toast(errorText(e), 'err');
        }
      },
      setHandoff: (h) => dispatch({ type: 'handoff', handoff: h }),
      setTheme: (t) => dispatch({ type: 'theme', theme: t }),
      openViewer: (a) => dispatch({ type: 'viewer', asset: a }),
      openEditor: (a) => dispatch({ type: 'editing', asset: a }),
      readNotices: () => dispatch({ type: 'read_notices' }),
    }),
    [state, submit, toast, hydrate],
  );

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

/** 拉取当前用户、任务、资产、流水与余额（登录后与支付成功后使用） */
async function snapshot() {
  const [me, tasks, assets, ledger, folders] = await Promise.all([api.me(), api.generations(), api.assets(), api.ledger(), api.folders()]);
  return {
    profile: profileFromDTO(me),
    available: me.credits.available,
    frozen: me.credits.frozen,
    expiringSoon: me.credits.expiring_soon,
    tasks: tasks.data.map(taskFromDTO),
    assets: assets.data.map(assetFromDTO),
    assetsCursor: assets.next_cursor,
    folders: folders.data.map(folderFromDTO),
    ledger: ledger.data.map(ledgerFromDTO),
  };
}

export function useStore(): Ctx {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}
