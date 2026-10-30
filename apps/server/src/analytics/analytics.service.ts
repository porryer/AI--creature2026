import { Inject, Injectable, Logger } from '@nestjs/common';
import { findTemplate, type AdminAnalyticsDTO, type ClientEvent } from '@creature/shared';
import { Errors } from '../common/errors';
import { newId } from '../common/ids';
import { Db, DB } from '../db/db';

/** 服务端记录的事件：以服务端为准，客户端无法伪造 */
export type ServerEventName = 'prompt_submit' | 'task_succeeded' | 'task_failed' | 'asset_export' | 'order_paid' | 'template_use';

/** 每个用户每分钟最多上报的客户端事件数 */
const CLIENT_RATE_PER_MIN = 300;
const NORTH_STAR_WEEKS = 8;

/**
 * 数据埋点（docs/02-prd.md 第 6 节）。事件写入 analytics_events；
 * 记录失败只写日志，不影响业务请求。数据量增长后迁移到 ClickHouse（见 03 技术架构）。
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger('Analytics');

  constructor(@Inject(DB) private readonly db: Db) {}

  async track(userId: string | null, name: ServerEventName, props: Record<string, unknown>): Promise<void> {
    try {
      await this.db.query(`INSERT INTO analytics_events (id, user_id, name, source, props) VALUES ($1, $2, $3, 'server', $4)`, [newId('evt'), userId, name, JSON.stringify(props)]);
    } catch (e) {
      this.logger.warn(`记录事件 ${name} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 客户端上报（已按白名单校验）；超出频率返回 429 */
  async trackClient(userId: string, events: ClientEvent[]): Promise<number> {
    const [{ n }] = await this.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM analytics_events WHERE user_id = $1 AND source = 'client' AND created_at > now() - interval '1 minute'`,
      [userId],
    );
    if (n + events.length > CLIENT_RATE_PER_MIN) throw Errors.rateLimited('上报太频繁', 60);
    const values: unknown[] = [];
    const rows = events.map((e, i) => {
      values.push(newId('evt'), userId, e.name, JSON.stringify(e.props));
      return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, 'client', $${i * 4 + 4})`;
    });
    await this.db.query(`INSERT INTO analytics_events (id, user_id, name, source, props) VALUES ${rows.join(', ')}`, values);
    return events.length;
  }

  /** 后台数据看板：最近 days 天的漏斗、事件计数、热门模板与付费转化，最近 8 周的北极星指标 */
  async report(days: number): Promise<AdminAnalyticsDTO> {
    const since = `${days} days`;
    const weeks = lastWeeks(NORTH_STAR_WEEKS);
    const [[f], byWeek, events, templates, [pay]] = await Promise.all([
      this.db.query<{ active: number; submitted: number; succeeded: number; continued: number; exported: number }>(
        `WITH ev AS (
           SELECT user_id, name, props, created_at FROM analytics_events WHERE created_at > now() - $1::interval AND user_id IS NOT NULL
         ),
         submitted AS (SELECT DISTINCT user_id FROM ev WHERE name = 'prompt_submit'),
         first_ok AS (SELECT e.user_id, MIN(e.created_at) AS t FROM ev e JOIN submitted s ON s.user_id = e.user_id WHERE e.name = 'task_succeeded' GROUP BY e.user_id)
         SELECT (SELECT COUNT(DISTINCT user_id) FROM ev)::int AS active,
                (SELECT COUNT(*) FROM submitted)::int AS submitted,
                (SELECT COUNT(*) FROM first_ok)::int AS succeeded,
                (SELECT COUNT(DISTINCT e.user_id) FROM ev e JOIN first_ok f ON f.user_id = e.user_id WHERE e.name = 'prompt_submit' AND e.created_at > f.t)::int AS continued,
                (SELECT COUNT(DISTINCT e.user_id) FROM ev e JOIN first_ok f ON f.user_id = e.user_id WHERE e.name = 'asset_export')::int AS exported`,
        [since],
      ),
      // 北京时间固定为 UTC+8：用固定偏移分周，不依赖数据库的时区数据
      this.db.query<{ week: string; works: number }>(
        `SELECT to_char(date_trunc('week', (created_at AT TIME ZONE 'UTC') + interval '8 hours'), 'YYYY-MM-DD') AS week,
                COUNT(DISTINCT COALESCE(props->>'asset_id', id))::int AS works
           FROM analytics_events
          WHERE name = 'asset_export' AND created_at >= $1::timestamptz
          GROUP BY 1`,
        [new Date(Date.parse(`${weeks[0]}T00:00:00+08:00`)).toISOString()],
      ),
      this.db.query<{ name: string; source: 'server' | 'client'; count: number }>(
        `SELECT name, source, COUNT(*)::int AS count FROM analytics_events WHERE created_at > now() - $1::interval GROUP BY 1, 2 ORDER BY 3 DESC`,
        [since],
      ),
      this.db.query<{ template_id: string; uses: number; users: number }>(
        `SELECT props->>'template_id' AS template_id, COUNT(*)::int AS uses, COUNT(DISTINCT user_id)::int AS users
           FROM analytics_events WHERE name = 'template_use' AND created_at > now() - $1::interval GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`,
        [since],
      ),
      this.db.query<AdminAnalyticsDTO['paywall']>(
        `SELECT COUNT(DISTINCT user_id) FILTER (WHERE name = 'paywall_shown')::int AS shown_users,
                COUNT(DISTINCT user_id) FILTER (WHERE name = 'order_paid')::int AS paid_users,
                COUNT(*) FILTER (WHERE name = 'order_paid')::int AS paid_orders,
                COALESCE(SUM((props->>'amount_fen')::int) FILTER (WHERE name = 'order_paid'), 0)::int AS amount_fen
           FROM analytics_events WHERE created_at > now() - $1::interval AND name IN ('paywall_shown', 'order_paid')`,
        [since],
      ),
    ]);
    return {
      days,
      funnel: [
        { key: 'active', label: '活跃用户', users: f.active },
        { key: 'submitted', label: '提交生成', users: f.submitted },
        { key: 'succeeded', label: '生成成功', users: f.succeeded },
        { key: 'continued', label: '二次操作', users: f.continued },
        { key: 'exported', label: '导出 / 下载 / 发布', users: f.exported },
      ],
      north_star: weeks.map((week) => ({ week, works: byWeek.find((w) => w.week === week)?.works ?? 0 })),
      events,
      templates: templates.map((t) => ({ ...t, title: findTemplate(t.template_id)?.title ?? t.template_id })),
      paywall: pay,
    };
  }
}

/** 最近 n 周（北京时间，周一为一周的开始）的周一日期，从早到晚 */
function lastWeeks(n: number): string[] {
  const now = new Date(Date.now() + 8 * 3600_000); // 北京时间的"墙上时间"
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  return Array.from({ length: n }, (_, i) => new Date(monday.getTime() - (n - 1 - i) * 7 * 86_400_000).toISOString().slice(0, 10));
}
