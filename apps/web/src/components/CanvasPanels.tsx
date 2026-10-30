import type { CanvasDTO, CanvasShareDTO, CanvasSnapshotDTO } from '@creature/shared';
import { Copy, History, Link2Off, RotateCcw, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { timeAgo } from '../lib/mock';
import { errorText, useStore } from '../lib/store';
import { Drawer } from './ui';

const REASON: Record<CanvasSnapshotDTO['reason'], string> = { auto: '自动保存', manual: '手动保存', restore: '恢复前备份' };

/** 画布历史版本：手动保存一个版本、查看列表、恢复（恢复前当前内容会自动备份） */
export function HistoryDrawer({ canvasId, version, onRestored, onClose }: { canvasId: string; version: () => number; onRestored: (c: CanvasDTO) => void; onClose: () => void }) {
  const { toast } = useStore();
  const [list, setList] = useState<CanvasSnapshotDTO[] | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api.canvasSnapshots(canvasId).then(
      (r) => setList(r.data),
      (e) => (toast(errorText(e), 'err'), setList([])),
    );
  useEffect(() => {
    void load();
  }, [canvasId]);

  const save = async () => {
    setBusy('save');
    try {
      await api.createSnapshot(canvasId, label.trim());
      setLabel('');
      toast('已保存当前版本');
      await load();
    } catch (e) {
      toast(errorText(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  const restore = async (s: CanvasSnapshotDTO) => {
    if (!window.confirm(`恢复到 ${new Date(s.created_at).toLocaleString('zh-CN', { hour12: false })} 的版本？当前内容会先自动备份，可以再恢复回来。`)) return;
    setBusy(s.id);
    try {
      onRestored(await api.restoreSnapshot(canvasId, s.id, version()));
      toast('已恢复，原内容已备份到历史版本');
    } catch (e) {
      toast(e instanceof ApiError && e.code === 'CANVAS_VERSION_CONFLICT' ? '画布刚刚在其他窗口修改过，请刷新后再恢复' : errorText(e), 'err');
      setBusy(null);
    }
  };

  return (
    <Drawer title="历史版本" onClose={onClose}>
      <p className="subtle" style={{ fontSize: 12.5 }}>
        编辑时每 10 分钟自动记录一个版本（最多 50 个）；重要节点可以手动保存并命名（最多 30 个）。
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <label htmlFor="snap-label" className="visually-hidden">
          版本名称
        </label>
        <input id="snap-label" className="input" style={{ flex: 1 }} maxLength={40} placeholder="版本名称（选填），如：给客户的初稿" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="btn primary" disabled={busy !== null} onClick={() => void save()}>
          <Save size={14} /> 保存当前版本
        </button>
      </div>
      {list === null ? (
        <p className="subtle">加载中…</p>
      ) : list.length === 0 ? (
        <div className="empty">
          <History size={24} />
          <b>还没有历史版本</b>
          <span>继续编辑，超过 10 分钟会自动记录；也可以手动保存</span>
        </div>
      ) : (
        <ol className="snapshot-list">
          {list.map((s) => (
            <li key={s.id}>
              <div className="grow">
                <b>{s.label || REASON[s.reason]}</b>
                <span className="subtle">
                  {timeAgo(Date.parse(s.created_at))} · {s.node_count} 个节点{s.label ? ` · ${REASON[s.reason]}` : ''}
                </span>
              </div>
              <button className="btn sm" disabled={busy !== null} onClick={() => void restore(s)}>
                <RotateCcw size={13} /> {busy === s.id ? '恢复中…' : '恢复'}
              </button>
            </li>
          ))}
        </ol>
      )}
    </Drawer>
  );
}

/** 分享只读链接：任何拿到链接的人无需登录即可查看画布与生成结果（带 AI 标识）；可随时关闭 */
export function ShareDrawer({ canvasId, onClose }: { canvasId: string; onClose: () => void }) {
  const { toast } = useStore();
  const [share, setShare] = useState<CanvasShareDTO | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const url = share ? new URL(share.path, window.location.origin + window.location.pathname).toString() : '';

  useEffect(() => {
    api.canvasShare(canvasId).then(
      (r) => setShare(r.share),
      (e) => (toast(errorText(e), 'err'), setShare(null)),
    );
  }, [canvasId, toast]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(errorText(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  const create = (showPrompts: boolean) => run(async () => setShare(await api.shareCanvas(canvasId, showPrompts)));
  const revoke = () =>
    run(async () => {
      await api.unshareCanvas(canvasId);
      setShare(null);
      toast('已关闭分享，原链接立即失效');
    });
  const copy = () =>
    navigator.clipboard?.writeText(url).then(
      () => toast('链接已复制'),
      () => toast('复制失败，请手动选中链接复制', 'err'),
    );

  return (
    <Drawer title="分享画布" onClose={onClose}>
      <p className="subtle" style={{ fontSize: 12.5 }}>
        拿到链接的人无需登录即可查看画布上的节点与生成结果（图片、视频带 AI 生成标识），不能编辑，也看不到小造对话与模型参数。
      </p>
      {share === undefined ? (
        <p className="subtle">加载中…</p>
      ) : share === null ? (
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void create(false)}>
          创建分享链接
        </button>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8 }}>
            <label htmlFor="share-url" className="visually-hidden">
              分享链接
            </label>
            <input id="share-url" className="input mono" style={{ flex: 1, fontSize: 12 }} readOnly value={url} onFocus={(e) => e.target.select()} />
            <button className="btn primary" onClick={() => void copy()}>
              <Copy size={14} /> 复制
            </button>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={share.show_prompts} disabled={busy} onChange={(e) => void create(e.target.checked)} />
            同时展示每个节点的提示词
          </label>
          <span className="subtle" style={{ fontSize: 12 }}>
            已被查看 {share.view_count} 次 · 创建于 {timeAgo(Date.parse(share.created_at))}
          </span>
          <button className="btn danger" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void revoke()}>
            <Link2Off size={14} /> 关闭分享
          </button>
        </>
      )}
    </Drawer>
  );
}
