-- 画布历史版本与分享链接

-- 历史版本：自动（保存时距上一个版本超过 10 分钟，记录被覆盖前的内容）、手动、恢复前自动备份
CREATE TABLE canvas_snapshots (
  id         text PRIMARY KEY,
  canvas_id  text NOT NULL REFERENCES canvases (id),
  user_id    text NOT NULL REFERENCES users (id),
  version    integer NOT NULL,
  doc        jsonb NOT NULL,
  node_count integer NOT NULL,
  reason     text NOT NULL CHECK (reason IN ('auto', 'manual', 'restore')),
  label      text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_snapshots_canvas ON canvas_snapshots (canvas_id, created_at DESC);

-- 分享链接：只读查看，令牌即访问凭证；每个画布最多一个有效链接
CREATE TABLE canvas_shares (
  id           text PRIMARY KEY,
  canvas_id    text NOT NULL REFERENCES canvases (id),
  user_id      text NOT NULL REFERENCES users (id),
  token        text NOT NULL UNIQUE,
  show_prompts boolean NOT NULL DEFAULT false,
  view_count   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
CREATE UNIQUE INDEX uq_shares_active ON canvas_shares (canvas_id) WHERE revoked_at IS NULL;
