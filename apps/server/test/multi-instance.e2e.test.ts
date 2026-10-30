import type { ServerEvent } from '@creature/shared';
import { readdirSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate, openDb } from '../src/db/db';
import { EventBus } from '../src/events/event-bus';
import { drain, login, makeApp, submit, type TestApp } from './helpers';

const ADMIN = '13700000031';
const until = async (fn: () => boolean | Promise<boolean>, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

// 多实例只在真实 PostgreSQL 上成立（LISTEN / NOTIFY）；PGlite 为单进程，跳过
const pg = process.env.TEST_DATABASE_URL ? describe : describe.skip;

pg('多实例：两个后端实例共用同一个数据库', () => {
  let a: TestApp;
  let b: TestApp;
  beforeAll(async () => {
    a = await makeApp({ adminPhones: [ADMIN], generationRatePerMin: 3 });
    b = await makeApp({ adminPhones: [ADMIN], generationRatePerMin: 3, databaseUrl: a.config.databaseUrl, eventsChannel: a.config.eventsChannel, storageDir: a.config.storageDir });
  });
  afterAll(async () => {
    await b?.close();
    await a?.close();
  });
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it('推送连接在 B、任务在 A 提交并由 A 的 Worker 处理：B 上的连接收到进度、完成与积分变化', async () => {
    const u = await login(a);
    const events: ServerEvent[] = [];
    // 模拟用户的推送连接建立在实例 B
    const sub = b.app.get(EventBus).stream(u.userId).subscribe((e) => events.push(e));
    try {
      const task = await submit(a, u.token, { modality: 'image', prompt: '秋日海报', params: { count: 1 } }).expect(202);
      expect(await until(() => events.some((e) => e.type === 'task.progress' && e.task.id === task.body.id))).toBe(true);
      expect(await until(() => events.some((e) => e.type === 'credits.changed'))).toBe(true);
      await drain(a);
      expect(await until(() => events.some((e) => e.type === 'task.succeeded'))).toBe(true);
      const done = events.find((e) => e.type === 'task.succeeded');
      expect(done?.type === 'task.succeeded' && done.task.outputs[0].url).toMatch(/^\/v1\/files\//);
      // A 上没有该用户的连接，进度不会在 A 本地发出
      expect(a.app.get(EventBus).listenerCount(u.userId)).toBe(0);
    } finally {
      sub.unsubscribe();
    }
  });

  it('写作流式输出：增量经通知送达 B 上的连接；在 B 停止，A 上的 Worker 立即结束并保留已生成的部分', async () => {
    const latency = { image: 0, video: 0, audio: 0, text: 1500 };
    const c = await makeApp({ mockLatencyMs: latency });
    const d = await makeApp({ mockLatencyMs: latency, databaseUrl: c.config.databaseUrl, eventsChannel: c.config.eventsChannel, storageDir: c.config.storageDir });
    try {
      const u = await login(c);
      const deltas: Extract<ServerEvent, { type: 'task.delta' }>[] = [];
      const sub = d.app.get(EventBus).stream(u.userId).subscribe((e) => e.type === 'task.delta' && deltas.push(e));
      const task = await submit(c, u.token, { modality: 'text', prompt: '秋季新品', params: { template: 'article' } }).expect(202);
      const started = Date.now();
      const run = c.worker.runOnce();
      expect(await until(() => deltas.length >= 2)).toBe(true);
      await d.http().post(`/v1/generations/${task.body.id}/cancel`).set(auth(u.token)).expect(200);
      await run;
      expect(Date.now() - started).toBeLessThan(1500);
      const done = (await d.http().get(`/v1/generations/${task.body.id}`).set(auth(u.token)).expect(200)).body;
      expect(done).toMatchObject({ status: 'succeeded', stopped: true });
      await until(() => false, 200); // 等待在途的通知
      sub.unsubscribe();
      // 通知可能乱序到达，按 offset 排序后拼接
      const text = [...deltas].sort((x, y) => x.offset - y.offset).reduce((cur, x) => cur.slice(0, x.offset) + x.text, '');
      expect(text.length).toBeGreaterThan(0);
      expect(done.outputs[0].text.startsWith(text)).toBe(true);
    } finally {
      await d.close();
      await c.close();
    }
  });

  it('任务内容随通知发送，B 无需读取；超过通知上限的长提示词改为传引用，由 B 读取', async () => {
    const u = await login(a);
    const busB = b.app.get(EventBus);
    const load = jest.spyOn(busB as unknown as { taskLoader: (userId: string, taskId: string) => Promise<unknown> }, 'taskLoader');
    const events: ServerEvent[] = [];
    const sub = busB.stream(u.userId).subscribe((e) => events.push(e));
    const progressOf = (id: string) => events.find((e) => e.type === 'task.progress' && e.task.id === id);
    try {
      const short = await submit(a, u.token, { modality: 'text', prompt: '短文案' }).expect(202);
      expect(await until(() => !!progressOf(short.body.id))).toBe(true);
      expect(load).not.toHaveBeenCalled();

      const prompt = '长'.repeat(4000); // UTF-8 下约 12 KB，超过通知上限
      const long = await submit(a, u.token, { modality: 'text', prompt }).expect(202);
      expect(await until(() => !!progressOf(long.body.id))).toBe(true);
      expect(load).toHaveBeenCalledWith(u.userId, long.body.id);
      const got = progressOf(long.body.id);
      expect(got?.type === 'task.progress' && got.task.prompt).toBe(prompt);
    } finally {
      sub.unsubscribe();
      load.mockRestore();
    }
  });

  it('监听连接被断开后自动重连：本实例的推送连接收到 sync（提示客户端重新拉取），之后跨实例推送恢复', async () => {
    const u = await login(a);
    const events: ServerEvent[] = [];
    const sub = b.app.get(EventBus).stream(u.userId).subscribe((e) => events.push(e));
    try {
      const killed = await a.db.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'creature-listener' AND query = $1`, [
        `LISTEN "${a.config.eventsChannel}"`,
      ]);
      expect(killed).toHaveLength(2); // A 与 B 各一条
      expect(await until(() => events.some((e) => e.type === 'sync'))).toBe(true);
      const task = await submit(a, u.token, { modality: 'text', prompt: '重连之后' }).expect(202);
      expect(await until(() => events.some((e) => e.type === 'task.progress' && e.task.id === task.body.id))).toBe(true);
    } finally {
      sub.unsubscribe();
    }
  });

  it('在 A 冻结账号后，B 上已缓存的账号状态立即失效', async () => {
    const u = await login(a);
    const admin = await login(a, ADMIN);
    await b.http().get('/v1/me').set(auth(u.token)).expect(200); // B 缓存了“正常”状态
    await a.http().post(`/v1/admin/users/${u.userId}/status`).set(auth(admin.token)).send({ status: 'frozen', reason: '多实例测试' }).expect(200);
    expect(await until(async () => (await b.http().get('/v1/me').set(auth(u.token))).status === 403, 3000)).toBe(true);
  });

  it('每分钟提交次数按数据库计数，在两个实例之间共享', async () => {
    const u = await login(a);
    await submit(a, u.token, { modality: 'text', prompt: '文案一' }).expect(202);
    await submit(b, u.token, { modality: 'text', prompt: '文案二' }).expect(202);
    await submit(a, u.token, { modality: 'text', prompt: '文案三' }).expect(202);
    expect((await submit(b, u.token, { modality: 'text', prompt: '文案四' }).expect(429)).body.error.code).toBe('RATE_LIMITED');
  });

  it('多个实例同时启动：迁移依次执行，只执行一次', async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    const schema = `t_mig_${Date.now().toString(36)}`;
    const c = new Client({ connectionString: url.toString() });
    await c.connect();
    await c.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const dbs = await Promise.all([1, 2, 3].map(() => openDb({ databaseUrl: url.toString() })));
    try {
      const results = await Promise.all(dbs.map((db) => migrate(db)));
      const files = readdirSync(join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
      expect(results.filter((r) => r.length > 0)).toEqual([files]);
      expect(results.filter((r) => r.length === 0)).toHaveLength(2);
    } finally {
      await Promise.all(dbs.map((db) => db.close()));
      await c.query(`DROP SCHEMA ${schema} CASCADE`);
      await c.end();
    }
  });
});

pg('事件监听连接', () => {
  it('数据库暂时不可达时持续重试，恢复后重新订阅并回调 onReconnect', async () => {
    const target = new URL(process.env.TEST_DATABASE_URL!);
    // 本地 TCP 代理：停止代理即可模拟数据库断开且暂时连不上
    const sockets = new Set<net.Socket>();
    let server: net.Server | undefined;
    const start = (port: number) =>
      new Promise<number>((resolve) => {
        server = net.createServer((client) => {
          const upstream = net.connect(Number(target.port || 5432), target.hostname);
          client.pipe(upstream).pipe(client);
          for (const s of [client, upstream]) {
            sockets.add(s);
            s.on('close', () => sockets.delete(s));
            s.on('error', () => s.destroy());
          }
        });
        server.listen(port, '127.0.0.1', () => resolve((server!.address() as net.AddressInfo).port));
      });
    const stop = () =>
      new Promise<void>((resolve) => {
        server!.close(() => resolve());
        sockets.forEach((s) => s.destroy());
      });

    const port = await start(0);
    const viaProxy = new URL(target);
    viaProxy.hostname = '127.0.0.1';
    viaProxy.port = String(port);
    const db = await openDb({ databaseUrl: viaProxy.toString() });
    const direct = await openDb({ databaseUrl: target.toString() });
    const channel = `ev_proxy_${Date.now().toString(36)}`;
    const got: string[] = [];
    let reconnects = 0;
    try {
      await db.listen!(channel, (p) => got.push(p), () => reconnects++);
      await direct.notify!(channel, 'before');
      expect(await until(() => got.includes('before'))).toBe(true);

      await stop(); // 断开现有连接，并在 2.5 秒内拒绝新连接：期间至少有一次重连失败
      await new Promise((r) => setTimeout(r, 2500));
      expect(reconnects).toBe(0);
      await start(port);
      expect(await until(() => reconnects === 1)).toBe(true);
      await direct.notify!(channel, 'after');
      expect(await until(() => got.includes('after'))).toBe(true);
    } finally {
      await db.close();
      await direct.close();
      await stop();
    }
  });
});
