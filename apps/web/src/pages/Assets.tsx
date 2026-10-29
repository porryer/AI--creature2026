import { AudioLines, Check, Download, FileText, Folder, FolderInput, FolderPlus, Heart, Image as ImageIcon, LayoutGrid, Palette, Pencil, Plus, Trash2, Upload, UserRound, Video, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Art } from '../components/Art';
import { BrandKits, CharacterLibrary } from '../components/Library';
import { BACKEND } from '../lib/api';
import { useLibrary } from '../lib/library';
import { BRAND_KIT, CHARACTERS, timeAgo } from '../lib/mock';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';

type Cat = 'all' | 'image' | 'video' | 'audio' | 'text' | 'favorite' | 'characters' | 'brand' | `folder:${string}`;

export function Assets() {
  const { state, mode, openViewer, removeAssets, toast, setHandoff, uploadImage, fetchAssets, createFolder, renameFolder, deleteFolder, moveAssets, downloadAsset } = useStore();
  const [cat, setCat] = useState<Cat>('all');
  const lib = useLibrary();
  // 接入后端时显示真实数量；离线演示显示示例数据
  const libCount = BACKEND === 'api' ? { characters: lib.characters.length, brand: lib.brandKits.length } : { characters: CHARACTERS.length, brand: 1 };
  const [picked, setPicked] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<'assets' | 'folder' | null>(null);
  const [q, setQ] = useState('');
  const [uploading, setUploading] = useState(0);
  const [moving, setMoving] = useState(false);
  const [naming, setNaming] = useState<{ id: string | null; value: string } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const folderId = cat.startsWith('folder:') ? cat.slice(7) : null;
  const folder = folderId ? state.folders.find((f) => f.id === folderId) : undefined;
  const count = (fn: (k: (typeof state.assets)[number]) => boolean) => state.assets.filter(fn).length;
  const list = useMemo(() => {
    let l = [...state.assets].sort((a, b) => b.createdAt - a.createdAt);
    if (cat === 'favorite') l = l.filter((a) => a.favorite);
    else if (folderId) l = l.filter((a) => a.folder === folderId);
    else if (cat !== 'all' && cat !== 'characters' && cat !== 'brand') l = l.filter((a) => a.kind === cat);
    if (q.trim()) l = l.filter((a) => (a.title + a.prompt).includes(q.trim()));
    return l;
  }, [state.assets, cat, folderId, q]);

  // 接入后端时本地只有最近的作品：切换文件夹或搜索时从服务端补齐
  // （store 的方法随状态变化重建，用 ref 避免作为依赖反复触发）
  const fetchRef = useRef(fetchAssets);
  fetchRef.current = fetchAssets;
  useEffect(() => {
    if (folderId) void fetchRef.current({ folder: folderId });
  }, [folderId]);
  useEffect(() => {
    const kw = q.trim();
    if (!kw) return;
    const t = window.setTimeout(() => void fetchRef.current({ q: kw }), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const nav: { id: Cat; label: string; icon: typeof ImageIcon; n?: number }[] = [
    { id: 'all', label: '全部作品', icon: LayoutGrid, n: state.assets.length },
    { id: 'image', label: '图像', icon: ImageIcon, n: count((a) => a.kind === 'image') },
    { id: 'video', label: '视频', icon: Video, n: count((a) => a.kind === 'video') },
    { id: 'audio', label: '音频', icon: AudioLines, n: count((a) => a.kind === 'audio') },
    { id: 'text', label: '文本', icon: FileText, n: count((a) => a.kind === 'text') },
    { id: 'favorite', label: '收藏', icon: Heart, n: count((a) => !!a.favorite) },
  ];

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const pickCat = (c: Cat) => {
    setCat(c);
    setPicked([]);
    setConfirm(null);
    setMoving(false);
  };

  const submitName = async () => {
    if (!naming) return;
    if (naming.id === null) {
      const f = await createFolder(naming.value);
      if (f) {
        setNaming(null);
        // 从“移动到”菜单新建时直接移入
        if (moving && picked.length) await move(f.id, f.name);
      }
    } else if (await renameFolder(naming.id, naming.value)) setNaming(null);
  };

  const move = async (id: string | null, name?: string) => {
    if (await moveAssets(picked, id)) toast(id ? `已将 ${picked.length} 个作品移到「${name}」` : `已将 ${picked.length} 个作品移出文件夹`);
    setMoving(false);
    setPicked([]);
  };

  const downloadPicked = async () => {
    const items = state.assets.filter((a) => picked.includes(a.id)).slice(0, 10);
    for (const a of items) await downloadAsset(a);
    if (picked.length > 10) toast('一次最多下载 10 个，其余请分批下载', 'info');
  };

  const nameInput = (
    <form
      className="folder-name"
      onSubmit={(e) => {
        e.preventDefault();
        void submitName();
      }}
    >
      <input
        className="input"
        autoFocus
        maxLength={20}
        aria-label="文件夹名称"
        placeholder="文件夹名称"
        value={naming?.value ?? ''}
        onChange={(e) => setNaming((n) => (n ? { ...n, value: e.target.value } : n))}
        onKeyDown={(e) => e.key === 'Escape' && setNaming(null)}
      />
      <button className="btn sm primary" type="submit" disabled={!naming?.value.trim()}>
        确定
      </button>
      <button className="btn sm" type="button" aria-label="取消" onClick={() => setNaming(null)}>
        <X size={14} />
      </button>
    </form>
  );

  return (
    <div className="page">
      <div className="assets">
        <nav className="side-nav" aria-label="资产分类">
          {nav.map((n) => (
            <button key={n.id} aria-pressed={cat === n.id} onClick={() => pickCat(n.id)}>
              <n.icon size={16} /> {n.label}
              <span className="count">{n.n}</span>
            </button>
          ))}
          <div className="group eyebrow">一致性资产</div>
          <button aria-pressed={cat === 'characters'} onClick={() => pickCat('characters')}>
            <UserRound size={16} /> 角色库 <span className="count">{libCount.characters}</span>
          </button>
          <button aria-pressed={cat === 'brand'} onClick={() => pickCat('brand')}>
            <Palette size={16} /> 品牌套件 <span className="count">{libCount.brand}</span>
          </button>
          <div className="group eyebrow">文件夹</div>
          {state.folders.map((f) => (
            <button key={f.id} aria-pressed={cat === `folder:${f.id}`} onClick={() => pickCat(`folder:${f.id}`)}>
              <Folder size={16} /> {f.name}
              <span className="count">{f.count ?? count((a) => a.folder === f.id)}</span>
            </button>
          ))}
          {naming && naming.id === null && !moving ? (
            nameInput
          ) : (
            <button className="subtle" onClick={() => setNaming({ id: null, value: '' })}>
              <FolderPlus size={16} /> 新建文件夹
            </button>
          )}
        </nav>

        <div style={{ minWidth: 0 }}>
          {cat === 'characters' ? (
            BACKEND === 'api' ? <CharacterLibrary /> : <Characters />
          ) : cat === 'brand' ? (
            BACKEND === 'api' ? <BrandKits /> : <Brand />
          ) : (
            <>
              <div className="page-head" style={{ marginBottom: 14 }}>
                <div style={{ minWidth: 0 }}>
                  {naming && naming.id && naming.id === folderId ? nameInput : <h2>{folder?.name ?? nav.find((n) => n.id === cat)?.label ?? '文件夹'}</h2>}
                  <p>未收藏的作品保留 180 天，收藏后永久保存。生成作品下载后带 AI 标识，上传的素材不加标识。</p>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {folder && !naming && (
                    <>
                      <button className="btn" onClick={() => setNaming({ id: folder.id, value: folder.name })}>
                        <Pencil size={14} /> 重命名
                      </button>
                      <button className="btn" onClick={() => setConfirm('folder')}>
                        <Trash2 size={14} /> 删除文件夹
                      </button>
                    </>
                  )}
                  <input id="asset-search" className="input" style={{ width: 220 }} placeholder="搜索：如“红色背景的猫”" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索资产" />
                  <label className="btn" title="支持 PNG、JPEG、WebP，单个不超过 20 MB" aria-busy={uploading > 0}>
                    <Upload size={15} /> {uploading > 0 ? `上传中 · ${uploading}` : '上传素材'}
                    <input
                      id="asset-upload"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      multiple
                      style={{ display: 'none' }}
                      onChange={async (e) => {
                        const files = Array.from(e.target.files ?? []);
                        e.target.value = '';
                        if (!files.length) return;
                        setUploading((n) => n + files.length);
                        const done = await Promise.all(files.map((f) => uploadImage(f).finally(() => setUploading((n) => n - 1))));
                        const ok = done.filter((a): a is NonNullable<typeof a> => !!a);
                        // 在文件夹里上传时直接归入该文件夹
                        if (ok.length && folderId) await moveAssets(ok.map((a) => a.id), folderId);
                        if (ok.length) toast(`已上传 ${ok.length} 个素材，审核通过并收录到资产库`);
                      }}
                    />
                  </label>
                </div>
              </div>
              {confirm === 'folder' && folder && (
                <div className="inline-confirm" style={{ marginBottom: 14 }}>
                  <span style={{ flex: 1 }}>删除文件夹「{folder.name}」？其中的作品不会被删除，会移回“全部作品”。</span>
                  <button className="btn sm" onClick={() => setConfirm(null)}>
                    取消
                  </button>
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      if (await deleteFolder(folder.id)) {
                        toast(`已删除文件夹「${folder.name}」`);
                        pickCat('all');
                      }
                    }}
                  >
                    删除
                  </button>
                </div>
              )}
              {picked.length > 0 && (
                <div className="bulkbar" role="toolbar" aria-label="批量操作" style={{ position: 'relative' }}>
                  <b style={{ marginRight: 'auto' }}>已选 {picked.length} 项</b>
                  <button className="btn sm" onClick={() => void downloadPicked()}>
                    <Download size={14} /> 下载
                  </button>
                  <button className="btn sm" onClick={() => (setHandoff({ to: 'canvas' }), navigate('canvas'), toast(`已将 ${picked.length} 个素材加入画布`))}>
                    <Plus size={14} /> 加入画布
                  </button>
                  <button className="btn sm" aria-expanded={moving} onClick={() => setMoving((v) => !v)}>
                    <FolderInput size={14} /> 移动
                  </button>
                  <button className="btn sm" onClick={() => setConfirm('assets')}>
                    <Trash2 size={14} /> 删除
                  </button>
                  <button className="btn sm" aria-label="取消选择" onClick={() => setPicked([])}>
                    <X size={14} />
                  </button>
                  {moving && (
                    <div className="popover move-menu" role="menu" aria-label="移动到文件夹">
                      <div className="popover-head">移动到</div>
                      <div className="popover-list">
                        {state.folders.map((f) => (
                          <button key={f.id} role="menuitem" disabled={f.id === folderId} onClick={() => void move(f.id, f.name)}>
                            <Folder size={15} /> {f.name}
                          </button>
                        ))}
                        {folderId && (
                          <button role="menuitem" onClick={() => void move(null)}>
                            <X size={15} /> 移出文件夹
                          </button>
                        )}
                        {naming && naming.id === null ? (
                          <div style={{ padding: 8 }}>{nameInput}</div>
                        ) : (
                          <button role="menuitem" onClick={() => setNaming({ id: null, value: '' })}>
                            <FolderPlus size={15} /> 新建文件夹并移入
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {confirm === 'assets' && picked.length > 0 && (
                <div className="inline-confirm" style={{ marginBottom: 14 }}>
                  <span style={{ flex: 1 }}>删除 {picked.length} 个作品？已发布到灵感广场的会同时撤回。</span>
                  <button className="btn sm" onClick={() => setConfirm(null)}>
                    取消
                  </button>
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      await removeAssets(picked);
                      toast(`已删除 ${picked.length} 个作品`);
                      setPicked([]);
                      setConfirm(null);
                    }}
                  >
                    删除
                  </button>
                </div>
              )}
              {list.length === 0 ? (
                <div className="empty">
                  {folder ? <Folder size={28} /> : <ImageIcon size={28} />}
                  <b>{folder ? '文件夹是空的' : '这里还没有作品'}</b>
                  <span>{folder ? '在其他分类中选中作品，点“移动”放进这个文件夹' : '去创作工作台生成，作品会自动收录到资产库'}</span>
                  {!folder && (
                    <button className="btn primary" onClick={() => navigate('studio')}>
                      去创作
                    </button>
                  )}
                </div>
              ) : (
                <div className="asset-grid">
                  {list.map((a) => {
                    const on = picked.includes(a.id);
                    return (
                      <div key={a.id} className={`asset ${on ? 'selected' : ''}`}>
                        <Art prompt={a.prompt} ratio="1:1" variant={a.variant} kind={a.kind} text={a.text} durationSec={a.durationSec} url={a.url} badge={a.source !== 'uploaded'} long={360} onClick={() => (picked.length ? toggle(a.id) : openViewer(a))} label={a.title} />
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
              {mode === 'api' && state.assetsCursor && !folderId && !q.trim() && (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: 18 }}>
                  <button
                    className="btn"
                    disabled={loadingMore}
                    onClick={async () => {
                      setLoadingMore(true);
                      await fetchAssets({ more: true });
                      setLoadingMore(false);
                    }}
                  >
                    {loadingMore ? '加载中…' : '加载更多'}
                  </button>
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
