import type { AdminUserDetailDTO, AdminUserDTO, UserStatus } from '@creature/shared';
import { Search } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Drawer, Status } from '../components/ui';
import { api } from '../lib/api';
import { fmt, timeAgo } from '../lib/mock';
import { errorText, uid, useStore } from '../lib/store';

const STATUS_LABEL: Record<UserStatus, [string, string]> = { active: ['正常', 'ok'], frozen: ['已冻结', 'text'], banned: ['已封禁', 'danger'] };
const ACTION_LABEL: Record<string, string> = { 'user.freeze': '冻结', 'user.ban': '封禁', 'user.restore': '解除限制', 'user.credits_adjust': '调整积分' };
const MODALITY_LABEL = { image: '图像', video: '视频', text: '写作', audio: '音频' } as const;

/** 后台用户管理：搜索、查看详情、冻结 / 封禁 / 解除、人工调整积分 */
export function AdminUsers() {
  const { toast } = useStore();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<UserStatus | ''>('');
  const [list, setList] = useState<AdminUserDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(
    async (more: boolean, from: string | null) => {
      try {
        const page = await api.adminUsers({ q: q.trim() || undefined, status: status || undefined, cursor: more ? from : null });
        setList((cur) => [...(more && cur ? cur : []), ...page.data]);
        setCursor(page.next_cursor);
      } catch (e) {
        toast(errorText(e), 'err');
        setList([]);
      }
    },
    [q, status, toast],
  );
  useEffect(() => {
    const t = window.setTimeout(() => void load(false, null), q ? 300 : 0);
    return () => window.clearTimeout(t);
  }, [load, q]);

  const updated = (u: AdminUserDTO) => setList((l) => l?.map((x) => (x.id === u.id ? { ...x, ...u } : x)) ?? null);

  return (
    <section className="panel" aria-labelledby="users-title" style={{ minWidth: 0 }}>
      <div className="section-title" style={{ padding: '16px 18px 8px', flexWrap: 'wrap', gap: 10 }}>
        <h3 id="users-title">用户</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="chips" role="group" aria-label="账号状态">
            {(
              [
                ['', '全部'],
                ['active', '正常'],
                ['frozen', '已冻结'],
                ['banned', '已封禁'],
              ] as const
            ).map(([v, l]) => (
              <button key={v} className="chip" aria-pressed={status === v} onClick={() => setStatus(v)}>
                {l}
              </button>
            ))}
          </div>
          <label className="search-box" style={{ width: 260 }}>
            <Search size={15} />
            <input aria-label="搜索用户" placeholder="手机号 / 后 4 位 / 昵称 / 用户 ID" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>用户</th>
              <th>手机号</th>
              <th>套餐</th>
              <th className="num">可用积分</th>
              <th className="num">任务</th>
              <th>状态</th>
              <th>注册</th>
            </tr>
          </thead>
          <tbody>
            {list?.map((u) => (
              <tr key={u.id} className="clickable" onClick={() => setOpen(u.id)}>
                <td>
                  <button className="link" onClick={() => setOpen(u.id)}>
                    {u.nickname}
                  </button>
                  {u.role === 'admin' && (
                    <span className="tag" style={{ marginLeft: 6 }}>
                      管理员
                    </span>
                  )}
                </td>
                <td className="mono">{u.phone_masked}</td>
                <td>{u.plan.name}</td>
                <td className="num">{fmt(u.credits.available)}</td>
                <td className="num">{fmt(u.tasks_total)}</td>
                <td>
                  <span className={`tag ${STATUS_LABEL[u.status][1]}`}>{STATUS_LABEL[u.status][0]}</span>
                </td>
                <td className="subtle">{timeAgo(Date.parse(u.created_at))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list?.length === 0 && (
          <p className="subtle" style={{ padding: 18 }}>
            没有符合条件的用户
          </p>
        )}
      </div>
      {cursor && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 14 }}>
          <button className="btn" onClick={() => void load(true, cursor)}>
            加载更多
          </button>
        </div>
      )}
      {open && <UserDrawer id={open} onClose={() => setOpen(null)} onChange={updated} />}
    </section>
  );
}

