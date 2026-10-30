import { TEMPLATE_CATALOG } from '@creature/shared';
import { drain, idemKey, login, makeApp, submit, type TestApp } from './helpers';
import { png } from './images';

describe('官方模板', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const generate = (token: string, id: string, body: Record<string, unknown>, key = idemKey()) =>
    t.http().post(`/v1/templates/${id}/generate`).set(auth(token)).set('idempotency-key', key).send(body);

  async function upload(token: string) {
    const data = png(80, 80);
    const ticket = (await t.http().post('/v1/assets/uploads').set(auth(token)).send({ filename: 'p.png', mime: 'image/png', size: data.length }).expect(201)).body;
    await t.http().put(ticket.upload_url).set('content-type', 'image/png').send(data).expect(204);
    return (await t.http().post(`/v1/assets/uploads/${ticket.upload_id}/complete`).set(auth(token)).expect(200)).body.id as string;
  }

  it('目录：20 个单步 + 6 个工作流模板，按分类与类型筛选；附带统计与预估积分', async () => {
    const u = await login(t);
    const all = (await t.http().get('/v1/templates').set(auth(u.token)).expect(200)).body.data;
    expect(all).toHaveLength(TEMPLATE_CATALOG.length);
    expect(all.filter((x: { kind: string }) => x.kind === 'single')).toHaveLength(20);
    const shop = (await t.http().get('/v1/templates?category=电商&kind=single').set(auth(u.token)).expect(200)).body.data;
    expect(shop.length).toBeGreaterThan(0);
    expect(shop.every((x: { category: string; kind: string }) => x.category === '电商' && x.kind === 'single')).toBe(true);
    const note = all.find((x: { id: string }) => x.id === 'xhs-note');
    expect(note).toMatchObject({ uses: 0, rating: { avg: null, count: 0 }, my_rating: null, used_by_me: false, estimated_credits: 1 });
    await t.http().get('/v1/templates/nope').set(auth(u.token)).expect(404);
  });

  it('单步模板：校验输入，渲染提示词后走普通生成链路；重放不重复计数；任务记录模板', async () => {
    const u = await login(t);
    expect((await generate(u.token, 'xhs-note', { values: {} }).expect(400)).body.error.message).toBe('请填写商品');
    expect((await generate(u.token, 'xhs-note', { values: { product: '长'.repeat(41) } }).expect(400)).body.error.message).toContain('最多 40 个字');
    // 审核：渲染后的提示词与普通提交一样过审
    expect((await generate(u.token, 'xhs-note', { values: { product: '违规商品' } }).expect(422)).body.error.code).toBe('CONTENT_REJECTED');

    const key = idemKey();
    const r = await generate(u.token, 'xhs-note', { values: { product: '山野枫糖拿铁' } }, key).expect(202);
    expect(r.body).toMatchObject({ source: 'template', prompt: '为「山野枫糖拿铁」写一篇小红书种草笔记，突出：真枫糖、燕麦奶、秋季限定', params: { template: 'xhs', tone: '亲切' } });
    expect((await generate(u.token, 'xhs-note', { values: { product: '山野枫糖拿铁' } }, key).expect(200)).body.id).toBe(r.body.id);
    const [row] = await t.db.query<{ template_id: string }>('SELECT template_id FROM generation_tasks WHERE id = $1', [r.body.id]);
    expect(row.template_id).toBe('xhs-note');
    expect((await t.http().get('/v1/templates/xhs-note').set(auth(u.token)).expect(200)).body).toMatchObject({ uses: 1, used_by_me: true });
    await drain(t);
    expect((await t.http().get(`/v1/generations/${r.body.id}`).set(auth(u.token))).body.status).toBe('succeeded');
    // 普通生成接口不能自称来自模板：请求体中的 template_id 被忽略
    const plain = await submit(t, u.token, { modality: 'text', prompt: '文案', template_id: 'xhs-note' }).expect(202);
    const [p] = await t.db.query<{ template_id: string | null }>('SELECT template_id FROM generation_tasks WHERE id = $1', [plain.body.id]);
    expect(p.template_id).toBeNull();
  });

  it('图片输入作为参考图提交；配音按文字长度计费；工作流只记录使用', async () => {
    const u = await login(t);
    const other = await login(t);
    expect((await generate(u.token, 'scene-swap', { values: {} }).expect(400)).body.error.message).toBe('请上传商品图');
    const theirs = await upload(other.token);
    expect((await generate(u.token, 'scene-swap', { images: { photo: theirs } }).expect(400)).body.error.message).toContain('参考图不存在');
    const mine = await upload(u.token);
    const img = (await generate(u.token, 'scene-swap', { images: { photo: mine } }).expect(202)).body;
    expect(img.references).toEqual([{ asset_id: mine, role: 'subject' }]);
    expect(img.params).toMatchObject({ ratio: '1:1', count: 4 });

    const script = '秋天的第一杯，山野枫糖拿铁，限时 8 折，到店说暗号再减五元。';
    const tts = (await generate(u.token, 'ad-voiceover', { values: { script } }).expect(202)).body;
    expect(tts.model.code).toBe('creature-tts');
    expect(tts.params.chars).toBe(script.length);

    expect((await generate(u.token, 't1', { values: {} }).expect(400)).body.error.message).toContain('画布');
    expect((await t.http().post('/v1/templates/xhs-note/use').set(auth(u.token)).expect(400)).body.error.message).toContain('单步模板');
    expect((await t.http().post('/v1/templates/t1/use').set(auth(u.token)).expect(200)).body).toMatchObject({ uses: 1, used_by_me: true });
  });

  it('评分：用过才能评；重复评分覆盖；平均分按所有用户计算', async () => {
    const a = await login(t);
    const b = await login(t);
    expect((await t.http().put('/v1/templates/t3/rating').set(auth(a.token)).send({ score: 5 }).expect(403)).body.error.message).toContain('使用过');
    await t.http().put('/v1/templates/t3/rating').set(auth(a.token)).send({ score: 6 }).expect(400);
    for (const u of [a, b]) await t.http().post('/v1/templates/t3/use').set(auth(u.token)).expect(200);
    await t.http().put('/v1/templates/t3/rating').set(auth(a.token)).send({ score: 5 }).expect(200);
    await t.http().put('/v1/templates/t3/rating').set(auth(a.token)).send({ score: 3 }).expect(200);
    const r = (await t.http().put('/v1/templates/t3/rating').set(auth(b.token)).send({ score: 4 }).expect(200)).body;
    expect(r).toMatchObject({ rating: { avg: 3.5, count: 2 }, my_rating: 4, uses: 2 });
    expect((await t.http().get('/v1/templates/t3').set(auth(a.token))).body.my_rating).toBe(3);
  });
});
