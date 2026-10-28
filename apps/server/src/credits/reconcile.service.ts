import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ReconcileRunDTO } from '@creature/shared';
import { newId } from '../common/ids';
import { Db, DB } from '../db/db';

const DETAIL_LIMIT = 100;

export type ReconcileRun = ReconcileRunDTO;

/**
 * 全量对账（docs/03-architecture.md 5.3）：
 * 1. 每个账户的可用余额 = 流水可用增量合计 = 批次剩余合计；冻结余额 = 流水冻结增量合计 = 冻结明细合计；
 * 2. 已结束的任务不应还有冻结明细（结算 / 返还时会删除）。
 * 用一条集合查询完成，不逐个账户加锁；结果写入 reconcile_runs，发现差异时输出错误日志用于告警。
 */
@Injectable()
export class ReconcileService {
  private readonly logger = new Logger('Reconcile');

  constructor(@Inject(DB) private readonly db: Db) {}

  async run(trigger: 'schedule' | 'manual', triggeredBy: string | null = null): Promise<ReconcileRun> {
    const id = newId('rec');
    await this.db.query('INSERT INTO reconcile_runs (id, trigger, triggered_by) VALUES ($1, $2, $3)', [id, trigger, triggeredBy]);
    const [[{ n }], bad, holds] = await Promise.all([
      this.db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM credit_accounts'),
      this.db.query<NonNullable<ReconcileRun['details']['accounts']>[number]>(
        `SELECT a.id AS account_id, a.owner_id, a.available, a.frozen,
                COALESCE(l.a, 0)::int AS ledger_available, COALESCE(l.f, 0)::int AS ledger_frozen,
                COALESCE(g.n, 0)::int AS grants_remaining, COALESCE(h.n, 0)::int AS holds
           FROM credit_accounts a
           LEFT JOIN (SELECT account_id, SUM(delta_available) AS a, SUM(delta_frozen) AS f FROM credit_ledger GROUP BY account_id) l ON l.account_id = a.id
           LEFT JOIN (SELECT account_id, SUM(remaining) AS n FROM credit_grants GROUP BY account_id) g ON g.account_id = a.id
           LEFT JOIN (SELECT gr.account_id, SUM(h.amount) AS n FROM credit_holds h JOIN credit_grants gr ON gr.id = h.grant_id GROUP BY gr.account_id) h ON h.account_id = a.id
          WHERE a.available <> COALESCE(l.a, 0) OR a.frozen <> COALESCE(l.f, 0) OR a.available <> COALESCE(g.n, 0) OR a.frozen <> COALESCE(h.n, 0)
          ORDER BY a.id`,
      ),
      this.db.query<{ task_id: string; status: string; amount: number }>(
        `SELECT h.task_id, t.status, SUM(h.amount)::int AS amount FROM credit_holds h JOIN generation_tasks t ON t.id = h.task_id
          WHERE t.status IN ('succeeded', 'failed', 'blocked', 'canceled') GROUP BY h.task_id, t.status ORDER BY h.task_id`,
      ),
    ]);
    const details = { accounts: bad.slice(0, DETAIL_LIMIT), holds: holds.slice(0, DETAIL_LIMIT) };
    const [row] = await this.db.query<ReconcileRun>(
      `UPDATE reconcile_runs SET finished_at = now(), accounts = $2, mismatches = $3, stale_holds = $4, details = $5 WHERE id = $1 RETURNING *`,
      [id, n, bad.length, holds.length, JSON.stringify(details)],
    );
    if (bad.length || holds.length) {
      this.logger.error(`对账发现异常：${bad.length} 个账户余额不一致，${holds.length} 个已结束任务仍有冻结积分。明细见 reconcile_runs ${id}`);
    } else {
      this.logger.log(`对账完成：${n} 个账户全部一致`);
    }
    return toRun(row);
  }

  async recent(limit = 10): Promise<ReconcileRun[]> {
    const rows = await this.db.query<ReconcileRun>('SELECT * FROM reconcile_runs ORDER BY started_at DESC LIMIT $1', [limit]);
    return rows.map(toRun);
  }

  /** 距离上一次定时对账超过 intervalHours 小时（或从未对账）时执行 */
  async runIfDue(intervalHours: number): Promise<ReconcileRun | null> {
    const [last] = await this.db.query<{ started_at: Date }>(`SELECT started_at FROM reconcile_runs WHERE trigger = 'schedule' ORDER BY started_at DESC LIMIT 1`);
    if (last && Date.now() - new Date(last.started_at).getTime() < intervalHours * 3600_000) return null;
    return this.run('schedule');
  }
}

const toRun = (r: ReconcileRun): ReconcileRun => ({
  ...r,
  started_at: new Date(r.started_at).toISOString(),
  finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
});
