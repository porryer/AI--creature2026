import { REPORT_REASONS, type FeedTab, type PostDTO, type PostStatus, type ReportReason } from '@creature/shared';
import { ArrowRight, AudioLines, Bot, Flag, Heart, Image as ImageIcon, PenLine, Repeat2, Undo2, Video } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Art } from '../components/Art';
import { Modal } from '../components/ui';
import { api, BACKEND } from '../lib/api';
import { fmt, POSTS } from '../lib/mock';
import { useTemplates } from '../lib/templates';
import { navigate } from '../lib/router';
import { errorText, simplifyRatio, useStore } from '../lib/store';
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
  const { setHandoff } = useStore();
  // 热门模板：按使用次数，新部署时按目录顺序
  const popular = [...useTemplates().templates].sort((a, b) => b.uses - a.uses).slice(0, 6);
  const [mode, setMode] = useState<Mode>('agent');
  const [prompt, setPrompt] = useState('');
  const current = MODES.find((m) => m.value === mode)!;

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
          {popular.map((t) => (
            <button
              key={t.id}
              className="tpl-card"
              onClick={() => {
                setHandoff({ to: 'templates', templateId: t.id });
                navigate('templates');
              }}
            >
              <Art prompt={t.cover} ratio="16:10" badge={false} long={480} />
              <div className="tpl-card-body">
                <div style={{ display: 'flex', gap: 6 }}>
                  <span className={`tag ${t.kind === 'workflow' ? 'video' : 'image'}`}>{t.kind === 'workflow' ? `工作流 · ${t.steps.length} 步` : '单步'}</span>
                  <span className="tag">官方</span>
                </div>
                <h4>{t.title}</h4>
                <p>{t.desc}</p>
                <div className="tpl-meta">
                  <span className="mono">约 {t.estimated_credits} 积分</span>
                  <span>{t.uses ? `${fmt(t.uses)} 次使用` : '新上架'}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>

      <Feed />
    </div>
  );
}

/* ---------------- 灵感广场 ---------------- */

interface FeedItem {
  id: string;
  title: string;
  /** 作者不公开提示词时为 null */
  prompt: string | null;
  author: string;
  kind: 'image' | 'video';
  ratio: string;
  likes: number;
  remix: number;
  model: string;
  tags: string[];
  url?: string;
  durationSec?: number;
  liked?: boolean;
  mine?: boolean;
  status?: PostStatus;
  contentId: string;
}

const fromMock = (p: Post): FeedItem => ({ id: p.id, title: p.title, prompt: p.prompt, author: p.author, kind: p.kind, ratio: p.ratio, likes: p.likes, remix: p.remix, model: p.model, tags: p.tags, durationSec: p.kind === 'video' ? 5 : undefined, contentId: `CRT-${p.id.toUpperCase()}-2026` });

const fromDTO = (p: PostDTO): FeedItem => ({
  id: p.id,
  title: p.title,
  prompt: p.prompt,
  author: p.author.nickname,
  kind: p.kind,
  ratio: p.width && p.height ? simplifyRatio(p.width, p.height) : '1:1',
  likes: p.like_count,
  remix: p.remix_count,
  model: p.model,
  tags: p.tags,
  url: p.url,
  durationSec: p.duration_sec,
  liked: p.liked,
  mine: p.mine,
  status: p.status,
  contentId: p.content_id,
});

const STATUS_TAG: Partial<Record<PostStatus, [string, string]>> = { reviewing: ['审核中', 'text'], hidden: ['已隐藏', 'danger'] };

function Feed() {
  const { setHandoff, toast } = useStore();
  const live = BACKEND === 'api';
  const [tab, setTab] = useState<FeedTab>('recommend');
  const [kind, setKind] = useState<'all' | 'image' | 'video'>('all');
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<FeedItem | null>(null);

  const load = useCallback(
    async (more: boolean, from: string | null) => {
      if (!live) {
        let list = POSTS.filter((p) => kind === 'all' || p.kind === kind).map(fromMock);
        if (tab === 'hot') list = [...list].sort((a, b) => b.likes - a.likes);
        if (tab === 'latest') list = [...list].reverse();
        setItems(list);
        return;
      }
      setLoading(true);
      try {
        const page = await api.feed(tab, kind === 'all' ? undefined : kind, more ? from : null);
        setItems((cur) => [...(more && cur ? cur : []), ...page.data.map(fromDTO)]);
        setCursor(page.next_cursor);
      } catch (e) {
        toast(errorText(e), 'err');
        if (!more) setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [live, tab, kind, toast],
  );
  useEffect(() => {
    void load(false, null);
  }, [load]);

  const patch = (id: string, p: Partial<FeedItem>) => {
    setItems((list) => list?.map((x) => (x.id === id ? { ...x, ...p } : x)) ?? null);
    setDetail((d) => (d?.id === id ? { ...d, ...p } : d));
  };

  const like = async (it: FeedItem) => {
    if (!live) return toast(it.liked ? '已取消喜欢' : '已加入喜欢'), patch(it.id, { liked: !it.liked, likes: it.likes + (it.liked ? -1 : 1) });
    try {
      const r = await api.setLike(it.id, !it.liked);
      patch(it.id, { liked: r.liked, likes: r.like_count });
    } catch (e) {
      toast(errorText(e), 'err');
    }
  };

  const remix = async (it: FeedItem) => {
    if (!live) {
      setHandoff({ to: 'studio', prompt: it.prompt ?? '', mode: it.kind });
      return navigate('studio', it.kind);
    }
    try {
      const r = await api.remix(it.id);
      setHandoff({ to: 'studio', prompt: r.prompt, mode: r.modality, params: r.params, modelCode: r.model_code });
      if (!r.prompt) toast('作者没有公开提示词，已沿用原作的模型与参数', 'info');
      navigate('studio', r.modality);
    } catch (e) {
      toast(errorText(e), 'err');
    }
  };

  const withdraw = async (it: FeedItem) => {
    try {
      await api.withdrawPost(it.id);
      setItems((list) => list?.filter((x) => x.id !== it.id) ?? null);
      setDetail(null);
      toast('已撤回，作品仍保留在你的资产库');
    } catch (e) {
      toast(errorText(e), 'err');
    }
  };

  const tabs: [FeedTab, string][] = [
    ['recommend', '推荐'],
    ['latest', '最新'],
    ['hot', '最热'],
    ...(live ? ([['mine', '我的发布']] as [FeedTab, string][]) : []),
  ];

  return (
    <section aria-labelledby="feed-title">
      <div className="section-title" style={{ flexWrap: 'wrap' }}>
        <h3 id="feed-title">灵感广场</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div className="chips" role="group" aria-label="排序">
            {tabs.map(([v, l]) => (
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
      {items === null ? (
        <p className="subtle">加载中…</p>
      ) : items.length === 0 ? (
        <div className="empty">
          <ImageIcon size={28} />
          <b>{tab === 'mine' ? '你还没有发布作品' : '广场上还没有作品'}</b>
          <span>在资产库打开一张生成的图像或视频，点“发布到广场”</span>
          <button className="btn" onClick={() => navigate('assets')}>
            去资产库
          </button>
        </div>
      ) : (
        <div className="masonry">
          {items.map((p) => (
            <article key={p.id}>
              <button className="post" onClick={() => setDetail(p)} aria-label={`查看作品：${p.title}`}>
                <Art prompt={p.prompt ?? p.title} ratio={p.ratio} kind={p.kind} durationSec={p.durationSec} url={p.url} long={520} />
              </button>
              <div className="post-title">
                {p.status && STATUS_TAG[p.status] && <span className={`tag ${STATUS_TAG[p.status]![1]}`} style={{ marginRight: 6 }}>{STATUS_TAG[p.status]![0]}</span>}
                {p.title}
              </div>
              <div className="post-meta">
                <span className="avatar sm">{p.author.slice(0, 1)}</span>
                <span>{p.author}</span>
                <span className="likes">
                  <Heart size={13} fill={p.liked ? 'currentColor' : 'none'} /> {fmt(p.likes)}
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
      {live && cursor && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 18 }}>
          <button className="btn" disabled={loading} onClick={() => void load(true, cursor)}>
            {loading ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
      {detail && <PostDetail item={detail} onClose={() => setDetail(null)} onLike={like} onRemix={remix} onWithdraw={withdraw} />}
    </section>
  );
}

function PostDetail({ item, onClose, onLike, onRemix, onWithdraw }: { item: FeedItem; onClose: () => void; onLike: (i: FeedItem) => void; onRemix: (i: FeedItem) => void; onWithdraw: (i: FeedItem) => void }) {
  const { toast } = useStore();
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState<ReportReason>('infringement');
  const [note, setNote] = useState('');
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);

  const report = async () => {
    if (BACKEND === 'api') {
      try {
        await api.report(item.id, reason, note.trim() || undefined);
      } catch (e) {
        return toast(errorText(e), 'err');
      }
    }
    setReporting(false);
    toast('已收到举报，我们会在 24 小时内处理', 'info');
  };

  return (
    <Modal title={item.title} onClose={onClose} wide>
      <div className="viewer">
        <div className="viewer-media">
          <Art prompt={item.prompt ?? item.title} ratio={item.ratio} kind={item.kind} durationSec={item.durationSec} url={item.url} controls long={900} />
        </div>
        <div className="viewer-info">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="avatar">{item.author.slice(0, 1)}</span>
            <div>
              <b>{item.author}</b>
              <div className="subtle" style={{ fontSize: 12 }}>
                {fmt(item.likes)} 喜欢 · {fmt(item.remix)} 人做了同款
              </div>
            </div>
            {item.status && STATUS_TAG[item.status] && <span className={`tag ${STATUS_TAG[item.status]![1]}`} style={{ marginLeft: 'auto' }}>{STATUS_TAG[item.status]![0]}</span>}
          </div>
          <div className="field">
            <span className="field-label">提示词</span>
            <div className="prompt-box">{item.prompt ?? <span className="subtle">作者没有公开提示词，做同款时沿用原作的模型与参数</span>}</div>
          </div>
          <dl className="kv">
            <dt>模型</dt>
            <dd>{item.model}</dd>
            <dt>比例</dt>
            <dd>{item.ratio}</dd>
            {item.tags.length > 0 && (
              <>
                <dt>标签</dt>
                <dd>{item.tags.join(' · ')}</dd>
              </>
            )}
            <dt>标识</dt>
            <dd>
              显式标识 + 隐式元数据
              <br />
              <span className="mono subtle" style={{ fontSize: 12 }}>
                内容编号 {item.contentId}
              </span>
            </dd>
          </dl>
          {reporting ? (
            <form
              className="panel publish-form"
              onSubmit={(e) => {
                e.preventDefault();
                void report();
              }}
            >
              <fieldset className="report-reasons">
                <legend className="field-label">举报原因</legend>
                {(Object.keys(REPORT_REASONS) as ReportReason[]).map((r) => (
                  <label key={r}>
                    <input type="radio" name="report-reason" value={r} checked={reason === r} onChange={() => setReason(r)} /> {REPORT_REASONS[r]}
                  </label>
                ))}
              </fieldset>
              <input className="input" aria-label="补充说明" placeholder="补充说明（选填）" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn" onClick={() => setReporting(false)}>
                  取消
                </button>
                <button type="submit" className="btn primary danger" style={{ flex: 1 }}>
                  提交举报
                </button>
              </div>
            </form>
          ) : confirmWithdraw ? (
            <div className="inline-confirm">
              <span style={{ flex: 1 }}>撤回后作品从广场移除，资产库中的原作品保留。</span>
              <button className="btn sm" onClick={() => setConfirmWithdraw(false)}>
                取消
              </button>
              <button className="btn sm danger" onClick={() => onWithdraw(item)}>
                撤回
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
              <button className="btn primary" onClick={() => onRemix(item)}>
                <Repeat2 size={16} /> 做同款
              </button>
              {item.status !== 'reviewing' && item.status !== 'hidden' && (
                <button className="btn" aria-pressed={!!item.liked} onClick={() => onLike(item)}>
                  <Heart size={16} fill={item.liked ? 'currentColor' : 'none'} /> {item.liked ? '已喜欢' : '喜欢'}
                </button>
              )}
              {item.mine ? (
                <button className="btn ghost" onClick={() => setConfirmWithdraw(true)}>
                  <Undo2 size={16} /> 撤回发布
                </button>
              ) : (
                <button className="btn ghost danger" onClick={() => setReporting(true)}>
                  <Flag size={16} /> 举报
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
