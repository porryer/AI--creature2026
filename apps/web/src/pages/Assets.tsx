import { AudioLines, Check, Download, FileText, Folder, FolderInput, Heart, Image as ImageIcon, LayoutGrid, Palette, Plus, Trash2, Upload, UserRound, Video, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Art } from '../components/Art';
import { BRAND_KIT, CHARACTERS, timeAgo } from '../lib/mock';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';

type Cat = 'all' | 'image' | 'video' | 'audio' | 'text' | 'favorite' | 'characters' | 'brand' | `folder:${string}`;

export function Assets() {
  const { state, openViewer, removeAssets, toast, setHandoff } = useStore();
  const [cat, setCat] = useState<Cat>('all');
  const [picked, setPicked] = useState<string[]>([]);
  const [confirmDel, setConfirmDel] = useState(false);
  const [q, setQ] = useState('');

  const folders = useMemo(() => Array.from(new Set(state.assets.map((a) => a.folder).filter(Boolean))) as string[], [state.assets]);
  const count = (fn: (k: (typeof state.assets)[number]) => boolean) => state.assets.filter(fn).length;
  const list = useMemo(() => {
    let l = state.assets;
    if (cat === 'favorite') l = l.filter((a) => a.favorite);
    else if (cat.startsWith('folder:')) l = l.filter((a) => a.folder === cat.slice(7));
    else if (cat !== 'all' && cat !== 'characters' && cat !== 'brand') l = l.filter((a) => a.kind === cat);
    if (q.trim()) l = l.filter((a) => (a.title + a.prompt).includes(q.trim()));
    return l;
  }, [state.assets, cat, q]);

  const nav: { id: Cat; label: string; icon: typeof ImageIcon; n?: number }[] = [
    { id: 'all', label: '全部作品', icon: LayoutGrid, n: state.assets.length },
    { id: 'image', label: '图像', icon: ImageIcon, n: count((a) => a.kind === 'image') },
    { id: 'video', label: '视频', icon: Video, n: count((a) => a.kind === 'video') },
    { id: 'audio', label: '音频', icon: AudioLines, n: count((a) => a.kind === 'audio') },
    { id: 'text', label: '文本', icon: FileText, n: count((a) => a.kind === 'text') },
    { id: 'favorite', label: '收藏', icon: Heart, n: count((a) => !!a.favorite) },
  ];

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  return (
    <div className="page">
      <div className="assets">
        <nav className="side-nav" aria-label="资产分类">
          {nav.map((n) => (
            <button key={n.id} aria-pressed={cat === n.id} onClick={() => (setCat(n.id), setPicked([]))}>
              <n.icon size={16} /> {n.label}
              <span className="count">{n.n}</span>
            </button>
          ))}
          <div className="group eyebrow">一致性资产</div>
          <button aria-pressed={cat === 'characters'} onClick={() => setCat('characters')}>
            <UserRound size={16} /> 角色库 <span className="count">{CHARACTERS.length}</span>
          </button>
          <button aria-pressed={cat === 'brand'} onClick={() => setCat('brand')}>
            <Palette size={16} /> 品牌套件 <span className="count">1</span>
          </button>
          <div className="group eyebrow">文件夹</div>
          {folders.map((f) => (
            <button key={f} aria-pressed={cat === `folder:${f}`} onClick={() => (setCat(`folder:${f}`), setPicked([]))}>
              <Folder size={16} /> {f}
              <span className="count">{count((a) => a.folder === f)}</span>
            </button>
          ))}
        </nav>

        <div style={{ minWidth: 0 }}>
          {cat === 'characters' ? (
            <Characters />
          ) : cat === 'brand' ? (
            <Brand />
          ) : (
            <>
              <div className="page-head" style={{ marginBottom: 14 }}>
                <div>
                  <h2>{nav.find((n) => n.id === cat)?.label ?? cat.slice(7)}</h2>
                  <p>未收藏的作品保留 180 天，收藏后永久保存。下载文件均带 AI 生成标识。</p>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <input id="asset-search" className="input" style={{ width: 220 }} placeholder="搜索：如“红色背景的猫”" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索资产" />
                  <label className="btn">
                    <Upload size={15} /> 上传素材
                    <input
                      id="asset-upload"
                      type="file"
                      accept="image/*,video/*,audio/*"
                      style={{ display: 'none' }}
                      onChange={(e) => e.target.files?.length && toast('素材已上传，正在进行内容审核', 'info')}
                    />
                  </label>
                </div>
              </div>
              {picked.length > 0 && (
                <div className="bulkbar" role="toolbar" aria-label="批量操作">
                  <b style={{ marginRight: 'auto' }}>已选 {picked.length} 项</b>
                  <button className="btn sm" onClick={() => toast(`已开始打包下载 ${picked.length} 个文件（原型演示）`, 'info')}>
                    <Download size={14} /> 下载
                  </button>
                  <button className="btn sm" onClick={() => (setHandoff({ to: 'canvas' }), navigate('canvas'), toast(`已将 ${picked.length} 个素材加入画布`))}>
                    <Plus size={14} /> 加入画布
                  </button>
                  <button className="btn sm" onClick={() => toast('已移动到文件夹「山野咖啡」')}>
                    <FolderInput size={14} /> 移动
                  </button>
                  <button className="btn sm" onClick={() => setConfirmDel(true)}>
                    <Trash2 size={14} /> 删除
                  </button>
                  <button className="btn sm" aria-label="取消选择" onClick={() => setPicked([])}>
                    <X size={14} />
                  </button>
                </div>
              )}
              {confirmDel && (
                <div className="inline-confirm" style={{ marginBottom: 14 }}>
                  <span style={{ flex: 1 }}>删除 {picked.length} 个作品？删除后 30 天内可在回收站恢复。</span>
                  <button className="btn sm" onClick={() => setConfirmDel(false)}>
                    取消
                  </button>
                  <button
                    className="btn sm primary"
                    style={{ background: 'var(--danger)', borderColor: 'var(--danger)', color: 'var(--surface)' }}
                    onClick={async () => {
                      await removeAssets(picked);
                      toast(`已删除 ${picked.length} 个作品`);
                      setPicked([]);
                      setConfirmDel(false);
                    }}
                  >
                    删除
                  </button>
                </div>
              )}
              {list.length === 0 ? (
                <div className="empty">
                  <ImageIcon size={28} />
                  <b>这里还没有作品</b>
                  <span>去创作工作台生成，作品会自动收录到资产库</span>
                  <button className="btn primary" onClick={() => navigate('studio')}>
                    去创作
                  </button>
                </div>
              ) : (
                <div className="asset-grid">
                  {list.map((a) => {
                    const on = picked.includes(a.id);
                    return (
                      <div key={a.id} className={`asset ${on ? 'selected' : ''}`}>
                        <Art prompt={a.prompt} ratio="1:1" variant={a.variant} kind={a.kind} text={a.text} durationSec={a.durationSec} url={a.url} long={360} onClick={() => (picked.length ? toggle(a.id) : openViewer(a))} label={a.title} />
                        <button className="check" aria-label={on ? `取消选择 ${a.title}` : `选择 ${a.title}`} aria-pressed={on} onClick={() => toggle(a.id)}>
                          {on && <Check size={13} strokeWidth={3} />}
                        </button>
                        <span className="asset-name">
                          {a.favorite && <Heart size={11} fill="currentColor" style={{ color: 'var(--danger)', marginRight: 4, verticalAlign: -1 }} />}
                          {a.title}
                        </span>
                        <span className="subtle" style={{ fontSize: 11.5 }}>
                          {a.model} · {timeAgo(a.createdAt)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Characters() {
  const { toast, setHandoff } = useStore();
  return (
    <>
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h2>角色库</h2>
          <p>上传 3–8 张参考图建立角色，生成图像或视频时引用，保持同一角色在不同画面中一致。</p>
        </div>
        <button className="btn primary" onClick={() => toast('新建角色：上传参考图后自动提取特征（原型演示）', 'info')}>
          <Plus size={15} /> 新建角色
        </button>
      </div>
      <div className="char-grid">
        {CHARACTERS.map((c) => (
          <article key={c.id} className="panel char-card">
            <div className="char-refs">
              {[0, 1, 2, 3, 4].map((i) => (
                <Art key={i} prompt={c.seed} ratio={i === 0 ? '3:4' : '1:1'} variant={i} badge={false} long={i === 0 ? 360 : 180} style={{ aspectRatio: 'auto', height: '100%' }} />
              ))}
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <h4 style={{ fontSize: 15 }}>{c.name}</h4>
                <span className="tag ok">一致性已就绪</span>
              </div>
              <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                {c.desc}
              </p>
              <p className="subtle" style={{ fontSize: 12, marginTop: 6 }}>
                {c.refs} 张参考图 · 已引用 {c.used} 次
              </p>
            </div>
            <button
              className="btn sm"
              onClick={() => {
                setHandoff({ to: 'studio', mode: 'image', prompt: `${c.name}（${c.desc}）坐在秋日咖啡馆窗边看书` });
                navigate('studio', 'image');
              }}
            >
              用这个角色创作
            </button>
          </article>
        ))}
      </div>
    </>
  );
}

function Brand() {
  return (
    <>
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h2>品牌套件</h2>
          <p>生成时勾选“应用品牌套件”，配色、调性与禁用元素会自动注入，海报模板会自动放置 Logo。</p>
        </div>
      </div>
      <article className="panel brand-card" style={{ maxWidth: 720 }}>
        <div className="brand-logo">
          <span className="mark" style={{ background: BRAND_KIT.colors[0].hex, color: BRAND_KIT.colors[1].hex }}>
            山
          </span>
          <div>
            <h3 style={{ fontSize: 18 }}>{BRAND_KIT.name}</h3>
            <span className="subtle" style={{ fontSize: 12.5 }}>
              Logo 3 个版本 · 团队共享
            </span>
          </div>
        </div>
        <div className="field">
          <span className="field-label">标准色</span>
          <div className="swatches">
            {BRAND_KIT.colors.map((c) => (
              <span className="swatch" key={c.hex}>
                <i style={{ background: c.hex }} />
                {c.name}
                <br />
                {c.hex}
              </span>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">字体</span>
          <div className="chips">
            {BRAND_KIT.fonts.map((f) => (
              <span className="tag" key={f}>
                {f}
              </span>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">品牌调性</span>
          <p className="prompt-box">{BRAND_KIT.tone}</p>
        </div>
        <div className="field">
          <span className="field-label">禁用元素</span>
          <div className="chips">
            {BRAND_KIT.banned.map((b) => (
              <span className="tag danger" key={b}>
                {b}
              </span>
            ))}
          </div>
        </div>
      </article>
    </>
  );
}
