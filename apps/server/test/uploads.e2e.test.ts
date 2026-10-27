import { imageInfo } from '../src/assets/image-info';
import { drain, login, makeApp, reconcileUser, submit, type TestApp } from './helpers';
import { jpeg, png, webp } from './images';

describe('图片识别', () => {
  it('从文件头读出格式与尺寸，拒绝伪造与超大尺寸', () => {
    expect(imageInfo(png(640, 480))).toEqual({ mime: 'image/png', width: 640, height: 480 });
    expect(imageInfo(jpeg(512, 256))).toEqual({ mime: 'image/jpeg', width: 512, height: 256 });
    expect(imageInfo(webp(300, 200))).toEqual({ mime: 'image/webp', width: 300, height: 200 });
    expect(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageInfo(png(0, 10))).toBeNull();
    expect(imageInfo(png(20000, 10))).toBeNull();
  });
});

describe('素材上传与参考图', () => {
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

  async function upload(token: string, data: Buffer, mime = 'image/png', filename = 'product.png') {
    const ticket = (await t.http().post('/v1/assets/uploads').set(auth(token)).send({ filename, mime, size: data.length }).expect(201)).body;
    await t.http().put(ticket.upload_url).set('content-type', mime).send(data).expect(204);
    return { ticket, complete: () => t.http().post(`/v1/assets/uploads/${ticket.upload_id}/complete`).set(auth(token)) };
  }

  it('完整流程：创建 → 签名上传 → 完成；上传素材不加 AI 标识', async () => {
    const u = await login(t);
    const data = png(800, 600);
    const { complete } = await upload(u.token, data);
    const asset = (await complete().expect(200)).body;
    expect(asset).toMatchObject({ kind: 'image', source: 'uploaded', mime: 'image/png', width: 800, height: 600, title: 'product' });
    expect(asset.content_id).toMatch(/^UPL-/);
    const file = await binary(t.http().get(asset.url)).expect(200);
    expect(Buffer.compare(file.body as Buffer, data)).toBe(0);
    // 重复完成返回同一资产
    expect((await complete().expect(200)).body.id).toBe(asset.id);
    const list = (await t.http().get('/v1/assets').set(auth(u.token))).body.data;
    expect(list.map((a: { id: string }) => a.id)).toContain(asset.id);
  });

  it('签名错误、过期、重复上传与内容不符都被拒绝', async () => {
    const u = await login(t);
    const data = png(10, 10);
    const ticket = (await t.http().post('/v1/assets/uploads').set(auth(u.token)).send({ filename: 'a.png', mime: 'image/png', size: data.length }).expect(201)).body;
    await t.http().put(ticket.upload_url.replace(/sig=[^&]+/, 'sig=forged')).send(data).expect(403);
    await t.http().put(ticket.upload_url.replace(/exp=\d+/, 'exp=1000')).send(data).expect(403);
    // 声明 PNG 却上传 JPEG
    const bad = await t.http().put(ticket.upload_url).set('content-type', 'image/png').send(jpeg(10, 10)).expect(400);
    expect(bad.body.error.message).toContain('格式不符');
    // 超过声明大小
    await t.http().put(ticket.upload_url).set('content-type', 'image/png').send(Buffer.concat([data, Buffer.alloc(10)])).expect(413);
    await t.http().put(ticket.upload_url).set('content-type', 'image/png').send(data).expect(204);
    await t.http().put(ticket.upload_url).set('content-type', 'image/png').send(data).expect(409);
  });

  it('创建会话时校验类型与大小；未上传不能完成；他人的上传不可见', async () => {
    const u = await login(t);
    await t.http().post('/v1/assets/uploads').set(auth(u.token)).send({ filename: 'a.gif', mime: 'image/gif', size: 10 }).expect(400);
    await t.http().post('/v1/assets/uploads').set(auth(u.token)).send({ filename: 'a.png', mime: 'image/png', size: 21 * 1024 * 1024 }).expect(400);
    const ticket = (await t.http().post('/v1/assets/uploads').set(auth(u.token)).send({ filename: 'a.png', mime: 'image/png', size: 64 }).expect(201)).body;
    const r = await t.http().post(`/v1/assets/uploads/${ticket.upload_id}/complete`).set(auth(u.token)).expect(409);
    expect(r.body.error.code).toBe('UPLOAD_INCOMPLETE');
    const other = await login(t);
    await t.http().post(`/v1/assets/uploads/${ticket.upload_id}/complete`).set(auth(other.token)).expect(404);
  });

  it('上传审核不通过：拒绝并留下审核记录，不生成资产', async () => {
    const u = await login(t);
    const { complete } = await upload(u.token, webp(100, 100), 'image/webp', '违规图片.webp');
    expect((await complete().expect(422)).body.error.code).toBe('CONTENT_REJECTED');
    await complete().expect(422);
    expect((await t.http().get('/v1/assets').set(auth(u.token))).body.data).toHaveLength(0);
    const rec = await t.db.query(`SELECT * FROM moderation_records WHERE user_id = $1 AND target_type = 'upload' AND verdict = 'block'`, [u.userId]);
    expect(rec).toHaveLength(1);
  });

  it('图生图：主体参考图被放进生成画面，任务记录参考信息，计价不变', async () => {
    const u = await login(t);
    const asset = (await (await upload(u.token, png(400, 400))).complete().expect(200)).body;
    const res = await submit(t, u.token, {
      modality: 'image',
      prompt: '把这款产品放在秋日咖啡馆的木桌上',
      params: { ratio: '1:1', resolution: '2k', count: 1 },
      references: [{ asset_id: asset.id, role: 'subject' }],
    }).expect(202);
    expect(res.body.references).toEqual([{ asset_id: asset.id, role: 'subject' }]);
    expect(res.body.estimated_credits).toBe(6);
    await drain(t);
    const task = (await t.http().get(`/v1/generations/${res.body.id}`).set(auth(u.token))).body;
    expect(task.status).toBe('succeeded');
    const svg = (await binary(t.http().get(task.outputs[0].url)).expect(200)).body.toString();
    expect(svg).toContain('<image href="data:image/png;base64,');
    expect(svg).toContain('aigc-label');
    expect((await reconcileUser(t, u.userId)).ok).toBe(true);
  });

  it('图生视频：生成的图像作为首帧驱动画面', async () => {
    const u = await login(t);
    const img = await submit(t, u.token, { modality: 'image', prompt: '樱花隧道里的电车，动漫风格', params: { count: 1 } }).expect(202);
    await drain(t);
    const frame = (await t.http().get(`/v1/generations/${img.body.id}`).set(auth(u.token))).body.outputs[0];
    const v = await submit(t, u.token, { modality: 'video', prompt: '电车缓缓驶出隧道', params: { duration: 5 }, references: [{ asset_id: frame.asset_id, role: 'first_frame' }] }).expect(202);
    await drain(t);
    const video = (await t.http().get(`/v1/generations/${v.body.id}`).set(auth(u.token))).body;
    expect(video.status).toBe('succeeded');
    const svg = (await binary(t.http().get(video.outputs[0].url)).expect(200)).body.toString();
    expect(svg).toContain('data:image/svg+xml;base64,');
    expect(svg).toContain('animateTransform');
  });

  it('非法参考图：用途与类型不匹配、重复首帧、他人素材、非图像资产', async () => {
    const u = await login(t);
    const mine = (await (await upload(u.token, png(64, 64))).complete().expect(200)).body;
    await submit(t, u.token, { modality: 'image', prompt: '测试', references: [{ asset_id: mine.id, role: 'first_frame' }] }).expect(400);
    await submit(t, u.token, {
      modality: 'video',
      prompt: '测试',
      references: [
        { asset_id: mine.id, role: 'first_frame' },
        { asset_id: mine.id, role: 'first_frame' },
      ],
    }).expect(400);
    const other = await login(t);
    await submit(t, other.token, { modality: 'image', prompt: '测试', references: [{ asset_id: mine.id, role: 'style' }] }).expect(400);
    const text = await submit(t, u.token, { modality: 'text', prompt: '一段文案' }).expect(202);
    await drain(t);
    const textAsset = (await t.http().get(`/v1/generations/${text.body.id}`).set(auth(u.token))).body.outputs[0].asset_id;
    await submit(t, u.token, { modality: 'image', prompt: '测试', references: [{ asset_id: textAsset, role: 'style' }] }).expect(400);
    // 校验失败不冻结积分
    expect((await t.http().get('/v1/credits/balance').set(auth(u.token))).body.frozen).toBe(0);
  });
});
