import { ArrowRight, AudioLines, Bot, Heart, Image as ImageIcon, PenLine, Repeat2, Video } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Art } from '../components/Art';
import { Modal } from '../components/ui';
import { fmt, POSTS, TEMPLATES } from '../lib/mock';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import type { Modality, Post } from '../lib/types';

type Mode = 'agent' | Modality;

const MODES: { value: Mode; label: string; icon: typeof Bot; placeholder: string }[] = [
  { value: 'agent', label: '小造 Agent', icon: Bot, placeholder: '描述你要完成的整套内容，例如：为山野咖啡做秋季上新物料，3 张小红书海报 + 1 条 15 秒短视频' },
  { value: 'image', label: '图像', icon: ImageIcon, placeholder: '描述画面：主体、场景、光线、风格……' },
  { value: 'video', label: '视频', icon: Video, placeholder: '描述镜头：画面内容、运镜方式、节奏……' },
  { value: 'text', label: '写作', icon: PenLine, placeholder: '要写什么：小红书笔记、短视频脚本、分镜表……' },
  { value: 'audio', label: '音频', icon: AudioLines, placeholder: '输入要配音的文字，或描述想要的配乐风格' },
];

const SUGGESTS: Record<Mode, string[]> = {
  agent: ['为新开的面包店做一套开业宣传物料', '把这段剧本拆成分镜并生成画面', '做一组国风节气海报'],
  image: ['水墨国风的山间小屋，留白构图', '白色降噪耳机产品图，极简白底', '星空下游过小镇的鲸鱼，奇幻插画'],
  video: ['赛博朋克雨夜街头，环绕运镜', '柠檬落入气泡水，慢动作特写', '樱花隧道中驶过的电车，动漫风格'],
  text: ['秋季咖啡新品的小红书笔记', '15 秒产品口播脚本', '雨夜重逢的漫剧分镜表'],
  audio: ['这个秋天，把山野的温度装进一杯拿铁里。', '温暖的 Lo-fi 爵士，咖啡馆氛围'],
};

