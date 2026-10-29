-- Sprint 8：角色库与品牌套件（专业版、团队版功能）

CREATE TABLE characters (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users (id),
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  -- 肖像声明：none 虚构角色 / 品牌 IP；self 本人肖像；authorized 他人肖像（须附授权材料）
  likeness         text NOT NULL CHECK (likeness IN ('none', 'self', 'authorized')),
  consent_asset_id text REFERENCES assets (id),
  used_count       integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CHECK (likeness <> 'authorized' OR consent_asset_id IS NOT NULL)
);
CREATE INDEX idx_characters_user ON characters (user_id, created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE character_refs (
  character_id text NOT NULL REFERENCES characters (id),
  position     integer NOT NULL,
  asset_id     text NOT NULL REFERENCES assets (id),
  view         text CHECK (view IN ('front', 'side', 'back', 'full_body', 'expression')),
  PRIMARY KEY (character_id, position)
);

CREATE TABLE brand_kits (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id),
  name       text NOT NULL,
  tone       text NOT NULL DEFAULT '',
  colors     jsonb NOT NULL DEFAULT '[]',  -- [{name, hex}]
  fonts      jsonb NOT NULL DEFAULT '[]',  -- ["思源宋体 · 标题"]
  banned     jsonb NOT NULL DEFAULT '[]',  -- 禁用元素
  logos      jsonb NOT NULL DEFAULT '[]',  -- [{asset_id, variant: primary|light|dark|mono}]
  used_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX idx_brand_kits_user ON brand_kits (user_id, created_at DESC) WHERE deleted_at IS NULL;

-- 生成任务引用的角色与品牌套件快照（创建时写入，之后修改角色或套件不影响该任务）
ALTER TABLE generation_tasks ADD COLUMN context jsonb;

-- 审核记录：增加角色与品牌套件的文字内容
ALTER TABLE moderation_records DROP CONSTRAINT IF EXISTS moderation_records_target_type_check;
ALTER TABLE moderation_records ADD CONSTRAINT moderation_records_target_type_check CHECK (target_type IN ('prompt', 'upload', 'output', 'post', 'character', 'brand_kit'));
