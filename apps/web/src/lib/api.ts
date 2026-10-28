import type {
  AdminModelDTO,
  AdminOverviewDTO,
  AdminUserDetailDTO,
  AdminUserDTO,
  ApiErrorBody,
  AssetDTO,
  BalanceDTO,
  CanvasDocDTO,
  CanvasDTO,
  DownloadDTO,
  FeedTab,
  FolderDTO,
  GenerationParams,
  LedgerEntryDTO,
  MeDTO,
  Modality,
  OrderDTO,
  Page,
  PostDTO,
  ProjectDTO,
  ReconcileRunDTO,
  ReferenceDTO,
  RemixDTO,
  ReportReason,
  ReviewItemDTO,
  RoutingStrategy,
  ServerEvent,
  TaskDTO,
  UploadTicketDTO,
  UserStatus,
} from '@creature/shared';

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
const suspendedListeners = new Set<() => void>();

/** 账号被后台冻结或封禁时触发（任意接口返回 ACCOUNT_SUSPENDED） */
export const onAccountSuspended = (fn: () => void) => {
  suspendedListeners.add(fn);
  return () => {
    suspendedListeners.delete(fn);
  };
};

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
    if (err?.code === 'ACCOUNT_SUSPENDED') {
      setToken(null);
      suspendedListeners.forEach((fn) => fn());
    }
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? '网络异常，请稍后重试', err?.details);
  }
  return data as T;
}

/**
 * 用 Cookie 中的刷新令牌换取新的访问令牌；并发调用只发一次请求。
 * 只有服务端明确拒绝（401 / 403）时才退出登录；网络中断或服务暂时不可用（如实例滚动重启）时保留当前令牌。
 */
