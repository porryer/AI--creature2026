import {
  AlertCircle,
  AudioLines,
  ChevronRight,
  Clapperboard,
  Download,
  FileText,
  Film,
  Heart,
  Image as ImageIcon,
  LayoutGrid,
  Megaphone,
  Newspaper,
  Pause,
  PenLine,
  Play,
  Plus,
  RefreshCw,
  Send,
  Shuffle,
  Sparkles,
  Square,
  Upload,
  Video,
  Wand2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Art } from '../components/Art';
import { ModelPicker, useResolvedModel } from '../components/ModelPicker';
import { Segmented, Status, Switch } from '../components/ui';
import { waveFor } from '../lib/art';
import { BRAND_KIT, CHARACTERS, VOICES, WRITING_TEMPLATES, timeAgo } from '../lib/mock';
import { estimateCredits, modelByCode, modelsFor } from '../lib/models';
import { navigate } from '../lib/router';
import { uid, useStore } from '../lib/store';
import type { Asset, Modality, Output, RoutingStrategy, Task } from '../lib/types';

const MODE_TABS: { value: Modality; label: string; icon: typeof ImageIcon }[] = [
  { value: 'image', label: '图像', icon: ImageIcon },
  { value: 'video', label: '视频', icon: Video },
  { value: 'text', label: '写作', icon: PenLine },
  { value: 'audio', label: '音频', icon: AudioLines },
];

export function Studio({ mode }: { mode: Modality }) {
  if (mode === 'video') return <VideoStudio />;
  if (mode === 'text') return <WriteStudio />;
  if (mode === 'audio') return <AudioStudio />;
  return <ImageStudio />;
}

function Shell({ mode, form, submit, main }: { mode: Modality; form: ReactNode; submit: ReactNode; main: ReactNode }) {
  return (
    <div className="studio">
      <aside className="studio-side" aria-label="创作参数">
        <div className="studio-modes" role="group" aria-label="创作类型">
          {MODE_TABS.map((t) => (
            <button key={t.value} className="studio-mode" aria-pressed={mode === t.value} onClick={() => navigate('studio', t.value)}>
              <t.icon size={18} />
              {t.label}
            </button>
          ))}
        </div>
        <div className="studio-form">{form}</div>
        <div className="studio-submit">{submit}</div>
      </aside>
      <section className="studio-main" aria-label="生成结果">
        {main}
      </section>
      <History mode={mode} />
    </div>
  );
}

