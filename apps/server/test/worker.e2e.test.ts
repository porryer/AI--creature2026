import { QUEUE_POSITION_CAP, type Modality } from '@creature/shared';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../src/config';
import { openDb } from '../src/db/db';
import { login, makeApp, submit, type TestApp } from './helpers';

const until = async (fn: () => boolean | Promise<boolean>, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};
const slots = (c: Partial<Record<Modality, number>>) => ({ image: 1, video: 1, text: 1, audio: 1, ...c });
const worker = (w: Partial<AppConfig['worker']>): AppConfig['worker'] => ({ enabled: false, pollMs: 50, concurrency: slots({}), shutdownGraceMs: 0, ...w });
const latency = (l: Partial<Record<Modality, number>>) => ({ image: 0, video: 0, text: 0, audio: 0, ...l });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('Worker 容量', () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('每次认领按各模态的空闲槽位分别取任务', async () => {
    t = await makeApp({ worker: worker({ concurrency: slots({ image: 2, text: 1 }) }) });
    const u = await login(t);
    for (const p of ['图一', '图二', '图三']) await submit(t, u.token, { modality: 'image', prompt: p, params: { count: 1 } }).expect(202);
    for (const p of ['文一', '文二']) await submit(t, u.token, { modality: 'text', prompt: p }).expect(202);
    expect(await t.worker.runOnce()).toBe(3); // 2 张图 + 1 段文本
    expect(await t.worker.runOnce()).toBe(2);
    expect(await t.worker.runOnce()).toBe(0);
  });

  it('任务结束立即补位：慢的视频任务处理期间，文本任务一个接一个完成', async () => {
    t = await makeApp({ worker: worker({ enabled: true, shutdownGraceMs: 3000 }), mockLatencyMs: latency({ video: 2500, text: 50 }) });
    const u = await login(t);
    const status = async (id: string) => (await t!.http().get(`/v1/generations/${id}`).set(auth(u.token))).body.status as string;
    const video = (await submit(t, u.token, { modality: 'video', prompt: '海边日落', params: { duration: 5 } }).expect(202)).body.id as string;
    const texts: string[] = [];
    for (const p of ['文一', '文二', '文三', '文四']) texts.push((await submit(t, u.token, { modality: 'text', prompt: p }).expect(202)).body.id);
    expect(await until(async () => (await Promise.all(texts.map(status))).every((s) => s === 'succeeded'))).toBe(true);
    expect(['running', 'post_processing']).toContain(await status(video)); // 视频仍在处理，没有拖住文本
    expect(await until(async () => (await status(video)) === 'succeeded')).toBe(true);
  });

  it('停机：宽限期内未完成的任务重新排队，由其他实例接手', async () => {
    const pgliteDir = mkdtempSync(join(tmpdir(), 'creature-pg-'));
    const app = await makeApp({ pgliteDir, worker: worker({ enabled: true, shutdownGraceMs: 200 }), mockLatencyMs: latency({ video: 1500 }) });
    const u = await login(app);
    const id = (await submit(app, u.token, { modality: 'video', prompt: '夜景延时', params: { duration: 5 } }).expect(202)).body.id;
    expect(await until(async () => (await app.http().get(`/v1/generations/${id}`).set(auth(u.token))).body.status === 'running')).toBe(true);
    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(1200); // 没有等视频生成完

    const db = await openDb({ databaseUrl: app.config.databaseUrl, pgliteDir });
    try {
      expect(await db.query('SELECT status, attempt FROM generation_tasks WHERE id = $1', [id])).toEqual([{ status: 'queued', attempt: 1 }]);
    } finally {
      await db.close();
    }
    await new Promise((r) => setTimeout(r, 1500)); // 等被放弃的那次处理结束（它的写入会因尝试次数不符被拒绝）
  });

  it('排队位置：只数同一模态排在前面的任务；计数有上限', async () => {
    t = await makeApp({});
    const u = await login(t);
    const pos = async (id: string) => (await t!.http().get(`/v1/generations/${id}`).set(auth(u.token))).body.queue.position as number;
    const img1 = (await submit(t, u.token, { modality: 'image', prompt: '图一', params: { count: 1 } }).expect(202)).body;
    const img2 = (await submit(t, u.token, { modality: 'image', prompt: '图二', params: { count: 1 } }).expect(202)).body;
    const text = (await submit(t, u.token, { modality: 'text', prompt: '文一' }).expect(202)).body;
    expect([img1.queue.position, img2.queue.position, text.queue.position]).toEqual([1, 2, 1]);

    // 在前面插入超过上限的排队任务：位置停在上限 + 1，不再继续计数
    await t.db.query(
      `INSERT INTO generation_tasks
       SELECT (jsonb_populate_record(NULL::generation_tasks, to_jsonb(g) || jsonb_build_object('id', 'tsk_fill_' || n, 'idempotency_key', 'fill-' || n, 'created_at', g.created_at - interval '1 hour'))).*
         FROM generation_tasks g, generate_series(1, $2::int) n WHERE g.id = $1`,
      [img1.id, QUEUE_POSITION_CAP + 5],
    );
    expect(await pos(img2.id)).toBe(QUEUE_POSITION_CAP + 1);
    expect(await pos(text.id)).toBe(1);
  });
});
