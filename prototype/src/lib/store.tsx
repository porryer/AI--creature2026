import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { INITIAL_ASSETS, INITIAL_LEDGER, NOW } from './mock';
import { estimateCredits, TIER_LABEL } from './models';
import type { Asset, LedgerEntry, Modality, ModelInfo, Notice, Task, Toast } from './types';

// 全局状态：积分账户、生成任务、资产、积分流水、通知。
// 任务进度按时间模拟：排队 → 生成中 → 完成 / 失败（失败与审核拦截全额返还）。

export type Theme = 'system' | 'dark' | 'light';

export interface Handoff {
  to: 'studio' | 'canvas';
  prompt?: string;
  mode?: Modality;
  autostart?: boolean;
  agentPrompt?: string;
  templateId?: string;
  firstFrame?: Asset;
}

interface State {
  available: number;
  frozen: number;
  tasks: Task[];
  assets: Asset[];
  ledger: LedgerEntry[];
  notices: Notice[];
  toasts: Toast[];
  handoff: Handoff | null;
  theme: Theme;
  viewer: Asset | null;
}

type Action =
  | { type: 'add_task'; task: Task; ledger?: LedgerEntry }
  | { type: 'patch_task'; id: string; patch: Partial<Task> }
  | { type: 'finish_task'; id: string; ok: boolean; outputs: Task['outputs']; assets: Asset[]; error?: string }
  | { type: 'charge'; credits: number; label: string }
  | { type: 'grant'; credits: number; label: string }
  | { type: 'add_asset'; asset: Asset }
  | { type: 'patch_asset'; id: string; patch: Partial<Asset> }
  | { type: 'remove_assets'; ids: string[] }
  | { type: 'toast'; toast: Toast }
  | { type: 'dismiss'; id: string }
  | { type: 'notice'; notice: Notice }
  | { type: 'read_notices' }
  | { type: 'handoff'; handoff: Handoff | null }
  | { type: 'theme'; theme: Theme }
  | { type: 'viewer'; asset: Asset | null };

let seq = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

const MOD_WORDS = ['违规', '血腥', '暴恐', '色情'];

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
    case 'charge': {
      const balance = s.available - a.credits;
      return { ...s, available: balance, ledger: [{ id: uid('lg'), time: Date.now(), type: 'settle', label: a.label, delta: -a.credits, balance }, ...s.ledger] };
    }
    case 'grant': {
      const balance = s.available + a.credits;
      return { ...s, available: balance, ledger: [{ id: uid('lg'), time: Date.now(), type: 'grant', label: a.label, delta: a.credits, balance }, ...s.ledger] };
    }
    case 'add_asset':
      return { ...s, assets: [a.asset, ...s.assets] };
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
  }
}

