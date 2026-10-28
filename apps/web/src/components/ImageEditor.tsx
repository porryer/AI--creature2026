import { EDIT_MODEL, EDIT_TOOLS, editLabel, estimateCredits, modelByCode, type EditTool } from '@creature/shared';
import { Brush, Eraser, Expand, Maximize2, Scissors, Sparkles, Undo2, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { navigate, useRoute } from '../lib/router';
import { useStore } from '../lib/store';
import type { Asset } from '../lib/types';
import { Art } from './Art';
import { Modal, Segmented } from './ui';

const TOOL_ICON: Record<EditTool, typeof Brush> = { inpaint: Brush, outpaint: Expand, erase: Eraser, cutout: Scissors, upscale: Maximize2 };
const RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'];
/** 导出遮罩的最大边长 */
const MASK_SIDE = 1024;

/** 一笔涂抹：坐标与笔刷粗细都按画面宽度归一化，和显示尺寸无关 */
interface Stroke {
  size: number;
  points: [number, number][];
}

const ratioOf = (r: string) => {
  const [a, b] = r.split(':').map(Number);
  return a && b ? a / b : 1;
};

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number, color: string) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    ctx.lineWidth = s.size * w;
    const [x0, y0] = s.points[0];
    if (s.points.length === 1) {
      ctx.beginPath();
      ctx.arc(x0 * w, y0 * h, (s.size * w) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(x0 * w, y0 * h);
    for (const [x, y] of s.points.slice(1)) ctx.lineTo(x * w, y * h);
    ctx.stroke();
  }
}

/** 导出遮罩：黑底白色涂抹区域的 PNG（白色为要修改的部分） */
function exportMask(strokes: Stroke[], ratio: number): string {
  const w = ratio >= 1 ? MASK_SIDE : Math.round(MASK_SIDE * ratio);
  const h = ratio >= 1 ? Math.round(MASK_SIDE / ratio) : MASK_SIDE;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  drawStrokes(ctx, strokes, w, h, '#fff');
  return c.toDataURL('image/png');
}

export function ImageEditor() {
  const { state } = useStore();
  return state.editing ? <EditorBody key={state.editing.id} asset={state.editing} /> : null;
}

