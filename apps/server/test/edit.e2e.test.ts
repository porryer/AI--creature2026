import { drain, login, makeApp, reconcileUser, submit, type TestApp } from './helpers';
import { jpeg, png } from './images';

describe('图像编辑：局部重绘、扩图、消除、抠图、超分', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const binary = (r: import('supertest').Test) =>
    r.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  const MASK = `data:image/png;base64,${png(96, 128).toString('base64')}`;

  /** 生成一张 3:4 的图像，返回资产 */
  async function image(token: string) {
    const task = await submit(t, token, { modality: 'image', prompt: '秋日咖啡馆海报', params: { ratio: '3:4', resolution: '1k', count: 1 } }).expect(202);
    await drain(t);
    const out = (await t.http().get(`/v1/generations/${task.body.id}`).set(auth(token))).body.outputs[0];
    return { id: out.asset_id as string, width: out.width as number, height: out.height as number };
  }

  async function uploaded(token: string, w = 64, h = 64) {
    const data = png(w, h);
    const ticket = (await t.http().post('/v1/assets/uploads').set(auth(token)).send({ filename: 'shop.png', mime: 'image/png', size: data.length }).expect(201)).body;
    await t.http().put(ticket.upload_url).set('content-type', 'image/png').send(data).expect(204);
    return (await t.http().post(`/v1/assets/uploads/${ticket.upload_id}/complete`).set(auth(token)).expect(200)).body.id as string;
  }

  const edit = (token: string, sourceId: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    submit(t, token, { modality: 'image', operation: 'edit', params, references: [{ asset_id: sourceId, role: 'source' }], ...extra });

  async function result(token: string, taskId: string) {
    await drain(t);
    const task = (await t.http().get(`/v1/generations/${taskId}`).set(auth(token))).body;
    expect(task.status).toBe('succeeded');
    const svg = (await binary(t.http().get(task.outputs[0].url)).expect(200)).body.toString();
    return { task, out: task.outputs[0], svg };
  }

  it('超分 4×：按次计 4 积分，尺寸放大 4 倍，结果带 AI 标识', async () => {
    const u = await login(t);
    const src = await image(u.token);
    const res = await edit(u.token, src.id, { tool: 'upscale', scale: 4 }).expect(202);
    expect(res.body).toMatchObject({ operation: 'edit', estimated_credits: 4, model: { code: 'creature-edit' }, references: [{ asset_id: src.id, role: 'source' }], params: { tool: 'upscale', scale: 4, count: 1 } });
    expect(res.body.prompt).toBe(`超分 4× · 秋日咖啡馆海报`);
    const { out, svg, task } = await result(u.token, res.body.id);
    expect([out.width, out.height]).toEqual([src.width * 4, src.height * 4]);
    expect(svg).toContain('<image href="data:image/svg+xml;base64,');
    expect(svg).toContain('aigc-label');
    expect(task.actual_credits).toBe(4);
    const ledger = (await t.http().get('/v1/credits/ledger').set(auth(u.token))).body.data;
    expect(ledger.some((e: { memo: string }) => e.memo.includes('图像编辑 · 超分 4×'))).toBe(true);
    expect((await reconcileUser(t, u.userId)).ok).toBe(true);
  });

  it('局部重绘：需要描述与 PNG 涂抹区域；涂抹区域私有保存并参与生成', async () => {
    const u = await login(t);
    const src = await image(u.token);
    expect((await edit(u.token, src.id, { tool: 'inpaint' }, { mask: MASK }).expect(400)).body.error.message).toContain('描述');
    expect((await edit(u.token, src.id, { tool: 'inpaint' }, { prompt: '换成蓝色杯子' }).expect(400)).body.error.message).toContain('涂抹');
    await edit(u.token, src.id, { tool: 'inpaint' }, { prompt: '换成蓝色杯子', mask: `data:image/png;base64,${jpeg(10, 10).toString('base64')}` }).expect(400);
    await edit(u.token, src.id, { tool: 'inpaint' }, { prompt: '换成蓝色杯子', mask: 'data:image/png;base64,???' }).expect(400);

    const res = await edit(u.token, src.id, { tool: 'inpaint' }, { prompt: '换成蓝色杯子', mask: MASK }).expect(202);
    expect(res.body).toMatchObject({ estimated_credits: 2, prompt: '换成蓝色杯子' });
    const [row] = await t.db.query<{ mask_key: string }>('SELECT mask_key FROM generation_tasks WHERE id = $1', [res.body.id]);
    expect(row.mask_key).toMatch(/^private\//);
    const { svg, out } = await result(u.token, res.body.id);
    expect([out.width, out.height]).toEqual([src.width, src.height]);
    expect(svg).toContain('<mask id="edit-mask"');
    expect(svg).toContain('data:image/png;base64,');
  });

  it('扩图：需要不同于原图的比例，结果按目标比例延展；消除与抠图', async () => {
    const u = await login(t);
    const src = await image(u.token);
    await edit(u.token, src.id, { tool: 'outpaint' }).expect(400);
    expect((await edit(u.token, src.id, { tool: 'outpaint', ratio: '3:4' }).expect(400)).body.error.message).toContain('相同');
    const wide = await edit(u.token, src.id, { tool: 'outpaint', ratio: '16:9' }).expect(202);
    const { out } = await result(u.token, wide.body.id);
    expect(out.height).toBe(src.height);
    expect(Math.round((out.width / out.height) * 9)).toBe(16);

    const erase = await edit(u.token, src.id, { tool: 'erase' }, { mask: MASK }).expect(202);
    expect((await result(u.token, erase.body.id)).svg).toContain('edit-fill');
    expect((await edit(u.token, src.id, { tool: 'cutout' }, { mask: MASK }).expect(400)).body.error.message).toContain('不需要涂抹');
    const cut = await edit(u.token, src.id, { tool: 'cutout' }).expect(202);
    expect((await result(u.token, cut.body.id)).svg).toContain('edit-feather');
  });

  it('上传的素材也可以编辑，编辑结果按生成内容添加 AI 标识；超分边长上限', async () => {
    const u = await login(t);
    const id = await uploaded(u.token);
    const res = await edit(u.token, id, { tool: 'upscale' }).expect(202);
    const { svg, out } = await result(u.token, res.body.id);
    expect([out.width, out.height]).toEqual([128, 128]);
    expect(svg).toContain('data:image/png;base64,');
    expect(svg).toContain('aigc-label');
    const big = await uploaded(u.token, 4096, 4096);
    await edit(u.token, big, { tool: 'upscale', scale: 4 }).expect(400);
    await edit(u.token, big, { tool: 'upscale', scale: 2 }).expect(202);
  });

  it('非法请求：缺少源图、多张参考、他人或非图像源图、生成任务带编辑参数、指定其他模型', async () => {
    const u = await login(t);
    const src = await image(u.token);
    await submit(t, u.token, { modality: 'image', operation: 'edit', params: { tool: 'cutout' } }).expect(400);
    await submit(t, u.token, { modality: 'image', operation: 'edit', params: {}, references: [{ asset_id: src.id, role: 'source' }] }).expect(400);
    await submit(t, u.token, {
      modality: 'image',
      operation: 'edit',
      params: { tool: 'cutout' },
      references: [
        { asset_id: src.id, role: 'source' },
        { asset_id: src.id, role: 'style' },
      ],
    }).expect(400);
    const other = await login(t);
    await edit(other.token, src.id, { tool: 'cutout' }).expect(400);
    const text = await submit(t, u.token, { modality: 'text', prompt: '一段文案' }).expect(202);
    await drain(t);
    const textAsset = (await t.http().get(`/v1/generations/${text.body.id}`).set(auth(u.token))).body.outputs[0].asset_id;
    await edit(u.token, textAsset, { tool: 'cutout' }).expect(400);

    // 普通生成不能带编辑参数，也不能指定编辑模型或使用源图用途
    await submit(t, u.token, { modality: 'image', prompt: '海报', params: { tool: 'cutout' } }).expect(400);
    await submit(t, u.token, { modality: 'image', prompt: '海报', routing: { strategy: 'auto', pinned_model: 'creature-edit' } }).expect(400);
    await submit(t, u.token, { modality: 'image', prompt: '海报', references: [{ asset_id: src.id, role: 'source' }] }).expect(400);
    await submit(t, u.token, { modality: 'image', prompt: '' }).expect(400);
    await edit(u.token, src.id, { tool: 'cutout' }, { routing: { strategy: 'auto', pinned_model: 'seedream-4' } }).expect(400);
    // 文本改写仍按原方式工作
    await submit(t, u.token, { modality: 'text', operation: 'edit', prompt: '把这段话写得更口语化', params: { transform: '改写' } }).expect(202);
    expect((await t.http().get('/v1/credits/balance').set(auth(u.token))).body.frozen).toBe(1);
  });

  it('编辑失败全额返还', async () => {
    const u = await login(t);
    const src = await image(u.token);
    const before = (await t.http().get('/v1/credits/balance').set(auth(u.token))).body.available;
    const res = await edit(u.token, src.id, { tool: 'inpaint' }, { prompt: '失败演示', mask: MASK }).expect(202);
    await drain(t);
    expect((await t.http().get(`/v1/generations/${res.body.id}`).set(auth(u.token))).body.status).toBe('failed');
    expect((await t.http().get('/v1/credits/balance').set(auth(u.token))).body.available).toBe(before);
    expect((await reconcileUser(t, u.userId)).ok).toBe(true);
  });
});