function UserDrawer({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: (u: AdminUserDTO) => void }) {
  const { toast } = useStore();
  const [u, setU] = useState<AdminUserDetailDTO | null>(null);
  const [mode, setMode] = useState<'status' | 'credits' | null>(null);
  const [next, setNext] = useState<UserStatus>('frozen');
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // 同一次调整重复点击只生效一次
  const [requestId, setRequestId] = useState(() => uid('adj-'));

  useEffect(() => {
    api.adminUser(id).then(setU, (e) => toast(errorText(e), 'err'));
  }, [id, toast]);

  const apply = (d: AdminUserDetailDTO, msg: string) => {
    setU(d);
    onChange(d);
    setMode(null);
    setReason('');
    setDelta('');
    setRequestId(uid('adj-'));
    toast(msg);
  };

  const submit = async () => {
    if (!u) return;
    setBusy(true);
    try {
      if (mode === 'status') apply(await api.setUserStatus(u.id, next, reason.trim()), next === 'active' ? '已解除限制' : `已${STATUS_LABEL[next][0].slice(1)}，该用户的登录已失效`);
      else apply(await api.adjustCredits(u.id, Number(delta), reason.trim(), requestId), `已${Number(delta) > 0 ? '增加' : '扣减'} ${Math.abs(Number(delta))} 积分`);
    } catch (e) {
      toast(errorText(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  // 管理员账号不能在后台限制（服务端同样拒绝），不显示冻结入口
  const protectedAccount = u?.role === 'admin';
  const deltaOk = /^-?\d+$/.test(delta.trim()) && Number(delta) !== 0 && Math.abs(Number(delta)) <= 100000;

  return (
    <Drawer title={u ? u.nickname : '用户详情'} onClose={onClose}>
      {!u ? (
        <p className="subtle">加载中…</p>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          <dl className="kv">
            <dt>用户 ID</dt>
            <dd className="mono">{u.id}</dd>
            <dt>手机号</dt>
            <dd className="mono">{u.phone_masked}</dd>
            <dt>状态</dt>
            <dd>
              <span className={`tag ${STATUS_LABEL[u.status][1]}`}>{STATUS_LABEL[u.status][0]}</span>
              {u.role === 'admin' && <span className="tag" style={{ marginLeft: 6 }}>管理员</span>}
            </dd>
            <dt>套餐</dt>
            <dd>
              {u.plan.name}
              {u.plan.expires_at && <span className="subtle"> · {new Date(u.plan.expires_at).toLocaleDateString('zh-CN')} 到期</span>}
            </dd>
            <dt>积分</dt>
            <dd>
              可用 {fmt(u.credits.available)} · 冻结 {fmt(u.credits.frozen)}
            </dd>
            <dt>数据</dt>
            <dd>
              任务 {u.tasks_total}（成功 {u.stats.tasks_succeeded} / 失败 {u.stats.tasks_failed}）· 作品 {u.stats.assets} · 发布 {u.stats.posts} · 被举报 {u.stats.reports_received}
            </dd>
            <dt>注册</dt>
            <dd>{new Date(u.created_at).toLocaleString('zh-CN')}</dd>
          </dl>

          {mode ? (
            <form
              className="panel publish-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              {mode === 'status' ? (
                <div className="chips" role="group" aria-label="设置状态">
                  {(['frozen', 'banned', 'active'] as UserStatus[])
                    .filter((s) => s !== u.status)
                    .map((s) => (
                      <button key={s} type="button" className="chip" aria-pressed={next === s} onClick={() => setNext(s)}>
                        {s === 'active' ? '解除限制' : s === 'frozen' ? '冻结' : '封禁'}
                      </button>
                    ))}
                </div>
              ) : (
                <div className="field">
                  <label htmlFor="adj-delta">调整数量 <span className="subtle">正数增加、负数扣减，单次不超过 100000</span></label>
                  <input id="adj-delta" className="input mono" inputMode="numeric" placeholder="如 50 或 -30" value={delta} onChange={(e) => setDelta(e.target.value)} />
                </div>
              )}
              <div className="field">
                <label htmlFor="adm-reason">原因 <span className="subtle">会写入审计日志{mode === 'credits' ? '，并显示在用户的积分明细中' : ''}</span></label>
                <input id="adm-reason" className="input" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn" onClick={() => setMode(null)}>
                  取消
                </button>
                <button type="submit" className={`btn primary ${mode === 'status' && next !== 'active' ? 'danger' : ''}`} style={{ flex: 1 }} disabled={busy || reason.trim().length < 2 || (mode === 'credits' && !deltaOk)}>
                  确认
                </button>
              </div>
            </form>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => setMode('credits')}>
                调整积分
              </button>
              {!protectedAccount && (
                <button
                  className="btn"
                  onClick={() => {
                    setNext(u.status === 'active' ? 'frozen' : 'active');
                    setMode('status');
                  }}
                >
                  {u.status === 'active' ? '冻结 / 封禁' : '解除限制'}
                </button>
              )}
            </div>
          )}

          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              最近任务
            </div>
            {u.recent_tasks.length === 0 ? (
              <p className="subtle">暂无</p>
            ) : (
              u.recent_tasks.map((t) => (
                <div key={t.id} className="admin-row">
                  <span className="grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {MODALITY_LABEL[t.modality]} · {t.prompt}
                  </span>
                  <span className="mono subtle">{t.credits}</span>
                  <Status value={t.status === 'post_processing' ? 'running' : t.status} />
                </div>
              ))
            )}
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              积分明细
            </div>
            {u.ledger.slice(0, 10).map((e) => (
              <div key={e.id} className="admin-row">
                <span className="grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {e.memo}
                </span>
                <span className="mono" style={{ color: e.delta_available > 0 ? 'var(--ok)' : undefined }}>
                  {e.delta_available > 0 ? '+' : ''}
                  {e.delta_available || (e.delta_frozen ? `冻结 ${e.delta_frozen}` : 0)}
                </span>
                <span className="subtle">{timeAgo(Date.parse(e.created_at))}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              操作记录
            </div>
            {u.audit.length === 0 ? (
              <p className="subtle">暂无</p>
            ) : (
              u.audit.map((a, i) => (
                <div key={i} className="admin-row">
                  <span className="grow">
                    {a.actor_nickname} {ACTION_LABEL[a.action] ?? a.action}
                    {typeof a.detail.delta === 'number' ? ` ${a.detail.delta > 0 ? '+' : ''}${a.detail.delta}` : ''}
                    {typeof a.detail.reason === 'string' ? ` · ${a.detail.reason}` : ''}
                  </span>
                  <span className="subtle">{timeAgo(Date.parse(a.created_at))}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
