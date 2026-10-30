import {
  checkTemplateInputs,
  estimateCredits,
  modelByCode,
  renderTemplate,
  routeModel,
  TEMPLATE_CATEGORIES,
  templateParams,
  type TemplateDTO,
} from '@creature/shared';
import { AudioLines, Image as ImageIcon, PenLine, Star, Upload, Video, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Art } from '../components/Art';
import { Drawer } from '../components/ui';
import { track } from '../lib/analytics';
import { api, BACKEND } from '../lib/api';
import { fmt } from '../lib/mock';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { patchTemplate, reloadTemplates, useTemplates } from '../lib/templates';
import type { Asset, Modality } from '../lib/types';

const STEP_ICON: Record<Modality, typeof ImageIcon> = { image: ImageIcon, video: Video, text: PenLine, audio: AudioLines };

const usesText = (t: TemplateDTO) => (t.uses ? `${fmt(t.uses)} 次使用` : '新上架');
const ratingText = (t: TemplateDTO) => (t.rating.avg === null ? '暂无评分' : String(t.rating.avg));

export function Templates() {
  const { state, setHandoff } = useStore();
  const { templates, loaded } = useTemplates();
  const [cat, setCat] = useState('全部');
  const [kind, setKind] = useState<'all' | 'single' | 'workflow'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const list = templates.filter((t) => (cat === '全部' || t.category === cat) && (kind === 'all' || t.kind === kind));
  const open = templates.find((t) => t.id === openId) ?? null;

  // 从首页进入：直接打开对应模板
  useEffect(() => {
    const h = state.handoff;
    if (h?.to === 'templates' && h.templateId) {
      setOpenId(h.templateId);
      setHandoff(null);
    }
  }, [state.handoff, setHandoff]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>模板市场</h2>
          <p>单步模板填写关键词或上传图片即可生成；工作流模板会在画布上展开为一组节点。</p>
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
      {loaded && list.length === 0 ? (
        <div className="empty">
          <b>这个分类下还没有{kind === 'single' ? '单步' : kind === 'workflow' ? '工作流' : ''}模板</b>
          <span>换个分类看看</span>
        </div>
      ) : (
        <div className="tpl-grid">
          {list.map((t) => (
            <button key={t.id} className="tpl-card" data-template={t.id} onClick={() => setOpenId(t.id)}>
              <Art prompt={t.cover} ratio="16:10" badge={false} long={480} />
              <div className="tpl-card-body">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className={`tag ${t.kind === 'workflow' ? 'video' : 'image'}`}>{t.kind === 'workflow' ? `工作流 · ${t.steps.length} 步` : '单步'}</span>
                  <span className="tag">{t.category}</span>
                  <span className="tag ok">官方</span>
                </div>
                <h4>{t.title}</h4>
                <p>{t.desc}</p>
                <div className="tpl-meta">
                  <span className="mono">约 {t.estimated_credits} 积分</span>
                  <span>{usesText(t)}</span>
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <Star size={12} /> {ratingText(t)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {open && (open.kind === 'workflow' ? <WorkflowDrawer t={open} onClose={() => setOpenId(null)} /> : <SingleDrawer t={open} onClose={() => setOpenId(null)} />)}
    </div>
  );
}

/** 评分：用过模板之后才能评（接入后端时） */
function Rating({ t }: { t: TemplateDTO }) {
  const { toast } = useStore();
  if (BACKEND !== 'api') return null;
  if (!t.used_by_me) return <p className="subtle" style={{ fontSize: 12 }}>使用后可以为这个模板评分</p>;
  const rate = async (score: number) => {
    try {
      patchTemplate(await api.rateTemplate(t.id, score));
      toast('感谢评分');
    } catch {
      toast('评分失败，请重试', 'err');
    }
  };
  return (
    <div className="rating" role="group" aria-label="为模板评分">
      <span className="subtle" style={{ fontSize: 12.5 }}>我的评分</span>
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" className="icon-btn" aria-label={`${n} 星`} aria-pressed={(t.my_rating ?? 0) >= n} onClick={() => void rate(n)}>
          <Star size={16} fill={(t.my_rating ?? 0) >= n ? 'currentColor' : 'none'} />
        </button>
      ))}
    </div>
  );
}

function Header({ t }: { t: TemplateDTO }) {
  return (
    <>
      <Art prompt={t.cover} ratio="16:10" long={900} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <span className={`tag ${t.kind === 'workflow' ? 'video' : 'image'}`}>{t.kind === 'workflow' ? '工作流' : '单步'}</span>
        <span className="subtle" style={{ fontSize: 12.5 }}>
          造物官方 · {usesText(t)} · 评分 {ratingText(t)}
          {t.rating.count > 1 ? `（${t.rating.count} 人）` : ''}
        </span>
      </div>
      <p className="muted">{t.desc}</p>
    </>
  );
}

function WorkflowDrawer({ t, onClose }: { t: TemplateDTO; onClose: () => void }) {
  const { setHandoff } = useStore();
  const use = () => {
    if (BACKEND === 'api') void api.useTemplate(t.id).then(patchTemplate, () => undefined);
    setHandoff({ to: 'canvas', templateId: t.id });
    navigate('canvas');
  };
  return (
    <Drawer
      title={t.title}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" style={{ flex: 1 }} onClick={use}>
            在画布中使用 <span className="cost">· 约 {t.estimated_credits} 积分</span>
          </button>
        </>
      }
    >
      <Header t={t} />
      <div>
        <div className="eyebrow" style={{ marginBottom: 12 }}>
          执行步骤
        </div>
        <ol className="steps">
          {t.steps.map((s, i) => {
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
        <span className="field-label">示例主题</span>
        <div className="prompt-box">{t.prompt}</div>
      </div>
      <Rating t={t} />
      <p className="subtle" style={{ fontSize: 12 }}>
        积分为预估值，实际以所选模型与参数为准；失败步骤全额返还。
      </p>
    </Drawer>
  );
}

function SingleDrawer({ t, onClose }: { t: TemplateDTO; onClose: () => void }) {
  const { state, submitTemplate, uploadImage, toast } = useStore();
  const [values, setValues] = useState<Record<string, string>>({});
  const [images, setImages] = useState<Record<string, Asset>>({});
  const [busy, setBusy] = useState(false);
  const prompt = renderTemplate(t, values);
  const model = t.model ? modelByCode(t.model) : routeModel(t.modality, prompt, t.strategy ?? 'auto').model;
  const credits = estimateCredits(model, templateParams(t, prompt));
  const problem = checkTemplateInputs(t, values, Object.keys(images));
  const short = credits > state.available;
  const recent = state.assets.filter((a) => a.kind === 'image').slice(0, 6);

  useEffect(() => {
    if (short) track({ name: 'paywall_shown', props: { trigger: 'insufficient_credits' } });
  }, [short]);

  const go = async () => {
    setBusy(true);
    const id = await submitTemplate(t, values, images);
    setBusy(false);
    if (!id) return;
    toast(`已用模板「${t.title}」提交，正在生成`);
    void reloadTemplates().catch(() => undefined);
    onClose();
    navigate('studio', t.modality);
  };

  return (
    <Drawer
      title={t.title}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          {short ? (
            <button className="btn primary" style={{ flex: 1 }} onClick={() => navigate('pricing')}>
              积分不足，去充值 <span className="cost">差 {credits - state.available}</span>
            </button>
          ) : (
            <button className="btn primary" style={{ flex: 1 }} disabled={!!problem || busy} onClick={() => void go()}>
              {busy ? '提交中…' : '用这个模板生成'} <span className="cost">· {credits} 积分</span>
            </button>
          )}
        </>
      }
    >
      <Header t={t} />
      {t.inputs.map((i) =>
        i.type === 'text' ? (
          <div className="field" key={i.key}>
            <label htmlFor={`tpl-${i.key}`}>
              <span>
                {i.label} {i.required ? <span className="subtle">必填</span> : <span className="subtle">选填，留空使用示例</span>}
              </span>
            </label>
            {(i.maxLength ?? 40) > 60 ? (
              <textarea id={`tpl-${i.key}`} className="textarea" rows={3} maxLength={i.maxLength} placeholder={i.example} value={values[i.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [i.key]: e.target.value }))} />
            ) : (
              <input id={`tpl-${i.key}`} className="input" maxLength={i.maxLength ?? 40} placeholder={i.example} value={values[i.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [i.key]: e.target.value }))} />
            )}
          </div>
        ) : (
          <div className="field" key={i.key}>
            <span className="field-label">
              <span>
                {i.label} <span className="subtle">必填</span>
              </span>
            </span>
            <div className="ref-row">
              {images[i.key] ? (
                <div className="ref-thumb">
                  <Art prompt={images[i.key].prompt} ratio="1:1" variant={images[i.key].variant} url={images[i.key].url} badge={false} long={160} style={{ borderRadius: 0, height: '100%' }} />
                  <button
                    className="ref-remove"
                    aria-label={`移除${i.label}`}
                    onClick={() =>
                      setImages((m) => {
                        const { [i.key]: _, ...rest } = m;
                        return rest;
                      })
                    }
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <>
                  <label className="ref-add" aria-label={`上传${i.label}`}>
                    <Upload size={18} />
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) void uploadImage(file).then((a) => a && setImages((m) => ({ ...m, [i.key]: a })));
                      }}
                    />
                  </label>
                  {recent.map((a) => (
                    <button key={a.id} type="button" className="ref-thumb" style={{ padding: 0 }} aria-label={`选择 ${a.title} 作为${i.label}`} onClick={() => setImages((m) => ({ ...m, [i.key]: a }))}>
                      <Art prompt={a.prompt} ratio="1:1" variant={a.variant} url={a.url} badge={false} long={160} style={{ borderRadius: 0, height: '100%' }} />
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        ),
      )}
      <div className="field">
        <span className="field-label">将提交的提示词</span>
        <div className="prompt-box" data-testid="tpl-preview">
          {prompt}
        </div>
        <span className="subtle" style={{ fontSize: 12 }}>
          {model.name} · {problem ?? '可以生成'}
        </span>
      </div>
      <Rating t={t} />
    </Drawer>
  );
}
