-- 广场评论与关注

-- 评论：只支持一层回复（parent_id 指向顶层评论）；published 可见，hidden 被举报自动隐藏待复核，removed 已删除
CREATE TABLE post_comments (
  id           text PRIMARY KEY,
  post_id      text NOT NULL REFERENCES posts (id),
  author_id    text NOT NULL REFERENCES users (id),
  parent_id    text REFERENCES post_comments (id),
  -- 回复的对象（回复某条回复时显示"回复 @某人"）
  reply_to_id  text REFERENCES users (id),
  body         text NOT NULL,
  status       text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'hidden', 'removed')),
  report_count integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_comments_post ON post_comments (post_id, created_at DESC) WHERE parent_id IS NULL;
CREATE INDEX idx_comments_parent ON post_comments (parent_id, created_at);
CREATE INDEX idx_comments_author_time ON post_comments (author_id, created_at DESC);
CREATE INDEX idx_comments_hidden ON post_comments (created_at) WHERE status = 'hidden';
ALTER TABLE posts ADD COLUMN comment_count integer NOT NULL DEFAULT 0;

-- 关注
CREATE TABLE user_follows (
  follower_id text NOT NULL REFERENCES users (id),
  followee_id text NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_follows_followee ON user_follows (followee_id, created_at DESC);

-- 举报与审核记录：增加评论
ALTER TABLE reports DROP CONSTRAINT reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('post', 'comment'));
ALTER TABLE moderation_records DROP CONSTRAINT IF EXISTS moderation_records_target_type_check;
ALTER TABLE moderation_records ADD CONSTRAINT moderation_records_target_type_check CHECK (target_type IN ('prompt', 'upload', 'output', 'post', 'character', 'brand_kit', 'comment'));
