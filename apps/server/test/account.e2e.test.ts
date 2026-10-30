import { DELETION_COOLING_DAYS } from '@creature/shared';
import { StorageCleanupService } from '../src/storage/cleanup.service';
import { StorageService } from '../src/storage/storage.service';
import { AccountService } from '../src/users/account.service';
import { drain, login, makeApp, submit, type TestApp } from './helpers';

const DAY = 86_400_000;

describe('个人信息权利：注销账号与导出', () => {
  let t: TestApp;
  let account: AccountService;
  beforeAll(async () => {
    t = await makeApp({ adminPhones: ['13700000051'] });
    await t.app.listen(0); // 让 supertest 在断言失败时能输出地址，而不是掩盖真实错误
    account = t.app.get(AccountService);
  });
  afterAll(() => t.close());
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  /** 验证码有 60 秒的重发间隔：把之前的验证码挪到 2 分钟前 */
  const ageCodes = () => t.db.query(`UPDATE sms_codes SET created_at = created_at - interval '2 minutes'`);
  async function deletionCode(token: string) {
    await ageCodes();
    return (await t.http().post('/v1/me/deletion/code').set(auth(token)).expect(200)).body.dev_code as string;
  }
  const relogin = async (phone: string) => {
    await ageCodes();
    return login(t, phone);
  };

  it('导出：包含账号、积分、生成记录与作品；每天最多 5 次', async () => {
    const u = await login(t);
    const task = await submit(t, u.token, { modality: 'text', prompt: '秋季新品文案' }).expect(202);
    await drain(t);
    const r = await t.http().get('/v1/me/export').set(auth(u.token)).expect(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="creature-personal-data-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(r.body.account).toMatchObject({ id: u.userId, phone: u.phone, plan: { code: 'free' } });
    expect(r.body.credits.balance.available).toBeGreaterThan(0);
    expect(r.body.credits.ledger.length).toBeGreaterThan(0);
    expect(r.body.generations).toEqual([expect.objectContaining({ id: task.body.id, prompt: '秋季新品文案', status: 'succeeded' })]);
    expect(r.body.assets).toEqual([expect.objectContaining({ kind: 'text', url: expect.stringMatching(/^\/v1\/files\//) })]);
    for (let i = 0; i < 4; i++) await t.http().get('/v1/me/export').set(auth(u.token)).expect(200);
    expect((await t.http().get('/v1/me/export').set(auth(u.token)).expect(429)).body.error.code).toBe('RATE_LIMITED');
  });

  it('申请注销：需要短信验证；生成中的任务需先结束；申请后会话立即失效', async () => {
    const u = await login(t);
    await t.http().delete('/v1/me').set(auth(u.token)).send({ code: '000000' }).expect(400);
    await submit(t, u.token, { modality: 'image', prompt: '海报', params: { count: 1 } }).expect(202);
    const code = await deletionCode(u.token);
    expect((await t.http().delete('/v1/me').set(auth(u.token)).send({ code }).expect(409)).body.error.code).toBe('ACCOUNT_BUSY');
    await drain(t);
    const r = (await t.http().delete('/v1/me').set(auth(u.token)).send({ code: await deletionCode(u.token) }).expect(200)).body;
    expect(r.status).toBe('deleting');
    expect(new Date(r.delete_after).getTime() - new Date(r.requested_at).getTime()).toBe(DELETION_COOLING_DAYS * DAY);
    expect((await t.http().get('/v1/me').set(auth(u.token)).expect(403)).body.error.code).toBe('ACCOUNT_DELETING');
    await t.http().post('/v1/auth/refresh').set('cookie', u.cookie).expect(401); // 会话已吊销
  });

  it('冷静期内重新登录即撤销注销', async () => {
    const u = await login(t);
    await t.http().delete('/v1/me').set(auth(u.token)).send({ code: await deletionCode(u.token) }).expect(200);
    await ageCodes();
    const sent = await t.http().post('/v1/auth/sms/send').send({ phone: u.phone }).expect(200);
    const again = (await t.http().post('/v1/auth/sms/login').send({ phone: u.phone, code: sent.body.dev_code }).expect(200)).body;
    expect(again).toMatchObject({ user_id: u.userId, is_new: false, deletion_canceled: true });
    await t.http().get('/v1/me').set(auth(again.access_token)).expect(200);
    // 冷静期满后的维护任务不会处理已撤销的账号
    await account.finalizeDue(new Date(Date.now() + 16 * DAY));
    expect((await t.db.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [u.userId]))[0].status).toBe('active');
    const [audit] = await t.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE target_id = $1 AND action = 'user.deletion_canceled'`, [u.userId]);
    expect(audit.n).toBe(1);
  });

  it('冷静期满：匿名化账号，删除作品与文件、撤回发布、删除点赞；流水与生成记录保留；手机号可重新注册', async () => {
    const u = await login(t);
    const fan = await login(t);
    const task = await submit(t, u.token, { modality: 'image', prompt: '秋日海报', params: { count: 1 } }).expect(202);
    await drain(t);
    const assetId = (await t.http().get(`/v1/generations/${task.body.id}`).set(auth(u.token))).body.outputs[0].asset_id;
    const post = (await t.http().post('/v1/posts').set(auth(u.token)).send({ asset_id: assetId, title: '秋日' }).expect(201)).body;
    // fan 的作品被 u 点赞
    const fanTask = await submit(t, fan.token, { modality: 'image', prompt: '咖啡馆', params: { count: 1 } }).expect(202);
    await drain(t);
    const fanAsset = (await t.http().get(`/v1/generations/${fanTask.body.id}`).set(auth(fan.token))).body.outputs[0].asset_id;
    const fanPost = (await t.http().post('/v1/posts').set(auth(fan.token)).send({ asset_id: fanAsset, title: '咖啡馆' }).expect(201)).body;
    await t.http().put(`/v1/posts/${fanPost.id}/like`).set(auth(u.token)).expect(200);
    await t.http().post('/v1/projects').set(auth(u.token)).send({ name: '秋季上新' }).expect(201);
    const [keys] = await t.db.query<{ storage_key: string; raw_storage_key: string }>('SELECT storage_key, raw_storage_key FROM assets WHERE id = $1', [assetId]);

    await t.http().delete('/v1/me').set(auth(u.token)).send({ code: await deletionCode(u.token) }).expect(200);
    const status = async () => (await t.db.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [u.userId]))[0].status;
    await account.finalizeDue(new Date(Date.now() + 14 * DAY));
    expect(await status()).toBe('deleting');
    expect(await account.finalizeDue(new Date(Date.now() + 16 * DAY))).toBeGreaterThanOrEqual(1);

    const [row] = await t.db.query<{ status: string; nickname: string; phone_enc: string; phone_hash: string }>('SELECT status, nickname, phone_enc, phone_hash FROM users WHERE id = $1', [u.userId]);
    expect(row).toMatchObject({ status: 'deleted', nickname: '已注销用户', phone_enc: '', phone_hash: `deleted:${u.userId}` });
    const [a] = await t.db.query<{ deleted_at: Date | null; prompt: string; content_id: string }>('SELECT deleted_at, prompt, content_id FROM assets WHERE id = $1', [assetId]);
    expect(a.deleted_at).not.toBeNull();
    expect(a.prompt).toBe('');
    expect(a.content_id).toBeTruthy(); // 内容编号保留，可追溯
    expect((await t.http().get(`/v1/posts/${post.id}`).set(auth(fan.token)).expect(404)).body.error.code).toBe('NOT_FOUND');
    expect((await t.http().get(`/v1/posts/${fanPost.id}`).set(auth(fan.token)).expect(200)).body.like_count).toBe(0);
    const [p] = await t.db.query<{ name: string; deleted_at: Date | null }>('SELECT name, deleted_at FROM projects WHERE user_id = $1', [u.userId]);
    expect(p).toMatchObject({ name: '' });
    expect(p.deleted_at).not.toBeNull();
    // 生成记录与积分流水保留（合规留存与财务记录），用户行为事件不再关联到个人
    expect((await t.db.query('SELECT id FROM generation_tasks WHERE user_id = $1', [u.userId])).length).toBe(1);
    expect((await t.db.query(`SELECT l.id FROM credit_ledger l JOIN credit_accounts c ON c.id = l.account_id WHERE c.owner_id = $1`, [u.userId])).length).toBeGreaterThan(0);
    expect((await t.db.query('SELECT id FROM analytics_events WHERE user_id = $1', [u.userId])).length).toBe(0);

    // 文件由存储清理立即删除（不等宽限期）
    const storage = t.app.get(StorageService);
    expect((await t.app.get(StorageCleanupService).run()).assets).toBeGreaterThanOrEqual(1);
    expect(await storage.tryRead(keys.storage_key)).toBeNull();
    expect(await storage.tryRead(keys.raw_storage_key)).toBeNull();

    // 同一手机号可以注册新账号
    const fresh = await relogin(u.phone);
    expect(fresh.userId).not.toBe(u.userId);
    expect(await status()).toBe('deleted');
    // 已注销的账号在后台不能被恢复
    const admin = await relogin('13700000051');
    expect((await t.http().post(`/v1/admin/users/${u.userId}/status`).set(auth(admin.token)).send({ status: 'active', reason: '误操作' }).expect(400)).body.error.message).toContain('注销');
  });
});
