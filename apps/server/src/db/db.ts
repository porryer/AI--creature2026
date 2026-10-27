import { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, types } from 'pg';

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
}

// int8 与 numeric 默认返回字符串，这里统一转为 number（积分与金额均在安全整数范围内）
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

class PgDb implements Db {
  readonly driver = 'pg' as const;
  constructor(private readonly pool: Pool) {}
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
  close() {
    return this.pool.end();
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
  if (opts.databaseUrl) return new PgDb(new Pool({ connectionString: opts.databaseUrl, max: 10 }));
  if (opts.pgliteDir) mkdirSync(opts.pgliteDir, { recursive: true });
  const pg = new PGlite(opts.pgliteDir);
  await pg.waitReady;
  return new PgliteDb(pg);
}

/** 按文件名顺序执行 migrations/ 下尚未执行过的 SQL 文件 */
export async function migrate(db: Db, dir = join(__dirname, '..', '..', 'migrations')): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    await db.tx(async (q) => {
      await q.exec(sql);
      await q.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}

/** 将 Postgres 唯一约束冲突识别出来 */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}
