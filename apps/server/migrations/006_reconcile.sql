-- Sprint 5：定期全量对账记录
CREATE TABLE reconcile_runs (
  id            text PRIMARY KEY,
  trigger       text NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  triggered_by  text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  accounts      integer NOT NULL DEFAULT 0,
  mismatches    integer NOT NULL DEFAULT 0,
  stale_holds   integer NOT NULL DEFAULT 0,
  -- 不一致的账户与残留冻结明细（各最多 100 条）
  details       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_reconcile_started ON reconcile_runs (started_at DESC);
