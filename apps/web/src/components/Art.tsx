import { FileText, Music2, Pause, Play } from 'lucide-react';
import { useEffect, useState, type CSSProperties } from 'react';
import { artFor, sizeForRatio, waveFor } from '@creature/shared';
import type { Modality } from '../lib/types';

interface ArtProps {
  prompt: string;
  ratio?: string;
  variant?: number;
  kind?: Modality;
  durationSec?: number;
  text?: string;
  /** 视频是否显示播放控件 */
  controls?: boolean;
  badge?: boolean;
  long?: number;
  style?: CSSProperties;
  className?: string;
  onClick?: () => void;
  label?: string;
  /** 后端返回的文件地址；为空时使用程序化占位图 */
  url?: string;
}

/** 作品缩略图：图像 / 视频使用程序化占位图，音频显示波形，文本显示摘要 */
export function Art({ prompt, ratio = '3:4', variant = 0, kind = 'image', durationSec, text, controls = false, badge = true, long = 640, style, className = '', onClick, label, url }: ArtProps) {
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const { w, h } = sizeForRatio(ratio, long);

  useEffect(() => {
    if (!playing || !durationSec) return;
    const start = performance.now() - t * 1000;
    let raf = 0;
    const step = (now: number) => {
      const s = (now - start) / 1000;
      if (s >= durationSec) {
        setT(0);
        setPlaying(false);
        return;
      }
      setT(s);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, durationSec]);

  const box: CSSProperties = { aspectRatio: `${w} / ${h}`, ...style };
  const interactive = onClick ? { role: 'button' as const, tabIndex: 0, onClick, onKeyDown: (e: React.KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && onClick() } : {};

  if (kind === 'audio') {
    const bars = waveFor(prompt + variant, 32);
    return (
      <div className={`art ${className}`} style={{ ...box, display: 'grid', placeItems: 'center', background: 'var(--violet-soft)' }} aria-label={label ?? prompt} {...interactive}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, height: '40%', width: '70%' }}>
          {bars.map((b, i) => (
            <i key={i} style={{ flex: 1, height: `${b * 100}%`, background: 'var(--violet)', borderRadius: 2, opacity: 0.85 }} />
          ))}
        </div>
        <span className="kind-badge">
          <Music2 size={11} /> {durationSec ? `${durationSec}s` : '音频'}
        </span>
        {badge && <span className="ai-badge">AI 生成</span>}
      </div>
    );
  }

  if (kind === 'text') {
    return (
      <div className={`art ${className}`} style={{ ...box, padding: '14% 12%', background: 'var(--gold-soft)', display: 'flex', flexDirection: 'column', gap: 6 }} aria-label={label ?? prompt} {...interactive}>
        <FileText size={20} color="var(--gold)" />
        <p style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--fg-2)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 5, WebkitBoxOrient: 'vertical' }}>{text ?? prompt}</p>
        {badge && <span className="ai-badge">AI 生成</span>}
      </div>
    );
  }

  // 后端文件自带显式 AI 标识（视频为 SVG 动画），不再叠加角标与模拟运镜
  if (url) {
    return (
      <div className={`art ${className}`} style={box} {...interactive}>
        <img src={url} alt={label ?? prompt} width={w} height={h} loading="lazy" draggable={false} />
        {kind === 'video' && (
          <span className="kind-badge">
            <Play size={10} /> {durationSec ? `00:${String(Math.round(durationSec)).padStart(2, '0')}` : '视频'}
          </span>
        )}
      </div>
    );
  }

  const src = artFor(prompt, { w, h, variant });
  return (
    <div className={`art ${kind === 'video' ? 'video' : ''} ${playing ? 'playing' : ''} ${className}`} style={box} {...interactive}>
      <img src={src} alt={label ?? prompt} width={w} height={h} loading="lazy" draggable={false} />
      {kind === 'video' && (
        <>
          <span className="kind-badge">
            <Play size={10} /> {durationSec ? `00:${String(Math.floor(controls && playing ? t : durationSec)).padStart(2, '0')}` : '视频'}
          </span>
          {controls && (
            <>
              <button
                className="play"
                aria-label={playing ? '暂停' : '播放'}
                onClick={(e) => {
                  e.stopPropagation();
                  setPlaying((p) => !p);
                }}
              >
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </button>
              <div className="scrub">
                <i style={{ width: `${durationSec ? (t / durationSec) * 100 : 0}%` }} />
              </div>
            </>
          )}
        </>
      )}
      {badge && <span className="ai-badge">AI 生成</span>}
    </div>
  );
}