function History({ mode }: { mode: Modality }) {
  const { state, openViewer } = useStore();
  const items = state.assets.filter((a) => a.kind === mode).slice(0, 16);
  return (
    <aside className="studio-history" aria-label="历史记录">
      <div className="eyebrow">历史记录</div>
      {items.length === 0 ? (
        <p className="subtle" style={{ fontSize: 12.5, marginTop: 10 }}>
          生成的作品会出现在这里
        </p>
      ) : (
        <div className="history-grid">
          {items.map((a) => (
            <button key={a.id} onClick={() => openViewer(a)} aria-label={a.title}>
              <Art prompt={a.prompt} ratio="1:1" variant={a.variant} kind={a.kind} text={a.text} durationSec={a.durationSec} badge={false} long={200} />
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}

/** 读取首页 / 模板带过来的预填内容 */
function useHandoff(mode: Modality, apply: (prompt: string, autostart: boolean, firstFrame?: Asset) => void) {
  const { state, setHandoff } = useStore();
  const applied = useRef(false);
  useEffect(() => {
    const h = state.handoff;
    if (applied.current || !h || h.to !== 'studio' || (h.mode ?? 'image') !== mode) return;
    applied.current = true;
    setHandoff(null);
    apply(h.prompt ?? '', !!h.autostart, h.firstFrame);
  }, [state.handoff, mode, setHandoff, apply]);
}

function SubmitButton({ credits, disabled, onClick, label = '生成' }: { credits: number; disabled?: boolean; onClick: () => void; label?: string }) {
  const { state } = useStore();
  const short = credits > state.available;
  return (
    <>
      {short ? (
        <button className="btn primary lg block" onClick={() => navigate('pricing')}>
          积分不足，去充值 <span className="cost">差 {credits - state.available}</span>
        </button>
      ) : (
        <button className="btn primary lg block" disabled={disabled} onClick={onClick}>
          <Sparkles size={17} /> {label} <span className="cost">· {credits} 积分</span>
        </button>
      )}
      <div className="hint">
        <span>可用 {state.available} 积分</span>
        <span>失败或拦截全额返还</span>
      </div>
    </>
  );
}

function PromptField({ id, value, onChange, placeholder, enhance = true, label = '提示词' }: { id: string; value: string; onChange: (v: string) => void; placeholder: string; enhance?: boolean; label?: string }) {
  const add = ['，细节丰富', '，柔和自然光', '，电影感构图', '，高级质感', '，浅景深'];
  return (
    <div className="field">
      <label htmlFor={id}>
        <span>{label}</span>
        {enhance && (
          <button
            type="button"
            className="btn ghost sm"
            style={{ height: 24, color: 'var(--accent)' }}
            disabled={!value.trim()}
            onClick={() => onChange(value.trim() + add.filter((a) => !value.includes(a.slice(1))).slice(0, 3).join(''))}
          >
            <Wand2 size={13} /> AI 润色
          </button>
        )}
      </label>
      <textarea id={id} className="textarea" placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} maxLength={2000} />
    </div>
  );
}

function assetFromOutput(o: Output, t: Task): Asset {
  return { id: o.id, kind: o.kind, title: t.prompt.slice(0, 16), prompt: o.prompt, ratio: o.ratio, variant: o.variant, createdAt: t.createdAt, model: t.model.name, durationSec: o.durationSec };
}

function TaskCard({ task, onVariant }: { task: Task; onVariant?: (t: Task) => void }) {
  const { state, openViewer, patchAsset, toast, setHandoff, submit } = useStore();
  const n = Math.min(task.count, 4);
  const paramText =
    task.modality === 'image'
      ? `${task.params.ratio} · ${String(task.params.resolution).toUpperCase()} · ${task.count} 张`
      : task.modality === 'video'
        ? `${task.params.ratio} · ${task.params.duration} 秒 · ${task.params.resolution}${task.params.audio ? ' · 原生音频' : ''}`
        : task.model.code === 'creature-music'
          ? `配乐 · ${task.params.seconds} 秒`
          : `配音 · ${task.params.voice ?? ''}`;
  return (
    <article className="task" aria-live="polite">
      <div className="task-head">
        <div className="grow">
          <p className="task-prompt">{task.prompt}</p>
          <div className="task-meta">
            <span>{task.model.name}</span>
            <span>{paramText}</span>
            <span className="mono">{task.credits} 积分</span>
            <span>{timeAgo(task.createdAt)}</span>
          </div>
        </div>
        <Status value={task.status} />
      </div>
      {(task.status === 'queued' || task.status === 'running') && (
        <div className="task-progress">
          <div className="row">
            <span>{task.status === 'queued' ? `排队中 · 前方 ${task.queuePos} 个任务` : task.progress < 85 ? '生成中' : '审核与添加 AI 标识'}</span>
            <span className="mono">{task.progress}%</span>
          </div>
          <div className="progress">
            <i style={{ width: `${task.status === 'queued' ? 2 : task.progress}%` }} />
          </div>
        </div>
      )}
      {(task.status === 'failed' || task.status === 'blocked') && (
        <div className="task-fail">
          <AlertCircle size={16} />
          <span style={{ flex: 1, minWidth: 0 }}>
            {task.error}
            {task.status === 'failed' && `，已返还 ${task.credits} 积分`}
          </span>
          {task.status === 'failed' && (
            <>
              <button className="btn sm" onClick={() => submit({ modality: task.modality, prompt: task.prompt.replace('失败', ''), model: task.model, params: task.params, count: task.count })}>
                <RefreshCw size={14} /> 重试
              </button>
              <button
                className="btn sm"
                onClick={() => {
                  const alt = modelsFor(task.modality).find((m) => m.code !== task.model.code && m.tier === task.model.tier) ?? modelsFor(task.modality)[0];
                  submit({ modality: task.modality, prompt: task.prompt.replace('失败', ''), model: alt, params: task.params, count: task.count });
                }}
              >
                <Shuffle size={14} /> 换模型重试
              </button>
            </>
          )}
        </div>
      )}
      {task.status === 'succeeded' && task.modality === 'audio' && (
        <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
          {task.outputs.map((o) => (
            <AudioCard key={o.id} seed={o.id} seconds={o.durationSec ?? 12} title={task.model.code === 'creature-music' ? '配乐' : `配音 · ${task.params.voice ?? ''}`} />
          ))}
        </div>
      )}
      {task.status === 'succeeded' && task.modality !== 'audio' && (
        <div className={`task-results n${n}`}>
          {task.outputs.map((o) => {
            const asset = state.assets.find((a) => a.id === o.id) ?? assetFromOutput(o, task);
            return (
              <div className="result" key={o.id}>
                <Art prompt={o.prompt} ratio={o.ratio} variant={o.variant} kind={o.kind} durationSec={o.durationSec} controls={o.kind === 'video'} onClick={() => openViewer(asset)} label={`查看第 ${o.variant + 1} 个结果`} />
                <div className="result-actions">
                  <button aria-label="下载" title="下载（带 AI 标识）" onClick={() => toast('已开始下载 · 文件含显式与隐式 AI 标识（原型演示）', 'info')}>
                    <Download size={15} />
                  </button>
                  <button aria-label="收藏" title="收藏" onClick={() => (patchAsset(asset.id, { favorite: !asset.favorite }), toast(asset.favorite ? '已取消收藏' : '已收藏到资产库'))}>
                    <Heart size={15} fill={asset.favorite ? 'currentColor' : 'none'} />
                  </button>
                  {o.kind === 'image' && onVariant && (
                    <button aria-label="生成变体" title="生成变体" onClick={() => onVariant(task)}>
                      <Shuffle size={15} />
                    </button>
                  )}
                  {o.kind === 'image' && (
                    <button
                      aria-label="转为视频"
                      title="转为视频"
                      onClick={() => {
                        setHandoff({ to: 'studio', mode: 'video', prompt: `${o.prompt}，镜头缓慢推进`, firstFrame: asset });
                        navigate('studio', 'video');
                      }}
                    >
                      <Film size={15} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

function AudioCard({ seed, seconds, title }: { seed: string; seconds: number; title: string }) {
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const bars = useMemo(() => waveFor(seed, 56), [seed]);
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => {
      setT((x) => {
        if (x + 0.1 >= seconds) {
          setPlaying(false);
          return 0;
        }
        return x + 0.1;
      });
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, seconds]);
  const ratio = t / seconds;
  return (
    <div className="audio-card">
      <button className="play-btn" aria-label={playing ? '暂停' : '播放'} onClick={() => setPlaying((p) => !p)}>
        {playing ? <Pause size={18} /> : <Play size={18} />}
      </button>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--fg-2)' }}>
          <span>{title}</span>
          <span className="mono">
            0:{String(Math.floor(t)).padStart(2, '0')} / 0:{String(seconds).padStart(2, '0')}
          </span>
        </div>
        <div className="wave" aria-hidden="true">
          {bars.map((b, i) => (
            <i key={i} className={i / bars.length <= ratio ? 'on' : ''} style={{ height: `${b * 100}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function TaskFeed({ modality, empty, onVariant }: { modality: Modality; empty: ReactNode; onVariant?: (t: Task) => void }) {
  const { state } = useStore();
  const tasks = state.tasks.filter((t) => t.modality === modality && t.source !== 'canvas' && t.source !== 'agent');
  if (tasks.length === 0) return <>{empty}</>;
  return (
    <>
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} onVariant={onVariant} />
      ))}
    </>
  );
}

/* ---------------- 图像 ---------------- */

function ImageStudio() {
  const { submit } = useStore();
  const [prompt, setPrompt] = useState('');
  const [strategy, setStrategy] = useState<RoutingStrategy>('auto');
  const [pinned, setPinned] = useState<string | null>(null);
  const [ratio, setRatio] = useState('3:4');
  const [resolution, setResolution] = useState('2k');
  const [count, setCount] = useState(4);
  const [refs, setRefs] = useState<{ id: string; url: string; role: string }[]>([]);
  const [negative, setNegative] = useState('');
  const [seed, setSeed] = useState('');
  const [brand, setBrand] = useState(false);
  const [character, setCharacter] = useState('');
  const { model } = useResolvedModel('image', prompt, strategy, pinned);
  const params = { ratio, resolution, count };
  const credits = estimateCredits(model, params);

  const go = (p = prompt) => {
    if (!p.trim()) return;
    const extra = [brand ? `（品牌套件：${BRAND_KIT.name}）` : '', character ? `（角色：${CHARACTERS.find((c) => c.id === character)?.name}）` : ''].join('');
    submit({ modality: 'image', prompt: p.trim() + extra, model, params, count });
  };

  useHandoff('image', (p, auto) => {
    setPrompt(p);
    if (auto && p) window.setTimeout(() => go(p), 50);
  });

  const onFiles = (files: FileList | null) => {
    if (!files) return;
    const next = Array.from(files)
      .slice(0, 4 - refs.length)
      .map((f) => ({ id: uid('ref'), url: URL.createObjectURL(f), role: '风格' }));
    setRefs((r) => [...r, ...next]);
  };

  return (
    <Shell
      mode="image"
      form={
        <>
          <PromptField id="img-prompt" value={prompt} onChange={setPrompt} placeholder="描述画面：主体、场景、光线、风格。含“违规”会演示审核拦截，含“失败”会演示失败返还" />
          <ModelPicker modality="image" prompt={prompt} strategy={strategy} onStrategy={setStrategy} pinned={pinned} onPinned={setPinned} />
          <div className="field">
            <span className="field-label">
              参考图 <span className="subtle">{refs.length}/4</span>
            </span>
            <div className="ref-row">
              {refs.map((r) => (
                <div className="ref-thumb" key={r.id}>
                  <img src={r.url} alt="参考图" />
                  <button aria-label="移除参考图" onClick={() => setRefs((x) => x.filter((y) => y.id !== r.id))}>
                    <X size={12} />
                  </button>
                </div>
              ))}
              {refs.length < 4 && (
                <label className="ref-add" aria-label="上传参考图">
                  <Upload size={18} />
                  <input id="img-ref-input" type="file" accept="image/*" multiple onChange={(e) => onFiles(e.target.files)} />
                </label>
              )}
            </div>
          </div>
          <div className="field">
            <span className="field-label">比例</span>
            <Segmented label="比例" value={ratio} onChange={setRatio} options={['1:1', '3:4', '4:3', '9:16', '16:9'].map((v) => ({ value: v, label: v }))} />
          </div>
          <div className="field">
            <span className="field-label">分辨率</span>
            <Segmented
              label="分辨率"
              value={resolution}
              onChange={setResolution}
              options={[
                { value: '1k', label: '标准 1K' },
                { value: '2k', label: '高清 2K' },
                { value: '4k', label: '超清 4K' },
              ]}
            />
          </div>
          <div className="field">
            <span className="field-label">数量</span>
            <Segmented label="数量" value={count} onChange={setCount} options={[1, 2, 3, 4].map((v) => ({ value: v, label: `${v} 张` }))} />
          </div>
          <div className="inline-row">
            <label htmlFor="brand-switch" style={{ fontSize: 13 }}>
              应用品牌套件 <span className="subtle">· {BRAND_KIT.name}</span>
            </label>
            <Switch id="brand-switch" checked={brand} onChange={setBrand} label="应用品牌套件" />
          </div>
          <div className="field">
            <label htmlFor="img-character">引用角色</label>
            <select id="img-character" className="select" value={character} onChange={(e) => setCharacter(e.target.value)}>
              <option value="">不使用角色</option>
              {CHARACTERS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.desc.slice(0, 12)}
                </option>
              ))}
            </select>
          </div>
          <details className="details">
            <summary>
              <ChevronRight size={14} /> 高级选项
            </summary>
            <div className="details-body">
              <div className="field">
                <label htmlFor="img-neg">负向提示词</label>
                <input id="img-neg" className="input" placeholder="不希望出现的内容，如：文字水印、模糊" value={negative} onChange={(e) => setNegative(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="img-seed">种子</label>
                <input id="img-seed" className="input mono" placeholder="留空为随机" value={seed} onChange={(e) => setSeed(e.target.value.replace(/\D/g, ''))} />
              </div>
            </div>
          </details>
        </>
      }
      submit={<SubmitButton credits={credits} disabled={!prompt.trim()} onClick={() => go()} />}
      main={
        <TaskFeed
          modality="image"
          onVariant={(t) => submit({ modality: 'image', prompt: t.prompt, model: t.model, params: t.params, count: t.count })}
          empty={
            <div className="empty">
              <ImageIcon size={28} />
              <b>还没有生成记录</b>
              <span>在左侧输入提示词，生成的图像会显示在这里</span>
            </div>
          }
        />
      }
    />
  );
}

/* ---------------- 视频 ---------------- */

const CAMERA = ['固定', '推进', '拉远', '左摇', '右摇', '环绕', '跟随', '升降'];

function VideoStudio() {
  const { state, submit } = useStore();
  const [prompt, setPrompt] = useState('');
  const [way, setWay] = useState<'t2v' | 'i2v' | 'fl'>('t2v');
  const [strategy, setStrategy] = useState<RoutingStrategy>('auto');
  const [pinned, setPinned] = useState<string | null>(null);
  const [ratio, setRatio] = useState('9:16');
  const [duration, setDuration] = useState(5);
  const [resolution, setResolution] = useState('720p');
  const [camera, setCamera] = useState('推进');
  const [strength, setStrength] = useState(50);
  const [audio, setAudio] = useState(false);
  const [frame, setFrame] = useState<Asset | null>(null);
  const { model } = useResolvedModel('video', prompt, strategy, pinned);
  const maxD = model.maxDuration ?? 10;
  const d = Math.min(duration, maxD);
  const params = { ratio, duration: d, resolution, audio: audio && !!model.nativeAudio, camera };
  const credits = estimateCredits(model, params);
  const images = state.assets.filter((a) => a.kind === 'image').slice(0, 6);

  const go = (p = prompt) => {
    if (!p.trim()) return;
    submit({ modality: 'video', prompt: `${p.trim()}${camera !== '固定' ? `（运镜：${camera}）` : ''}`, model, params, count: 1 });
  };

  useHandoff('video', (p, auto, ff) => {
    setPrompt(p);
    if (ff) {
      setFrame(ff);
      setWay('i2v');
      setRatio(ff.ratio === '3:4' ? '9:16' : ff.ratio);
    }
    if (auto && p) window.setTimeout(() => go(p), 50);
  });

  return (
    <Shell
      mode="video"
      form={
        <>
          <Segmented
            label="生成方式"
            value={way}
            onChange={setWay}
            options={[
              { value: 't2v', label: '文生视频' },
              { value: 'i2v', label: '图生视频' },
              { value: 'fl', label: '首尾帧' },
            ]}
          />
          {way !== 't2v' && (
            <div className="field">
              <span className="field-label">{way === 'fl' ? '首帧（从资产库选择）' : '参考首帧（从资产库选择）'}</span>
              <div className="ref-row">
                {images.map((a) => (
                  <button
                    key={a.id}
                    className="ref-thumb"
                    style={{ padding: 0, outline: frame?.id === a.id ? '2px solid var(--accent-2)' : undefined, outlineOffset: 2 }}
                    onClick={() => setFrame(a)}
                    aria-label={`选择 ${a.title} 作为首帧`}
                    aria-pressed={frame?.id === a.id}
                  >
                    <Art prompt={a.prompt} ratio="1:1" variant={a.variant} badge={false} long={160} style={{ borderRadius: 0, height: '100%' }} />
                  </button>
                ))}
              </div>
            </div>
          )}
          <PromptField id="vid-prompt" value={prompt} onChange={setPrompt} placeholder="描述镜头：画面内容、动作、节奏。写“多镜头 / 广告片”会路由到多镜头模型" />
          <ModelPicker modality="video" prompt={prompt} strategy={strategy} onStrategy={setStrategy} pinned={pinned} onPinned={setPinned} />
          <div className="field">
            <span className="field-label">比例</span>
            <Segmented label="比例" value={ratio} onChange={setRatio} options={['9:16', '16:9', '1:1', '4:3'].map((v) => ({ value: v, label: v }))} />
          </div>
          <div className="field">
            <span className="field-label">
              时长 <span className="subtle">该模型最长 {maxD} 秒</span>
            </span>
            <Segmented label="时长" value={d} onChange={setDuration} options={[5, 10, 15].filter((v) => v <= maxD).map((v) => ({ value: v, label: `${v} 秒` }))} />
          </div>
          <div className="field">
            <span className="field-label">分辨率</span>
            <Segmented
              label="分辨率"
              value={resolution}
              onChange={setResolution}
              options={[
                { value: '720p', label: '720p' },
                { value: '1080p', label: '1080p' },
              ]}
            />
          </div>
          <div className="field">
            <span className="field-label">
              运镜 <span className="subtle">强度 {strength}</span>
            </span>
            <div className="camera-grid" role="group" aria-label="运镜">
              {CAMERA.map((c) => (
                <button key={c} aria-pressed={camera === c} onClick={() => setCamera(c)}>
                  {c}
                </button>
              ))}
            </div>
            <input id="vid-strength" type="range" min={0} max={100} value={strength} onChange={(e) => setStrength(Number(e.target.value))} aria-label="运镜强度" style={{ accentColor: 'var(--accent-2)' }} />
          </div>
          <div className="inline-row">
            <label htmlFor="vid-audio" style={{ fontSize: 13, color: model.nativeAudio ? undefined : 'var(--fg-3)' }}>
              原生音频 <span className="subtle">{model.nativeAudio ? '积分 ×1.5' : '当前模型不支持'}</span>
            </label>
            <Switch id="vid-audio" checked={audio && !!model.nativeAudio} onChange={(v) => model.nativeAudio && setAudio(v)} label="原生音频" />
          </div>
        </>
      }
      submit={<SubmitButton credits={credits} disabled={!prompt.trim() || (way !== 't2v' && !frame)} onClick={() => go()} />}
      main={
        <>
          <div className="example-note">
            <Clapperboard size={14} /> 视频通常需要 1–5 分钟，提交后可以离开页面，完成后会通知你
          </div>
          <TaskFeed
            modality="video"
            empty={
              <div className="empty">
                <Video size={28} />
                <b>还没有视频任务</b>
                <span>描述一个镜头，或从图像结果点“转为视频”</span>
              </div>
            }
          />
        </>
      }
    />
  );
}

/* ---------------- 写作 ---------------- */

const TPL_ICON: Record<string, typeof FileText> = { xhs: Heart, script: Clapperboard, ad: Megaphone, storyboard: LayoutGrid, article: Newspaper };

function draft(tpl: string, topic: string, tone: string): string {
  const t = topic || '秋季咖啡新品';
  switch (tpl) {
    case 'xhs':
      return `【标题】${t}｜这个秋天的第一杯，我先替你们试过了\n\n姐妹们，${t}真的有被惊艳到！\n\n入口是枫糖的焦香，接着是燕麦奶的绵密，最后留下一点点肉桂的暖意。店里靠窗的位置下午三点光线最好，随手一拍就是封面。\n\n推荐指数：★★★★★\n人均：32 元\n适合：一个人发呆 / 和闺蜜拍照\n\n#${t.replace(/\s/g, '')} #秋天的第一杯 #城市探店 #咖啡日记`;
    case 'script':
      return `《${t}》15 秒口播脚本（${tone}）\n\n0–3 秒｜开场钩子\n画面：特写镜头，热气从杯口升起\n口播：“秋天的第一杯，你喝对了吗？”\n\n3–9 秒｜产品卖点\n画面：枫糖淋在奶泡上，慢动作\n口播：“真枫糖、燕麦奶、现磨豆，三样都不将就。”\n\n9–15 秒｜行动号召\n画面：门店外景 + 品牌 Logo\n口播：“到店说‘山野’，第二杯半价。”`;
    case 'ad':
      return `${t} · 广告文案（${tone}）\n\n主标题：把山野的秋天，装进一杯拿铁\n副标题：真枫糖 × 燕麦奶，限定 60 天\n\n卖点：\n· 加拿大真枫糖浆，不加香精\n· 燕麦奶基底，轻盈不腻\n· 每日现烘豆，下单现磨`;
    case 'article':
      return `${t}：一家小店如何在秋天被记住\n\n一、为什么是秋天\n秋天是饮品消费的拐点，热饮重新回到菜单 C 位……\n\n二、产品怎么讲故事\n比起“好喝”，用户更愿意为“有画面的味道”买单……\n\n三、门店如何承接流量\n从小红书种草到到店核销，关键是一个能被拍下来的角落……`;
    default:
      return '';
  }
}

const BOARD = [
  ['1', '远景', '雨夜街头，霓虹倒映在积水里，行人匆匆', '（环境音：雨声）', '3s'],
  ['2', '中景', '沈砚撑黑伞站在便利店门口，望向街对面', '—', '2s'],
  ['3', '特写', '女主回头，雨水顺着发梢滴落，眼神惊讶', '“……是你？”', '2s'],
  ['4', '近景', '沈砚握伞的手微微收紧', '“好久不见。”', '2s'],
  ['5', '全景', '两人隔着马路对望，一辆电车从中间驶过', '（电车铃声）', '3s'],
  ['6', '特写', '电车驶过后，街对面只剩一把打开的伞', '—', '3s'],
];

function WriteStudio() {
  const { charge, addAsset, toast, setHandoff } = useStore();
  const [tpl, setTpl] = useState('xhs');
  const [topic, setTopic] = useState('');
  const [tone, setTone] = useState('亲切');
  const [length, setLength] = useState('中');
  const [strategy, setStrategy] = useState<RoutingStrategy>('auto');
  const [pinned, setPinned] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [board, setBoard] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number>(0);
  const routingHint = `${WRITING_TEMPLATES.find((w) => w.id === tpl)?.name} ${topic}`;
  const { model } = useResolvedModel('text', routingHint, strategy, pinned);
  const target = { 短: 300, 中: 800, 长: 2000 }[length] ?? 800;
  const credits = estimateCredits(model, { chars: target });

  useHandoff('text', (p) => setTopic(p));
  useEffect(() => () => window.clearInterval(timer.current), []);

  const run = () => {
    if (!charge(credits, `写作 · ${model.name} · ${WRITING_TEMPLATES.find((w) => w.id === tpl)?.name}`)) return;
    window.clearInterval(timer.current);
    if (tpl === 'storyboard') {
      setText('');
      setBoard(false);
      setStreaming(true);
      timer.current = window.setTimeout(() => {
        setBoard(true);
        setStreaming(false);
        addAsset({ id: uid('ast_'), kind: 'text', title: `分镜表 · ${topic || '雨夜重逢'}`, prompt: '分镜表', ratio: '1:1', variant: 0, createdAt: Date.now(), model: model.name, text: BOARD.map((r) => r.join(' | ')).join('\n') });
        toast(`分镜表已生成 · 消耗 ${credits} 积分`);
      }, 1400) as unknown as number;
      return;
    }
    setBoard(false);
    const full = draft(tpl, topic, tone);
    let i = 0;
    setText('');
    setStreaming(true);
    timer.current = window.setInterval(() => {
      i += 3 + Math.floor(Math.random() * 4);
      setText(full.slice(0, i));
      if (i >= full.length) {
        window.clearInterval(timer.current);
        setStreaming(false);
        addAsset({ id: uid('ast_'), kind: 'text', title: `${WRITING_TEMPLATES.find((w) => w.id === tpl)?.name} · ${topic || '秋季咖啡新品'}`, prompt: topic, ratio: '1:1', variant: 0, createdAt: Date.now(), model: model.name, text: full });
        toast(`写作完成 · 消耗 ${credits} 积分`);
      }
    }, 30);
  };

  const transform = (kind: '改写' | '扩写' | '缩写' | '换语气') => {
    const el = area.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    if (s === e) {
      toast('先在正文中选中一段文字', 'info');
      return;
    }
    if (!charge(1, `写作 · 选中${kind}`)) return;
    const sel = text.slice(s, e);
    const out =
      kind === '扩写'
        ? `${sel}在细节上再多说一点：它不只是一杯饮品，更像是给忙碌日子按下的暂停键。`
        : kind === '缩写'
          ? sel.slice(0, Math.max(6, Math.ceil(sel.length / 2))) + '。'
          : kind === '换语气'
            ? `说真的，${sel.replace(/！/g, '。')}`
            : sel.replace(/真的/g, '确实').replace(/推荐/g, '强烈安利').replace(/惊艳/g, '眼前一亮');
    setText(text.slice(0, s) + out + text.slice(e));
    toast(`已${kind}选中内容 · 1 积分`);
  };

  return (
    <Shell
      mode="text"
      form={
        <>
          <div className="field">
            <span className="field-label">文体模板</span>
            <div className="tpl-list" role="group" aria-label="文体模板">
              {WRITING_TEMPLATES.map((w) => {
                const Icon = TPL_ICON[w.id] ?? FileText;
                return (
                  <button key={w.id} aria-pressed={tpl === w.id} onClick={() => setTpl(w.id)}>
                    <span className="ico">
                      <Icon size={15} />
                    </span>
                    <span>
                      <b style={{ fontWeight: 500, display: 'block', fontSize: 13.5 }}>{w.name}</b>
                      <span className="subtle" style={{ fontSize: 12 }}>
                        {w.hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <PromptField id="write-topic" label="主题与要点" value={topic} onChange={setTopic} placeholder={tpl === 'storyboard' ? '粘贴剧本片段，或写下这一集的剧情梗概' : '例如：山野咖啡秋季新品枫糖拿铁，主打真枫糖与燕麦奶'} enhance={false} />
          <div className="field">
            <span className="field-label">语气</span>
            <div className="chips">
              {['亲切', '专业', '幽默', '文艺', '激昂'].map((t) => (
                <button key={t} className="chip" aria-pressed={tone === t} onClick={() => setTone(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span className="field-label">篇幅</span>
            <Segmented label="篇幅" value={length} onChange={setLength} options={['短', '中', '长'].map((v) => ({ value: v, label: v }))} />
          </div>
          <ModelPicker modality="text" prompt={routingHint} strategy={strategy} onStrategy={setStrategy} pinned={pinned} onPinned={setPinned} />
        </>
      }
      submit={<SubmitButton credits={credits} disabled={streaming} onClick={run} label={streaming ? '生成中…' : '开始写作'} />}
      main={
        <div className="writer">
          <div className="writer-toolbar" role="toolbar" aria-label="选中文字后操作">
            <span className="subtle" style={{ fontSize: 12.5, padding: '0 6px' }}>
              选中文字后：
            </span>
            {(['改写', '扩写', '缩写', '换语气'] as const).map((k) => (
              <button key={k} className="btn ghost sm" onClick={() => transform(k)} disabled={board || !text}>
                {k}
              </button>
            ))}
            <span className="sep" />
            <button
              className="btn ghost sm"
              disabled={!text}
              onClick={() => {
                navigator.clipboard?.writeText(`${text}\n\n（本内容由 AI 生成）`).then(
                  () => toast('已复制，末尾附带“本内容由 AI 生成”标识'),
                  () => toast('复制失败，请手动选中文本复制', 'err'),
                );
              }}
            >
              复制
            </button>
            {streaming && (
              <button className="btn ghost sm" onClick={() => (window.clearInterval(timer.current), setStreaming(false))}>
                <Square size={13} /> 停止
              </button>
            )}
          </div>
          {board ? (
            <>
              <div className="board-table-wrap">
                <table className="board">
                  <thead>
                    <tr>
                      <th>镜号</th>
                      <th>景别</th>
                      <th>画面描述</th>
                      <th>台词 / 声音</th>
                      <th>时长</th>
                    </tr>
                  </thead>
                  <tbody>
                    {BOARD.map((r) => (
                      <tr key={r[0]}>
                        {r.map((c, i) => (
                          <td key={i} className={i === 0 || i === 4 ? 'mono' : undefined}>
                            {c}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn primary"
                  onClick={() => {
                    setHandoff({ to: 'canvas', templateId: 't4' });
                    navigate('canvas');
                  }}
                >
                  <Send size={15} /> 发送到画布，每个镜头生成一个图像节点
                </button>
              </div>
            </>
          ) : (
            <>
              <label htmlFor="writer-doc" className="visually-hidden">
                正文
              </label>
              <textarea
                id="writer-doc"
                ref={area}
                className="writer-doc"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={streaming ? '正在生成…' : '选择左侧模板，填写主题后点击“开始写作”。生成的文字可直接编辑，选中一段可以改写、扩写或缩写。'}
                rows={18}
              />
            </>
          )}
          <div className="writer-foot">
            <span className="mono">{board ? `${BOARD.length} 个镜头` : `${text.length} 字`}</span>
            <span>导出或复制时自动附带 AI 生成标识</span>
          </div>
        </div>
      }
    />
  );
}

/* ---------------- 音频 ---------------- */

function AudioStudio() {
  const { submit } = useStore();
  const [tab, setTab] = useState<'tts' | 'music'>('tts');
  const [text, setText] = useState('这个秋天，把山野的温度装进一杯拿铁里。真枫糖、燕麦奶、现磨豆，到店说“山野”，第二杯半价。');
  const [voice, setVoice] = useState('v1');
  const [speed, setSpeed] = useState(1);
  const [emotion, setEmotion] = useState('温柔');
  const [style, setStyle] = useState('Lo-fi');
  const [mood, setMood] = useState('温暖');
  const [seconds, setSeconds] = useState(30);
  const [vocal, setVocal] = useState(false);

  useHandoff('audio', (p) => p && setText(p));

  const tts = modelByCode('creature-tts');
  const music = modelByCode('creature-music');
  const vname = VOICES.find((v) => v.id === voice)?.name ?? '';
  const credits = tab === 'tts' ? estimateCredits(tts, { chars: text.length }) : estimateCredits(music, {});

  const go = () => {
    if (tab === 'tts') {
      if (!text.trim()) return;
      submit({ modality: 'audio', prompt: text.trim(), model: tts, params: { chars: text.length, voice: vname, seconds: Math.max(4, Math.round(text.length / 4.5 / speed)) }, count: 1 });
    } else {
      submit({ modality: 'audio', prompt: `${style} · ${mood}${vocal ? ' · 带人声' : ''}，${seconds} 秒`, model: music, params: { seconds }, count: 1 });
    }
  };

  return (
    <Shell
      mode="audio"
      form={
        <>
          <Segmented
            label="音频类型"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'tts', label: '配音' },
              { value: 'music', label: '配乐' },
            ]}
          />
          {tab === 'tts' ? (
            <>
              <div className="field">
                <label htmlFor="tts-text">
                  <span>配音文本</span>
                  <span className="subtle mono">{text.length} 字</span>
                </label>
                <textarea id="tts-text" className="textarea" value={text} onChange={(e) => setText(e.target.value)} maxLength={3000} />
              </div>
              <div className="field">
                <span className="field-label">音色</span>
                <div className="voice-list" role="group" aria-label="音色">
                  {VOICES.map((v) => (
                    <button key={v.id} className="voice" aria-pressed={voice === v.id} onClick={() => setVoice(v.id)}>
                      <span className="av">{v.av}</span>
                      <span style={{ minWidth: 0 }}>
                        {v.name}
                        <small>{v.desc}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span className="field-label">情绪</span>
                <div className="chips">
                  {['温柔', '平静', '兴奋', '悲伤', '严肃'].map((e) => (
                    <button key={e} className="chip" aria-pressed={emotion === e} onClick={() => setEmotion(e)}>
                      {e}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label htmlFor="tts-speed">
                  <span>语速</span>
                  <span className="mono subtle">{speed.toFixed(1)}×</span>
                </label>
                <input id="tts-speed" type="range" min={0.6} max={1.6} step={0.1} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ accentColor: 'var(--violet)' }} />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <span className="field-label">风格</span>
                <div className="chips">
                  {['Lo-fi', '流行', '古风', '电子', '钢琴', '史诗'].map((s) => (
                    <button key={s} className="chip" aria-pressed={style === s} onClick={() => setStyle(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span className="field-label">情绪</span>
                <div className="chips">
                  {['温暖', '轻快', '紧张', '治愈', '热血'].map((s) => (
                    <button key={s} className="chip" aria-pressed={mood === s} onClick={() => setMood(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <span className="field-label">时长</span>
                <Segmented label="时长" value={seconds} onChange={setSeconds} options={[15, 30, 60, 120].map((v) => ({ value: v, label: `${v} 秒` }))} />
              </div>
              <div className="inline-row">
                <label htmlFor="music-vocal" style={{ fontSize: 13 }}>
                  带人声
                </label>
                <Switch id="music-vocal" checked={vocal} onChange={setVocal} label="带人声" />
              </div>
            </>
          )}
          <div className="route-reason" style={{ background: 'var(--violet-soft)' }}>
            <Plus size={14} style={{ color: 'var(--violet)' }} />
            <span>声音克隆需要本人录制授权声明并通过人工审核，将在后续版本开放。</span>
          </div>
        </>
      }
      submit={<SubmitButton credits={credits} disabled={tab === 'tts' && !text.trim()} onClick={go} label={tab === 'tts' ? '生成配音' : '生成配乐'} />}
      main={
        <TaskFeed
          modality="audio"
          empty={
            <div className="empty">
              <AudioLines size={28} />
              <b>还没有音频</b>
              <span>选择音色并输入文字，或描述想要的配乐</span>
            </div>
          }
        />
      }
    />
  );
}
