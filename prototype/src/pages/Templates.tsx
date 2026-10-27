import { AudioLines, Image as ImageIcon, PenLine, Star, Video } from 'lucide-react';
import { useState } from 'react';
import { Art } from '../components/Art';
import { Drawer } from '../components/ui';
import { fmt, TEMPLATE_CATEGORIES, TEMPLATES } from '../lib/mock';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import type { Modality, Template } from '../lib/types';

const STEP_ICON: Record<Modality, typeof ImageIcon> = { image: ImageIcon, video: Video, text: PenLine, audio: AudioLines };

export function Templates() {
  const { setHandoff } = useStore();
  const [cat, setCat] = useState('全部');
  const [kind, setKind] = useState<'all' | 'single' | 'workflow'>('all');
  const [open, setOpen] = useState<Template | null>(null);
  const list = TEMPLATES.filter((t) => (cat === '全部' || t.category === cat) && (kind === 'all' || t.kind === kind));

  const use = (t: Template) => {
    if (t.kind === 'workflow') {
      setHandoff({ to: 'canvas', templateId: t.id });
      navigate('canvas');
    } else {
      setHandoff({ to: 'studio', prompt: t.prompt, mode: t.modality });
      navigate('studio', t.modality);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>模板市场</h2>
          <p>单步模板替换关键词即可出图；工作流模板会在画布上展开为一组节点。</p>
        </div>
        <div className="seg" role="group" aria-label="模板类型" style={{ width: 'auto' }}>
          {(
            [
              ['all', '全部'],
              ['single', '单步'],
              ['workflow', '工作流'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} aria-pressed={kind === v} onClick={() => setKind(v)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="chips" style={{ marginBottom: 18 }} role="group" aria-label="分类">
        {TEMPLATE_CATEGORIES.map((c) => (
          <button key={c} className="chip" aria-pressed={cat === c} onClick={() => setCat(c)}>
            {c}
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <div className="empty">
          <b>这个分类下还没有{kind === 'single' ? '单步' : '工作流'}模板</b>
          <span>换个分类看看，或在画布中把自己的工作流发布为模板</span>
        </div>
      ) : (
        <div className="tpl-grid">
          {list.map((t) => (
            <button key={t.id} className="tpl-card" onClick={() => setOpen(t)}>
              <Art prompt={t.cover} ratio="16:10" badge={false} long={480} />
              <div className="tpl-card-body">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className={`tag ${t.kind === 'workflow' ? 'video' : 'image'}`}>{t.kind === 'workflow' ? `工作流 · ${t.steps.length} 步` : '单步'}</span>
                  <span className="tag">{t.category}</span>
                  {t.official && <span className="tag ok">官方</span>}
                </div>
                <h4>{t.title}</h4>
                <p>{t.desc}</p>
                <div className="tpl-meta">
                  <span className="mono">约 {t.steps.reduce((a, s) => a + s.credits, 0)} 积分</span>
                  <span>{fmt(t.uses)} 次使用</span>
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <Star size={12} /> {t.rating}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {open && (
        <Drawer
          title={open.title}
          onClose={() => setOpen(null)}
          foot={
            <>
              <button className="btn" onClick={() => setOpen(null)}>
                关闭
              </button>
              <button className="btn primary" style={{ flex: 1 }} onClick={() => use(open)}>
                使用模板 <span className="cost">· 约 {open.steps.reduce((a, s) => a + s.credits, 0)} 积分</span>
              </button>
            </>
          }
        >
          <Art prompt={open.cover} ratio="16:10" long={900} />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className={`tag ${open.kind === 'workflow' ? 'video' : 'image'}`}>{open.kind === 'workflow' ? '工作流' : '单步'}</span>
            <span className="subtle" style={{ fontSize: 12.5 }}>
              作者 {open.author} · {fmt(open.uses)} 次使用 · 评分 {open.rating}
            </span>
          </div>
          <p className="muted">{open.desc}</p>
          <div>
            <div className="eyebrow" style={{ marginBottom: 12 }}>
              执行步骤
            </div>
            <ol className="steps">
              {open.steps.map((s, i) => {
                const Icon = STEP_ICON[s.kind];
                return (
                  <li key={i}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Icon size={15} /> {s.title}
                      </span>
                      <span className="mono" style={{ color: 'var(--gold)', fontSize: 12.5 }}>
                        {s.credits} 积分
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="field">
            <span className="field-label">示例输入</span>
            <div className="prompt-box">{open.prompt}</div>
          </div>
          <p className="subtle" style={{ fontSize: 12 }}>
            积分为预估值，实际以所选模型与参数为准；失败步骤全额返还。
          </p>
        </Drawer>
      )}
    </div>
  );
}
