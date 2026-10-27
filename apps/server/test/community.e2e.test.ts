import { drain, login, makeApp, submit, type TestApp } from './helpers';
import { png } from './images';

const ADMIN_PHONE = '13700000001';

describe('作品库、灵感广场与管理后台', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ adminPhones: [ADMIN_PHONE] });
  });
  afterAll(() => t.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  /** 生成一张图像，返回资产 ID */
  async function image(token: string, prompt = '秋日咖啡馆海报，暖色逆光') {
    const task = await submit(t, token, { modality: 'image', prompt, params: { ratio: '3:4', count: 1 } }).expect(202);
    await drain(t);
    return (await t.http().get(`/v1/generations/${task.body.id}`).set(auth(token))).body.outputs[0].asset_id as string;
  }

  async function uploaded(token: string) {
    const data = png(32, 32);
    const ticket = (await t.http().post('/v1/assets/uploads').set(auth(token)).send({ filename: 'shop.png', mime: 'image/png', size: data.length }).expect(201)).body;
    await t.http().put(ticket.upload_url).set('content-type', 'image/png').send(data).expect(204);
    return (await t.http().post(`/v1/assets/uploads/${ticket.upload_id}/complete`).set(auth(token)).expect(200)).body.id as string;
  }

  const publish = (token: string, body: Record<string, unknown>) => t.http().post('/v1/posts').set(auth(token)).send(body);
  const feed = (token: string, q = 'tab=latest') => t.http().get(`/v1/feed?${q}`).set(auth(token)).expect(200).then((r) => r.body);

  it('文件夹：创建、重名、批量移动、按文件夹筛选、删除后作品保留', async () => {
    const u = await login(t);
    const a1 = await image(u.token);
    const a2 = await image(u.token, '雪山湖泊');
    const f = (await t.http().post('/v1/asset-folders').set(auth(u.token)).send({ name: '秋季上新' }).expect(201)).body;
    expect((await t.http().post('/v1/asset-folders').set(auth(u.token)).send({ name: '秋季上新' }).expect(409)).body.error.code).toBe('FOLDER_EXISTS');

    expect((await t.http().post('/v1/assets/move').set(auth(u.token)).send({ ids: [a1, a2, 'ast_ghost'], folder_id: f.id }).expect(200)).body.moved).toBe(2);
    expect((await t.http().get('/v1/asset-folders').set(auth(u.token))).body.data).toEqual([expect.objectContaining({ id: f.id, name: '秋季上新', asset_count: 2 })]);
    const inFolder = (await t.http().get(`/v1/assets?folder=${f.id}`).set(auth(u.token))).body.data;
    expect(inFolder.map((a: { id: string }) => a.id).sort()).toEqual([a1, a2].sort());
    expect(inFolder[0].folder_id).toBe(f.id);

    await t.http().post('/v1/assets/move').set(auth(u.token)).send({ ids: [a2], folder_id: null }).expect(200);
    expect((await t.http().get('/v1/assets?folder=none').set(auth(u.token))).body.data.map((a: { id: string }) => a.id)).toEqual([a2]);

    // 他人的文件夹不可用
    const other = await login(t);
    await t.http().post('/v1/assets/move').set(auth(other.token)).send({ ids: [a1], folder_id: f.id }).expect(404);
    await t.http().patch(`/v1/asset-folders/${f.id}`).set(auth(other.token)).send({ name: 'x' }).expect(404);

    await t.http().patch(`/v1/asset-folders/${f.id}`).set(auth(u.token)).send({ name: '秋季物料' }).expect(204);
    await t.http().delete(`/v1/asset-folders/${f.id}`).set(auth(u.token)).expect(204);
    const all = (await t.http().get('/v1/assets').set(auth(u.token))).body.data;
    expect(all).toHaveLength(2);
    expect(all.every((a: { folder_id: string | null }) => a.folder_id === null)).toBe(true);
    expect((await t.http().get('/v1/asset-folders').set(auth(u.token))).body.data).toEqual([]);
  });

  it('下载：附件地址带文件名，文件名参与签名，下载的是带标识的交付文件', async () => {
    const u = await login(t);
    const id = await image(u.token);
    await t.http().patch(`/v1/assets/${id}`).set(auth(u.token)).send({ title: '秋季/主视觉' }).expect(200);
    const d = (await t.http().get(`/v1/assets/${id}/download`).set(auth(u.token)).expect(200)).body;
    expect(d.filename).toBe('秋季 主视觉.svg');
    const res = await t.http().get(d.url).expect(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="__ ___.svg"; filename*=UTF-8''${encodeURIComponent('秋季 主视觉.svg')}`);
    expect(String(res.body ?? res.text)).toContain('aigc-label');
    // 篡改文件名后签名失效
    await t.http().get(d.url.replace(/dl=[^&]+/, `dl=${Buffer.from('evil.html').toString('base64url')}`)).expect(404);
    const other = await login(t);
    await t.http().get(`/v1/assets/${id}/download`).set(auth(other.token)).expect(404);
  });

  it('发布：只能发布自己的 AI 生成图像 / 视频；重复发布返回同一条；审核拦截与人工复核', async () => {
    const u = await login(t);
    const img = await image(u.token);
    const post = (await publish(u.token, { asset_id: img, title: '秋天的第一杯', tags: ['咖啡', '海报', '咖啡'] }).expect(201)).body;
    expect(post).toMatchObject({ status: 'published', kind: 'image', title: '秋天的第一杯', tags: ['咖啡', '海报'], mine: true, like_count: 0, model: 'Seedream 4.0' });
    expect(post.url).toMatch(/^\/v1\/files\//);
    expect((await publish(u.token, { asset_id: img, title: '再发一次' }).expect(201)).body.id).toBe(post.id);

    await publish(u.token, { asset_id: await uploaded(u.token), title: '门店照片' }).expect(400);
    const text = await submit(t, u.token, { modality: 'text', prompt: '一段文案' }).expect(202);
    await drain(t);
    const textAsset = (await t.http().get(`/v1/generations/${text.body.id}`).set(auth(u.token))).body.outputs[0].asset_id;
    await publish(u.token, { asset_id: textAsset, title: '文案' }).expect(400);
    const other = await login(t);
    await publish(other.token, { asset_id: img, title: '偷发' }).expect(404);

    const img2 = await image(u.token, '雪山湖泊');
    expect((await publish(u.token, { asset_id: img2, title: '违规内容' }).expect(422)).body.error.code).toBe('CONTENT_REJECTED');
    const reviewing = (await publish(u.token, { asset_id: img2, title: '明星同款湖景' }).expect(201)).body;
    expect(reviewing.status).toBe('reviewing');
    // 审核中的作品只有作者能看到
    expect((await feed(other.token)).data.map((p: { id: string }) => p.id)).not.toContain(reviewing.id);
    await t.http().get(`/v1/posts/${reviewing.id}`).set(auth(other.token)).expect(404);
    expect((await feed(u.token, 'tab=mine')).data.map((p: { id: string }) => p.id)).toEqual([reviewing.id, post.id]);
  });

  it('广场：点赞幂等、隐藏提示词、做同款按人计数、排序与分页', async () => {
    const author = await login(t);
    const p1 = (await publish(author.token, { asset_id: await image(author.token, '樱花隧道里的电车'), title: '电车', show_prompt: false }).expect(201)).body;
    const p2 = (await publish(author.token, { asset_id: await image(author.token, '水墨山间小屋'), title: '小屋' }).expect(201)).body;
    const fan = await login(t);

    const seen = (await feed(fan.token)).data.find((p: { id: string }) => p.id === p1.id);
    expect(seen).toMatchObject({ prompt: null, liked: false, mine: false });
    expect((await t.http().put(`/v1/posts/${p1.id}/like`).set(auth(fan.token)).expect(200)).body).toEqual({ liked: true, like_count: 1 });
    expect((await t.http().put(`/v1/posts/${p1.id}/like`).set(auth(fan.token)).expect(200)).body.like_count).toBe(1);
    expect((await t.http().get(`/v1/posts/${p1.id}`).set(auth(fan.token))).body.liked).toBe(true);

    const hot = (await feed(fan.token, 'tab=hot&limit=30')).data.map((p: { id: string }) => p.id);
    expect(hot.indexOf(p1.id)).toBeLessThan(hot.indexOf(p2.id));

    const remix = (await t.http().post(`/v1/posts/${p1.id}/remix`).set(auth(fan.token)).expect(200)).body;
    // 做同款沿用原作实际使用的模型
    const [{ code }] = await t.db.query<{ code: string }>('SELECT COALESCE(t.used_model_code, t.model_code) AS code FROM posts p JOIN assets a ON a.id = p.asset_id JOIN generation_tasks t ON t.id = a.task_id WHERE p.id = $1', [p1.id]);
    expect(remix).toMatchObject({ modality: 'image', prompt: '', model_code: code, params: expect.objectContaining({ ratio: '3:4' }) });
    await t.http().post(`/v1/posts/${p1.id}/remix`).set(auth(fan.token)).expect(200);
    await t.http().post(`/v1/posts/${p1.id}/remix`).set(auth(author.token)).expect(200);
    expect((await t.http().post(`/v1/posts/${p2.id}/remix`).set(auth(fan.token)).expect(200)).body.prompt).toBe('水墨山间小屋');
    expect((await t.http().get(`/v1/posts/${p1.id}`).set(auth(fan.token))).body.remix_count).toBe(1);

    expect((await t.http().delete(`/v1/posts/${p1.id}/like`).set(auth(fan.token)).expect(200)).body).toEqual({ liked: false, like_count: 0 });

    const page1 = await feed(fan.token, 'tab=latest&limit=1');
    expect(page1.data).toHaveLength(1);
    const page2 = await feed(fan.token, `tab=latest&limit=1&cursor=${page1.next_cursor}`);
    expect(page2.data[0].id).not.toBe(page1.data[0].id);
    expect((await feed(fan.token, 'tab=recommend&kind=video')).data).toEqual([]);
  });

  it('举报：不能举报自己；重复举报只算一次；累计 3 人举报自动隐藏；撤回与删除作品后不可见', async () => {
    const author = await login(t);
    const asset = await image(author.token);
    const post = (await publish(author.token, { asset_id: asset, title: '被举报的作品' }).expect(201)).body;
    await t.http().post('/v1/reports').set(auth(author.token)).send({ target_type: 'post', target_id: post.id, reason: 'ad' }).expect(400);

    const reporters = await Promise.all([login(t), login(t), login(t)]);
    const r1 = (await t.http().post('/v1/reports').set(auth(reporters[0].token)).send({ target_type: 'post', target_id: post.id, reason: 'infringement', detail: '盗用了我的照片' }).expect(201)).body;
    expect((await t.http().post('/v1/reports').set(auth(reporters[0].token)).send({ target_type: 'post', target_id: post.id, reason: 'ad' }).expect(201)).body.id).toBe(r1.id);
    await t.http().post('/v1/reports').set(auth(reporters[1].token)).send({ target_type: 'post', target_id: post.id, reason: 'infringement' }).expect(201);
    expect((await t.http().get(`/v1/posts/${post.id}`).set(auth(reporters[2].token)).expect(200)).body.status).toBe('published');
    await t.http().post('/v1/reports').set(auth(reporters[2].token)).send({ target_type: 'post', target_id: post.id, reason: 'porn' }).expect(201);
    await t.http().get(`/v1/posts/${post.id}`).set(auth(reporters[2].token)).expect(404);
    expect((await t.http().get(`/v1/posts/${post.id}`).set(auth(author.token))).body.status).toBe('hidden');
    // 已隐藏的作品不再接受举报
    const late = await login(t);
    await t.http().post('/v1/reports').set(auth(late.token)).send({ target_type: 'post', target_id: post.id, reason: 'ad' }).expect(404);

    // 撤回与删除作品
    const p2 = (await publish(author.token, { asset_id: await image(author.token, '雪山'), title: '雪山' }).expect(201)).body;
    await t.http().delete(`/v1/posts/${p2.id}`).set(auth(reporters[0].token)).expect(404);
    await t.http().delete(`/v1/posts/${p2.id}`).set(auth(author.token)).expect(204);
    await t.http().get(`/v1/posts/${p2.id}`).set(auth(author.token)).expect(404);
    const p3 = (await publish(author.token, { asset_id: await image(author.token, '湖泊'), title: '湖泊' }).expect(201)).body;
    const [{ asset_id }] = await t.db.query<{ asset_id: string }>('SELECT asset_id FROM posts WHERE id = $1', [p3.id]);
    await t.http().delete(`/v1/assets/${asset_id}`).set(auth(author.token)).expect(204);
    await t.http().get(`/v1/posts/${p3.id}`).set(auth(author.token)).expect(404);
  });

  it('管理后台：非管理员 403；概览、模型健康度；复核通过与下架都留审核记录和审计日志', async () => {
    const user = await login(t);
    await t.http().get('/v1/admin/overview').set(auth(user.token)).expect(403);
    expect((await t.http().get('/v1/me').set(auth(user.token))).body.role).toBe('user');

    const admin = await login(t, ADMIN_PHONE);
    expect((await t.http().get('/v1/me').set(auth(admin.token))).body.role).toBe('admin');

    // 一条待复核（命中复核词）、一条被举报
    const reviewing = (await publish(user.token, { asset_id: await image(user.token), title: '代言人同款海报' }).expect(201)).body;
    const reported = (await publish(user.token, { asset_id: await image(user.token, '樱花'), title: '樱花' }).expect(201)).body;
    const reporter = await login(t);
    await t.http().post('/v1/reports').set(auth(reporter.token)).send({ target_type: 'post', target_id: reported.id, reason: 'violence' }).expect(201);

    const ov = (await t.http().get('/v1/admin/overview').set(auth(admin.token)).expect(200)).body;
    expect(ov.users_total).toBeGreaterThan(0);
    expect(ov.tasks_today).toBeGreaterThan(0);
    expect(ov.pending_reviews).toBeGreaterThanOrEqual(2);
    expect(ov.trend).toHaveLength(14);
    expect(ov.trend[13].tasks).toBe(ov.tasks_today);

    const models = (await t.http().get('/v1/admin/models').set(auth(admin.token)).expect(200)).body.data;
    const seedream = models.find((m: { code: string }) => m.code === 'seedream-4');
    expect(seedream).toMatchObject({ enabled: true, breaker_open: false });
    expect(seedream.tasks_24h).toBeGreaterThan(0);
    expect(seedream.success_rate_24h).toBe(1);

    const queue = (await t.http().get('/v1/admin/review-queue').set(auth(admin.token)).expect(200)).body.data;
    const qr = queue.find((x: { post: { id: string } }) => x.post.id === reviewing.id);
    const qp = queue.find((x: { post: { id: string } }) => x.post.id === reported.id);
    expect(qr).toMatchObject({ reason: 'reviewing', machine_labels: ['review:代言'] });
    expect(qp).toMatchObject({ reason: 'reported', reports: [{ reason: 'violence', count: 1 }] });

    expect((await t.http().post(`/v1/admin/posts/${reviewing.id}/decision`).set(auth(admin.token)).send({ action: 'approve' }).expect(200)).body.status).toBe('published');
    expect((await t.http().get(`/v1/posts/${reviewing.id}`).set(auth(reporter.token)).expect(200)).body.published_at).toBeTruthy();
    expect((await t.http().post(`/v1/admin/posts/${reported.id}/decision`).set(auth(admin.token)).send({ action: 'remove', note: '暴力画面' }).expect(200)).body.status).toBe('hidden');
    await t.http().get(`/v1/posts/${reported.id}`).set(auth(reporter.token)).expect(404);
    await t.http().post(`/v1/admin/posts/${reported.id}/decision`).set(auth(user.token)).send({ action: 'approve' }).expect(403);

    const left = (await t.http().get('/v1/admin/review-queue').set(auth(admin.token))).body.data.map((x: { post: { id: string } }) => x.post.id);
    expect(left).not.toContain(reviewing.id);
    expect(left).not.toContain(reported.id);
    const [rep] = await t.db.query<{ status: string; handled_by: string }>('SELECT status, handled_by FROM reports WHERE target_id = $1', [reported.id]);
    expect(rep).toEqual({ status: 'resolved', handled_by: admin.userId });
    const human = await t.db.query<{ verdict: string }>(`SELECT verdict FROM moderation_records WHERE target_type = 'post' AND stage = 'human' AND reviewer_id = $1 ORDER BY created_at`, [admin.userId]);
    expect(human.map((h) => h.verdict)).toEqual(['pass', 'block']);
    const audit = await t.db.query<{ action: string }>('SELECT action FROM audit_logs WHERE actor_id = $1 ORDER BY created_at', [admin.userId]);
    expect(audit.map((a) => a.action)).toEqual(['post.approve', 'post.remove']);
  });
});
