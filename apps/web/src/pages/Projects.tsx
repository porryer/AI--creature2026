import type { ProjectDTO } from '@creature/shared';
import { FolderOpen, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Art } from '../components/Art';
import { api, BACKEND } from '../lib/api';
import { PROJECTS, timeAgo } from '../lib/mock';
import { navigate } from '../lib/router';
import { errorText, useStore } from '../lib/store';

export function Projects() {
  return BACKEND === 'api' ? <ApiProjects /> : <DemoProjects />;
}

function Head({ onCreate, busy }: { onCreate: () => void; busy?: boolean }) {
  return (
    <div className="page-head">
      <div>
        <h2>项目</h2>
        <p>一个项目包含若干画布和它们产出的全部资产，可以邀请团队成员一起编辑和评论。</p>
      </div>
      <button className="btn primary" disabled={busy} onClick={onCreate}>
        <Plus size={15} /> 新建项目
      </button>
    </div>
  );
}

/** 接入后端：列出、新建、打开与删除项目（画布内容自动保存） */
function ApiProjects() {
  const { toast, setHandoff } = useStore();
  const [list, setList] = useState<ProjectDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(() => {
    api.projects().then(
      (r) => setList(r.data),
      (e) => {
        setList([]);
        toast(errorText(e), 'err');
      },
    );
  }, [toast]);
  useEffect(load, [load]);

  const open = (canvasId: string) => {
    setHandoff({ to: 'canvas', canvasId });
    navigate('canvas');
  };

  const create = async () => {
    setBusy(true);
    try {
      const c = await api.createProject('未命名项目');
      open(c.id);
    } catch (e) {
      toast(errorText(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteProject(id);
      setList((l) => l?.filter((p) => p.id !== id) ?? null);
      toast('项目已删除');
    } catch (e) {
      toast(errorText(e), 'err');
    }
    setConfirmId(null);
  };

  return (
    <div className="page">
      <Head onCreate={() => void create()} busy={busy} />
      {list === null ? (
        <p className="subtle">加载中…</p>
      ) : list.length === 0 ? (
        <div className="empty">
          <FolderOpen size={28} />
          <b>还没有项目</b>
          <span>新建一个项目，在画布上用节点串起文案、图像、视频与配音</span>
          <button className="btn primary" disabled={busy} onClick={() => void create()}>
            新建项目
          </button>
        </div>
      ) : (
        <div className="card-grid">
          {list.map((p) => {
            const canvas = p.canvases[0];
            const nodes = p.canvases.reduce((a, c) => a + c.node_count, 0);
            return (
              <article key={p.id} className="panel proj-card" style={{ position: 'relative' }}>
                <button className="proj-open" aria-label={`打开项目 ${p.name}`} disabled={!canvas} onClick={() => canvas && open(canvas.id)}>
                  <div className="proj-cover">
                    {[0, 1, 2].map((i) => (
                      <Art key={i} prompt={`${p.name} ${i}`} ratio={i === 0 ? '4:3' : '1:1'} variant={i} badge={false} long={i === 0 ? 480 : 240} style={{ aspectRatio: 'auto', height: '100%' }} />
                    ))}
                  </div>
                  <div className="proj-body">
                    <h4 style={{ fontSize: 15 }}>{p.name}</h4>
                    <span className="subtle" style={{ fontSize: 12.5 }}>
                      {p.canvases.length} 个画布 · {nodes} 个节点 · {timeAgo(Date.parse(p.updated_at))}更新
                    </span>
                  </div>
                </button>
                {confirmId === p.id ? (
                  <div className="inline-confirm" style={{ margin: '0 14px 14px' }}>
                    <span style={{ flex: 1 }}>删除项目？已生成的作品仍保留在资产库。</span>
                    <button className="btn sm" onClick={() => setConfirmId(null)}>
                      取消
                    </button>
                    <button className="btn sm danger" onClick={() => void remove(p.id)}>
                      删除
                    </button>
                  </div>
                ) : (
                  <button className="icon-btn proj-del" aria-label={`删除项目 ${p.name}`} onClick={() => setConfirmId(p.id)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DemoProjects() {
  const { toast } = useStore();
  return (
    <div className="page">
      <Head onCreate={() => (toast('已创建项目「未命名项目」'), navigate('canvas'))} />
      <div className="card-grid">
        {PROJECTS.map((p) => (
          <button key={p.id} className="panel proj-card" onClick={() => navigate('canvas')}>
            <div className="proj-cover">
              {p.covers.map((c, i) => (
                <Art key={i} prompt={c} ratio={i === 0 ? '4:3' : '1:1'} variant={i} badge={false} long={i === 0 ? 480 : 240} style={{ aspectRatio: 'auto', height: '100%' }} />
              ))}
            </div>
            <div className="proj-body">
              <h4 style={{ fontSize: 15 }}>{p.name}</h4>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span className="subtle" style={{ fontSize: 12.5 }}>
                  {p.items} 个资产 · {timeAgo(p.updated)}更新
                </span>
                <span className="avatars">
                  {p.members.map((m) => (
                    <span key={m} className="avatar sm">
                      {m}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
