-- 写作流式输出与存储清理

-- 用户在生成中途停止写作任务：保留已生成的部分，按实际字数结算
ALTER TABLE generation_tasks ADD COLUMN stop_requested boolean NOT NULL DEFAULT false;
ALTER TABLE generation_tasks ADD COLUMN stopped boolean NOT NULL DEFAULT false;

-- 已删除作品的文件在宽限期后清理；清理完成后记录时间，避免重复处理
ALTER TABLE assets ADD COLUMN files_purged_at timestamptz;
CREATE INDEX idx_assets_purge ON assets (deleted_at) WHERE deleted_at IS NOT NULL AND files_purged_at IS NULL;

-- 过期未完成的上传会话：删除已写入的文件后标记为 expired
ALTER TABLE uploads DROP CONSTRAINT uploads_status_check;
ALTER TABLE uploads ADD CONSTRAINT uploads_status_check CHECK (status IN ('pending', 'uploaded', 'completed', 'rejected', 'expired'));
CREATE INDEX idx_uploads_unfinished ON uploads (expires_at) WHERE status IN ('pending', 'uploaded');
