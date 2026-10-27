-- 素材上传与参考图

-- 作品来源：生成 / 用户上传（上传的非 AI 素材不添加 AI 标识）
ALTER TABLE assets ADD COLUMN source text NOT NULL DEFAULT 'generated' CHECK (source IN ('generated', 'uploaded'));

-- 生成任务引用的参考图：[{ "asset_id": "...", "role": "style | subject | character | first_frame | last_frame" }]
ALTER TABLE generation_tasks ADD COLUMN input_refs jsonb NOT NULL DEFAULT '[]';

-- 上传会话：创建 → 签名地址上传 → 完成（审核通过后生成资产）
CREATE TABLE uploads (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id),
  filename    text NOT NULL,
  mime_type   text NOT NULL,
  max_bytes   integer NOT NULL,
  size_bytes  integer,
  status      text NOT NULL CHECK (status IN ('pending', 'uploaded', 'completed', 'rejected')),
  storage_key text NOT NULL,
  asset_id    text,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_uploads_user_time ON uploads (user_id, created_at DESC);
