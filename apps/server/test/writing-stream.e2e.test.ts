import type { ServerEvent } from '@creature/shared';
import { EventBus } from '../src/events/event-bus';
import { login, makeApp, submit, type TestApp } from './helpers';

type Delta = Extract<ServerEvent, { type: 'task.delta' }>;

/** 按 offset 拼接推送的文本（与前端的处理方式一致） */
const assemble = (deltas: Delta[]) => deltas.reduce((cur, d) => cur.slice(0, d.offset) + d.text, '');

describe('写作流式输出', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ mockLatencyMs: { image: 0, video: 0, audio: 0, text: 1500 } });
  });
  afterAll(() => t.close());
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  /** 订阅某个用户的推送，收集写作增量 */
  function collect(userId: string) {
    const deltas: Delta[] = [];
    const sub = t.app.get(EventBus).stream(userId).subscribe((e) => e.type === 'task.delta' && deltas.push(e));
    return { deltas, stop: () => sub.unsubscribe() };
  }
  const task = async (token: string, id: string) => (await t.http().get(`/v1/generations/${id}`).set(auth(token)).expect(200)).body;
  const balance = async (token: string) => (await t.http().get('/v1/credits/balance').set(auth(token)).expect(200)).body.available as number;
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it('逐段推送，按 offset 拼接后与最终结果一致；按实际字数计费', async () => {
    const u = await login(t);
    const c = collect(u.userId);
    const r = await submit(t, u.token, { modality: 'text', prompt: '秋季新品', params: { template: 'article', chars: 2000 } }).expect(202);
    expect(r.body.estimated_credits).toBe(1);
    await t.worker.runOnce();
    c.stop();
    const done = await task(u.token, r.body.id);
    expect(done).toMatchObject({ status: 'succeeded', stopped: false, actual_credits: 1 });
    expect(c.deltas.length).toBeGreaterThan(3);
    expect(c.deltas.every((d) => d.task_id === r.body.id)).toBe(true);
    // 增量首尾相接，拼接结果就是正文（最终结果末尾另附 AI 生成标识）
    c.deltas.forEach((d, i) => i > 0 && expect(d.offset).toBe(c.deltas[i - 1].offset + c.deltas[i - 1].text.length));
    const text = assemble(c.deltas);
    expect(done.outputs[0].text.startsWith(text)).toBe(true);
    expect(text.length).toBeGreaterThan(100);
  });

  it('中途停止：保留已生成的部分并结算；已结束的任务不能再停止', async () => {
    const u = await login(t);
    const c = collect(u.userId);
    const before = await balance(u.token);
    const r = await submit(t, u.token, { modality: 'text', prompt: '秋季新品', params: { template: 'article' } }).expect(202);
    const run = t.worker.runOnce();
    await waitFor(() => c.deltas.length >= 2);
    const stopped = await t.http().post(`/v1/generations/${r.body.id}/cancel`).set(auth(u.token)).expect(200);
    expect(stopped.body.status).toBe('running');
    await run;
    c.stop();
    const done = await task(u.token, r.body.id);
    expect(done).toMatchObject({ status: 'succeeded', stopped: true, actual_credits: 1 });
    const text = assemble(c.deltas);
    const full = (await task(u.token, (await submitAndRun(u.token)).id)).outputs[0].text as string;
    expect(done.outputs[0].text.startsWith(text)).toBe(true);
    expect(text.length).toBeLessThan(full.length / 2);
    expect(await balance(u.token)).toBe(before - 2); // 停止的任务与对照任务各 1 积分
    expect((await t.http().post(`/v1/generations/${r.body.id}/cancel`).set(auth(u.token)).expect(409)).body.error.code).toBe('TASK_NOT_CANCELABLE');
  });

  async function submitAndRun(token: string) {
    const r = await submit(t, token, { modality: 'text', prompt: '秋季新品', params: { template: 'article' } }).expect(202);
    await t.worker.runOnce();
    return r.body as { id: string };
  }

  it('流式审核：已生成的文字命中拦截词时中止生成，违规文字不会推送，积分全额返还', async () => {
    const u = await login(t);
    const c = collect(u.userId);
    const before = await balance(u.token);
    const r = await submit(t, u.token, { modality: 'text', prompt: '敏感文字测试', params: { template: 'article' } }).expect(202);
    const started = Date.now();
    await t.worker.runOnce();
    c.stop();
    const done = await task(u.token, r.body.id);
    expect(done).toMatchObject({ status: 'blocked', error: { code: 'CONTENT_BLOCKED' }, outputs: [] });
    expect(c.deltas.length).toBeGreaterThan(0); // 违规内容出现在正文中段，此前的部分已推送
    expect(c.deltas.some((d) => d.text.includes('违规'))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500); // 中途中止，没有等到生成结束
    expect(await balance(u.token)).toBe(before);
    const [rec] = await t.db.query<{ verdict: string }>(`SELECT verdict FROM moderation_records WHERE target_type = 'output' AND target_id = $1`, [r.body.id]);
    expect(rec.verdict).toBe('block');
  });

  it('切换备选模型时从头重新推送', async () => {
    const u = await login(t);
    const c = collect(u.userId);
    const r = await submit(t, u.token, { modality: 'text', prompt: '超时演示', params: { template: 'ad' } }).expect(202);
    await t.worker.runOnce();
    c.stop();
    const done = await task(u.token, r.body.id);
    expect(done.status).toBe('succeeded');
    expect(done.model.code).not.toBe(r.body.model.code);
    expect(c.deltas.filter((d) => d.offset === 0).length).toBe(2);
    expect(done.outputs[0].text.startsWith(assemble(c.deltas))).toBe(true);
  });
});
