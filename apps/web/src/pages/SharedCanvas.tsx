import type { SharedCanvasDTO } from '@creature/shared';
import { Link2Off, Sparkles } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { Art } from '../components/Art';
import { api } from '../lib/api';
import { edgePath, KIND_META, NODE_W } from '../lib/canvas';
import { timeAgo } from '../lib/mock';
import { outputFromDTO } from '../lib/store';

/** 估算节点高度，用于把整张画布缩放到可视区域内 */
const APPROX_NODE_H = 320;

/** 分享页（无需登录）：只读查看画布，可拖动平移、滚轮缩放 */
export function SharedCanvas({ token }: { token: string }) {
  const [data, setData] = useState<SharedCanvasDTO | null | 'gone'>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    api.sharedCanvas(token).then(setData, () => setData('gone'));
  }, [token]);

  // 首次加载时缩放到能看到全部节点
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el || !data || data === 'gone' || !data.nodes.length) return;
    const minX = Math.min(...data.nodes.map((n) => n.x));
    const minY = Math.min(...data.nodes.map((n) => n.y));
    const maxX = Math.max(...data.nodes.map((n) => n.x + NODE_W));
    const maxY = Math.max(...data.nodes.map((n) => n.y + APPROX_NODE_H));
    const pad = 32;
    const k = Math.min(1, (el.clientWidth - pad * 2) / (maxX - minX), (el.clientHeight - pad * 2) / (maxY - minY));
    setView({ k, x: pad - minX * k + Math.max(0, (el.clientWidth - pad * 2 - (maxX - minX) * k) / 2), y: pad - minY * k });
  }, [data]);

  if (data === null) return <div className="splash">正在打开分享的画布…</div>;
  if (data === 'gone')
    return (
      <div className="share-page">
        <div className="empty" style={{ margin: 'auto' }}>
          <Link2Off size={28} />
          <b>链接已失效</b>
          <span>分享者可能已关闭分享或删除了这个项目</span>
          <a className="btn primary" href="#explore">
            去造物看看
          </a>
        </div>
      </div>
    );

  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const onDown = (e: RPointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (d) setView((v) => ({ ...v, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy }));
  };
  const onWheel = (e: React.WheelEvent) => {
    const rect = stage.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setView((v) => {
      const k = Math.min(2, Math.max(0.2, v.k * (e.deltaY > 0 ? 0.9 : 1.1)));
      return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k };
    });
  };

  return (
    <div className="share-page">
      <header className="share-head">
        <div className="rail-logo" style={{ marginBottom: 0 }} aria-hidden>
          造
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1>{data.name}</h1>
          <span className="subtle">
            {data.owner} 分享 · 更新于 {timeAgo(Date.parse(data.updated_at))} · {data.nodes.length} 个节点 · 内容由 AI 生成
          </span>
        </div>
        <a className="btn primary" href="#explore">
          <Sparkles size={15} /> <span className="hide-sm">我也来创作</span>
        </a>
      </header>
      <div ref={stage} className="canvas-stage share-stage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => (drag.current = null)} onWheel={onWheel} aria-label="只读画布">
        <div className="canvas-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="canvas-edges" width="1" height="1">
            {data.edges.map((e) => {
              const a = byId.get(e.from);
              const b = byId.get(e.to);
              return a && b ? <path key={e.id} d={edgePath(a, b)} stroke={KIND_META[a.kind].color} opacity={0.75} /> : null;
            })}
          </svg>
          {data.nodes.map((n) => {
            const M = KIND_META[n.kind];
            const outs = n.outputs.map((o, i) => outputFromDTO(o, i, n.prompt ?? n.title));
            return (
              <div key={n.id} className={`node ${n.kind}`} style={{ left: n.x, top: n.y }}>
                <span className="port in" />
                <span className="port out" />
                <div className="node-head">
                  <span className="ico">
                    <M.icon size={14} />
                  </span>
                  <span className="title">{n.title}</span>
                </div>
                <div className="node-body">
                  {n.prompt && <p className="prompt">{n.prompt}</p>}
                  {outs.length > 0 && n.kind === 'text' && <p className="prompt share-text">{outs[0].text}</p>}
                  {outs.length > 0 && n.kind !== 'text' && (
                    <div className={`node-outs ${outs.length === 1 ? 'single' : ''}`}>
                      {outs.slice(0, 4).map((o) => (
                        <Art key={o.id} prompt={o.prompt} ratio={n.kind === 'audio' ? '3:1' : o.ratio} variant={o.variant} kind={o.kind} durationSec={o.durationSec} url={o.kind === 'audio' ? undefined : o.url} controls={o.kind === 'video'} long={320} />
                      ))}
                    </div>
                  )}
                  {!outs.length && <p className="subtle" style={{ fontSize: 12 }}>尚未生成</p>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
