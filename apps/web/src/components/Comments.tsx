import { COMMENT_MAX_LENGTH, REPORT_REASONS, type CommentDTO, type CommentThreadDTO, type ReportReason } from '@creature/shared';
import { Flag, MessageCircle, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { timeAgo } from '../lib/mock';
import { errorText, useStore } from '../lib/store';

/** 作品详情中的评论区：发表、回复（一层）、展开回复、删除、举报 */
export function Comments({ postId, count, onCount, onAuthor }: { postId: string; count: number; onCount: (n: number) => void; onAuthor: (id: string) => void }) {
  const { toast } = useStore();
  const [threads, setThreads] = useState<CommentThreadDTO[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<CommentDTO | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.comments(postId).then(
      (p) => (setThreads(p.data), setCursor(p.next_cursor)),
      (e) => (toast(errorText(e), 'err'), setThreads([])),
    );
  }, [postId, toast]);

  const more = async () => {
    try {
      const p = await api.comments(postId, cursor);
      setThreads((cur) => [...(cur ?? []), ...p.data]);
      setCursor(p.next_cursor);
    } catch (e) {
      toast(errorText(e), 'err');
    }
  };

  const send = async () => {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    try {
      const c = await api.addComment(postId, text, replyTo?.id);
      const parent = replyTo && (threads?.find((t) => t.id === replyTo.id) ?? threads?.find((t) => t.replies.some((r) => r.id === replyTo.id)));
      setThreads((cur) =>
        parent
          ? (cur ?? []).map((t) => (t.id === parent.id ? { ...t, reply_count: t.reply_count + 1, replies: [...t.replies, c] } : t))
          : [{ ...c, reply_count: 0, replies: [] }, ...(cur ?? [])],
      );
      onCount(count + 1);
      setBody('');
      setReplyTo(null);
    } catch (e) {
      toast(errorText(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (c: CommentDTO) => {
    try {
      await api.deleteComment(c.id);
      const top = threads?.find((t) => t.id === c.id);
      setThreads((cur) => (cur ?? []).filter((t) => t.id !== c.id).map((t) => ({ ...t, replies: t.replies.filter((r) => r.id !== c.id), reply_count: t.replies.some((r) => r.id === c.id) ? t.reply_count - 1 : t.reply_count })));
      onCount(Math.max(0, count - (top ? 1 + top.reply_count : 1)));
      toast('已删除');
    } catch (e) {
      toast(errorText(e), 'err');
    }
  };

  const expand = async (t: CommentThreadDTO) => {
    try {
      const p = await api.replies(t.id);
      setThreads((cur) => (cur ?? []).map((x) => (x.id === t.id ? { ...x, replies: p.data } : x)));
    } catch (e) {
      toast(errorText(e), 'err');
    }
  };

  const item = (c: CommentDTO, reply: boolean) => <CommentItem key={c.id} c={c} reply={reply} onReply={() => setReplyTo(c)} onDelete={() => void remove(c)} onAuthor={onAuthor} />;

  return (
    <section className="comments" aria-labelledby={`comments-${postId}`}>
      <h4 id={`comments-${postId}`}>
        <MessageCircle size={15} /> 评论 {count > 0 && <span className="subtle">{count}</span>}
      </h4>
      <form
        className="comment-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {replyTo && (
          <div className="replying subtle">
            回复 @{replyTo.author.nickname}
            <button type="button" className="btn ghost sm" onClick={() => setReplyTo(null)}>
              取消
            </button>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <label htmlFor={`comment-input-${postId}`} className="visually-hidden">
            评论内容
          </label>
          <input
            id={`comment-input-${postId}`}
            className="input"
            style={{ flex: 1 }}
            maxLength={COMMENT_MAX_LENGTH}
            placeholder={replyTo ? `回复 @${replyTo.author.nickname}` : '说点什么…'}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <button className="btn primary" disabled={busy || !body.trim()}>
            发送
          </button>
        </div>
      </form>
      {threads === null ? (
        <p className="subtle">加载中…</p>
      ) : threads.length === 0 ? (
        <p className="subtle" style={{ fontSize: 13 }}>
          还没有评论，来说第一句吧
        </p>
      ) : (
        <ul className="comment-list">
          {threads.map((t) => (
            <li key={t.id}>
              {item(t, false)}
              {t.replies.length > 0 && <ul className="comment-replies">{t.replies.map((r) => <li key={r.id}>{item(r, true)}</li>)}</ul>}
              {t.reply_count > t.replies.length && (
                <button className="btn ghost sm comment-more" onClick={() => void expand(t)}>
                  展开其余 {t.reply_count - t.replies.length} 条回复
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <button className="btn ghost sm" onClick={() => void more()}>
          更多评论
        </button>
      )}
    </section>
  );
}

function CommentItem({ c, reply, onReply, onDelete, onAuthor }: { c: CommentDTO; reply: boolean; onReply: () => void; onDelete: () => void; onAuthor: (id: string) => void }) {
  const { toast } = useStore();
  const [reporting, setReporting] = useState(false);
  const report = async (reason: ReportReason) => {
    setReporting(false);
    try {
      await api.reportComment(c.id, reason);
      toast('已收到举报，我们会尽快处理', 'info');
    } catch (e) {
      toast(errorText(e), 'err');
    }
  };
  return (
    <div className={`comment ${reply ? 'reply' : ''}`}>
      <span className="avatar sm">{c.author.nickname.slice(0, 1)}</span>
      <div className="comment-main">
        <div className="comment-head">
          <button className="link" onClick={() => onAuthor(c.author.id)}>
            {c.author.nickname}
          </button>
          {c.reply_to && <span className="subtle"> 回复 @{c.reply_to.nickname}</span>}
          <span className="subtle"> · {timeAgo(Date.parse(c.created_at))}</span>
        </div>
        <p>{c.body}</p>
        <div className="comment-actions">
          <button className="btn ghost sm" onClick={onReply}>
            回复
          </button>
          {c.can_delete && (
            <button className="btn ghost sm" aria-label="删除评论" onClick={onDelete}>
              <Trash2 size={13} />
            </button>
          )}
          {!c.mine &&
            (reporting ? (
              <select className="input sm" aria-label="举报原因" defaultValue="" onChange={(e) => e.target.value && void report(e.target.value as ReportReason)} onBlur={() => setReporting(false)} autoFocus>
                <option value="" disabled>
                  选择举报原因
                </option>
                {(Object.keys(REPORT_REASONS) as ReportReason[]).map((r) => (
                  <option key={r} value={r}>
                    {REPORT_REASONS[r]}
                  </option>
                ))}
              </select>
            ) : (
              <button className="btn ghost sm" aria-label="举报评论" onClick={() => setReporting(true)}>
                <Flag size={13} />
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
