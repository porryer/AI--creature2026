import { Download, Film, Heart, Repeat2, Send } from 'lucide-react';
import { navigate } from '../lib/router';
import { useStore } from '../lib/store';
import { Art } from './Art';
import { Modal } from './ui';

/** 作品详情：大图 / 播放、生成参数、AI 标识信息与后续操作 */
export function AssetViewer() {
  const { state, openViewer, patchAsset, toast, setHandoff } = useStore();
  const a = state.viewer;
  if (!a) return null;
  const close = () => openViewer(null);
  const contentId = `CRT-${new Date(a.createdAt).toISOString().slice(0, 10).replace(/-/g, '')}-${a.id.slice(-5).toUpperCase()}`;

  return (
    <Modal title={a.title} onClose={close} wide>
      <div className="viewer">
        <div className="viewer-media">
          {a.kind === 'text' ? (
            <div className="prompt-box" style={{ whiteSpace: 'pre-wrap', width: '100%', maxHeight: '60vh', overflowY: 'auto', fontSize: 14 }}>
              {a.text ?? a.prompt}
              {'\n\n'}
              <span className="subtle">（本内容由 AI 生成）</span>
            </div>
          ) : (
            <Art prompt={a.prompt} ratio={a.kind === 'audio' ? '16:9' : a.ratio} variant={a.variant} kind={a.kind} durationSec={a.durationSec} controls long={1000} />
          )}
        </div>
        <div className="viewer-info">
          <div className="field">
            <span className="field-label">提示词</span>
            <div className="prompt-box">{a.prompt}</div>
          </div>
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
              显式角标 + 隐式元数据
              <br />
              <span className="mono subtle" style={{ fontSize: 12 }}>
                内容编号 {contentId}
              </span>
            </dd>
          </dl>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 'auto' }}>
            <button className="btn primary" onClick={() => toast('已开始下载 · 文件含显式与隐式 AI 标识（原型演示）', 'info')}>
              <Download size={15} /> 下载
            </button>
            <button className="btn" onClick={() => patchAsset(a.id, { favorite: !a.favorite })} aria-pressed={!!a.favorite}>
              <Heart size={15} fill={a.favorite ? 'currentColor' : 'none'} /> {a.favorite ? '已收藏' : '收藏'}
            </button>
            {(a.kind === 'image' || a.kind === 'video') && (
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
            <button className="btn ghost" onClick={() => toast('已发布到灵感广场，审核通过后可见', 'info')}>
              <Send size={15} /> 发布
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
