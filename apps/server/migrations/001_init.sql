-- 造物 Creature 初始表结构（MVP 范围，完整设计见 docs/04-database.md）
-- ID 统一为带类型前缀、按时间有序的文本主键；积分与金额（分）使用 integer。

CREATE TABLE users (
  id              text PRIMARY KEY,
  nickname        text NOT NULL,
  phone_enc       text NOT NULL,                -- AES-256-GCM 密文（base64）
  phone_hash      text NOT NULL UNIQUE,         -- HMAC-SHA256，用于查找
  phone_last4     text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'banned')),
  plan_code       text NOT NULL DEFAULT 'free',
  plan_expires_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sms_codes (
  id          text PRIMARY KEY,
  phone_hash  text NOT NULL,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sms_phone_time ON sms_codes (phone_hash, created_at DESC);

CREATE TABLE auth_sessions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users (id),
  family_id   text NOT NULL,                    -- 同一次登录派生的令牌族，用于重用检测
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_user_active ON auth_sessions (user_id, created_at) WHERE revoked_at IS NULL;

-- 积分：账户 + 批次 + 冻结明细 + 只追加流水
CREATE TABLE credit_accounts (
  id         text PRIMARY KEY,
  owner_type text NOT NULL CHECK (owner_type IN ('user', 'team')),
  owner_id   text NOT NULL,
  available  integer NOT NULL DEFAULT 0 CHECK (available >= 0),
  frozen     integer NOT NULL DEFAULT 0 CHECK (frozen >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_type, owner_id)
);

CREATE TABLE credit_grants (
  id         text PRIMARY KEY,
  account_id text NOT NULL REFERENCES credit_accounts (id),
  source     text NOT NULL CHECK (source IN ('daily', 'signup', 'subscription', 'pack', 'admin')),
  amount     integer NOT NULL CHECK (amount > 0),
  remaining  integer NOT NULL CHECK (remaining >= 0 AND remaining <= amount),
  expires_at timestamptz NOT NULL,
  ref_id     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_grants_consume ON credit_grants (account_id, expires_at) WHERE remaining > 0;

CREATE TABLE credit_holds (
  task_id  text NOT NULL,
  grant_id text NOT NULL REFERENCES credit_grants (id),
  amount   integer NOT NULL CHECK (amount > 0),
  PRIMARY KEY (task_id, grant_id)
);

CREATE TABLE credit_ledger (
  id              text PRIMARY KEY,
  account_id      text NOT NULL REFERENCES credit_accounts (id),
  entry_type      text NOT NULL CHECK (entry_type IN ('grant', 'freeze', 'settle', 'unfreeze', 'refund', 'expire', 'adjust')),
  delta_available integer NOT NULL,
  delta_frozen    integer NOT NULL,
  balance_after   integer NOT NULL,
  task_id         text,
  grant_id        text,
  idempotency_key text,
  memo            text NOT NULL DEFAULT '',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key)
);
CREATE INDEX idx_ledger_account ON credit_ledger (account_id, id DESC);

CREATE TABLE generation_tasks (
  id                text PRIMARY KEY,
  user_id           text NOT NULL REFERENCES users (id),
  account_id        text NOT NULL REFERENCES credit_accounts (id),
  modality          text NOT NULL CHECK (modality IN ('image', 'video', 'text', 'audio')),
  operation         text NOT NULL CHECK (operation IN ('generate', 'edit')),
  model_code        text NOT NULL,
  used_model_code   text,
  routing_strategy  text NOT NULL,
  routing_reason    text NOT NULL DEFAULT '',
  prompt            text NOT NULL,
  params            jsonb NOT NULL,
  status            text NOT NULL CHECK (status IN ('queued', 'running', 'post_processing', 'succeeded', 'failed', 'blocked', 'canceled')),
  queue             text NOT NULL CHECK (queue IN ('p0', 'p1', 'p2')),
  progress          integer NOT NULL DEFAULT 0,
  estimated_credits integer NOT NULL,
  actual_credits    integer,
  vendor_cost_fen   integer,
  attempt           integer NOT NULL DEFAULT 0,
  error_code        text,
  error_message     text,
  idempotency_key   text NOT NULL,
  request_hash      text NOT NULL,
  source            text NOT NULL DEFAULT 'studio',
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX idx_tasks_user ON generation_tasks (user_id, id DESC);
CREATE INDEX idx_tasks_queued ON generation_tasks (queue, created_at) WHERE status = 'queued';
CREATE INDEX idx_tasks_inflight ON generation_tasks (started_at) WHERE status IN ('running', 'post_processing');

CREATE TABLE assets (
  id              text PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users (id),
  task_id         text,
  kind            text NOT NULL CHECK (kind IN ('image', 'video', 'text', 'audio')),
  title           text NOT NULL,
  prompt          text NOT NULL,
  model_name      text NOT NULL,
  storage_key     text NOT NULL,                -- 带 AI 标识的交付文件
  raw_storage_key text,                         -- 内部原始文件，不对外
  mime_type       text NOT NULL,
  width           integer,
  height          integer,
  duration_ms     integer,
  size_bytes      integer NOT NULL,
  text_content    text,
  content_id      text NOT NULL UNIQUE,         -- 隐式标识中的内容编号
  favorite        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX idx_assets_user ON assets (user_id, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE moderation_records (
  id          text PRIMARY KEY,
  user_id     text,
  target_type text NOT NULL CHECK (target_type IN ('prompt', 'upload', 'output')),
  target_id   text,
  verdict     text NOT NULL CHECK (verdict IN ('pass', 'review', 'block')),
  labels      jsonb NOT NULL DEFAULT '[]',
  provider    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id          text PRIMARY KEY,
  order_no    text NOT NULL UNIQUE,
  user_id     text NOT NULL REFERENCES users (id),
  item_type   text NOT NULL CHECK (item_type IN ('subscription', 'credit_pack')),
  item_ref    text NOT NULL,
  cycle       text CHECK (cycle IN ('month', 'year')),
  amount_fen  integer NOT NULL,
  credits     integer NOT NULL,
  status      text NOT NULL CHECK (status IN ('pending', 'paid', 'closed')),
  pay_channel text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  paid_at     timestamptz
);
CREATE INDEX idx_orders_user ON orders (user_id, id DESC);

CREATE TABLE subscriptions (
  id                   text PRIMARY KEY,
  user_id              text NOT NULL REFERENCES users (id),
  plan_code            text NOT NULL,
  cycle                text NOT NULL CHECK (cycle IN ('month', 'year')),
  status               text NOT NULL CHECK (status IN ('active', 'expired')),
  current_period_start timestamptz NOT NULL,
  current_period_end   timestamptz NOT NULL,
  next_grant_at        timestamptz,             -- 年付套餐按月发放积分
  order_id             text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_subs_due ON subscriptions (next_grant_at) WHERE status = 'active';
