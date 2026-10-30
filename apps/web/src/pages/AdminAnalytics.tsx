import { EVENT_LABEL, type AdminAnalyticsDTO } from '@creature/shared';
import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Segmented } from '../components/ui';
import { api } from '../lib/api';
import { fmt } from '../lib/mock';
import { errorText, useStore } from '../lib/store';

const ratio = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—');
const weekLabel = (w: string) => `${Number(w.slice(5, 7))}/${Number(w.slice(8, 10))}`;

/** 后台数据看板：核心漏斗、北极星指标、事件计数、热门模板与付费转化（docs/02-prd.md 第 6 节） */
export function AdminAnalytics() {
  const { toast } = useStore();
  const [days, setDays] = useState(7);
  const [data, setData] = useState<AdminAnalyticsDTO | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.adminAnalytics(days));
    } catch (e) {
      toast(errorText(e), 'err');
    }
  }, [days, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <p className="subtle">加载中…</p>;
  const { funnel, north_star: ns, paywall } = data;
  const by = Object.fromEntries(funnel.map((s) => [s.key, s.users]));
  const thisWeek = ns.at(-1)?.works ?? 0;
  const lastWeek = ns.at(-2)?.works ?? 0;
  const kpis = [
    { k: '本周成品数（北极星）', v: fmt(thisWeek), d: `上周 ${fmt(lastWeek)}` },
    { k: '提交 → 成功', v: ratio(by.succeeded, by.submitted), d: `${by.succeeded} / ${by.submitted} 人` },
    { k: '成功 → 导出', v: ratio(by.exported, by.succeeded), d: `${by.exported} / ${by.succeeded} 人` },
    { k: '付费墙 → 付费', v: ratio(paywall.paid_users, paywall.shown_users), d: `${paywall.paid_orders} 笔 · ¥${fmt(paywall.amount_fen / 100)}` },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }} data-testid="admin-analytics">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Segmented
          label="统计周期"
          value={days}
          onChange={setDays}
          options={[
            { value: 7, label: '近 7 天' },
            { value: 30, label: '近 30 天' },
            { value: 90, label: '近 90 天' },
          ]}
        />
        <button className="btn" onClick={() => void load()}>
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

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
        <section className="panel" aria-labelledby="funnel-title" style={{ minWidth: 0, padding: '16px 18px 18px' }}>
          <div className="section-title">
            <h3 id="funnel-title">核心漏斗</h3>
            <span className="subtle" style={{ fontSize: 12 }}>
              近 {data.days} 天去重用户；括号内为相对上一步
            </span>
          </div>
          <Funnel steps={funnel} />
        </section>

        <section className="panel" aria-labelledby="ns-title" style={{ minWidth: 0, padding: '16px 18px 18px' }}>
          <div className="section-title">
            <h3 id="ns-title">北极星 · 每周成品数</h3>
            <span className="subtle" style={{ fontSize: 12 }}>
              被下载、导出或发布的作品，按北京时间周一起算
            </span>
          </div>
          <WeeklyBars data={ns} />
        </section>
      </div>

      <div className="admin-grid">
        <section className="panel" aria-labelledby="tpl-stat-title" style={{ minWidth: 0 }}>
          <div className="section-title" style={{ padding: '16px 18px 0' }}>
            <h3 id="tpl-stat-title">热门模板</h3>
          </div>
          {data.templates.length === 0 ? (
            <p className="subtle" style={{ padding: 18 }}>
              这段时间还没有人使用模板
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>模板</th>
                    <th className="num">使用次数</th>
                    <th className="num">使用人数</th>
                  </tr>
                </thead>
                <tbody>
                  {data.templates.map((t) => (
                    <tr key={t.template_id}>
                      <td>{t.title}</td>
                      <td className="num">{fmt(t.uses)}</td>
                      <td className="num">{fmt(t.users)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel" aria-labelledby="events-title" style={{ minWidth: 0 }}>
          <div className="section-title" style={{ padding: '16px 18px 0' }}>
            <h3 id="events-title">事件计数</h3>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>事件</th>
                  <th>来源</th>
                  <th className="num">次数</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((e) => (
                  <tr key={`${e.source}:${e.name}`}>
                    <td>
                      {EVENT_LABEL[e.name] ?? e.name} <span className="subtle mono">{e.name}</span>
                    </td>
                    <td>{e.source === 'server' ? '服务端' : '客户端'}</td>
                    <td className="num">{fmt(e.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

/** 横向条形漏斗：单一系列，条长按第一步归一，数值与转化率直接标注 */
function Funnel({ steps }: { steps: AdminAnalyticsDTO['funnel'] }) {
  const max = Math.max(1, steps[0]?.users ?? 0);
  return (
    <ol className="funnel" aria-label="核心漏斗">
      {steps.map((s, i) => {
        // 二次操作与导出都相对"生成成功"计算
        const base = i === 0 ? null : s.key === 'continued' || s.key === 'exported' ? steps.find((x) => x.key === 'succeeded')! : steps[i - 1];
        return (
          <li key={s.key} title={`${s.label}：${s.users} 人${base ? `，占${base.label} ${ratio(s.users, base.users)}` : ''}`}>
            <span className="label">{s.label}</span>
            <span className="track">
              {s.users > 0 && <span className="fill" style={{ width: `${(s.users / max) * 100}%` }} />}
            </span>
            <span className="val">
              {fmt(s.users)}
              {base && <span className="subtle"> ({ratio(s.users, base.users)})</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** 最近 8 周柱状图；悬停显示数值，可切换为表格 */
function WeeklyBars({ data }: { data: AdminAnalyticsDTO['north_star'] }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [hover, setHover] = useState<number | null>(null);
  const W = 560;
  const H = 150;
  const pad = { l: 28, r: 8, t: 12, b: 20 };
  const peak = Math.max(...data.map((d) => d.works), 0);
  const step = peak > 50 ? 50 : peak > 10 ? 10 : 2;
  const top = Math.max(step, Math.ceil(peak / step) * step);
  const slot = (W - pad.l - pad.r) / data.length;
  const bw = Math.min(36, slot - 2);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const h = hover === null ? null : data[hover];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 6 }}>
        <Segmented
          label="显示方式"
          value={view}
          onChange={setView}
          options={[
            { value: 'chart', label: '图表' },
            { value: 'table', label: '表格' },
          ]}
        />
      </div>
      {view === 'table' ? (
        <div className="table-wrap">
          <table className="data" style={{ minWidth: 0 }}>
            <thead>
              <tr>
                <th>周（周一）</th>
                <th className="num">成品数</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.week}>
                  <td>{d.week}</td>
                  <td className="num">{fmt(d.works)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
          <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`最近 8 周成品数，本周 ${data.at(-1)?.works ?? 0}`}>
            {[0, top / 2, top].map((t) => (
              <g key={t}>
                <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
                <text x={pad.l - 4} y={y(t) + 3} textAnchor="end">
                  {t}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = pad.l + slot * i + slot / 2;
              const bh = y(0) - y(d.works);
              const r = Math.min(4, bh / 2, bw / 2);
              const x0 = cx - bw / 2;
              const x1 = cx + bw / 2;
              const top0 = y(d.works);
              // 只把远离基线的一端做成圆角
              const path = bh > 0 ? `M${x0},${y(0)} V${top0 + r} Q${x0},${top0} ${x0 + r},${top0} H${x1 - r} Q${x1},${top0} ${x1},${top0 + r} V${y(0)} Z` : '';
              return (
                <g key={d.week} onMouseEnter={() => setHover(i)}>
                  <rect x={cx - slot / 2} y={pad.t} width={slot} height={H - pad.t - pad.b} fill="transparent" />
                  {path && <path d={path} className="bar" opacity={hover === null || hover === i ? 1 : 0.45} />}
                  <text x={cx} y={H - 6} textAnchor="middle">
                    {weekLabel(d.week)}
                  </text>
                </g>
              );
            })}
            {data.length > 0 && (
              <text x={pad.l + slot * (data.length - 0.5)} y={y(data.at(-1)!.works) - 5} textAnchor="middle" style={{ fill: 'var(--fg)' }}>
                {data.at(-1)!.works}
              </text>
            )}
          </svg>
          {h && hover !== null && (
            <div
              className="chart-tip"
              style={{ left: `${((pad.l + slot * hover + slot / 2) / W) * 100}%`, transform: `translateX(${hover === 0 ? -20 : hover >= data.length - 2 ? -85 : -50}%)` }}
              role="status"
            >
              <b>{fmt(h.works)}</b> 件成品
              <span className="subtle"> · {h.week} 起一周</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
