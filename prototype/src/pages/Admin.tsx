import { Check, Info, X } from 'lucide-react';
import { useState } from 'react';
import { Art } from '../components/Art';
import { Switch } from '../components/ui';
import { ADMIN } from '../lib/mock';
import { useStore } from '../lib/store';

export function Admin() {
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
            <TrendChart />
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

function TrendChart() {
  const data = ADMIN.trend;
  const W = 560;
  const H = 120;
  const pad = { l: 28, r: 10, t: 10, b: 16 };
  const top = Math.ceil(Math.max(...data) / 50) * 50;
  const x = (i: number) => pad.l + (i / (data.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const line = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z`;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`日生成量由 ${data[0]} 千次增长到 ${data[data.length - 1]} 千次`}>
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