export function Explore() {
  const { setHandoff, toast } = useStore();
  const [mode, setMode] = useState<Mode>('agent');
  const [prompt, setPrompt] = useState('');
  const [tab, setTab] = useState<'recommend' | 'latest' | 'hot'>('recommend');
  const [kind, setKind] = useState<'all' | 'image' | 'video'>('all');
  const [detail, setDetail] = useState<Post | null>(null);
  const current = MODES.find((m) => m.value === mode)!;

  const posts = useMemo(() => {
    let list = POSTS.filter((p) => kind === 'all' || p.kind === kind);
    if (tab === 'hot') list = [...list].sort((a, b) => b.likes - a.likes);
    if (tab === 'latest') list = [...list].reverse();
    return list;
  }, [tab, kind]);

  const go = (text = prompt) => {
    const value = text.trim();
    if (!value) return;
    if (mode === 'agent') {
      setHandoff({ to: 'canvas', agentPrompt: value });
      navigate('canvas');
    } else {
      setHandoff({ to: 'studio', prompt: value, mode, autostart: mode !== 'text' });
      navigate('studio', mode);
    }
  };

  const remix = (p: Post) => {
    setHandoff({ to: 'studio', prompt: p.prompt, mode: p.kind });
    navigate('studio', p.kind);
  };

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      <section className="hero" aria-labelledby="hero-title">
        <h2 id="hero-title">
          说出想法，<em>造物</em>帮你做完整套内容
        </h2>
        <p>文案、图像、视频、配音在同一张画布上串联。小造会先给出计划和积分预估，你确认后再执行。</p>
        <div className="mode-tabs" role="group" aria-label="创作模式">
          {MODES.map((m) => (
            <button key={m.value} className="mode-tab" aria-pressed={mode === m.value} onClick={() => setMode(m.value)}>
              <m.icon size={16} />
              {m.label}
            </button>
          ))}
        </div>
        <div className="promptbox">
          <label htmlFor="hero-prompt" className="visually-hidden">
            创作描述
          </label>
          <textarea
            id="hero-prompt"
            rows={2}
            placeholder={current.placeholder}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                go();
              }
            }}
          />
          <div className="promptbox-foot">
            <span className="subtle" style={{ fontSize: 12.5 }}>
              {mode === 'agent' ? '规划与对话免费，执行生成按实际任务计费' : 'Enter 开始生成 · Shift + Enter 换行'}
            </span>
            <span className="grow" />
            <button className="btn primary" onClick={() => go()} disabled={!prompt.trim()}>
              {mode === 'agent' ? '交给小造' : '开始生成'}
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
        <div className="suggests">
          <span className="subtle">试试：</span>
          {SUGGESTS[mode].map((s) => (
            <button key={s} onClick={() => setPrompt(s)}>
              {s}
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="tpl-title">
        <div className="section-title">
          <h3 id="tpl-title">热门模板</h3>
          <button className="btn ghost sm" onClick={() => navigate('templates')}>
            全部模板 <ArrowRight size={14} />
          </button>
        </div>
        <div className="rail-scroll">
          {TEMPLATES.slice(0, 6).map((t) => (
            <button
              key={t.id}
              className="tpl-card"
              onClick={() => {
                setHandoff(t.kind === 'workflow' ? { to: 'canvas', templateId: t.id } : { to: 'studio', prompt: t.prompt, mode: t.modality });
                navigate(t.kind === 'workflow' ? 'canvas' : 'studio', t.kind === 'workflow' ? undefined : t.modality);
              }}
            >
              <Art prompt={t.cover} ratio="16:10" badge={false} long={480} />
              <div className="tpl-card-body">
                <div style={{ display: 'flex', gap: 6 }}>
                  <span className={`tag ${t.kind === 'workflow' ? 'video' : 'image'}`}>{t.kind === 'workflow' ? `工作流 · ${t.steps.length} 步` : '单步'}</span>
                  {t.official && <span className="tag">官方</span>}
                </div>
                <h4>{t.title}</h4>
                <p>{t.desc}</p>
                <div className="tpl-meta">
                  <span className="mono">约 {t.steps.reduce((a, s) => a + s.credits, 0)} 积分</span>
                  <span>{fmt(t.uses)} 次使用</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="feed-title">
        <div className="section-title" style={{ flexWrap: 'wrap' }}>
          <h3 id="feed-title">灵感广场</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <div className="chips" role="group" aria-label="排序">
              {(
                [
                  ['recommend', '推荐'],
                  ['latest', '最新'],
                  ['hot', '最热'],
                ] as const
              ).map(([v, l]) => (
                <button key={v} className="chip" aria-pressed={tab === v} onClick={() => setTab(v)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="chips" role="group" aria-label="类型">
              {(
                [
                  ['all', '全部'],
                  ['image', '图像'],
                  ['video', '视频'],
                ] as const
              ).map(([v, l]) => (
                <button key={v} className="chip" aria-pressed={kind === v} onClick={() => setKind(v)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="masonry">
          {posts.map((p) => (
            <article key={p.id}>
              <button className="post" onClick={() => setDetail(p)} aria-label={`查看作品：${p.title}`}>
                <Art prompt={p.prompt} ratio={p.ratio} kind={p.kind} durationSec={p.kind === 'video' ? 5 : undefined} long={520} />
              </button>
              <div className="post-title">{p.title}</div>
              <div className="post-meta">
                <span className="avatar sm">{p.author.slice(0, 1)}</span>
                <span>{p.author}</span>
                <span className="likes">
                  <Heart size={13} /> {fmt(p.likes)}
                </span>
              </div>
            </article>
          ))}
        </div>
      </section>

      {detail && (
        <Modal title={detail.title} onClose={() => setDetail(null)} wide>
          <div className="viewer">
            <div className="viewer-media">
              <Art prompt={detail.prompt} ratio={detail.ratio} kind={detail.kind} durationSec={detail.kind === 'video' ? 5 : undefined} controls long={900} />
            </div>
            <div className="viewer-info">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="avatar">{detail.author.slice(0, 1)}</span>
                <div>
                  <b>{detail.author}</b>
                  <div className="subtle" style={{ fontSize: 12 }}>
                    {fmt(detail.likes)} 喜欢 · {fmt(detail.remix)} 人做了同款
                  </div>
                </div>
              </div>
              <div className="field">
                <span className="field-label">提示词</span>
                <div className="prompt-box">{detail.prompt}</div>
              </div>
              <dl className="kv">
                <dt>模型</dt>
                <dd>{detail.model}</dd>
                <dt>比例</dt>
                <dd>{detail.ratio}</dd>
                <dt>标签</dt>
                <dd>{detail.tags.join(' · ')}</dd>
                <dt>标识</dt>
                <dd>显式标识 + 隐式元数据（内容编号 CRT-{detail.id.toUpperCase()}-2026）</dd>
              </dl>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
                <button className="btn primary" onClick={() => remix(detail)}>
                  <Repeat2 size={16} /> 做同款
                </button>
                <button className="btn" onClick={() => toast('已加入喜欢')}>
                  <Heart size={16} /> 喜欢
                </button>
                <button className="btn ghost danger" onClick={() => toast('已收到举报，我们会在 24 小时内处理', 'info')}>
                  举报
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
