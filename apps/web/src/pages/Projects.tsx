import { Plus } from 'lucide-react';
import { Art } from '../components/Art';
import { PROJECTS, timeAgo } from '../lib/mock';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';

export function Projects() {
  const { toast } = useStore();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>项目</h2>
          <p>一个项目包含若干画布和它们产出的全部资产，可以邀请团队成员一起编辑和评论。</p>
        </div>
        <button className="btn primary" onClick={() => (toast('已创建项目「未命名项目」'), navigate('canvas'))}>
          <Plus size={15} /> 新建项目
        </button>
      </div>
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
