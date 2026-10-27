import { decodeWav } from '../src/safety/wav';
import { drain, idemKey, login, makeApp, reconcileUser, submit, type TestApp } from './helpers';

const IMAGE = { modality: 'image', prompt: '秋日咖啡馆海报，标题文字“秋天的第一杯”', params: { ratio: '3:4', resolution: '2k', count: 2 } };

describe('API 集成测试', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const balance = async (token: string) => (await t.http().get('/v1/credits/balance').set(auth(token)).expect(200)).body;

  describe('账号与登录', () => {
    it('健康检查', async () => {
      const r = await t.http().get('/v1/healthz').expect(200);
      expect(r.body).toMatchObject({ ok: true, providers: 'mock' });
    });

    it('手机号格式校验与统一错误结构', async () => {
      const r = await t.http().post('/v1/auth/sms/send').send({ phone: '12345' }).expect(400);
      expect(r.body.error).toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(r.body.error.request_id).toBeTruthy();
      expect(r.headers['x-request-id']).toBe(r.body.error.request_id);
    });

    it('60 秒内重复获取验证码被限流', async () => {
      await t.http().post('/v1/auth/sms/send').send({ phone: '13700000001' }).expect(200);
      const r = await t.http().post('/v1/auth/sms/send').send({ phone: '13700000001' }).expect(429);
      expect(r.body.error.code).toBe('RATE_LIMITED');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('验证码错误 5 次后失效', async () => {
      const phone = '13700000002';
      const sent = await t.http().post('/v1/auth/sms/send').send({ phone }).expect(200);
      const wrong = sent.body.dev_code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) await t.http().post('/v1/auth/sms/login').send({ phone, code: wrong }).expect(400);
      const r = await t.http().post('/v1/auth/sms/login').send({ phone, code: sent.body.dev_code }).expect(400);
      expect(r.body.error.message).toContain('失效');
    });

    it('首次登录自动注册：新手 100 + 每日 20 积分，手机号脱敏', async () => {
      const u = await login(t, '13700000003');
      const me = await t.http().get('/v1/me').set(auth(u.token)).expect(200);
      expect(me.body).toMatchObject({ phone_masked: '137****0003', plan: { code: 'free' }, credits: { available: 120, frozen: 0 } });
      // 同一天再次访问不重复赠送
      const again = await t.http().get('/v1/me').set(auth(u.token)).expect(200);
      expect(again.body.credits.available).toBe(120);
      // 手机号加密存储
      const [row] = await t.db.query<{ phone_enc: string }>('SELECT phone_enc FROM users WHERE id = $1', [u.userId]);
      expect(row.phone_enc).not.toContain('13700000003');
    });

    it('刷新令牌轮换；旧令牌被重复使用时整个令牌族失效', async () => {
      const u = await login(t);
      const r1 = await t.http().post('/v1/auth/refresh').set('cookie', u.cookie).expect(200);
      const newCookie = ([] as string[]).concat(r1.headers['set-cookie']).find((c) => c.startsWith('crt_rt='))!.split(';')[0];
      expect(newCookie).not.toBe(u.cookie);
      // 重放旧令牌：拒绝，并吊销新令牌
      await t.http().post('/v1/auth/refresh').set('cookie', u.cookie).expect(401);
      await t.http().post('/v1/auth/refresh').set('cookie', newCookie).expect(401);
    });

    it('退出登录后刷新令牌失效；无令牌访问受保护接口返回 401', async () => {
      const u = await login(t);
      await t.http().post('/v1/auth/logout').set('cookie', u.cookie).expect(204);
      await t.http().post('/v1/auth/refresh').set('cookie', u.cookie).expect(401);
      await t.http().get('/v1/me').expect(401);
      await t.http().get('/v1/me').set('authorization', 'Bearer not-a-jwt').expect(401);
    });
  });

  describe('生成任务', () => {
    it('完整链路：冻结 → 生成 → 标识 → 结算，作品可通过签名地址访问', async () => {
      const u = await login(t);
      const res = await submit(t, u.token, IMAGE).expect(202);
      expect(res.body).toMatchObject({ status: 'queued', model: { code: 'seedream-4' }, estimated_credits: 12, queue: { name: 'p2', position: 1 } });
      expect(await balance(u.token)).toMatchObject({ available: 108, frozen: 12 });

      expect(await drain(t)).toBeGreaterThanOrEqual(1);
      const task = (await t.http().get(`/v1/generations/${res.body.id}`).set(auth(u.token)).expect(200)).body;
      expect(task).toMatchObject({ status: 'succeeded', progress: 100, actual_credits: 12 });
      expect(task.outputs).toHaveLength(2);
      expect(await balance(u.token)).toMatchObject({ available: 108, frozen: 0 });

      const file = await t.http().get(task.outputs[0].url).expect(200);
      expect(file.headers['content-type']).toContain('image/svg+xml');
      expect(file.headers['content-security-policy']).toContain('sandbox');
      const svg = file.body.toString();
      expect(svg).toContain(task.outputs[0].content_id);
      expect(svg).toContain('AI 生成');

      // 篡改签名、越权访问
      await t.http().get(task.outputs[0].url.replace(/sig=[^&]+/, 'sig=forged')).expect(404);
      const other = await login(t);
      await t.http().get(`/v1/generations/${res.body.id}`).set(auth(other.token)).expect(404);
      await t.http().get(`/v1/assets/${task.outputs[0].asset_id}`).set(auth(other.token)).expect(404);

      const assets = (await t.http().get('/v1/assets?kind=image').set(auth(u.token)).expect(200)).body;
      expect(assets.data).toHaveLength(2);
      expect((await reconcileUser(t, u.userId)).ok).toBe(true);
    });

    it('幂等：相同键重放返回同一任务，不同内容返回 409，缺少键返回 400', async () => {
      const u = await login(t);
      const key = idemKey();
      const a = await submit(t, u.token, IMAGE, key).expect(202);
      const b = await submit(t, u.token, IMAGE, key).expect(200);
      expect(b.body.id).toBe(a.body.id);
      await submit(t, u.token, { ...IMAGE, prompt: '另一个提示词' }, key).expect(409);
      await t.http().post('/v1/generations').set(auth(u.token)).send(IMAGE).expect(400);
      expect((await balance(u.token)).frozen).toBe(12);
    });

    it('积分不足返回 402，并说明差额', async () => {
      const u = await login(t);
      const r = await submit(t, u.token, { modality: 'video', prompt: '多镜头广告片', params: { duration: 15, resolution: '1080p' } }).expect(402);
      expect(r.body.error).toMatchObject({ code: 'INSUFFICIENT_CREDITS', details: { available: 120 } });
      expect(await balance(u.token)).toMatchObject({ available: 120, frozen: 0 });
    });

    it('提示词审核不通过返回 422，不冻结积分并留下审核记录', async () => {
      const u = await login(t);
      const r = await submit(t, u.token, { modality: 'image', prompt: '违规内容' }).expect(422);
      expect(r.body.error.code).toBe('CONTENT_REJECTED');
      expect((await balance(u.token)).frozen).toBe(0);
      const rec = await t.db.query(`SELECT * FROM moderation_records WHERE user_id = $1 AND verdict = 'block'`, [u.userId]);
      expect(rec).toHaveLength(1);
    });

    it('所有模型失败：任务失败并全额返还', async () => {
      const u = await login(t);
      const res = await submit(t, u.token, { modality: 'image', prompt: '失败演示：海边灯塔', params: { resolution: '2k' } }).expect(202);
      await drain(t);
      const task = (await t.http().get(`/v1/generations/${res.body.id}`).set(auth(u.token))).body;
      expect(task).toMatchObject({ status: 'failed', error: { code: 'ALL_MODELS_FAILED' } });
      expect(await balance(u.token)).toMatchObject({ available: 120, frozen: 0 });
      expect((await reconcileUser(t, u.userId)).ok).toBe(true);
    });

    it('主模型超时：自动切换备选模型完成，按较低价格结算', async () => {
      const u = await login(t);
      const res = await submit(t, u.token, { modality: 'image', prompt: '超时演示：产品白底图', params: { resolution: '2k', count: 1 } }).expect(202);
      await drain(t);
      const task = (await t.http().get(`/v1/generations/${res.body.id}`).set(auth(u.token))).body;
      expect(task.status).toBe('succeeded');
      expect(task.model.code).not.toBe('seedream-4');
      expect(task.routing_reason).toContain('自动切换');
      expect(task.actual_credits).toBeLessThanOrEqual(task.estimated_credits);
      expect((await reconcileUser(t, u.userId)).ok).toBe(true);
    });

    it('输出审核拦截：任务被拦截并返还积分', async () => {
      const u = await login(t);
      const res = await submit(t, u.token, { modality: 'image', prompt: '敏感画面测试' }).expect(202);
      await drain(t);
      const task = (await t.http().get(`/v1/generations/${res.body.id}`).set(auth(u.token))).body;
      expect(task).toMatchObject({ status: 'blocked', error: { code: 'CONTENT_BLOCKED' }, outputs: [] });
      expect((await balance(u.token)).available).toBe(120);
    });

    it('取消排队中的任务全额返还；已完成的任务不能取消', async () => {
      const u = await login(t);
      const a = await submit(t, u.token, IMAGE).expect(202);
      const c = await t.http().post(`/v1/generations/${a.body.id}/cancel`).set(auth(u.token)).expect(200);
      expect(c.body.status).toBe('canceled');
      expect(await balance(u.token)).toMatchObject({ available: 120, frozen: 0 });
      const b = await submit(t, u.token, IMAGE).expect(202);
      await drain(t);
      const r = await t.http().post(`/v1/generations/${b.body.id}/cancel`).set(auth(u.token)).expect(409);
      expect(r.body.error.code).toBe('TASK_NOT_CANCELABLE');
    });

    it('写作：分镜表与选中改写；音频：WAV 带提示音与隐式标识', async () => {
      const u = await login(t);
      const s = await submit(t, u.token, { modality: 'text', prompt: '雨夜重逢', params: { template: 'storyboard', chars: 800 } }).expect(202);
      const e = await submit(t, u.token, { modality: 'text', operation: 'edit', prompt: '真的推荐', params: { transform: '改写' } }).expect(202);
      const a = await submit(t, u.token, { modality: 'audio', prompt: '这个秋天，把山野的温度装进一杯拿铁里。', params: { chars: 20, voice: '晚晴', seconds: 4 } }).expect(202);
      await drain(t);
      const get = async (id: string) => (await t.http().get(`/v1/generations/${id}`).set(auth(u.token))).body;
      expect((await get(s.body.id)).outputs[0].text).toContain('| 远景 |');
      expect((await get(e.body.id)).outputs[0].text).toContain('确实强烈安利');
      const audio = await get(a.body.id);
      const file = await t.http().get(audio.outputs[0].url).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      const wav = decodeWav(file.body as Buffer);
      expect(JSON.parse(wav.info.ICMT).AIGC.ProduceID).toBe(audio.outputs[0].content_id);
      expect(audio.outputs[0].duration_sec).toBeGreaterThan(4);
    });

    it('参数校验：未知字段、超出范围的数量被拒绝；视频时长被限制在模型上限', async () => {
      const u = await login(t);
      await submit(t, u.token, { modality: 'image', prompt: 'x', params: { count: 99 } }).expect(400);
      await submit(t, u.token, { modality: 'image', prompt: 'x', params: { hack: 1 } }).expect(400);
      const v = await submit(t, u.token, { modality: 'video', prompt: '动漫风格的电车', params: { duration: 15 } }).expect(202);
      expect(v.body).toMatchObject({ model: { code: 'vidu-q3' }, params: { duration: 10 } });
    });

    it('并发提交不会超额冻结', async () => {
      const u = await login(t);
      // 每个任务 24 积分，余额 120 最多容纳 5 个
      const body = { modality: 'image', prompt: '并发测试海报，标题文字', params: { resolution: '2k', count: 4 } };
      const results = await Promise.all(Array.from({ length: 8 }, () => submit(t, u.token, body)));
      const ok = results.filter((r) => r.status === 202).length;
      expect(ok).toBe(5);
      expect(results.filter((r) => r.status === 402)).toHaveLength(3);
      expect(await balance(u.token)).toMatchObject({ available: 0, frozen: 120 });
      expect((await reconcileUser(t, u.userId)).ok).toBe(true);
    });

    it('卡死任务：先重新排队，超过重试次数后失败并返还', async () => {
      const u = await login(t);
      const res = await submit(t, u.token, IMAGE).expect(202);
      await t.db.query(`UPDATE generation_tasks SET status = 'running', attempt = 1, started_at = now() - interval '1 hour' WHERE id = $1`, [res.body.id]);
      await t.worker.recoverStale();
      expect((await t.db.query<{ status: string }>('SELECT status FROM generation_tasks WHERE id = $1', [res.body.id]))[0].status).toBe('queued');
      await t.db.query(`UPDATE generation_tasks SET status = 'running', attempt = 3, started_at = now() - interval '1 hour' WHERE id = $1`, [res.body.id]);
      await t.worker.recoverStale();
      const task = (await t.http().get(`/v1/generations/${res.body.id}`).set(auth(u.token))).body;
      expect(task).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
      expect(await balance(u.token)).toMatchObject({ available: 120, frozen: 0 });
    });

    it('推送事件：任务状态与积分变化按用户分发；事件流需要登录', async () => {
      const u = await login(t);
      const bus = t.app.get((await import('../src/events/event-bus')).EventBus);
      const events: string[] = [];
      const sub = bus.stream(u.userId).subscribe((e) => events.push(e.type));
      await submit(t, u.token, IMAGE).expect(202);
      await drain(t);
      sub.unsubscribe();
      expect(events).toEqual(expect.arrayContaining(['task.progress', 'credits.changed', 'task.succeeded']));
      await t.http().get('/v1/events').expect(401);
    });
  });

  describe('订单与会员', () => {
    it('积分包：模拟支付到账，重复支付幂等', async () => {
      const u = await login(t);
      const o = await t.http().post('/v1/orders').set(auth(u.token)).send({ item_type: 'credit_pack', item_ref: '500' }).expect(201);
      expect(o.body).toMatchObject({ amount_fen: 4500, credits: 500, status: 'pending' });
      await t.http().post(`/v1/orders/${o.body.id}/mock-pay`).set(auth(u.token)).expect(200);
      await t.http().post(`/v1/orders/${o.body.id}/mock-pay`).set(auth(u.token)).expect(200);
      expect((await balance(u.token)).available).toBe(620);
      expect((await reconcileUser(t, u.userId)).ok).toBe(true);
    });

    it('专业版年付：立即发放首月积分、提升队列优先级，次月自动发放', async () => {
      const u = await login(t);
      const o = await t.http().post('/v1/orders').set(auth(u.token)).send({ item_type: 'subscription', item_ref: 'pro', cycle: 'year' }).expect(201);
      expect(o.body.amount_fen).toBe(94800);
      await t.http().post(`/v1/orders/${o.body.id}/mock-pay`).set(auth(u.token)).expect(200);
      const me = (await t.http().get('/v1/me').set(auth(u.token))).body;
      expect(me.plan.code).toBe('pro');
      expect(me.credits.available).toBe(1920);
      const task = await submit(t, u.token, IMAGE).expect(202);
      expect(task.body.queue.name).toBe('p0');

      const nextMonth = new Date(Date.now() + 32 * 86400_000);
      const billing = t.app.get((await import('../src/billing/billing.service')).BillingService);
      expect((await billing.runDue(nextMonth)).granted).toBeGreaterThanOrEqual(1);
      expect((await billing.runDue(nextMonth)).granted).toBe(0);
    });

    it('非法商品与他人订单', async () => {
      const u = await login(t);
      await t.http().post('/v1/orders').set(auth(u.token)).send({ item_type: 'subscription', item_ref: 'free', cycle: 'month' }).expect(400);
      const o = await t.http().post('/v1/orders').set(auth(u.token)).send({ item_type: 'credit_pack', item_ref: '100' }).expect(201);
      const other = await login(t);
      await t.http().post(`/v1/orders/${o.body.id}/mock-pay`).set(auth(other.token)).expect(404);
    });
  });
});
