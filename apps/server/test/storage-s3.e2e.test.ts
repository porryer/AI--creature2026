import { randomBytes } from 'node:crypto';
import { StorageCleanupService } from '../src/storage/cleanup.service';
import { S3Client } from '../src/storage/s3';
import { StorageService } from '../src/storage/storage.service';
import { drain, login, makeApp, submit, type TestApp } from './helpers';
import { jpeg, png } from './images';

// 需要 S3 兼容存储（CI 中为 MinIO）：TEST_S3_ENDPOINT=http://127.0.0.1:9000 TEST_S3_ACCESS_KEY=… TEST_S3_SECRET_KEY=…
const endpoint = process.env.TEST_S3_ENDPOINT;
const s3 = endpoint ? describe : describe.skip;

s3('对象存储驱动（S3 兼容）', () => {
  let t: TestApp;
  let storage: StorageService;
  const bucket = `creature-test-${randomBytes(4).toString('hex')}`;
  beforeAll(async () => {
    t = await makeApp({
      storageDriver: 's3',
      s3: {
        endpoint: endpoint!,
        publicEndpoint: endpoint!,
        region: 'us-east-1',
        bucket,
        accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? 'creature-test',
        secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? 'creature-test-secret',
        forcePathStyle: true,
      },
    });
    storage = t.app.get(StorageService);
  });
  afterAll(() => t?.close());
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  /** /v1/files 地址：校验签名后跳转到存储桶的预签名地址，跟随跳转读取 */
  async function follow(url: string) {
    const r = await t.http().get(url).expect(302);
    expect(r.headers.location.startsWith(`${endpoint}/${bucket}/public/`)).toBe(true);
    const res = await fetch(r.headers.location);
    return { res, body: Buffer.from(await res.arrayBuffer()), location: new URL(r.headers.location) };
  }

  async function ticket(token: string, data: Buffer, mime = 'image/png') {
    return (await t.http().post('/v1/assets/uploads').set(auth(token)).send({ filename: '门店照片.png', mime, size: data.length }).expect(201)).body;
  }
  const put = (url: string, data: Buffer, mime = 'image/png') => fetch(url, { method: 'PUT', headers: { 'content-type': mime }, body: data });

  it('启动时创建存储桶；健康检查显示驱动；多个实例同时创建同一个存储桶都能启动', async () => {
    expect((await t.http().get('/v1/healthz').expect(200)).body.storage).toBe('s3');
    const fresh = { ...t.config.s3!, bucket: `creature-race-${randomBytes(4).toString('hex')}` };
    const results = await Promise.all([1, 2, 3].map(() => new S3Client(fresh).ensureBucket(true)));
    expect(results.filter((r) => r === 'created').length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r === 'created' || r === 'ok')).toBe(true);
  });

  it('上传：直传到存储桶，完成时校验后生成资产；文件地址跳转到预签名地址', async () => {
    const u = await login(t);
    const data = png(64, 48);
    const tk = await ticket(u.token, data);
    expect(tk.upload_url.startsWith(`${endpoint}/${bucket}/private/${u.userId}/`)).toBe(true);
    expect(tk.upload_url).toContain('X-Amz-Signature=');
    expect(tk.headers).toEqual({ 'content-type': 'image/png' });

    // 未上传就完成；本服务的上传接口在对象存储模式下不可用
    expect((await t.http().post(`/v1/assets/uploads/${tk.upload_id}/complete`).set(auth(u.token)).expect(409)).body.error.code).toBe('UPLOAD_INCOMPLETE');
    await t.http().put(`/v1/uploads/${tk.upload_id}?exp=1&sig=x`).send(data).expect(404);

    expect((await put(tk.upload_url, data)).status).toBe(200);
    const asset = (await t.http().post(`/v1/assets/uploads/${tk.upload_id}/complete`).set(auth(u.token)).expect(200)).body;
    expect(asset).toMatchObject({ source: 'uploaded', width: 64, height: 48 });
    const { res, body } = await follow(asset.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(body.equals(data)).toBe(true); // 上传素材不加 AI 标识
    // 重复完成返回同一资产
    expect((await t.http().post(`/v1/assets/uploads/${tk.upload_id}/complete`).set(auth(u.token)).expect(200)).body.id).toBe(asset.id);
  });

  it('上传：大小与签名不符被存储拒绝；格式不符在完成时拒绝并删除文件', async () => {
    const u = await login(t);
    const data = png(32, 32);
    const tk = await ticket(u.token, data);
    expect((await put(tk.upload_url, Buffer.concat([data, Buffer.alloc(16)]))).status).toBe(403); // content-length 参与签名
    expect((await put(tk.upload_url, data, 'image/jpeg')).status).toBe(403); // content-type 参与签名
    expect((await put(tk.upload_url.replace(/X-Amz-Signature=[0-9a-f]+/, `X-Amz-Signature=${'0'.repeat(64)}`), data)).status).toBe(403);

    // 声明 PNG、实际上传 JPEG（大小一致）：存储接受，完成时识别出来
    const fake = jpeg(20, 20);
    const tk2 = await ticket(u.token, fake);
    expect((await put(tk2.upload_url, fake)).status).toBe(200);
    const [row] = await t.db.query<{ storage_key: string }>('SELECT storage_key FROM uploads WHERE id = $1', [tk2.upload_id]);
    expect(await storage.tryRead(row.storage_key)).not.toBeNull();
    expect((await t.http().post(`/v1/assets/uploads/${tk2.upload_id}/complete`).set(auth(u.token)).expect(400)).body.error.message).toContain('格式不符');
    expect(await storage.tryRead(row.storage_key)).toBeNull();
    expect((await t.http().post(`/v1/assets/uploads/${tk2.upload_id}/complete`).set(auth(u.token)).expect(409)).body.error.code).toBe('UPLOAD_INCOMPLETE');
  });

  it('清理：直传到存储桶但未完成的上传在过期后删除；已删除作品的文件在宽限期后删除', async () => {
    const u = await login(t);
    const data = png(32, 32);
    const tk = await ticket(u.token, data);
    expect((await put(tk.upload_url, data)).status).toBe(200);
    const [{ storage_key: key }] = await t.db.query<{ storage_key: string }>('SELECT storage_key FROM uploads WHERE id = $1', [tk.upload_id]);
    expect(await storage.tryRead(key)).not.toBeNull();
    await t.db.query(`UPDATE uploads SET expires_at = now() - interval '2 hours' WHERE id = $1`, [tk.upload_id]);

    const task = await submit(t, u.token, { modality: 'image', prompt: '清理演示', params: { count: 1 } }).expect(202);
    await drain(t);
    const asset = (await t.http().get(`/v1/generations/${task.body.id}`).set(auth(u.token))).body.outputs[0].asset_id;
    const [keys] = await t.db.query<{ storage_key: string; raw_storage_key: string }>('SELECT storage_key, raw_storage_key FROM assets WHERE id = $1', [asset]);
    await t.http().delete(`/v1/assets/${asset}`).set(auth(u.token)).expect(204);

    const r = await t.app.get(StorageCleanupService).run(new Date(Date.now() + 31 * 86_400_000));
    expect(r.uploads).toBeGreaterThanOrEqual(1);
    expect(r.assets).toBeGreaterThanOrEqual(1);
    for (const k of [key, keys.storage_key, keys.raw_storage_key]) expect(await storage.tryRead(k)).toBeNull();
  });

  it('生成：原始文件与带标识的交付文件写入存储桶；下载地址以附件返回，文件名参与签名', async () => {
    const u = await login(t);
    const task = await submit(t, u.token, { modality: 'image', prompt: '秋日咖啡馆海报', params: { count: 1 } }).expect(202);
    await drain(t);
    const out = (await t.http().get(`/v1/generations/${task.body.id}`).set(auth(u.token))).body.outputs[0];
    const [a] = await t.db.query<{ storage_key: string; raw_storage_key: string }>('SELECT storage_key, raw_storage_key FROM assets WHERE id = $1', [out.asset_id]);
    expect(a.raw_storage_key).toMatch(/^private\//);
    expect(await storage.tryRead(a.raw_storage_key)).not.toBeNull();

    const { res, body } = await follow(out.url);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(body.toString()).toContain(out.content_id); // 交付文件带隐式标识

    const dl = (await t.http().get(`/v1/assets/${out.asset_id}/download`).set(auth(u.token)).expect(200)).body;
    const d = await follow(dl.url);
    const disposition = d.res.headers.get('content-disposition')!;
    expect(disposition.startsWith('attachment; filename="')).toBe(true);
    expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(disposition)![1])).toBe(dl.filename);
    expect(d.location.searchParams.get('response-content-disposition')).toContain(encodeURIComponent(dl.filename));
    // 篡改文件名或签名：不跳转
    await t.http().get(dl.url.replace(/dl=[^&]+/, 'dl=ZXZpbC5zdmc')).expect(404);
    await t.http().get(out.url.replace(/sig=[^&]+/, 'sig=forged')).expect(404);
  });

  it('参考图与图像编辑：Worker 从存储桶读取原始文件；涂抹区域私有保存', async () => {
    const u = await login(t);
    const data = png(96, 128);
    const tk = await ticket(u.token, data);
    expect((await put(tk.upload_url, data)).status).toBe(200);
    const src = (await t.http().post(`/v1/assets/uploads/${tk.upload_id}/complete`).set(auth(u.token)).expect(200)).body;

    const i2i = await submit(t, u.token, { modality: 'image', prompt: '换成水彩风格', params: { count: 1 }, references: [{ asset_id: src.id, role: 'style' }] }).expect(202);
    const mask = `data:image/png;base64,${png(96, 128).toString('base64')}`;
    const edit = await submit(t, u.token, { modality: 'image', operation: 'edit', prompt: '换成蓝色杯子', mask, params: { tool: 'inpaint' }, references: [{ asset_id: src.id, role: 'source' }] }).expect(202);
    await drain(t);
    for (const id of [i2i.body.id, edit.body.id]) expect((await t.http().get(`/v1/generations/${id}`).set(auth(u.token))).body.status).toBe('succeeded');
    const [row] = await t.db.query<{ mask_key: string }>('SELECT mask_key FROM generation_tasks WHERE id = $1', [edit.body.id]);
    expect(row.mask_key).toMatch(/^private\//);
    expect(await storage.tryRead(row.mask_key)).not.toBeNull();
    expect(() => storage.signedUrl(row.mask_key)).toThrow(); // 私有文件不能生成访问地址
  });
});
