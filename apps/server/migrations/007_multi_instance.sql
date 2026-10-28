-- Sprint 6：生成提交限流改为按数据库计数（多实例共享），为两类计数建索引
CREATE INDEX idx_tasks_user_inflight ON generation_tasks (user_id) WHERE status IN ('queued', 'running', 'post_processing');
CREATE INDEX idx_tasks_user_created ON generation_tasks (user_id, created_at DESC);
