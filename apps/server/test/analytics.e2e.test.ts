import { drain, login, makeApp, submit, type TestApp } from './helpers';

const ADMIN = '13700000041';

describe('数据埋点与看板', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ adminPhones: [ADMIN] });
  });
  afterAll(() => t.close());
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const track = (token: string, events: unknown[]) => t.http().post('/v1/analytics/events').set(auth(token)).send({ events });
  const eventsOf = (userId: string) =>
    t.db.query<{ name: string; source: string; props: Record<string, unknown> }>('SELECT name, source, props FROM analytics_events WHERE user_id = $1 ORDER BY created_at, id', [userId]);

  it('客户端上报：只接受白名单事件与属性；每次最多 20 条；按用户限流', async () => {
    const u = await login(t);
    await t.http().post('/v1/analytics/events').send({ events: [{ name: 'page_view', props: { page: 'home' } }] }).expect(401);
    expect(
      (
        await track(u.token, [
          { name: 'page_view', props: { page: 'studio-image' } },
          { name: 'agent_plan_confirmed', props: { step_count: 3, estimated_credits: 31, edited_steps: 1 } },
        ]).expect(202)
      ).body,
    ).toEqual({ accepted: 2 });
    await track(u.token, [{ name: 'prompt_submit', props: {} }]).expect(400); // 服务端事件不能由客户端上报
    await track(u.token, [{ name: 'page_view', props: { page: 'home', extra: 1 } }]).expect(400);
    await track(u.token, [{ name: 'asset_export', props: { channel: 'download', asset_type: 'image' } }]).expect(400); // 下载由服务端记录
    await track(u.token, Array.from({ length: 21 }, () => ({ name: 'page_view', props: { page: 'home' } }))).expect(400);
    expect((await eventsOf(u.userId)).map((e) => `${e.source}:${e.name}`)).toEqual(['client:page_view', 'client:agent_plan_confirmed']);

    await t.db.query(`INSERT INTO analytics_events (id, user_id, name, source, props) SELECT 'evt_fill_' || n, $1, 'page_view', 'client', '{}' FROM generate_series(1, 298) n`, [u.userId]);
    expect((await track(u.token, [{ name: 'page_view', props: { page: 'a' } }, { name: 'page_view', props: { page: 'b' } }]).expect(429)).body.error.code).toBe('RATE_LIMITED');
  });

  it('服务端事件：提交、成功 / 失败、下载、发布、支付', async () => {
    const u = await login(t);
    const ok = await submit(t, u.token, { modality: 'image', prompt: '秋日海报', params: { count: 1 } }).expect(202);
    await submit(t, u.token, { modality: 'text', prompt: '失败演示文案' }).expect(202);
    await drain(t);
    const asset = (await t.http().get(`/v1/generations/${ok.body.id}`).set(auth(u.token))).body.outputs[0].asset_id;
    await t.http().get(`/v1/assets/${asset}/download`).set(auth(u.token)).expect(200);
    await t.http().post('/v1/posts').set(auth(u.token)).send({ asset_id: asset, title: '秋日' }).expect(201);
    const order = (await t.http().post('/v1/orders').set(auth(u.token)).send({ item_type: 'credit_pack', item_ref: '100' }).expect(201)).body;
    await t.http().post(`/v1/orders/${order.id}/mock-pay`).set(auth(u.token)).expect(200);
    await t.http().post(`/v1/orders/${order.id}/mock-pay`).set(auth(u.token)).expect(200); // 重复回调不重复记录

    const ev = await eventsOf(u.userId);
    expect(ev.every((e) => e.source === 'server')).toBe(true);
    expect(ev.map((e) => e.name).sort()).toEqual(['asset_export', 'asset_export', 'order_paid', 'prompt_submit', 'prompt_submit', 'task_failed', 'task_succeeded'].sort());
    expect(ev.find((e) => e.name === 'prompt_submit')!.props).toMatchObject({ task_id: ok.body.id, mode: 'image', operation: 'generate', routing_strategy: 'auto', ref_count: 0, source: 'studio', template_id: null });
    expect(ev.find((e) => e.name === 'task_succeeded')!.props).toMatchObject({ task_id: ok.body.id, task_type: 'image', retry_count: 0, error_code: null });
    expect(ev.find((e) => e.name === 'task_failed')!.props).toMatchObject({ task_type: 'text', error_code: 'ALL_MODELS_FAILED' });
    expect(ev.filter((e) => e.name === 'asset_export').map((e) => e.props.channel)).toEqual(['download', 'publish']);
    expect(ev.find((e) => e.name === 'order_paid')!.props).toMatchObject({ item_type: 'credit_pack', amount_fen: 1000 });
  });

  it('后台看板：漏斗、北极星、事件计数、热门模板与付费转化；只有管理员能看', async () => {
    const app = await makeApp({ adminPhones: [ADMIN] });
    try {
      const a = await login(app);
      const b = await login(app);
      const c = await login(app);
      const d = await login(app);
      const sub = (u: { token: string }, body: Record<string, unknown>) => submit(app, u.token, body).expect(202);
      // A：提交 → 成功 → 再次提交 → 下载；B：提交 → 成功；C：只浏览并看到付费墙；D：提交但失败
      const first = await sub(a, { modality: 'image', prompt: '海报', params: { count: 1 } });
      await sub(b, { modality: 'text', prompt: '文案' });
      await sub(d, { modality: 'text', prompt: '失败演示' });
      await drain(app);
      await sub(a, { modality: 'text', prompt: '再写一段' });
      const asset = (await app.http().get(`/v1/generations/${first.body.id}`).set(auth(a.token))).body.outputs[0].asset_id;
      await app.http().get(`/v1/assets/${asset}/download`).set(auth(a.token)).expect(200);
      await app.http().get(`/v1/assets/${asset}/download`).set(auth(a.token)).expect(200); // 同一作品只算一个成品
      await app.http().post('/v1/analytics/events').set(auth(c.token)).send({ events: [{ name: 'page_view', props: { page: 'pricing' } }, { name: 'paywall_shown', props: { trigger: 'pricing' } }] }).expect(202);
      await app.http().post('/v1/templates/t1/use').set(auth(b.token)).expect(200);

      await app.http().get('/v1/admin/analytics').set(auth(a.token)).expect(403);
      const admin = await login(app, ADMIN);
      await app.http().get('/v1/admin/analytics?days=0').set(auth(admin.token)).expect(400);
      const r = (await app.http().get('/v1/admin/analytics?days=7').set(auth(admin.token)).expect(200)).body;
      expect(r.funnel.map((s: { key: string; users: number }) => [s.key, s.users])).toEqual([
        ['active', 4],
        ['submitted', 3],
        ['succeeded', 2],
        ['continued', 1],
        ['exported', 1],
      ]);
      expect(r.north_star).toHaveLength(8);
      expect(r.north_star.at(-1).works).toBe(1);
      expect(r.north_star.slice(0, 7).every((w: { works: number }) => w.works === 0)).toBe(true);
      expect(new Date(`${r.north_star.at(-1).week}T00:00:00Z`).getUTCDay()).toBe(1); // 周一
      expect(r.events).toEqual(expect.arrayContaining([{ name: 'prompt_submit', source: 'server', count: 4 }, { name: 'page_view', source: 'client', count: 1 }]));
      expect(r.templates).toEqual([{ template_id: 't1', title: '小红书封面 3 连图', uses: 1, users: 1 }]);
      expect(r.paywall).toEqual({ shown_users: 1, paid_users: 0, paid_orders: 0, amount_fen: 0 });
    } finally {
      await app.close();
    }
  });
});