function seedTasks(): Task[] {
  const mk = (id: string, prompt: string, model: ModelInfo, params: Task['params'], count: number, ago: number, modality: Modality): Task => ({
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
    outputs: Array.from({ length: count }, (_, i) => ({
      id: `${id}_${i}`,
      kind: modality,
      prompt,
      ratio: String(params.ratio ?? '3:4'),
      variant: i,
      durationSec: modality === 'video' ? Number(params.duration) : undefined,
    })),
    source: 'studio',
    count,
    queueMs: 0,
    runMs: 0,
  });
  return [
    mk(
      'seed_img_1',
      '秋日午后的咖啡馆窗边，一杯枫糖拿铁，暖色逆光，胶片质感，浅景深',
      { code: 'seedream-4', name: 'Seedream 4.0', vendor: '火山方舟', modality: 'image', tier: 'advanced', quality: 5, speed: 4, price: 4, unit: '张', tags: [], desc: '' },
      { ratio: '3:4', resolution: '2k', count: 4 },
      4,
      2 * 3600_000,
      'image',
    ),
    mk(
      'seed_vid_1',
      '秋日咖啡馆，镜头缓慢推进到冒着热气的拿铁，落叶飘过窗外',
      { code: 'kling-3.0', name: 'Kling 3.0', vendor: '可灵', modality: 'video', tier: 'flagship', quality: 5, speed: 2, price: 15, unit: '秒', tags: [], desc: '', nativeAudio: true },
      { ratio: '9:16', resolution: '1080p', duration: 10 },
      1,
      3 * 3600_000,
      'video',
    ),
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

const initial: State = {
  available: 1268,
  frozen: 0,
  tasks: seedTasks(),
  assets: INITIAL_ASSETS,
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
};

export interface SubmitSpec {
  modality: Modality;
  prompt: string;
  model: ModelInfo;
  params: Task['params'];
  count?: number;
  source?: Task['source'];
}

interface Ctx {
  state: State;
  submit: (spec: SubmitSpec) => string | null;
  charge: (credits: number, label: string) => boolean;
  grant: (credits: number, label: string) => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  dismiss: (id: string) => void;
  addAsset: (asset: Asset) => void;
  patchAsset: (id: string, patch: Partial<Asset>) => void;
  removeAssets: (ids: string[]) => void;
  setHandoff: (h: Handoff | null) => void;
  setTheme: (t: Theme) => void;
  openViewer: (a: Asset | null) => void;
  readNotices: () => void;
}

const StoreCtx = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const ref = useRef(state);
  ref.current = state;

  const toast = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = uid('t');
    dispatch({ type: 'toast', toast: { id, kind, text } });
    window.setTimeout(() => dispatch({ type: 'dismiss', id }), kind === 'err' ? 6000 : 3200);
  }, []);

  const submit = useCallback(
    (spec: SubmitSpec): string | null => {
      const count = spec.count ?? Number(spec.params.count ?? 1);
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
        count,
        queueMs: 900 + Math.random() * 900,
        runMs: (3200 + Math.random() * 2400) * slow * (spec.model.speed >= 4 ? 0.8 : 1.15),
        failAt: spec.prompt.includes('失败') ? 0.6 : undefined,
        error: blocked ? '提示词可能违反社区规范，未生成，积分未扣除' : undefined,
      };
      const spec2 = spec.modality === 'image' ? `${String(spec.params.resolution ?? '1k').toUpperCase()} ×${count}` : spec.modality === 'video' ? `${spec.params.duration} 秒 ${spec.params.resolution}` : TIER_LABEL[spec.model.tier];
      const ledger: LedgerEntry | undefined = blocked
        ? undefined
        : { id: `lg_${id}`, time: Date.now(), type: 'freeze', label: `冻结 · ${{ image: '图像生成', video: '视频生成', text: '写作', audio: '音频生成' }[spec.modality]} · ${spec.model.name} · ${spec2}`, delta: -credits, balance: ref.current.available - credits };
      dispatch({ type: 'add_task', task, ledger });
      if (blocked) toast('内容可能违反社区规范，未生成，积分未扣除', 'err');
      return id;
    },
    [toast],
  );

  // 任务进度模拟
  useEffect(() => {
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
          dispatch({ type: 'notice', notice: { id: uid('n'), time: now, kind: 'err', title: `生成失败，已返还 ${t.credits} 积分`, body: t.model.name } });
          continue;
        }
        if (p >= 1) {
          const outputs = Array.from({ length: t.count }, (_, i) => ({
            id: `${t.id}_${i}`,
            kind: t.modality,
            prompt: t.prompt,
            ratio: String(t.params.ratio ?? (t.modality === 'audio' ? '1:1' : '3:4')),
            variant: i,
            durationSec: t.modality === 'video' ? Number(t.params.duration) : t.modality === 'audio' ? Number(t.params.seconds ?? 12) : undefined,
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
          }));
          dispatch({ type: 'finish_task', id: t.id, ok: true, outputs, assets });
          const label = { image: '图像', video: '视频', text: '文本', audio: '音频' }[t.modality];
          if (t.source === 'studio' || t.source === 'template') toast(`${label}生成完成 · 消耗 ${t.credits} 积分`);
          dispatch({ type: 'notice', notice: { id: uid('n'), time: now, kind: 'ok', title: `${label}生成完成`, body: `${t.prompt.slice(0, 18)} · ${t.count} 个结果` } });
          continue;
        }
        const progress = Math.round(p * 100);
        if (t.status !== 'running' || Math.abs(progress - t.progress) >= 2) {
          dispatch({ type: 'patch_task', id: t.id, patch: { status: 'running', progress, queuePos: 0 } });
        }
      }
    }, 300);
    return () => window.clearInterval(timer);
  }, [toast]);

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
      submit,
      toast,
      charge: (credits, label) => {
        if (credits > ref.current.available) {
          toast(`积分不足：需要 ${credits} 积分，当前可用 ${ref.current.available}`, 'err');
          return false;
        }
        dispatch({ type: 'charge', credits, label });
        return true;
      },
      grant: (credits, label) => dispatch({ type: 'grant', credits, label }),
      dismiss: (id) => dispatch({ type: 'dismiss', id }),
      addAsset: (asset) => dispatch({ type: 'add_asset', asset }),
      patchAsset: (id, patch) => dispatch({ type: 'patch_asset', id, patch }),
      removeAssets: (ids) => dispatch({ type: 'remove_assets', ids }),
      setHandoff: (h) => dispatch({ type: 'handoff', handoff: h }),
      setTheme: (t) => dispatch({ type: 'theme', theme: t }),
      openViewer: (a) => dispatch({ type: 'viewer', asset: a }),
      readNotices: () => dispatch({ type: 'read_notices' }),
    }),
    [state, submit, toast],
  );

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore(): Ctx {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内使用');
  return ctx;
}
