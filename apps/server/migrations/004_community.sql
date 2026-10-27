-- Sprint 3：作品库文件夹、灵感广场、举报、后台角色与人工审核

CREATE TABLE asset_folders (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE UNIQUE INDEX uq_folders_name ON asset_folders (user_id, name) WHERE deleted_at IS NULL;

ALTER TABLE assets ADD COLUMN folder_id text REFERENCES asset_folders (id);
CREATE INDEX idx_assets_folder ON assets (folder_id) WHERE deleted_at IS NULL;

-- 灵感广场：发布时快照提示词、模型与参数，用于展示和"做同款"
CREATE TABLE posts (
  id            text PRIMARY KEY,
  author_id     text NOT NULL REFERENCES users (id),
  asset_id      text NOT NULL REFERENCES assets (id),
  kind          text NOT NULL CHECK (kind IN ('image', 'video')),
  title         text NOT NULL,
  prompt        text NOT NULL,
  show_prompt   boolean NOT NULL DEFAULT true,
  tags          jsonb NOT NULL DEFAULT '[]',
  model_code    text,
  model_name    text NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}',
  like_count    integer NOT NULL DEFAULT 0,
  remix_count   integer NOT NULL DEFAULT 0,
  report_count  integer NOT NULL DEFAULT 0,
  status        text NOT NULL CHECK (status IN ('reviewing', 'published', 'hidden', 'removed')),
  hidden_reason text CHECK (hidden_reason IN ('reports', 'admin')),
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- 同一作品同时只能有一条未撤回的发布
CREATE UNIQUE INDEX uq_posts_asset ON posts (asset_id) WHERE status <> 'removed';
CREATE INDEX idx_posts_published ON posts (published_at DESC) WHERE status = 'published';
CREATE INDEX idx_posts_author ON posts (author_id, created_at DESC);

CREATE TABLE post_likes (
  post_id     text NOT NULL REFERENCES posts (id),
  user_id     text NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

-- 做同款按人计数，同一用户重复点击不重复累计
CREATE TABLE post_remixes (
  post_id     text NOT NULL REFERENCES posts (id),
  user_id     text NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

CREATE TABLE reports (
  id           text PRIMARY KEY,
  reporter_id  text NOT NULL REFERENCES users (id),
  target_type  text NOT NULL CHECK (target_type IN ('post')),
  target_id    text NOT NULL,
  reason       text NOT NULL CHECK (reason IN ('porn', 'violence', 'politics', 'infringement', 'ad', 'other')),
  detail       text,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'rejected')),
  handled_by   text,
  handled_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_reports_once ON reports (reporter_id, target_type, target_id);
CREATE INDEX idx_reports_target ON reports (target_type, target_id) WHERE status = 'open';

-- 后台角色：由 ADMIN_PHONES 配置的手机号登录时授予
ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin'));

-- 审核记录：增加广场作品，区分机审与人工复核
ALTER TABLE moderation_records DROP CONSTRAINT IF EXISTS moderation_records_target_type_check;
ALTER TABLE moderation_records ADD CONSTRAINT moderation_records_target_type_check CHECK (target_type IN ('prompt', 'upload', 'output', 'post'));
ALTER TABLE moderation_records ADD COLUMN stage text NOT NULL DEFAULT 'machine' CHECK (stage IN ('machine', 'human'));
ALTER TABLE moderation_records ADD COLUMN reviewer_id text;

-- 后台操作审计（只追加）
CREATE TABLE audit_logs (
  id           text PRIMARY KEY,
  actor_id     text NOT NULL,
  action       text NOT NULL,
  target_type  text NOT NULL,
  target_id    text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_target ON audit_logs (target_type, target_id, created_at DESC);
