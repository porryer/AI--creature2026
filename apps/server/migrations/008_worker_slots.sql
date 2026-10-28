-- Sprint 7：Worker 按模态分别认领排队任务，排队位置也按模态计数
CREATE INDEX idx_tasks_queued_modality ON generation_tasks (modality, queue, created_at) WHERE status = 'queued';
DROP INDEX IF EXISTS idx_tasks_queued;
