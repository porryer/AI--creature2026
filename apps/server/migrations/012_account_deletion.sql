-- 账号注销：申请后进入 15 天冷静期（deleting，期间登录即撤销），到期后匿名化（deleted）

ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'frozen', 'banned', 'deleting', 'deleted'));
ALTER TABLE users ADD COLUMN deletion_requested_at timestamptz;
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
CREATE INDEX idx_users_deleting ON users (deletion_requested_at) WHERE status = 'deleting';

-- 审计日志按操作人查询（个人信息导出的每日次数）
CREATE INDEX idx_audit_actor ON audit_logs (actor_id, action, created_at DESC);
