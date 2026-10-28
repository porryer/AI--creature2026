import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.module';
import { loadConfig, type AppConfig } from '../src/config';
import { CreditsService } from '../src/credits/credits.service';
import { DB, type Db } from '../src/db/db';
import { GenerationWorker } from '../src/generations/worker.service';

/**
 * 测试应用：默认使用内存 PGlite；设置 TEST_DATABASE_URL 时连接真实 PostgreSQL，
 * 每个应用实例使用独立 schema，互不干扰。
 */
export async function makeApp(overrides: Partial<AppConfig> = {}) {
  const base = loadConfig({ NODE_ENV: 'test' });
  let databaseUrl: string | undefined;
  let eventsChannel = base.eventsChannel;
  const pgUrl = process.env.TEST_DATABASE_URL;
  if (pgUrl) {
    const schema = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const c = new Client({ connectionString: pgUrl });
    await c.connect();
    await c.query(`CREATE SCHEMA ${schema}`);
    await c.end();
    const u = new URL(pgUrl);
    u.searchParams.set('options', `-c search_path=${schema}`);
    databaseUrl = u.toString();
    // 通知频道是整个数据库共享的：每个测试应用用自己的频道，避免互相收到事件
    eventsChannel = `ev_${schema}`;
  }
  const config: AppConfig = { ...base, databaseUrl, eventsChannel, storageDir: mkdtempSync(join(tmpdir(), 'creature-files-')), ...overrides };
  const app = await createApp(config);
  await app.init();
  const http = () => request(app.getHttpServer());
  return {
    app,
    config,
    http,
    db: app.get<Db>(DB),
    worker: app.get(GenerationWorker),
    credits: app.get(CreditsService),
    close: () => app.close(),
  };
}

export type TestApp = Awaited<ReturnType<typeof makeApp>>;

let phoneSeq = 0;
/** 用开发模式验证码登录一个新用户，返回访问令牌与 cookie */
export async function login(t: TestApp, phone = `139${String(Date.now() % 1e4).padStart(4, '0')}${String(phoneSeq++ % 1e4).padStart(4, '0')}`) {
  const sent = await t.http().post('/v1/auth/sms/send').send({ phone }).expect(200);
  const res = await t.http().post('/v1/auth/sms/login').send({ phone, code: sent.body.dev_code }).expect(200);
  const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('crt_rt='));
  return { token: res.body.access_token as string, userId: res.body.user_id as string, cookie: cookie!.split(';')[0], phone };
}

let idem = 0;
export const idemKey = () => `test-${Date.now()}-${idem++}`;

/** 提交生成任务（自动带幂等键） */
export function submit(t: TestApp, token: string, body: Record<string, unknown>, key = idemKey()) {
  return t.http().post('/v1/generations').set('authorization', `Bearer ${token}`).set('idempotency-key', key).send(body);
}

/** 反复运行 Worker 直到队列清空 */
export async function drain(t: TestApp) {
  let total = 0;
  for (let n = await t.worker.runOnce(); n > 0; n = await t.worker.runOnce()) total += n;
  return total;
}

export async function reconcileUser(t: TestApp, userId: string) {
  return t.credits.reconcile(await t.credits.accountIdFor(userId));
}
