import { drain, login, makeApp, submit, type TestApp } from './helpers';

const ADMIN = '13700000021';

describe('上线准备：安全响应头、指标、限流、对账', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ adminPhones: [ADMIN], generationRatePerMin: 4, maxInflightTasks: 3 });
  });
  afterAll(() => t.close());
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it('接口响应带安全头；文件接口保留沙箱策略', async () => {
    const r = await t.http().get('/v1/models').expect(200);
    expect(r.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    expect(r.headers['strict-transport-security']).toBeUndefined();
    const u = await login(t);
    const task = await submit(t, u.token, { modality: 'image', prompt: '海报', params: { count: 1 } }).expect(202);
    await drain(t);
    const url = (await t.http().get(`/v1/generations/${task.body.id}`).set(auth(u.token))).body.outputs[0].url;
    expect((await t.http().get(url).expect(200)).headers['content-security-policy']).toContain('sandbox');
  });

  it('按用户限流：每分钟提交次数与进行中任务数；幂等重放不计入', async () => {
    const u = await login(t);
    const first = await submit(t, u.token, { modality: 'text', prompt: '文案一' }, 'idem-rate-0001').expect(202);
    // 重放同一个幂等键不计入限额
    await submit(t, u.token, { modality: 'text', prompt: '文案一' }, 'idem-rate-0001').expect(200);
    await submit(t, u.token, { modality: 'text', prompt: '文案二' }).expect(202);
    await submit(t, u.token, { modality: 'text', prompt: '文案三' }).expect(202);
    // 已有 3 个进行中（Worker 在测试中不自动运行）；被拒绝的提交不计入每分钟次数
    const inflight = await submit(t, u.token, { modality: 'text', prompt: '文案四' }).expect(429);
    expect(inflight.body.error.message).toContain('进行中的任务');
    await drain(t);
    await submit(t, u.token, { modality: 'text', prompt: '文案五' }).expect(202);
    // 1 分钟内已创建 4 个任务，再提交超出每分钟 4 次
    const r = await submit(t, u.token, { modality: 'text', prompt: '文案六' }).expect(429);
    expect(r.body.error.message).toContain('提交太频繁');
    expect(r.body.error.code).toBe('RATE_LIMITED');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    // 其他用户不受影响
    const other = await login(t);
    await submit(t, other.token, { modality: 'text', prompt: '别人的文案' }).expect(202);
    expect(first.body.id).toBeTruthy();
  });

  it('指标：请求按路由模板聚合，任务结束计数与队列', async () => {
    const u = await login(t);
    await submit(t, u.token, { modality: 'image', prompt: '指标测试', params: { count: 1 } }).expect(202);
    const before = (await t.http().get('/v1/metrics').expect(200)).text;
    expect(before).toMatch(/creature_tasks_in_flight\{status="queued"\} [1-9]/);
    await drain(t);
    const text = (await t.http().get('/v1/metrics').expect(200).expect('content-type', /text\/plain/)).text;
    expect(text).toMatch(/creature_http_requests_total\{method="POST",route="\/v1\/generations",status="202"\} \d+/);
    expect(text).toContain('creature_http_requests_total{method="GET",route="/v1/generations/:id"');
    expect(text).not.toMatch(/route="\/v1\/generations\/tsk_/);
    expect(text).toMatch(/creature_tasks_finished_total\{modality="image",status="succeeded"\} \d+/);
    expect(text).toMatch(/creature_task_duration_seconds_count\{modality="image"\} \d+/);
    expect(text).toMatch(/creature_model_calls_total\{model="[a-z0-9.-]+",result="ok"\} \d+/);
    expect(text).toContain('creature_tasks_in_flight{status="queued"} 0');
    expect(text).toMatch(/process_resident_memory_bytes \d+/);
  });

  it('指标令牌：设置后需要 Bearer；staging / 生产未设置令牌时不开放', async () => {
    const withToken = await makeApp({ metricsToken: 'metrics-secret-token' });
    await withToken.http().get('/v1/metrics').expect(401);
    await withToken.http().get('/v1/metrics').set('authorization', 'Bearer wrong-token-xxxxxxx').expect(401);
    await withToken.http().get('/v1/metrics').set('authorization', 'Bearer metrics-secret-token').expect(200);
    await withToken.close();
    const staging = await makeApp({ env: 'staging', metricsToken: undefined });
    await staging.http().get('/v1/metrics').expect(404);
    await staging.close();
  });

  it('对账：全部一致；人为制造差异与残留冻结后能被发现，并在指标中体现；按间隔定时执行', async () => {
    const admin = await login(t, ADMIN);
    const user = await login(t);
    await t.http().get('/v1/admin/reconcile').set(auth(user.token)).expect(403);

    const ok = (await t.http().post('/v1/admin/reconcile/run').set(auth(admin.token)).expect(200)).body;
    expect(ok).toMatchObject({ trigger: 'manual', mismatches: 0, stale_holds: 0 });
    expect(ok.accounts).toBeGreaterThan(1);

    // 制造两类异常：账户余额被直接改动；已结束任务的冻结明细未清理
    const [acc] = await t.db.query<{ id: string }>(`SELECT id FROM credit_accounts WHERE owner_id = $1`, [user.userId]);
    await t.db.query('UPDATE credit_accounts SET available = available + 5 WHERE id = $1', [acc.id]);
    const task = await submit(t, user.token, { modality: 'text', prompt: '一段文案' }).expect(202);
    await drain(t);
    const [grant] = await t.db.query<{ id: string }>('SELECT id FROM credit_grants WHERE account_id = $1 LIMIT 1', [acc.id]);
    await t.db.query('INSERT INTO credit_holds (task_id, grant_id, amount) VALUES ($1, $2, 1)', [task.body.id, grant.id]);

    const bad = (await t.http().post('/v1/admin/reconcile/run').set(auth(admin.token)).expect(200)).body;
    expect(bad).toMatchObject({ mismatches: 1, stale_holds: 1 });
    expect(bad.details.accounts[0]).toMatchObject({ account_id: acc.id, owner_id: user.userId });
    expect(bad.details.accounts[0].available - bad.details.accounts[0].ledger_available).toBe(5);
    expect(bad.details.holds[0]).toMatchObject({ task_id: task.body.id, status: 'succeeded', amount: 1 });
    expect((await t.http().get('/v1/metrics')).text).toContain('creature_reconcile_mismatches 1');

    const runs = (await t.http().get('/v1/admin/reconcile').set(auth(admin.token)).expect(200)).body.data;
    expect(runs.map((r: { mismatches: number }) => r.mismatches)).toEqual([1, 0]);
    const audit = await t.db.query<{ action: string }>(`SELECT action FROM audit_logs WHERE actor_id = $1`, [admin.userId]);
    expect(audit.filter((a) => a.action === 'credits.reconcile')).toHaveLength(2);

    // 定时对账：从未定时执行过则立即执行，间隔内不重复
    const { ReconcileService } = await import('../src/credits/reconcile.service');
    const svc = t.app.get(ReconcileService);
    expect(await svc.runIfDue(24)).toMatchObject({ trigger: 'schedule' });
    expect(await svc.runIfDue(24)).toBeNull();
  });
});
