import { StorageCleanupService } from '../src/storage/cleanup.service';
import { StorageService } from '../src/storage/storage.service';
import { drain, login, makeApp, submit, type TestApp } from './helpers';
import { png } from './images';

const DAY = 86_400_000;

describe('存储清理', () => {
  let t: TestApp;
  let cleanup: StorageCleanupService;
  let storage: StorageService;
  beforeAll(async () => {
    t = await makeApp();
    cleanup = t.app.get(StorageCleanupService);
    storage = t.app.get(StorageService);
  });
  afterAll(() => t.close());
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const exists = async (key: string) => (await storage.tryRead(key)) !== null;
  const later = (days: number) => new Date(Date.now() + days * DAY);

  async function ticket(token: string) {
    const data = png(64, 64);
    const r = (await t.http().post('/v1/assets/uploads').set(auth(token)).send({ filename: 'p.png', mime: 'image/png', size: data.length }).expect(201)).body;
    return { ...r, data } as { upload_id: string; upload_url: string; data: Buffer };
  }
  async function upload(token: string) {
    const k = await ticket(token);
    await t.http().put(k.upload_url).set('content-type', 'image/png').send(k.data).expect(204);
    return (await t.http().post(`/v1/assets/uploads/${k.upload_id}/complete`).set(auth(token)).expect(200)).body.id as string;
  }
  const keysOf = async (id: string) =>
    (await t.db.query<{ storage_key: string; raw_storage_key: string }>('SELECT storage_key, raw_storage_key FROM assets WHERE id = $1', [id]))[0];

  it('过期未完成的上传：删除已写入的文件并标记为 expired；完成的与未过期的不受影响', async () => {
    const u = await login(t);
    const written = await ticket(u.token);
    await t.http().put(written.upload_url).set('content-type', 'image/png').send(written.data).expect(204);
    const empty = await ticket(u.token);
    const fresh = await ticket(u.token);
    const done = await upload(u.token);
    const [{ storage_key: key }] = await t.db.query<{ storage_key: string }>('SELECT storage_key FROM uploads WHERE id = $1', [written.upload_id]);
    expect(await exists(key)).toBe(true);

    // 会话有效期 15 分钟，过期后再等 1 小时才清理
    await t.db.query(`UPDATE uploads SET expires_at = now() - interval '30 minutes' WHERE id = ANY($1::text[])`, [[written.upload_id, empty.upload_id]]);
    expect((await cleanup.run()).uploads).toBe(0);
    await t.db.query(`UPDATE uploads SET expires_at = now() - interval '2 hours' WHERE id = ANY($1::text[])`, [[written.upload_id, empty.upload_id]]);
    expect(await cleanup.run()).toMatchObject({ uploads: 2 });
    expect(await exists(key)).toBe(false);
    const status = Object.fromEntries((await t.db.query<{ id: string; status: string }>('SELECT id, status FROM uploads WHERE user_id = $1', [u.userId])).map((r) => [r.id, r.status]));
    expect(status[written.upload_id]).toBe('expired');
    expect(status[empty.upload_id]).toBe('expired');
    expect(status[fresh.upload_id]).toBe('pending');
    expect(await exists((await keysOf(done)).storage_key)).toBe(true);
    // 已清理的会话不能再完成
    expect((await t.http().post(`/v1/assets/uploads/${written.upload_id}/complete`).set(auth(u.token)).expect(409)).body.error.code).toBe('UPLOAD_CLOSED');
  });

  it('已删除的作品：宽限期后删除交付文件与原始文件，保留元数据；只处理一次', async () => {
    const u = await login(t);
    const task = await submit(t, u.token, { modality: 'image', prompt: '秋日海报', params: { count: 2 } }).expect(202);
    await drain(t);
    const [gone, kept] = (await t.http().get(`/v1/generations/${task.body.id}`).set(auth(u.token))).body.outputs.map((o: { asset_id: string }) => o.asset_id);
    await t.http().delete(`/v1/assets/${gone}`).set(auth(u.token)).expect(204);
    const keys = await keysOf(gone);
    expect(keys.storage_key).not.toBe(keys.raw_storage_key);

    expect((await cleanup.run(later(29))).assets).toBe(0);
    expect(await exists(keys.storage_key)).toBe(true);
    expect(await cleanup.run(later(31))).toMatchObject({ assets: 1, files: 2 });
    expect(await exists(keys.storage_key)).toBe(false);
    expect(await exists(keys.raw_storage_key)).toBe(false);
    expect(await exists((await keysOf(kept)).storage_key)).toBe(true);
    const [row] = await t.db.query<{ content_id: string; files_purged_at: Date | null }>('SELECT content_id, files_purged_at FROM assets WHERE id = $1', [gone]);
    expect(row.content_id).toBeTruthy();
    expect(row.files_purged_at).not.toBeNull();
    expect((await cleanup.run(later(31))).assets).toBe(0);
  });

  it('仍被使用的文件不删：肖像授权材料、未删除角色的参考图、未删除品牌套件的 Logo', async () => {
    const u = await login(t);
    await t.db.query(`UPDATE users SET plan_code = 'pro', plan_expires_at = now() + interval '30 days' WHERE id = $1`, [u.userId]);
    const [a, b, c, consent, logo] = [await upload(u.token), await upload(u.token), await upload(u.token), await upload(u.token), await upload(u.token)];
    const ch = (
      await t.http()
        .post('/v1/characters')
        .set(auth(u.token))
        .send({ name: '林夏', description: '短发、圆框眼镜', likeness: 'authorized', consent_asset_id: consent, refs: [{ asset_id: a }, { asset_id: b }, { asset_id: c }] })
        .expect(201)
    ).body;
    const kit = (await t.http().post('/v1/brand-kits').set(auth(u.token)).send({ name: '山野咖啡', logos: [{ asset_id: logo, variant: 'primary' }] }).expect(201)).body;
    for (const id of [a, consent, logo]) await t.http().delete(`/v1/assets/${id}`).set(auth(u.token)).expect(204);

    expect((await cleanup.run(later(31))).assets).toBe(0);
    await t.http().delete(`/v1/characters/${ch.id}`).set(auth(u.token)).expect(204);
    await t.http().delete(`/v1/brand-kits/${kit.id}`).set(auth(u.token)).expect(204);
    expect((await cleanup.run(later(31))).assets).toBe(2); // 参考图与 Logo；授权材料一直保留
    expect(await exists((await keysOf(a)).storage_key)).toBe(false);
    expect(await exists((await keysOf(logo)).storage_key)).toBe(false);
    expect(await exists((await keysOf(consent)).storage_key)).toBe(true);
  });
});
