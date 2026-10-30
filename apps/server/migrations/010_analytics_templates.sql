-- Sprint 9：数据埋点（docs/02-prd.md 第 6 节）与官方模板的使用统计

-- 埋点事件：服务端记录的事件（提交、成功 / 失败、导出、支付、模板使用）为准，客户端只上报界面行为
CREATE TABLE analytics_events (
  id         text PRIMARY KEY,
  user_id    text,
  name       text NOT NULL,
  source     text NOT NULL CHECK (source IN ('server', 'client')),
  props      jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_events_name_time ON analytics_events (name, created_at);
CREATE INDEX idx_events_user_time ON analytics_events (user_id, created_at);

-- 模板目录随代码发布，这里只存统计
CREATE TABLE template_stats (
  template_id  text PRIMARY KEY,
  use_count    integer NOT NULL DEFAULT 0,
  rating_sum   integer NOT NULL DEFAULT 0,
  rating_count integer NOT NULL DEFAULT 0
);

-- 用过模板的用户才能评分
CREATE TABLE template_uses (
  user_id       text NOT NULL REFERENCES users (id),
  template_id   text NOT NULL,
  use_count     integer NOT NULL DEFAULT 1,
  first_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, template_id)
);

CREATE TABLE template_ratings (
  user_id     text NOT NULL REFERENCES users (id),
  template_id text NOT NULL,
  score       smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, template_id)
);

-- 由模板创建的任务
ALTER TABLE generation_tasks ADD COLUMN template_id text;
