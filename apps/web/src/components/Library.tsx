// 角色库与品牌套件（接入后端时）：资产页中的管理界面，以及工作台中的引用选择

import {
  CHARACTER_VIEWS,
  CONTEXT_MODALITIES,
  LIBRARY_LIMITS,
  LIKENESS_LABEL,
  LOGO_VARIANTS,
  type BrandColor,
  type BrandKitDTO,
  type CharacterDTO,
  type CharacterView,
  type Likeness,
  type LogoVariant,
  type Modality,
} from '@creature/shared';
import { Crown, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { reloadLibrary, useLibrary, type ContextChoice } from '../lib/library';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { Art } from './Art';
import { Modal } from './ui';

/** 选中的图片：资产 ID 与访问地址 */
interface Pick {
  asset_id: string;
  url?: string;
}

const splitTags = (s: string) =>
  s
    .split(/[,，、\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

function Upgrade() {
  return (
    <div className="panel upgrade-card">
      <Crown size={20} />
      <div style={{ flex: 1 }}>
        <h4>角色库与品牌套件是专业版功能</h4>
        <p className="muted">升级后可建立角色卡保持人物一致，并把品牌配色、调性、禁用元素与 Logo 自动带入生成。</p>
      </div>
      <button className="btn primary" onClick={() => navigate('pricing')}>
        查看套餐
      </button>
    </div>
  );
}

function Thumb({ url, label, children }: { url?: string; label: string; children?: ReactNode }) {
  return (
    <div className="ref-thumb" aria-label={label}>
      <Art prompt="" ratio="1:1" url={url} badge={false} long={160} style={{ borderRadius: 0, height: '100%' }} />
      {children}
    </div>
  );
}

/** 从资产库选图或上传新图；extra 渲染在每张已选图片上（如视角、Logo 版本） */
function ImagePicker({
  picked,
  max,
  onAdd,
  onRemove,
  extra,
  uploadedOnly = false,
  label,
}: {
  picked: Pick[];
  max: number;
  onAdd: (p: Pick) => void;
  onRemove: (assetId: string) => void;
  extra?: (p: Pick) => ReactNode;
  uploadedOnly?: boolean;
  label: string;
}) {
  const { state, uploadImage } = useStore();
  const [busy, setBusy] = useState(0);
  const library = state.assets.filter((a) => a.kind === 'image' && (!uploadedOnly || a.source === 'uploaded') && !picked.some((p) => p.asset_id === a.id)).slice(0, 12);
  const onFiles = (files: FileList | null) => {
    for (const file of Array.from(files ?? []).slice(0, max - picked.length)) {
      setBusy((n) => n + 1);
      void uploadImage(file)
        .then((a) => a && onAdd({ asset_id: a.id, url: a.url }))
        .finally(() => setBusy((n) => n - 1));
    }
  };
  return (
    <div className="lib-picker">
      <div className="ref-row">
        {picked.map((p) => (
          <Thumb key={p.asset_id} url={p.url} label={label}>
            {extra?.(p)}
            <button type="button" className="ref-remove" aria-label="移除" onClick={() => onRemove(p.asset_id)}>
              <X size={12} />
            </button>
          </Thumb>
        ))}
        {busy > 0 && <div className="ref-thumb ref-busy-tile">上传中</div>}
        {picked.length + busy < max && (
          <label className="ref-add" aria-label={`上传${label}`}>
            <Upload size={18} />
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple={max > 1} onChange={(e) => (onFiles(e.target.files), (e.target.value = ''))} />
          </label>
        )}
      </div>
      {picked.length < max && library.length > 0 && (
        <div className="ref-row lib-source" role="group" aria-label={`从资产库选择${label}`}>
          {library.map((a) => (
            <button key={a.id} type="button" className="ref-thumb" style={{ padding: 0 }} aria-label={`选择 ${a.title}`} onClick={() => onAdd({ asset_id: a.id, url: a.url })}>
              <Art prompt={a.prompt} ratio="1:1" variant={a.variant} url={a.url} badge={false} long={160} style={{ borderRadius: 0, height: '100%' }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DeleteConfirm({ what, onCancel, onConfirm }: { what: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="inline-confirm">
      <span style={{ flex: 1 }}>删除{what}？已生成的作品不受影响。</span>
      <button className="btn sm" onClick={onCancel}>
        取消
      </button>
      <button className="btn sm danger" onClick={onConfirm}>
        删除
      </button>
    </div>
  );
}

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : '保存失败，请重试');

// ---------- 角色库 ----------

export function CharacterLibrary() {
  const lib = useLibrary();
  const { toast, setHandoff } = useStore();
  const [editing, setEditing] = useState<CharacterDTO | 'new' | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const { used, limit } = lib.quota.characters;
  // 进入页面时刷新（可能刚升级了套餐）
  useEffect(() => void reloadLibrary().catch(() => undefined), []);

  const remove = async (id: string) => {
    try {
      await api.deleteCharacter(id);
      await reloadLibrary();
      toast('角色已删除');
    } catch (e) {
      toast(errorText(e), 'err');
    }
    setConfirmId(null);
  };

  return (
    <>
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h2>角色库</h2>
          <p>
            上传 {LIBRARY_LIMITS.characterRefs.min}–{LIBRARY_LIMITS.characterRefs.max} 张同一人物或 IP 的图片建立角色，生成图像或视频时引用，保持角色在不同画面中一致。
            {limit > 0 && (
              <span className="subtle">
                {' '}
                已建 {used} / {limit} 个
              </span>
            )}
          </p>
        </div>
        <button className="btn primary" disabled={!limit || used >= limit} onClick={() => setEditing('new')}>
          <Plus size={15} /> 新建角色
        </button>
      </div>
      {lib.loaded && !limit && <Upgrade />}
      {lib.loaded && limit > 0 && !lib.characters.length && <p className="empty">还没有角色。上传正面、侧面、全身等几张图片，生成时引用即可。</p>}
      <div className="char-grid">
        {lib.characters.map((c) => (
          <article key={c.id} className="panel char-card" data-character={c.name}>
            <div className={`char-refs ${c.refs.length >= 5 ? '' : 'three'}`}>
              {c.refs.slice(0, c.refs.length >= 5 ? 5 : 3).map((r) => (
                <Art key={r.asset_id} prompt="" ratio="1:1" url={r.url} badge={false} long={360} style={{ aspectRatio: 'auto', height: '100%' }} />
              ))}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <h4 style={{ fontSize: 15 }}>{c.name}</h4>
                <span className="tag">{LIKENESS_LABEL[c.likeness]}</span>
              </div>
              {c.description && (
                <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                  {c.description}
                </p>
              )}
              <p className="subtle" style={{ fontSize: 12, marginTop: 6 }}>
                {c.refs.length} 张参考图 · 已引用 {c.used_count} 次
              </p>
              {c.refs.length < LIBRARY_LIMITS.characterRefs.min && <p className="hint warn">部分参考图已被删除，请编辑角色补充</p>}
            </div>
            {confirmId === c.id ? (
              <DeleteConfirm what={`角色「${c.name}」`} onCancel={() => setConfirmId(null)} onConfirm={() => void remove(c.id)} />
            ) : (
              <div className="row-actions">
                <button
                  className="btn sm primary"
                  disabled={!limit}
                  onClick={() => {
                    setHandoff({ to: 'studio', mode: 'image', characterIds: [c.id] });
                    navigate('studio', 'image');
                  }}
                >
                  用这个角色创作
                </button>
                <button className="icon-btn" aria-label={`编辑角色 ${c.name}`} disabled={!limit} onClick={() => setEditing(c)}>
                  <Pencil size={15} />
                </button>
                <button className="icon-btn" aria-label={`删除角色 ${c.name}`} onClick={() => setConfirmId(c.id)}>
                  <Trash2 size={15} />
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {editing && <CharacterEditor character={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function CharacterEditor({ character, onClose }: { character: CharacterDTO | null; onClose: () => void }) {
  const { toast } = useStore();
  const [name, setName] = useState(character?.name ?? '');
  const [description, setDescription] = useState(character?.description ?? '');
  const [likeness, setLikeness] = useState<Likeness>(character?.likeness ?? 'none');
  const [consent, setConsent] = useState<Pick[]>([]);
  const [refs, setRefs] = useState<(Pick & { view: CharacterView | null })[]>(character?.refs.map((r) => ({ asset_id: r.asset_id, url: r.url, view: r.view })) ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { min, max } = LIBRARY_LIMITS.characterRefs;

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body = {
        name: name.trim(),
        description: description.trim(),
        likeness,
        refs: refs.map((r) => ({ asset_id: r.asset_id, view: r.view })),
        // 编辑已授权的角色且没有更换授权材料时沿用原来的
        ...(likeness === 'authorized' && consent[0] ? { consent_asset_id: consent[0].asset_id } : {}),
      };
      if (character) await api.updateCharacter(character.id, body);
      else await api.createCharacter(body);
      await reloadLibrary();
      toast(character ? '角色已保存' : `已创建角色「${body.name}」`);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={character ? `编辑角色 · ${character.name}` : '新建角色'} onClose={onClose}>
      <div className="modal-body form-stack">
        <div className="field">
          <label htmlFor="char-name">名称</label>
          <input id="char-name" className="input" maxLength={20} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：林夏" />
        </div>
        <div className="field">
          <label htmlFor="char-desc">外观与设定</label>
          <textarea id="char-desc" className="textarea" maxLength={200} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="年龄、发型、服装、性格等，生成时会附在提示词中" />
        </div>
        <div className="field">
          <span className="field-label">
            参考图 <span className="subtle">{refs.length}/{max}，至少 {min} 张</span>
          </span>
          <ImagePicker
            label="参考图"
            picked={refs}
            max={max}
            onAdd={(p) => setRefs((r) => [...r, { ...p, view: null }])}
            onRemove={(id) => setRefs((r) => r.filter((x) => x.asset_id !== id))}
            extra={(p) => (
              <select
                className="ref-view"
                aria-label="视角"
                value={refs.find((r) => r.asset_id === p.asset_id)?.view ?? ''}
                onChange={(e) => setRefs((r) => r.map((x) => (x.asset_id === p.asset_id ? { ...x, view: (e.target.value || null) as CharacterView | null } : x)))}
              >
                <option value="">视角</option>
                {Object.entries(CHARACTER_VIEWS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            )}
          />
          <span className="subtle" style={{ fontSize: 12 }}>
            标注正面、全身的图片会优先用于生成
          </span>
        </div>
        <fieldset className="field">
          <legend className="field-label">肖像声明</legend>
          {(Object.keys(LIKENESS_LABEL) as Likeness[]).map((k) => (
            <label key={k} className="radio-row">
              <input type="radio" name="likeness" value={k} checked={likeness === k} onChange={() => setLikeness(k)} /> {LIKENESS_LABEL[k]}
            </label>
          ))}
          {likeness === 'authorized' && (
            <>
              <span className="subtle" style={{ fontSize: 12 }}>
                使用他人肖像需上传本人签署的肖像授权书照片{character?.likeness === 'authorized' ? '（不上传则沿用之前的授权材料）' : ''}
              </span>
              <ImagePicker label="授权材料" picked={consent} max={1} uploadedOnly onAdd={(p) => setConsent([p])} onRemove={() => setConsent([])} />
            </>
          )}
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !name.trim() || refs.length < min} onClick={() => void save()}>
            {busy ? '保存中…' : '保存角色'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- 品牌套件 ----------

export function BrandKits() {
  const lib = useLibrary();
  const { toast } = useStore();
  const [editing, setEditing] = useState<BrandKitDTO | 'new' | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const { used, limit } = lib.quota.brandKits;
  useEffect(() => void reloadLibrary().catch(() => undefined), []);

  const remove = async (id: string) => {
    try {
      await api.deleteBrandKit(id);
      await reloadLibrary();
      toast('品牌套件已删除');
    } catch (e) {
      toast(errorText(e), 'err');
    }
    setConfirmId(null);
  };

  return (
    <>
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h2>品牌套件</h2>
          <p>
            生成时选择品牌套件，配色、调性与禁用元素会自动带入提示词，图像还可以在右上角放置 Logo。
            {limit > 0 && (
              <span className="subtle">
                {' '}
                已建 {used} / {limit} 个
              </span>
            )}
          </p>
        </div>
        <button className="btn primary" disabled={!limit || used >= limit} onClick={() => setEditing('new')}>
          <Plus size={15} /> 新建品牌套件
        </button>
      </div>
      {lib.loaded && !limit && <Upgrade />}
      {lib.loaded && limit > 0 && !lib.brandKits.length && <p className="empty">还没有品牌套件。填写标准色、字体、调性与禁用元素，再上传 Logo。</p>}
      <div className="brand-list">
        {lib.brandKits.map((k) => (
          <article key={k.id} className="panel brand-card" data-brand={k.name}>
            <div className="brand-logo">
              {k.logos[0] ? (
                <Art prompt="" ratio="1:1" url={k.logos[0].url} badge={false} long={120} style={{ width: 52, height: 52, borderRadius: 14 }} />
              ) : (
                <span className="mark" style={{ background: k.colors[0]?.hex ?? 'var(--surface-2)', color: k.colors[1]?.hex ?? 'var(--fg)' }}>
                  {k.name.slice(0, 1)}
                </span>
              )}
              <div style={{ flex: 1 }}>
                <h3 style={{ fontSize: 18 }}>{k.name}</h3>
                <span className="subtle" style={{ fontSize: 12.5 }}>
                  {k.logos.length ? `Logo ${k.logos.length} 个版本` : '未上传 Logo'} · 已引用 {k.used_count} 次
                </span>
              </div>
              {confirmId !== k.id && (
                <>
                  <button className="icon-btn" aria-label={`编辑品牌套件 ${k.name}`} disabled={!limit} onClick={() => setEditing(k)}>
                    <Pencil size={15} />
                  </button>
                  <button className="icon-btn" aria-label={`删除品牌套件 ${k.name}`} onClick={() => setConfirmId(k.id)}>
                    <Trash2 size={15} />
                  </button>
                </>
              )}
            </div>
            {confirmId === k.id && <DeleteConfirm what={`品牌套件「${k.name}」`} onCancel={() => setConfirmId(null)} onConfirm={() => void remove(k.id)} />}
            {k.colors.length > 0 && (
              <div className="field">
                <span className="field-label">标准色</span>
                <div className="swatches">
                  {k.colors.map((c) => (
                    <span className="swatch" key={c.hex + c.name}>
                      <i style={{ background: c.hex }} />
                      {c.name}
                      <br />
                      {c.hex}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {k.fonts.length > 0 && (
              <div className="field">
                <span className="field-label">字体</span>
                <div className="chips">
                  {k.fonts.map((f) => (
                    <span className="tag" key={f}>
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {k.tone && (
              <div className="field">
                <span className="field-label">品牌调性</span>
                <p className="prompt-box">{k.tone}</p>
              </div>
            )}
            {k.banned.length > 0 && (
              <div className="field">
                <span className="field-label">禁用元素</span>
                <div className="chips">
                  {k.banned.map((b) => (
                    <span className="tag danger" key={b}>
                      {b}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
      {editing && <BrandEditor kit={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function BrandEditor({ kit, onClose }: { kit: BrandKitDTO | null; onClose: () => void }) {
  const { toast } = useStore();
  const [name, setName] = useState(kit?.name ?? '');
  const [tone, setTone] = useState(kit?.tone ?? '');
  const [colors, setColors] = useState<BrandColor[]>(kit?.colors ?? []);
  const [fonts, setFonts] = useState((kit?.fonts ?? []).join('、'));
  const [banned, setBanned] = useState((kit?.banned ?? []).join('、'));
  const [logos, setLogos] = useState<(Pick & { variant: LogoVariant })[]>(kit?.logos ?? []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const variants = Object.keys(LOGO_VARIANTS) as LogoVariant[];

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body = { name: name.trim(), tone: tone.trim(), colors, fonts: splitTags(fonts), banned: splitTags(banned), logos: logos.map((l) => ({ asset_id: l.asset_id, variant: l.variant })) };
      if (kit) await api.updateBrandKit(kit.id, body);
      else await api.createBrandKit(body);
      await reloadLibrary();
      toast(kit ? '品牌套件已保存' : `已创建品牌套件「${body.name}」`);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={kit ? `编辑品牌套件 · ${kit.name}` : '新建品牌套件'} onClose={onClose}>
      <div className="modal-body form-stack">
        <div className="field">
          <label htmlFor="brand-name">品牌名称</label>
          <input id="brand-name" className="input" maxLength={20} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：山野咖啡" />
        </div>
        <div className="field">
          <span className="field-label">
            标准色 <span className="subtle">{colors.length}/{LIBRARY_LIMITS.brandColors}</span>
          </span>
          {colors.map((c, i) => (
            <div className="color-row" key={i}>
              <input type="color" aria-label={`颜色 ${i + 1}`} value={c.hex} onChange={(e) => setColors((x) => x.map((y, j) => (j === i ? { ...y, hex: e.target.value.toUpperCase() } : y)))} />
              <input className="input" aria-label={`颜色 ${i + 1} 名称`} maxLength={10} value={c.name} onChange={(e) => setColors((x) => x.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
              <span className="mono subtle">{c.hex}</span>
              <button type="button" className="icon-btn" aria-label={`移除颜色 ${i + 1}`} onClick={() => setColors((x) => x.filter((_, j) => j !== i))}>
                <X size={14} />
              </button>
            </div>
          ))}
          {colors.length < LIBRARY_LIMITS.brandColors && (
            <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setColors((x) => [...x, { name: `颜色 ${x.length + 1}`, hex: '#B5652B' }])}>
              <Plus size={14} /> 添加颜色
            </button>
          )}
        </div>
        <div className="field">
          <label htmlFor="brand-fonts">字体</label>
          <input id="brand-fonts" className="input" value={fonts} onChange={(e) => setFonts(e.target.value)} placeholder="用顿号分隔，如：思源宋体 · 标题、思源黑体 · 正文" />
        </div>
        <div className="field">
          <label htmlFor="brand-tone">品牌调性</label>
          <textarea id="brand-tone" className="textarea" rows={2} maxLength={200} value={tone} onChange={(e) => setTone(e.target.value)} placeholder="如：温暖、自然、有手作感" />
        </div>
        <div className="field">
          <label htmlFor="brand-banned">禁用元素</label>
          <input id="brand-banned" className="input" value={banned} onChange={(e) => setBanned(e.target.value)} placeholder="用顿号分隔，如：冷色调、塑料质感" />
        </div>
        <div className="field">
          <span className="field-label">
            Logo <span className="subtle">最多 {LIBRARY_LIMITS.brandLogos} 个版本，主 Logo 用于放置在画面中</span>
          </span>
          <ImagePicker
            label="Logo"
            picked={logos}
            max={LIBRARY_LIMITS.brandLogos}
            onAdd={(p) => setLogos((l) => [...l, { ...p, variant: variants.find((v) => !l.some((x) => x.variant === v)) ?? 'primary' }])}
            onRemove={(id) => setLogos((l) => l.filter((x) => x.asset_id !== id))}
            extra={(p) => (
              <select
                className="ref-view"
                aria-label="Logo 版本"
                value={logos.find((l) => l.asset_id === p.asset_id)?.variant}
                onChange={(e) => setLogos((l) => l.map((x) => (x.asset_id === p.asset_id ? { ...x, variant: e.target.value as LogoVariant } : x)))}
              >
                {variants.map((v) => (
                  <option key={v} value={v}>
                    {LOGO_VARIANTS[v]}
                  </option>
                ))}
              </select>
            )}
          />
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy ? '保存中…' : '保存品牌套件'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- 工作台：选择引用 ----------

/** 工作台中的品牌套件与角色选择（接入后端时） */
export function ContextPicker({ modality, value, onChange }: { modality: Modality; value: ContextChoice; onChange: (v: ContextChoice) => void }) {
  const lib = useLibrary();
  const { state } = useStore();
  // 套餐变化（如刚升级）后刷新配额
  useEffect(() => void reloadLibrary().catch(() => undefined), [state.profile?.planCode, state.profile?.planExpiresAt]);
  const locked = lib.loaded && !lib.quota.characters.limit;
  const withCharacters = CONTEXT_MODALITIES.characters.includes(modality);
  const kit = lib.brandKits.find((k) => k.id === value.brandKitId);
  // 选中的角色或套件被删除后取消选择
  useEffect(() => {
    if (!lib.loaded) return;
    const characterIds = value.characterIds.filter((id) => lib.characters.some((c) => c.id === id));
    const brandKitId = value.brandKitId && lib.brandKits.some((k) => k.id === value.brandKitId) ? value.brandKitId : null;
    if (characterIds.length !== value.characterIds.length || brandKitId !== value.brandKitId) onChange({ characterIds, brandKitId, placeLogo: brandKitId ? value.placeLogo : false });
  }, [lib, value, onChange]);

  if (locked) {
    return (
      <div className="field">
        <span className="field-label">品牌套件{withCharacters ? ' · 角色' : ''}</span>
        <button type="button" className="btn sm" onClick={() => navigate('pricing')}>
          <Crown size={14} /> 专业版功能，查看套餐
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="field">
        <label htmlFor={`${modality}-brand`}>品牌套件</label>
        <select id={`${modality}-brand`} className="select" value={value.brandKitId ?? ''} onChange={(e) => onChange({ ...value, brandKitId: e.target.value || null, placeLogo: false })}>
          <option value="">不使用品牌套件</option>
          {lib.brandKits.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
        {lib.loaded && !lib.brandKits.length && (
          <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => navigate('assets')}>
            去资产 · 品牌套件新建
          </button>
        )}
        {modality === 'image' && kit && (
          <label className="check-row">
            <input type="checkbox" checked={value.placeLogo} disabled={!kit.logos.length} onChange={(e) => onChange({ ...value, placeLogo: e.target.checked })} />
            {kit.logos.length ? '在画面右上角放置 Logo' : '该品牌套件还没有 Logo'}
          </label>
        )}
      </div>
      {withCharacters && (
        <div className="field">
          <span className="field-label">
            引用角色 <span className="subtle">最多 {LIBRARY_LIMITS.charactersPerGeneration} 个</span>
          </span>
          <div className="chips" role="group" aria-label="引用角色">
            {lib.characters.map((c) => {
              const on = value.characterIds.includes(c.id);
              const full = !on && value.characterIds.length >= LIBRARY_LIMITS.charactersPerGeneration;
              return (
                <button
                  key={c.id}
                  type="button"
                  className="chip char-chip"
                  aria-pressed={on}
                  disabled={full}
                  onClick={() => onChange({ ...value, characterIds: on ? value.characterIds.filter((x) => x !== c.id) : [...value.characterIds, c.id] })}
                >
                  {c.refs[0] && <Art prompt="" ratio="1:1" url={c.refs[0].url} badge={false} long={64} style={{ width: 20, height: 20, borderRadius: 10 }} />}
                  {c.name}
                </button>
              );
            })}
            {lib.loaded && !lib.characters.length && (
              <button type="button" className="btn ghost sm" onClick={() => navigate('assets')}>
                去资产 · 角色库新建
              </button>
            )}
          </div>
        </div>
      )}
    </>
  );
}
