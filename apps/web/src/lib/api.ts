import type { ApiErrorBody, AssetDTO, BalanceDTO, GenerationParams, LedgerEntryDTO, MeDTO, Modality, OrderDTO, Page, RoutingStrategy, ServerEvent, TaskDTO } from '@creature/shared';

/** api：连接后端；mock：本地模拟数据的离线演示 */
export const BACKEND: 'api' | 'mock' = import.meta.env.VITE_BACKEND === 'api' ? 'api' : 'mock';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

// 访问令牌只保存在内存中；刷新令牌由后端写入 httpOnly Cookie，脚本无法读取
let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const tokenListeners = new Set<(token: string | null) => void>();

export const onTokenChange = (fn: (token: string | null) => void) => {
  tokenListeners.add(fn);
  return () => tokenListeners.delete(fn);
};

function setToken(token: string | null) {
  accessToken = token;
  tokenListeners.forEach((fn) => fn(token));
}

async function raw<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`/v1${path}`, {
    method,
    credentials: 'include',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? '网络异常，请稍后重试', err?.details);
  }
  return data as T;
}

/** 用 Cookie 中的刷新令牌换取新的访问令牌；并发调用只发一次请求 */
export function refresh(): Promise<boolean> {
  refreshing ??= raw<{ access_token: string }>('POST', '/auth/refresh', {})
    .then((r) => {
      setToken(r.access_token);
      return true;
    })
    .catch(() => {
      setToken(null);
      return false;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/** 带认证的请求：访问令牌过期时自动刷新并重试一次 */
async function call<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  try {
    return await raw<T>(method, path, body, headers);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && (await refresh())) return raw<T>(method, path, body, headers);
    throw e;
  }
}

const qs = (o: Record<string, string | number | boolean | undefined | null>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? `?${new URLSearchParams(p.map(([k, v]) => [k, String(v)])).toString()}` : '';
};

export interface CreateGenerationBody {
  modality: Modality;
  operation?: 'generate' | 'edit';
  prompt: string;
  params: GenerationParams;
  routing: { strategy: RoutingStrategy; pinned_model?: string | null };
  source?: TaskDTO['source'];
}

export const api = {
  sendCode: (phone: string) => raw<{ expires_in: number; dev_code?: string }>('POST', '/auth/sms/send', { phone }),
  async login(phone: string, code: string) {
    const r = await raw<{ access_token: string; user_id: string; is_new: boolean }>('POST', '/auth/sms/login', { phone, code });
    setToken(r.access_token);
    return r;
  },
  async logout() {
    await raw('POST', '/auth/logout', {}).catch(() => undefined);
    setToken(null);
  },
  me: () => call<MeDTO>('GET', '/me'),
  balance: () => call<BalanceDTO>('GET', '/credits/balance'),
  ledger: (cursor?: string) => call<Page<LedgerEntryDTO>>('GET', `/credits/ledger${qs({ limit: 30, cursor })}`),
  createGeneration: (body: CreateGenerationBody, idempotencyKey: string) => call<TaskDTO>('POST', '/generations', body, { 'idempotency-key': idempotencyKey }),
  generations: (modality?: Modality) => call<Page<TaskDTO>>('GET', `/generations${qs({ limit: 30, modality })}`),
  cancelGeneration: (id: string) => call<TaskDTO>('POST', `/generations/${id}/cancel`, {}),
  assets: () => call<Page<AssetDTO>>('GET', `/assets${qs({ limit: 50 })}`),
  updateAsset: (id: string, patch: { favorite?: boolean; title?: string }) => call<AssetDTO>('PATCH', `/assets/${id}`, patch),
  deleteAsset: (id: string) => call<void>('DELETE', `/assets/${id}`),
  createOrder: (body: { item_type: 'subscription'; item_ref: string; cycle: 'month' | 'year' } | { item_type: 'credit_pack'; item_ref: string }) => call<OrderDTO>('POST', '/orders', body),
  mockPay: (id: string) => call<OrderDTO>('POST', `/orders/${id}/mock-pay`, {}),
};

/**
 * 订阅服务端推送。EventSource 无法设置请求头，访问令牌通过查询参数传递；
 * 断线或令牌更新时自动重连。返回取消订阅函数。
 */
export function subscribeEvents(onEvent: (e: ServerEvent) => void): () => void {
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const open = () => {
    if (closed || !accessToken) return;
    es?.close();
    es = new EventSource(`/v1/events?access_token=${encodeURIComponent(accessToken)}`);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as ServerEvent);
      } catch {
        /* 忽略无法解析的消息 */
      }
    };
    es.onerror = () => {
      es?.close();
      clearTimeout(retry);
      // 可能是访问令牌过期：刷新成功会触发令牌变更，从而重连
      retry = setTimeout(() => void refresh(), 3000);
    };
  };

  const off = onTokenChange(() => open());
  open();
  return () => {
    closed = true;
    off();
    clearTimeout(retry);
    es?.close();
  };
}
