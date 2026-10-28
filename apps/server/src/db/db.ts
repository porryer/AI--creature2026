import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool, types } from 'pg';

// 数据访问层：同一套 SQL 运行在真实 PostgreSQL（pg）或内嵌 PGlite 上

export const DB = Symbol('DB');

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** 执行不带参数的多条语句（迁移用） */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly driver: 'pg' | 'pglite';
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  /**
   * PostgreSQL LISTEN / NOTIFY（只有真实 PostgreSQL 提供，用于多实例之间广播事件）。
   * 订阅返回取消函数；连接断开时每秒重试，重连后重新订阅并调用 onReconnect（断开期间的通知已丢失）。
   */
  listen?(channel: string, onMessage: (payload: string) => void, onReconnect?: () => void): Promise<() => Promise<void>>;
  notify?(channel: string, payload: string): Promise<void>;
}

const CHANNEL_RE = /^[a-z_][a-z0-9_]{0,62}$/;

// int8 与 numeric 默认返回字符串，这里统一转为 number（积分与金额均在安全整数范围内）
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

class PgDb implements Db {
  readonly driver = 'pg' as const;
  private listener?: Client;
  private connecting?: Promise<void>;
  private closing = false;
  private readonly handlers = new Map<string, Set<(payload: string) => void>>();
  private readonly reconnectHandlers = new Set<() => void>();

  constructor(
    private readonly pool: Pool,
    private readonly url: string,
  ) {}

  async listen(channel: string, onMessage: (payload: string) => void, onReconnect?: () => void): Promise<() => Promise<void>> {
    if (!CHANNEL_RE.test(channel)) throw new Error(`非法的通知频道名：${channel}`);
    const set = this.handlers.get(channel) ?? new Set();
    const first = set.size === 0;
    set.add(onMessage);
    this.handlers.set(channel, set);
    if (onReconnect) this.reconnectHandlers.add(onReconnect);
    if (!this.listener) await this.connectListener(false);
    else if (first) await this.listener.query(`LISTEN "${channel}"`);
    return async () => {
      set.delete(onMessage);
      if (onReconnect) this.reconnectHandlers.delete(onReconnect);
      if (set.size === 0 && this.listener && !this.closing) await this.listener.query(`UNLISTEN "${channel}"`).catch(() => undefined);
    };
  }

  async notify(channel: string, payload: string): Promise<void> {
    await this.pool.query('SELECT pg_notify($1, $2)', [channel, payload]);
  }

  /**
   * 专用连接（不放回连接池，经过 PgBouncer 时须为 session 模式）。
   * 连接断开（出错或被关闭）后每秒重试，直到成功；首次连接失败直接抛出，由启动流程处理。
   */
  private connectListener(retry: boolean): Promise<void> {
    this.connecting ??= (async () => {
      const c = new Client({ connectionString: this.url, application_name: 'creature-listener' });
      let dropped = false;
      const drop = () => {
        if (dropped) return;
        dropped = true;
        const wasLive = this.listener === c;
        if (wasLive) this.listener = undefined;
        void c.end().catch(() => undefined);
        if (!this.closing && (wasLive || retry)) setTimeout(() => this.reconnect(), 1000);
      };
      c.on('notification', (m) => this.handlers.get(m.channel)?.forEach((h) => h(m.payload ?? '')));
      c.on('error', drop);
      c.on('end', drop);
      try {
        await c.connect();
        for (const [ch, set] of this.handlers) if (set.size) await c.query(`LISTEN "${ch}"`);
      } catch (e) {
        drop();
        throw e;
      }
      if (this.closing) return void c.end().catch(() => undefined);
      this.listener = c;
    })().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private reconnect() {
    if (this.closing) return;
    // 失败时 drop() 已安排下一次重试
    this.connectListener(true).then(
      () => this.reconnectHandlers.forEach((h) => h()),
      () => undefined,
    );
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }
  /** 事务遇到死锁或序列化冲突时自动重试（事务函数内只能有数据库操作） */
  async tx<T>(fn: (q: Queryable) => Promise<T>, attempt = 1): Promise<T> {
    try {
      return await this.txOnce(fn);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if ((code === '40P01' || code === '40001') && attempt < 3) return this.tx(fn, attempt + 1);
      throw e;
    }
  }

  private async txOnce<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const q: Queryable = {
        query: async <R>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as R[],
        exec: async (sql: string) => void (await client.query(sql)),
      };
      const result = await fn(q);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
  async close() {
    this.closing = true;
    await this.listener?.end().catch(() => undefined);
    await this.pool.end();
  }
}

class PgliteDb implements Db {
  readonly driver = 'pglite' as const;
  constructor(private readonly pg: PGlite) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.pg.query<T>(sql, params)).rows;
  }
  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (t) =>
      fn({
        query: async <R>(sql: string, params: unknown[] = []) => (await t.query<R>(sql, params)).rows,
        exec: async (sql: string) => void (await t.exec(sql)),
      }),
    );
  }
  close() {
    return this.pg.close();
  }
}

export async function openDb(opts: { databaseUrl?: string; pgliteDir?: string }): Promise<Db> {
  if (opts.databaseUrl) return new PgDb(new Pool({ connectionString: opts.databaseUrl, max: 10 }), opts.databaseUrl);
  if (opts.pgliteDir) mkdirSync(opts.pgliteDir, { recursive: true });
  const pg = new PGlite(opts.pgliteDir);
  await pg.waitReady;
  return new PgliteDb(pg);
}

/** 迁移用的事务级咨询锁：多个实例同时启动时依次执行迁移，后启动的实例看到已完成的版本后直接跳过 */
const MIGRATION_LOCK = 72026001;

/** 按文件名顺序在一个事务中执行 migrations/ 下尚未执行过的 SQL 文件 */
export async function migrate(db: Db, dir = join(__dirname, '..', '..', 'migrations')): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  return db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await q.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await q.query<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version));
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      await q.exec(readFileSync(join(dir, file), 'utf8'));
      await q.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      applied.push(file);
    }
    return applied;
  });
}

/** 将 Postgres 唯一约束冲突识别出来 */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}
