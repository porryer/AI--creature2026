import { Check, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Modal, Segmented } from '../components/ui';
import { qrPattern } from '../lib/art';
import { CREDIT_PACKS, fmt, PLANS, USAGE_30D } from '../lib/mock';
import { useStore } from '../lib/store';

type Purchase = { title: string; amount: number; credits: number };

const TYPE_LABEL = { grant: '发放', freeze: '冻结', settle: '消耗', refund: '返还', expire: '过期' } as const;

export function Pricing() {
  const { state, grant, toast } = useStore();
  const [cycle, setCycle] = useState<'month' | 'year'>('year');
  const [buy, setBuy] = useState<Purchase | null>(null);
  const [channel, setChannel] = useState<'wechat' | 'alipay'>('wechat');

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      <section className="panel" aria-label="积分概览">
        <div className="balance">
          <div>
            <div className="k">可用积分</div>
            <div className="v gold">{fmt(state.available)}</div>
            <div className="subtle" style={{ fontSize: 12 }}>
              专业版 · 下次发放 11 月 20 日
            </div>
          </div>
          <div>
            <div className="k">冻结中</div>
            <div className="v">{fmt(state.frozen)}</div>
            <div className="subtle" style={{ fontSize: 12 }}>
              生成完成后结算，失败自动返还
            </div>
          </div>
          <div>
            <div className="k">3 天内过期</div>
            <div className="v">20</div>
            <div className="subtle" style={{ fontSize: 12 }}>
              每日赠送积分优先消耗
            </div>
          </div>
          <div>
            <div className="k" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span>近 30 天消耗</span>
              <span style={{ display: 'flex', gap: 10 }}>
                <span>
                  <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--accent)', marginRight: 4 }} />
                  图像
                </span>
                <span>
                  <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: 'var(--accent-2)', marginRight: 4 }} />
                  视频
                </span>
              </span>
            </div>
            <UsageChart />
          </div>
        </div>
      </section>

      <section aria-labelledby="plans-title">
        <div className="section-title" style={{ flexWrap: 'wrap' }}>
          <div>
            <h3 id="plans-title">选择套餐</h3>
            <p className="muted" style={{ fontSize: 13, marginTop: 2 }}>
              所有付费套餐的作品均可商用。法规要求的“AI 生成”标识在任何套餐中都会保留。
            </p>
          </div>
          <div style={{ width: 220 }}>
            <Segmented
              label="计费周期"
              value={cycle}
              onChange={setCycle}
              options={[
                { value: 'month', label: '按月' },
                { value: 'year', label: '按年 · 省 20%' },
              ]}
            />
          </div>
        </div>
        <div className="plans">
          {PLANS.map((p) => {
            const price = cycle === 'year' ? p.year : p.month;
            const current = p.code === 'pro';
            return (
              <article key={p.code} className={`panel plan-card ${p.featured ? 'featured' : ''}`}>
                {p.featured && <span className="ribbon">最受欢迎</span>}
                <div>
                  <h4 style={{ fontSize: 16 }}>{p.name}</h4>
                  <div className="plan-credits">{p.credits} 积分</div>
                </div>
                <div className="plan-price">
                  <span>¥</span>
                  <b>{price}</b>
                  <span>/ 月{cycle === 'year' && price > 0 ? '，按年付' : ''}</span>
                </div>
                <ul>
                  {p.perks.map((x) => (
                    <li key={x}>
                      <Check size={14} />
                      {x}
                    </li>
                  ))}
                </ul>
                {current ? (
                  <button className="btn block" disabled>
                    当前套餐
                  </button>
                ) : p.code === 'free' ? (
                  <button className="btn block ghost" disabled>
                    基础权益
                  </button>
                ) : (
                  <button
                    className={`btn block ${p.featured ? 'primary' : ''}`}
                    onClick={() => setBuy({ title: `${p.name} · ${cycle === 'year' ? '年付' : '月付'}`, amount: cycle === 'year' ? price * 12 : price, credits: parseInt(p.credits, 10) || 0 })}
                  >
                    {p.code === 'team' ? '升级团队版' : '切换到此套餐'}
                  </button>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="packs-title">
        <div className="section-title">
          <h3 id="packs-title">积分加油包</h3>
          <span className="subtle" style={{ fontSize: 12.5 }}>
            有效期 1 年，可与订阅积分叠加
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          {CREDIT_PACKS.map((p) => (
            <button key={p.credits} className="panel" style={{ padding: 16, textAlign: 'left', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }} onClick={() => setBuy({ title: `积分包 ${p.credits}`, amount: p.price, credits: p.credits })}>
              <span>
                <b className="mono" style={{ color: 'var(--gold)', fontSize: 18 }}>
                  {fmt(p.credits)}
                </b>{' '}
                积分
                <span className="subtle" style={{ display: 'block', fontSize: 12 }}>
                  约 ¥{((p.price / p.credits) * 100).toFixed(1)} / 百积分
                </span>
              </span>
              <span className="btn sm">¥{p.price}</span>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="ledger-title">
        <div className="section-title">
          <h3 id="ledger-title">积分明细</h3>
          <span className="subtle" style={{ fontSize: 12.5 }}>
            冻结 → 结算 / 返还，每一笔都可追溯到任务
          </span>
        </div>
        <div className="panel table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>说明</th>
                <th className="num">变动</th>
                <th className="num">可用余额</th>
              </tr>
            </thead>
            <tbody>
              {state.ledger.slice(0, 14).map((l) => (
                <tr key={l.id}>
                  <td className="mono subtle">{new Date(l.time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>
                    <span className={`tag ${l.type === 'grant' || l.type === 'refund' ? 'ok' : l.type === 'freeze' ? 'text' : ''}`}>{TYPE_LABEL[l.type]}</span>
                  </td>
                  <td style={{ whiteSpace: 'normal', minWidth: 240 }}>{l.label}</td>
                  <td className={`num ${l.delta > 0 ? 'pos' : 'neg'}`}>
                    {l.delta > 0 ? '+' : ''}
                    {l.delta}
                  </td>
                  <td className="num">{fmt(l.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {buy && (
        <Modal title="确认支付" onClose={() => setBuy(null)}>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
              <span>{buy.title}</span>
              <b style={{ fontFamily: 'var(--font-display)', fontSize: 28 }}>¥{buy.amount}</b>
            </div>
            <Segmented
              label="支付方式"
              value={channel}
              onChange={setChannel}
              options={[
                { value: 'wechat', label: '微信支付' },
                { value: 'alipay', label: '支付宝' },
              ]}
            />
            <QR seed={buy.title + channel} />
            <p className="subtle" style={{ textAlign: 'center', fontSize: 12.5 }}>
              请使用{channel === 'wechat' ? '微信' : '支付宝'}扫码支付 · 二维码 15 分钟内有效
            </p>
            <button
              className="btn primary lg"
              onClick={() => {
                grant(buy.credits, `${buy.title} · 到账`);
                toast(`支付成功，${buy.credits} 积分已到账`);
                setBuy(null);
              }}
            >
              模拟支付成功
            </button>
            <p className="subtle" style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
              <ShieldCheck size={14} /> 自动续费可随时在账户设置中关闭；虚拟商品一经使用不支持退款。
            </p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UsageChart() {
  const W = 420;
  const H = 120;
  const pad = { l: 28, r: 6, t: 8, b: 18 };
  const max = Math.max(...USAGE_30D.map((d) => d.img + d.vid));
  const top = Math.ceil(max / 50) * 50;
  const bw = (W - pad.l - pad.r) / USAGE_30D.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const ticks = [0, top / 2, top];
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`近 30 天每日积分消耗，峰值 ${max}`}>
      {ticks.map((t) => (
        <g key={t}>
          <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
          <text x={pad.l - 4} y={y(t) + 3} textAnchor="end">
            {t}
          </text>
        </g>
      ))}
      {USAGE_30D.map((d, i) => {
        const x = pad.l + i * bw + 1;
        return (
          <g key={i}>
            <rect className="bar" x={x} width={bw - 2} y={y(d.img)} height={y(0) - y(d.img)} rx={1.5} />
            {d.vid > 0 && <rect className="bar video" x={x} width={bw - 2} y={y(d.img + d.vid)} height={y(d.img) - y(d.img + d.vid)} rx={1.5} />}
          </g>
        );
      })}
      <text x={pad.l} y={H - 4}>
        30 天前
      </text>
      <text x={W - pad.r} y={H - 4} textAnchor="end">
        今天
      </text>
    </svg>
  );
}

function QR({ seed }: { seed: string }) {
  const g = qrPattern(seed);
  const n = g.length;
  return (
    <svg className="qr" viewBox={`0 0 ${n} ${n}`} role="img" aria-label="支付二维码（示意）" shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#ffffff" />
      {g.flatMap((row, y) => row.map((on, x) => (on ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="#0f1716" /> : null)))}
    </svg>
  );
}
