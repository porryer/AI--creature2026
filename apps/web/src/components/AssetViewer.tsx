import { stripAiTextLabel } from '@creature/shared';
import { Download, Film, Heart, Repeat2, Send, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { api, BACKEND } from '../lib/api';
import { navigate } from '../lib/router';
import { errorText, useStore } from '../lib/store';
import type { Asset } from '../lib/types';
import { Art } from './Art';
import { Modal, Switch } from './ui';

/** 作品详情：大图 / 播放、生成参数、AI 标识信息与后续操作 */
export function AssetViewer() {
  const { state } = useStore();
  return state.viewer ? <ViewerBody key={state.viewer.id} a={state.viewer} /> : null;
}

function ViewerBody({ a }: { a: Asset }) {
  const { openViewer, openEditor, patchAsset, setHandoff, downloadAsset } = useStore();
  const [publishing, setPublishing] = useState(false);
  const close = () => openViewer(null);
  const contentId = a.contentId ?? `CRT-${new Date(a.createdAt).toISOString().slice(0, 10).replace(/-/g, '')}-${a.id.slice(-5).toUpperCase()}`;
  const uploaded = a.source === 'uploaded';

  return (
    <Modal title={a.title} onClose={close} wide>
      <div className="viewer">
        <div className="viewer-media">
          {a.kind === 'text' ? (
            <div className="prompt-box" style={{ whiteSpace: 'pre-wrap', width: '100%', maxHeight: '60vh', overflowY: 'auto', fontSize: 14 }}>
              {stripAiTextLabel(a.text ?? a.prompt)}
              {'\n\n'}
              <span className="subtle">（本内容由 AI 生成）</span>
            </div>
          ) : (
            a.kind === 'audio' && a.url ? (
            <audio src={a.url} controls style={{ width: '100%' }} />
          ) : (
            <Art prompt={a.prompt} ratio={a.kind === 'audio' ? '16:9' : a.ratio} variant={a.variant} kind={a.kind} durationSec={a.durationSec} url={a.url} controls badge={!uploaded} long={1000} />
          )
          )}
        </div>
        <div className="viewer-info">
          {a.prompt && (
            <div className="field">
              <span className="field-label">提示词</span>
              <div className="prompt-box">{a.prompt}</div>
            </div>
          )}
          <dl className="kv">
            <dt>模型</dt>
            <dd>{a.model}</dd>
            <dt>类型</dt>
            <dd>{{ image: '图像', video: '视频', audio: '音频', text: '文本' }[a.kind]}</dd>
            {a.kind !== 'text' && a.kind !== 'audio' && (
              <>
                <dt>比例</dt>
                <dd>{a.ratio}</dd>
              </>
            )}
            {a.durationSec && (
              <>
                <dt>时长</dt>
                <dd>{a.durationSec} 秒</dd>
              </>
            )}
            <dt>时间</dt>
            <dd>{new Date(a.createdAt).toLocaleString('zh-CN')}</dd>
            <dt>AI 标识</dt>
            <dd>
              {uploaded ? '用户上传，不添加' : '显式角标 + 隐式元数据'}
              <br />
              <span className="mono subtle" style={{ fontSize: 12 }}>
                内容编号 {contentId}
              </span>
            </dd>
          </dl>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
            <button className="btn primary" onClick={() => void downloadAsset(a)}>
              <Download size={15} /> 下载
            </button>
            <button className="btn" onClick={() => patchAsset(a.id, { favorite: !a.favorite })} aria-pressed={!!a.favorite}>
              <Heart size={15} fill={a.favorite ? 'currentColor' : 'none'} /> {a.favorite ? '已收藏' : '收藏'}
            </button>
            {(a.kind === 'image' || a.kind === 'video') && !uploaded && (
              <button
                className="btn"
                onClick={() => {
                  setHandoff({ to: 'studio', mode: a.kind, prompt: a.prompt });
                  close();
                  navigate('studio', a.kind);
                }}
              >
                <Repeat2 size={15} /> 再次生成
              </button>
            )}
            {a.kind === 'image' && (
              <button className="btn" onClick={() => openEditor(a)}>
                <Wand2 size={15} /> 编辑
              </button>
            )}
            {a.kind === 'image' && (
              <button
                className="btn"
                onClick={() => {
                  setHandoff({ to: 'studio', mode: 'video', prompt: `${a.prompt}，镜头缓慢推进`, firstFrame: a });
                  close();
                  navigate('studio', 'video');
                }}
              >
                <Film size={15} /> 转为视频
              </button>
            )}
            {!uploaded && (a.kind === 'image' || a.kind === 'video') && (
              <button className="btn ghost" aria-expanded={publishing} onClick={() => setPublishing((v) => !v)}>
                <Send size={15} /> 发布到广场
              </button>
            )}
          </div>
          {publishing && <PublishForm a={a} onDone={() => setPublishing(false)} />}
        </div>
      </div>
    </Modal>
  );
}

/** 发布到灵感广场：标题、标签、是否公开提示词；发布时机审，存疑的进入人工复核 */
function PublishForm({ a, onDone }: { a: Asset; onDone: () => void }) {
  const { toast } = useStore();
  const [title, setTitle] = useState(a.title.slice(0, 40));
  const [tags, setTags] = useState('');
  const [showPrompt, setShowPrompt] = useState(true);
  const [busy, setBusy] = useState(false);
  const tagList = [...new Set(tags.split(/[\s,，#]+/).map((t) => t.trim()).filter(Boolean))].slice(0, 5);

  const submit = async () => {
    if (BACKEND === 'mock') {
      toast('已发布到灵感广场（离线演示）');
      return onDone();
    }
    setBusy(true);
    try {
      const post = await api.publish({ asset_id: a.id, title: title.trim(), tags: tagList, show_prompt: showPrompt });
      toast(post.status === 'reviewing' ? '已提交，人工审核通过后会出现在灵感广场' : post.status === 'published' ? '已发布到灵感广场' : '该作品目前不可见，请联系客服', post.status === 'published' ? 'ok' : 'info');
      onDone();
    } catch (e) {
      toast(errorText(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="panel publish-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="field">
        <label htmlFor="pub-title">标题</label>
        <input id="pub-title" className="input" maxLength={40} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pub-tags">
          标签 <span className="subtle">最多 5 个，空格分隔</span>
        </label>
        <input id="pub-tags" className="input" placeholder="如：咖啡 海报 秋季" value={tags} onChange={(e) => setTags(e.target.value)} />
      </div>
      <div className="inline-row">
        <label htmlFor="pub-prompt" style={{ fontSize: 13 }}>
          公开提示词 <span className="subtle">关闭后他人做同款只能沿用参数</span>
        </label>
        <Switch id="pub-prompt" checked={showPrompt} onChange={setShowPrompt} label="公开提示词" />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn" onClick={onDone}>
          取消
        </button>
        <button type="submit" className="btn primary" style={{ flex: 1 }} disabled={busy || !title.trim()}>
          {busy ? '发布中…' : '发布'}
        </button>
      </div>
    </form>
  );
}
