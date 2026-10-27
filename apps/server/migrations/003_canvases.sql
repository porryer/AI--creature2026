-- 项目与画布（MVP：画布文档整体保存为 JSON，用版本号做乐观锁；多人实时协作在 Beta 引入 Yjs）

CREATE TABLE projects (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX idx_projects_user ON projects (user_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE canvases (
  id         text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects (id),
  user_id    text NOT NULL REFERENCES users (id),
  name       text NOT NULL,
  -- { nodes: [...], edges: [...], messages: [...], viewport: {...} }；节点只保存 taskId，产物在读取时按任务补全
  doc        jsonb NOT NULL,
  version    integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_canvases_project ON canvases (project_id, updated_at DESC);
CREATE INDEX idx_canvases_user ON canvases (user_id, updated_at DESC);
