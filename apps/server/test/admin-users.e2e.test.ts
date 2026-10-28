import { login, makeApp, reconcileUser, submit, type TestApp } from './helpers';

const ADMIN = '13700000011';
const ADMIN2 = '13700000012';

describe('后台用户管理', () => {
  let t: TestApp;
  let admin: Awaited<ReturnType<typeof login>>;
  beforeAll(async () => {
    t = await makeApp({ adminPhones: [ADMIN, ADMIN2] });
    admin = await login(t, ADMIN);
  });
  // 同一手机号 60 秒内只能获取一次验证码：需要重复登录时把已发送记录往前挪
  const allowResend = () => t.db.query(`UPDATE sms_codes SET created_at = created_at - interval '2 minutes'`);
  afterAll(() => t.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  let rid = 0;
  const requestId = () => `adj-${Date.now()}-${rid++}`;

  it('只有管理员可以访问；按手机号、后 4 位、昵称、ID 与状态查询', async () => {
    const u = await login(t, '13912345678');
    await t.http().patch('/v1/me').set(auth(u.token)).send({ nickname: '秋日咖啡店主' }).expect(200);
    await t.http().get('/v1/admin/users').set(auth(u.token)).expect(403);
    const find = async (q: string) => (await t.http().get(`/v1/admin/users?q=${encodeURIComponent(q)}`).set(auth(admin.token)).expect(200)).body.data.map((x: { id: string }) => x.id);
    expect(await find('13912345678')).toEqual([u.userId]);
    expect(await find('5678')).toContain(u.userId);
    expect(await find('咖啡店主')).toEqual([u.userId]);
    expect(await find(u.userId)).toEqual([u.userId]);
    const row = (await t.http().get(`/v1/admin/users?q=13912345678`).set(auth(admin.token))).body.data[0];
    expect(row).toMatchObject({ nickname: '秋日咖啡店主', phone_masked: '139****5678', status: 'active', role: 'user', plan: { code: 'free' }, credits: { available: 120, frozen: 0 } });
    expect((await t.http().get('/v1/admin/users?status=banned').set(auth(admin.token))).body.data).toEqual([]);
  });

  it('人工调整积分：增加、扣减、幂等、余额不足拒绝；写流水与审计日志，对账一致', async () => {
    const u = await login(t);
    const adjust = (delta: number, reason = '生成异常补偿', id = requestId()) => t.http().post(`/v1/admin/users/${u.userId}/credits`).set(auth(admin.token)).send({ delta, reason, request_id: id });

    const id1 = requestId();
    expect((await adjust(50, '生成异常补偿', id1).expect(200)).body.credits.available).toBe(170);
    expect((await adjust(50, '生成异常补偿', id1).expect(200)).body.credits.available).toBe(170);
    expect((await adjust(-30, '误发扣回').expect(200)).body.credits.available).toBe(140);
    expect((await adjust(-1000).expect(400)).body.error.message).toContain('不足以扣减');
    await adjust(0).expect(400);
    await adjust(100001).expect(400);
    await t.http().post(`/v1/admin/users/${u.userId}/credits`).set(auth(admin.token)).send({ delta: 5, reason: '', request_id: requestId() }).expect(400);

    const detail = (await t.http().get(`/v1/admin/users/${u.userId}`).set(auth(admin.token)).expect(200)).body;
    expect(detail.ledger.filter((e: { entry_type: string }) => e.entry_type === 'adjust').map((e: { delta_available: number; memo: string }) => [e.delta_available, e.memo])).toEqual([
      [-30, '人工调整 · 误发扣回'],
      [50, '人工调整 · 生成异常补偿'],
    ]);
    expect(detail.audit.map((a: { action: string; actor_nickname: string }) => a.action)).toEqual(['user.credits_adjust', 'user.credits_adjust']);
    expect(detail.audit[0].actor_nickname).toMatch(/^创作者/);
    // 用户自己的明细里也能看到
    expect((await t.http().get('/v1/credits/balance').set(auth(u.token))).body.available).toBe(140);
    expect((await reconcileUser(t, u.userId)).ok).toBe(true);
  });

  it('冻结：立即吊销会话与访问令牌，不能登录；解除后恢复；不能修改自己和其他管理员', async () => {
    const u = await login(t);
    await submit(t, u.token, { modality: 'text', prompt: '一段文案' }).expect(202);
    const setStatus = (status: string, who = u.userId, token = admin.token) => t.http().post(`/v1/admin/users/${who}/status`).set(auth(token)).send({ status, reason: '批量注册刷积分' });

    expect((await setStatus('frozen').expect(200)).body).toMatchObject({ status: 'frozen', stats: { tasks_succeeded: 0 } });
    expect((await t.http().get('/v1/me').set(auth(u.token)).expect(403)).body.error.code).toBe('ACCOUNT_SUSPENDED');
    await t.http().post('/v1/auth/refresh').set('cookie', u.cookie).send({}).expect((r) => expect([401, 403]).toContain(r.status));
    await allowResend();
    const sent = await t.http().post('/v1/auth/sms/send').send({ phone: u.phone }).expect(200);
    expect((await t.http().post('/v1/auth/sms/login').send({ phone: u.phone, code: sent.body.dev_code }).expect(403)).body.error.code).toBe('ACCOUNT_SUSPENDED');

    await setStatus('active').expect(200);
    await allowResend();
    const again = await login(t, u.phone);
    await t.http().get('/v1/me').set(auth(again.token)).expect(200);

    await setStatus('banned', admin.userId).expect(400);
    const admin2 = await login(t, ADMIN2);
    expect((await setStatus('frozen', admin2.userId).expect(400)).body.error.message).toContain('管理员');
    await setStatus('frozen', u.userId, u.token).expect(403);

    const detail = (await t.http().get(`/v1/admin/users/${u.userId}`).set(auth(admin.token))).body;
    expect(detail.audit.map((a: { action: string }) => a.action)).toEqual(['user.restore', 'user.freeze']);
    expect(detail.audit[1].detail).toMatchObject({ from: 'active', to: 'frozen', reason: '批量注册刷积分' });
    expect(detail.recent_tasks).toHaveLength(1);
  });
});