/** 图像编辑：局部重绘 / 扩图 / 消除 / 抠图 / 超分，提交后作为图像任务出现在工作台 */
function EditorBody({ asset }: { asset: Asset }) {
  const { state, submit, toast, openEditor } = useStore();
  const route = useRoute();
  const [tool, setTool] = useState<EditTool>('inpaint');
  const [prompt, setPrompt] = useState('');
  const [brush, setBrush] = useState(0.06);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [ratio, setRatio] = useState(() => RATIOS.find((r) => r !== asset.ratio && ratioOf(r) > ratioOf(asset.ratio)) ?? '16:9');
  const [scale, setScale] = useState<2 | 4>(2);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<Stroke | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  const spec = EDIT_TOOLS[tool];
  const srcRatio = ratioOf(asset.ratio);
  // 扩图时预览框换成目标比例，原图居中
  const frameRatio = tool === 'outpaint' ? ratioOf(ratio) : srcRatio;
  const params = { tool, ...(tool === 'outpaint' ? { ratio } : {}), ...(tool === 'upscale' ? { scale } : {}) };
  const model = modelByCode(EDIT_MODEL);
  const credits = estimateCredits(model, params);
  const short = credits > state.available;
  const missing = spec.needsMask && strokes.length === 0 ? '先在图上涂抹要修改的区域' : spec.needsPrompt && !prompt.trim() ? '描述要改成什么' : '';

  // 按容器大小计算画面尺寸（保持比例、不超出）
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fit = () => {
      // clientWidth / clientHeight 包含内边距，要扣掉
      const cs = getComputedStyle(el);
      const cw = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const ch = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const w = Math.min(cw, ch * frameRatio);
      setBox({ w, h: w / frameRatio });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frameRatio]);

  // 涂抹层：按显示尺寸重绘半透明笔迹
  const imgBox = tool === 'outpaint' ? (srcRatio > frameRatio ? { w: box.w, h: box.w / srcRatio } : { w: box.h * srcRatio, h: box.h }) : box;
  useEffect(() => {
    const c = canvas.current;
    if (!c || !imgBox.w) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(imgBox.w * dpr);
    c.height = Math.round(imgBox.h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, imgBox.w, imgBox.h);
    drawStrokes(ctx, strokes, imgBox.w, imgBox.h, tool === 'erase' ? 'rgba(232, 93, 93, 0.55)' : 'rgba(30, 170, 140, 0.55)');
  }, [strokes, imgBox.w, imgBox.h, tool]);

  const point = (e: RPointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  const onDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = { size: brush, points: [point(e)] };
    setStrokes((s) => [...s, drawing.current!]);
  };
  const onMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const d = drawing.current;
    if (!d) return;
    d.points.push(point(e));
    setStrokes((s) => [...s.slice(0, -1), { ...d }]);
  };
  const onUp = () => {
    drawing.current = null;
  };

  const go = async () => {
    if (missing || busy) return;
    setBusy(true);
    const label = editLabel(params);
    const id = await submit({
      modality: 'image',
      operation: 'edit',
      prompt: prompt.trim() || `${label} · ${asset.title}`,
      model,
      params,
      count: 1,
      references: [{ assetId: asset.id, role: 'source' }],
      mask: spec.needsMask ? exportMask(strokes, srcRatio) : undefined,
      editSource: asset,
    });
    setBusy(false);
    if (!id) return;
    openEditor(null);
    toast(`已提交${label}，结果会出现在图像工作台`, 'info');
    if (!(route.name === 'studio' && route.mode === 'image')) navigate('studio', 'image');
  };

  return (
    <Modal title={`编辑 · ${asset.title}`} onClose={() => openEditor(null)} wide>
      <div className="editor">
        <div className="editor-stage" ref={wrap}>
          <div className={`editor-frame ${tool === 'outpaint' ? 'outpaint' : ''} ${tool === 'cutout' ? 'cutout' : ''}`} style={{ width: box.w, height: box.h }}>
            <div className="editor-image" style={{ width: imgBox.w, height: imgBox.h }}>
              <Art prompt={asset.prompt} ratio={asset.ratio} variant={asset.variant} url={asset.url} badge={false} long={900} style={{ borderRadius: 0, width: '100%', height: '100%' }} />
              {spec.needsMask && (
                <canvas
                  ref={canvas}
                  className="editor-mask"
                  aria-label="在图上涂抹要修改的区域"
                  onPointerDown={onDown}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                />
              )}
            </div>
          </div>
        </div>
        <div className="editor-side">
          <div className="editor-tools" role="tablist" aria-label="编辑工具">
            {(Object.keys(EDIT_TOOLS) as EditTool[]).map((k) => {
              const Icon = TOOL_ICON[k];
              return (
                <button key={k} role="tab" aria-selected={tool === k} onClick={() => setTool(k)}>
                  <Icon size={16} />
                  {EDIT_TOOLS[k].label}
                </button>
              );
            })}
          </div>
          <p className="subtle" style={{ fontSize: 13 }}>
            {spec.desc}
          </p>

          {spec.needsMask && (
            <div className="field">
              <span className="field-label">
                <span>
                  笔刷 <span className="subtle">{Math.round(brush * 100)}</span>
                </span>
                <span style={{ display: 'flex', gap: 4 }}>
                  <button type="button" className="btn ghost sm" disabled={!strokes.length} onClick={() => setStrokes((s) => s.slice(0, -1))}>
                    <Undo2 size={13} /> 撤销
                  </button>
                  <button type="button" className="btn ghost sm" disabled={!strokes.length} onClick={() => setStrokes([])}>
                    <Trash2 size={13} /> 清空
                  </button>
                </span>
              </span>
              <input type="range" min={2} max={20} value={Math.round(brush * 100)} onChange={(e) => setBrush(Number(e.target.value) / 100)} aria-label="笔刷大小" style={{ accentColor: 'var(--accent)' }} />
            </div>
          )}

          {tool === 'outpaint' && (
            <div className="field">
              <span className="field-label">扩展到</span>
              <Segmented label="扩图比例" value={ratio} onChange={setRatio} options={RATIOS.filter((r) => Math.abs(ratioOf(r) - srcRatio) / srcRatio >= 0.03).map((r) => ({ value: r, label: r }))} />
            </div>
          )}

          {tool === 'upscale' && (
            <div className="field">
              <span className="field-label">放大倍数</span>
              <Segmented
                label="放大倍数"
                value={scale}
                onChange={setScale}
                options={[
                  { value: 2, label: '2 倍 · 2 积分' },
                  { value: 4, label: '4 倍 · 4 积分' },
                ]}
              />
            </div>
          )}

          {(tool === 'inpaint' || tool === 'outpaint') && (
            <div className="field">
              <label htmlFor="edit-prompt">{tool === 'inpaint' ? '改成什么' : '延展内容（选填）'}</label>
              <textarea
                id="edit-prompt"
                className="textarea"
                style={{ minHeight: 80 }}
                maxLength={500}
                placeholder={tool === 'inpaint' ? '如：换成一杯冒着热气的蓝色马克杯' : '如：窗外是秋天的街道'}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </div>
          )}

          <div style={{ marginTop: 'auto', display: 'grid', gap: 8 }}>
            {short ? (
              <button className="btn primary lg block" onClick={() => (openEditor(null), navigate('pricing'))}>
                积分不足，去充值 <span className="cost">差 {credits - state.available}</span>
              </button>
            ) : (
              <button className="btn primary lg block" disabled={!!missing || busy} onClick={() => void go()}>
                <Sparkles size={17} /> {missing || `开始${spec.label}`} <span className="cost">· {credits} 积分</span>
              </button>
            )}
            <div className="hint">
              <span>可用 {state.available} 积分</span>
              <span>结果带 AI 标识 · 失败全额返还</span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
