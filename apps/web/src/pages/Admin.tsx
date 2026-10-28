import { REPORT_REASONS, type AdminModelDTO, type AdminOverviewDTO, type ReviewItemDTO } from '@creature/shared';
import { Check, Info, RefreshCw, ShieldOff, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Art } from '../components/Art';
import { Segmented, Switch } from '../components/ui';
import { api, BACKEND } from '../lib/api';
import { ADMIN, fmt, timeAgo } from '../lib/mock';
import { errorText, simplifyRatio, useStore } from '../lib/store';
import { AdminUsers } from './AdminUsers';

export function Admin() {
  return BACKEND === 'api' ? <LiveAdmin /> : <DemoAdmin />;
}

const pct = (v: number | null, digits = 1) => (v === null ? '—' : `${(v * 100).toFixed(digits)}%`);

function modelHealth(m: AdminModelDTO): ['ok' | 'warn' | 'down', string] {
  if (!m.enabled) return ['down', '未配置'];
  if (m.breaker_open) return ['down', '已熔断'];
  if (m.success_rate_24h !== null && m.success_rate_24h < 0.95) return ['warn', '波动'];
  return ['ok', '正常'];
}

/** 接入后端：真实的运营概览、模型健康度与广场内容复核 */
function LiveAdmin() {
  const { state, toast } = useStore();
  const [overview, setOverview] = useState<AdminOverviewDTO | null>(null);
  const [models, setModels] = useState<AdminModelDTO[]>([]);
  const [queue, setQueue] = useState<ReviewItemDTO[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'users'>('overview');
  const isAdmin = state.profile?.role === 'admin';

  const load = useCallback(async () => {
    try {
      const [o, m, q] = await Promise.all([api.adminOverview(), api.adminModels(), api.reviewQueue()]);
      setOverview(o);
      setModels(m.data);
      setQueue(q.data);
    } catch (e) {
      toast(errorText(e), 'err');
      setQueue([]);
    }
  }, [toast]);
  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, load]);

  if (!isAdmin) {
    return (
      <div className="page">
        <div className="empty">
          <ShieldOff size={28} />
          <b>需要管理员权限</b>
          <span>在后端配置 ADMIN_PHONES 后，用对应手机号重新登录即可进入管理后台</span>
        </div>
      </div>
    );
  }

  const decide = async (item: ReviewItemDTO, action: 'approve' | 'remove') => {
    setBusy(item.post.id);
    try {
      await api.decide(item.post.id, action);
      setQueue((q) => q?.filter((x) => x.post.id !== item.post.id) ?? null);
      setOverview((o) => (o ? { ...o, pending_reviews: Math.max(0, o.pending_reviews - 1) } : o));
      toast(action === 'approve' ? '已通过，作品在广场可见，相关举报已驳回' : '已下架，相关举报已处理');
    } catch (e) {
      toast(errorText(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  const kpis = overview
    ? [
        { k: '今日生成任务', v: fmt(overview.tasks_today), d: `排队 ${overview.queue.queued} · 生成中 ${overview.queue.running}` },
        { k: '今日成功率', v: pct(overview.success_rate_today), d: '失败与拦截均已返还积分' },
        { k: '今日收入', v: `¥${fmt(overview.revenue_today_fen / 100)}`, d: `消耗 ${fmt(overview.credits_consumed_today)} 积分` },
        { k: '用户', v: fmt(overview.users_total), d: `今日新增 ${overview.users_new_today}` },
      ]
    : [];

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>{tab === 'overview' ? '运营概览' : '用户管理'}</h2>
          <p>{tab === 'overview' ? '数据按北京时间统计；模型健康度来自网关 5 分钟窗口与近 24 小时任务。' : '冻结或封禁会立即让该用户退出登录；积分调整与状态变更都会写入审计日志。'}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Segmented
            label="后台页面"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'overview', label: '概览与审核' },
              { value: 'users', label: '用户' },
            ]}
          />
          {tab === 'overview' && (
            <button className="btn" onClick={() => void load()}>
              <RefreshCw size={14} /> 刷新
            </button>
          )}
        </div>
      </div>
      {tab === 'users' ? (
        <AdminUsers />
      ) : (
        <>
          <div className="kpis">
            {kpis.map((k) => (
              <div className="panel kpi" key={k.k}>
                <span className="k">{k.k}</span>
                <span className="v">{k.v}</span>
                <span className="d subtle">{k.d}</span>
              </div>
            ))}
          </div>

          <div className="admin-grid">
            <section className="panel" aria-labelledby="models-title" style={{ minWidth: 0 }}>
              <div className="section-title" style={{ padding: '16px 18px 0' }}>
                <h3 id="models-title">模型健康度</h3>
                <span className="subtle" style={{ fontSize: 12 }}>
                  5 分钟窗口成功率低于 85% 自动熔断
                </span>
              </div>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>模型</th>
                      <th>状态</th>
                      <th className="num">24 小时任务</th>
                      <th className="num">成功率</th>
                      <th className="num">P95 耗时</th>
                      <th className="num">5 分钟样本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {models.map((m) => {
                      const [h, label] = modelHealth(m);
                      return (
                        <tr key={m.code}>
                          <td>{m.name}</td>
                          <td>
                            <span className={`health ${h}`}>
                              <i />
                              {label}
                            </span>
                          </td>
                          <td className="num">{fmt(m.tasks_24h)}</td>
                          <td className="num" style={{ color: h === 'warn' ? 'var(--gold)' : undefined }}>
                            {pct(m.success_rate_24h)}
                          </td>
                          <td className="num">{m.p95_sec_24h === null ? '—' : m.p95_sec_24h >= 60 ? `${(m.p95_sec_24h / 60).toFixed(1)} 分` : `${m.p95_sec_24h} 秒`}</td>
                          <td className="num">{m.window_samples}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {overview && (
                <div style={{ padding: '14px 18px 18px' }}>
                  <div className="eyebrow" style={{ marginBottom: 8 }}>
                    近 14 天日生成量（次）
                  </div>
                  <TrendChart data={overview.trend.map((d) => d.tasks)} unit="次" />
                </div>
              )}
            </section>

            <section className="panel" aria-labelledby="mod-title" style={{ minWidth: 0 }}>
              <div className="section-title" style={{ padding: '16px 18px 4px' }}>
                <h3 id="mod-title">内容复核 · 灵感广场</h3>
                <span className="tag text">{queue?.length ?? 0} 条待处理</span>
              </div>
              {queue === null ? (
                <p className="subtle" style={{ padding: 18 }}>
                  加载中…
                </p>
              ) : queue.length === 0 ? (
                <div className="empty" style={{ margin: 16 }}>
                  <Check size={24} />
                  <b>复核队列已清空</b>
                  <span>发布时机审存疑或被举报的作品会出现在这里</span>
                </div>
              ) : (
                queue.map((item) => (
                  <div key={item.post.id} className="mod-item">
                    <Art prompt={item.post.prompt ?? item.post.title} ratio={item.post.width && item.post.height ? simplifyRatio(item.post.width, item.post.height) : '1:1'} kind={item.post.kind} url={item.post.url} badge={false} long={120} />
                    <div className="grow">
                      <p>
                        <b>{item.post.title}</b> · {item.post.prompt}
                      </p>
                      <span className="subtle" style={{ fontSize: 12 }}>
                        {item.reason === 'reviewing'
                          ? `机审存疑 · ${item.machine_labels.map((l) => l.replace(/^review:/, '')).join('、') || '待复核'}`
                          : `被举报 · ${item.reports.map((r) => `${REPORT_REASONS[r.reason]} ×${r.count}`).join('、')}${item.post.status === 'hidden' ? ' · 已自动隐藏' : ''}`}{' '}
                        · {item.post.author.nickname} · {timeAgo(Date.parse(item.post.created_at))}
                      </span>
                    </div>
                    <button className="btn sm" aria-label={`通过 ${item.post.title}`} title="通过" disabled={busy === item.post.id} onClick={() => void decide(item, 'approve')}>
                      <Check size={14} />
                    </button>
                    <button className="btn sm danger" aria-label={`下架 ${item.post.title}`} title="下架" disabled={busy === item.post.id} onClick={() => void decide(item, 'remove')}>
                      <X size={14} />
                    </button>
                  </div>
                ))
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function DemoAdmin() {
  const { toast } = useStore();
  const [models, setModels] = useState(ADMIN.models.map((m) => ({ ...m, enabled: m.health !== 'down', weight: m.share })));
  const [queue, setQueue] = useState(ADMIN.moderation);

  const decide = (id: string, pass: boolean) => {
    setQueue((q) => q.filter((x) => x.id !== id));
    toast(pass ? '已通过，内容恢复可见' : '已拦截，已通知用户并返还积分');
  };

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h2>运营概览</h2>
          <p>
            <span className="example-note">
              <Info size={13} /> 以下为示例数据，用于展示后台信息结构
            </span>
          </p>
        </div>
      </div>
      <div className="kpis">
        {ADMIN.kpis.map((k) => (
          <div className="panel kpi" key={k.k}>
            <span className="k">{k.k}</span>
            <span className="v">{k.v}</span>
            <span className="d" style={{ color: k.up ? 'var(--ok)' : 'var(--danger)' }}>
              {k.d} 较昨日
            </span>
          </div>
        ))}
      </div>

      <div className="admin-grid">
        <section className="panel" aria-labelledby="models-title" style={{ minWidth: 0 }}>
          <div className="section-title" style={{ padding: '16px 18px 0' }}>
            <h3 id="models-title">模型路由与健康度</h3>
            <span className="subtle" style={{ fontSize: 12 }}>
              5 分钟窗口 · 成功率低于 85% 自动熔断
            </span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>模型</th>
                  <th>状态</th>
                  <th className="num">成功率</th>
                  <th className="num">P95 耗时</th>
                  <th>路由权重</th>
                  <th>启用</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.code}>
                    <td>{m.name}</td>
                    <td>
                      <span className={`health ${m.health}`}>
                        <i />
                        {m.health === 'ok' ? '正常' : m.health === 'warn' ? '波动' : '已熔断'}
                      </span>
                    </td>
                    <td className="num" style={{ color: m.success < 85 ? 'var(--danger)' : m.success < 95 ? 'var(--gold)' : undefined }}>
                      {m.success.toFixed(1)}%
                    </td>
                    <td className="num">{m.p95 >= 60 ? `${(m.p95 / 60).toFixed(1)} 分` : `${m.p95} 秒`}</td>
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <input
                          id={`w-${m.code}`}
                          className="range"
                          type="range"
                          min={0}
                          max={60}
                          value={m.weight}
                          disabled={!m.enabled}
                          aria-label={`${m.name} 路由权重`}
                          onChange={(e) => setModels((ms) => ms.map((x) => (x.code === m.code ? { ...x, weight: Number(e.target.value) } : x)))}
                        />
                        <span className="mono subtle" style={{ fontSize: 12, width: 24 }}>
                          {m.weight}
                        </span>
                      </span>
                    </td>
                    <td>
                      <Switch
                        checked={m.enabled}
                        label={`启用 ${m.name}`}
                        onChange={(v) => {
                          setModels((ms) => ms.map((x) => (x.code === m.code ? { ...x, enabled: v } : x)));
                          toast(`${m.name} 已${v ? '启用' : '停用'}，路由将在 30 秒内生效`, 'info');
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '14px 18px 18px' }}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              近 19 天日生成量（千次）
            </div>
            <TrendChart data={ADMIN.trend} unit="千次" />
          </div>
        </section>

        <section className="panel" aria-labelledby="mod-title" style={{ minWidth: 0 }}>
          <div className="section-title" style={{ padding: '16px 18px 4px' }}>
            <h3 id="mod-title">内容审核 · 人工复核</h3>
            <span className="tag text">{queue.length} 条待处理</span>
          </div>
          {queue.length === 0 ? (
            <div className="empty" style={{ margin: 16 }}>
              <Check size={24} />
              <b>复核队列已清空</b>
              <span>机审疑似内容会自动进入这里</span>
            </div>
          ) : (
            queue.map((m) => (
              <div key={m.id} className="mod-item">
                <Art prompt={m.seed} ratio="1:1" badge={false} long={120} />
                <div className="grow">
                  <p>{m.prompt}</p>
                  <span className="subtle" style={{ fontSize: 12 }}>
                    {{ image: '图像', video: '视频', text: '文本' }[m.kind]} · {m.label} · {m.user}
                  </span>
                </div>
                <button className="btn sm" aria-label="通过" onClick={() => decide(m.id, true)}>
                  <Check size={14} />
                </button>
                <button className="btn sm danger" aria-label="拦截" onClick={() => decide(m.id, false)}>
                  <X size={14} />
                </button>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

function TrendChart({ data, unit }: { data: number[]; unit: string }) {
  const W = 560;
  const H = 120;
  const pad = { l: 28, r: 10, t: 10, b: 16 };
  const step = Math.max(...data) > 50 ? 50 : 5;
  const top = Math.max(step, Math.ceil(Math.max(...data) / step) * step);
  const x = (i: number) => pad.l + (i / (data.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const line = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z`;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`日生成量由 ${data[0]} ${unit}变为 ${data[data.length - 1]} ${unit}`}>
      {[0, top / 2, top].map((t) => (
        <g key={t}>
          <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
          <text x={pad.l - 4} y={y(t) + 3} textAnchor="end">
            {t}
          </text>
        </g>
      ))}
      <path d={area} fill="var(--accent-soft)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r={4} fill="var(--accent)" />
      <text x={x(data.length - 1) - 6} y={y(data[data.length - 1]) - 8} textAnchor="end" style={{ fill: 'var(--fg)' }}>
        {data[data.length - 1]}
      </text>
    </svg>
  );
}