export function refresh(): Promise<boolean> {
  refreshing ??= raw<{ access_token: string }>('POST', '/auth/refresh', {})
    .then((r) => {
      setToken(r.access_token);
      return true;
    })
    .catch((e) => {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) setToken(null);
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
  references?: ReferenceDTO[];
  /** 图像编辑的涂抹区域（PNG data URL） */
  mask?: string;
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
  assets: (f: { cursor?: string | null; folder?: string; q?: string } = {}) => call<Page<AssetDTO>>('GET', `/assets${qs({ limit: 50, ...f })}`),
  downloadAsset: (id: string) => call<DownloadDTO>('GET', `/assets/${id}/download`),
  moveAssets: (ids: string[], folderId: string | null) => call<{ moved: number }>('POST', '/assets/move', { ids, folder_id: folderId }),
  folders: () => call<{ data: FolderDTO[] }>('GET', '/asset-folders'),
  createFolder: (name: string) => call<FolderDTO>('POST', '/asset-folders', { name }),
  renameFolder: (id: string, name: string) => call<void>('PATCH', `/asset-folders/${id}`, { name }),
  deleteFolder: (id: string) => call<void>('DELETE', `/asset-folders/${id}`),
  updateAsset: (id: string, patch: { favorite?: boolean; title?: string }) => call<AssetDTO>('PATCH', `/assets/${id}`, patch),
  deleteAsset: (id: string) => call<void>('DELETE', `/assets/${id}`),
  createOrder: (body: { item_type: 'subscription'; item_ref: string; cycle: 'month' | 'year' } | { item_type: 'credit_pack'; item_ref: string }) => call<OrderDTO>('POST', '/orders', body),
  mockPay: (id: string) => call<OrderDTO>('POST', `/orders/${id}/mock-pay`, {}),

  /** 上传图片：创建会话 → PUT 到签名地址 → 完成（审核通过后返回资产） */
  async uploadImage(file: File): Promise<AssetDTO> {
    const ticket = await call<UploadTicketDTO>('POST', '/assets/uploads', { filename: file.name, mime: file.type, size: file.size });
    const put = await fetch(ticket.upload_url, { method: 'PUT', headers: ticket.headers, body: file });
    if (!put.ok) {
      const err = ((await put.json().catch(() => null)) as ApiErrorBody | null)?.error;
      throw new ApiError(put.status, err?.code ?? `HTTP_${put.status}`, err?.message ?? '上传失败，请重试');
    }
    return call<AssetDTO>('POST', `/assets/uploads/${ticket.upload_id}/complete`, {});
  },

  feed: (tab: FeedTab, kind?: 'image' | 'video', cursor?: string | null) => call<Page<PostDTO>>('GET', `/feed${qs({ tab, kind, cursor, limit: 20 })}`),
  publish: (body: { asset_id: string; title: string; tags: string[]; show_prompt: boolean }) => call<PostDTO>('POST', '/posts', body),
  post: (id: string) => call<PostDTO>('GET', `/posts/${id}`),
  withdrawPost: (id: string) => call<void>('DELETE', `/posts/${id}`),
  setLike: (id: string, on: boolean) => call<{ liked: boolean; like_count: number }>(on ? 'PUT' : 'DELETE', `/posts/${id}/like`),
  remix: (id: string) => call<RemixDTO>('POST', `/posts/${id}/remix`, {}),
  report: (postId: string, reason: ReportReason, detail?: string) => call<{ id: string }>('POST', '/reports', { target_type: 'post', target_id: postId, reason, detail }),

  adminOverview: () => call<AdminOverviewDTO>('GET', '/admin/overview'),
  adminModels: () => call<{ data: AdminModelDTO[] }>('GET', '/admin/models'),
  reviewQueue: () => call<{ data: ReviewItemDTO[] }>('GET', '/admin/review-queue'),
  decide: (postId: string, action: 'approve' | 'remove', note?: string) => call<PostDTO>('POST', `/admin/posts/${postId}/decision`, { action, note }),
  reconcileRuns: () => call<{ data: ReconcileRunDTO[] }>('GET', '/admin/reconcile'),
  runReconcile: () => call<ReconcileRunDTO>('POST', '/admin/reconcile/run', {}),
  adminUsers: (f: { q?: string; status?: UserStatus; cursor?: string | null }) => call<Page<AdminUserDTO>>('GET', `/admin/users${qs({ limit: 30, ...f })}`),
  adminUser: (id: string) => call<AdminUserDetailDTO>('GET', `/admin/users/${id}`),
  setUserStatus: (id: string, status: UserStatus, reason: string) => call<AdminUserDetailDTO>('POST', `/admin/users/${id}/status`, { status, reason }),
  adjustCredits: (id: string, delta: number, reason: string, requestId: string) => call<AdminUserDetailDTO>('POST', `/admin/users/${id}/credits`, { delta, reason, request_id: requestId }),

  projects: () => call<{ data: ProjectDTO[] }>('GET', '/projects'),
  createProject: (name: string, doc?: CanvasDocDTO) => call<CanvasDTO>('POST', '/projects', { name, doc }),
  deleteProject: (id: string) => call<void>('DELETE', `/projects/${id}`),
  latestCanvas: () => call<CanvasDTO>('GET', '/canvases/latest'),
  canvas: (id: string) => call<CanvasDTO>('GET', `/canvases/${id}`),
  saveCanvas: (id: string, body: { doc: CanvasDocDTO; version: number; name?: string }) => call<{ version: number; updated_at: string }>('PUT', `/canvases/${id}`, body),
};

/**
 * 订阅服务端推送。EventSource 无法设置请求头，访问令牌通过查询参数传递；
 * 断线或令牌更新时自动重连，重连后发出 sync（期间的事件可能已丢失）。返回取消订阅函数。
 */
export function subscribeEvents(onEvent: (e: ServerEvent) => void): () => void {
  let es: EventSource | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let opened = false;

  const open = () => {
    if (closed || !accessToken) return;
    es?.close();
    es = new EventSource(`/v1/events?access_token=${encodeURIComponent(accessToken)}`);
    es.onopen = () => {
      if (opened) onEvent({ type: 'sync' });
      opened = true;
    };
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
      // 可能是访问令牌过期：刷新成功会触发令牌变更，从而重连；服务暂时不可用时保留登录状态，稍后再连
      retry = setTimeout(() => void refresh().then((ok) => !ok && open()), 3000);
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
