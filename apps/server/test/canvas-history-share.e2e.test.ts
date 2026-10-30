import { CANVAS_SNAPSHOT_LIMIT } from '@creature/shared';
import { drain, login, makeApp, submit, type TestApp } from './helpers';

const node = (id: string, prompt = '秋日咖啡馆海报', extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'image',
  title: '主视觉',
  prompt,
  x: 0,
  y: 0,
  modelCode: 'seedream-4',
  params: { ratio: '3:4', count: 1 },
  count: 1,
  status: 'draft',
  ...extra,
});

describe('画布历史版本与分享链接', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
    await t.app.listen(0); // 断言失败时 supertest 能输出真实错误
  });
  afterAll(() => t.close());
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const create = async (token: string, nodes: unknown[]) => (await t.http().post('/v1/projects').set(auth(token)).send({ name: '秋季上新', doc: { nodes, edges: [] } }).expect(201)).body;
  const save = (token: string, id: string, version: number, nodes: unknown[]) => t.http().put(`/v1/canvases/${id}`).set(auth(token)).send({ doc: { nodes, edges: [] }, version });
  const snapshots = async (token: string, id: string) => (await t.http().get(`/v1/canvases/${id}/snapshots`).set(auth(token)).expect(200)).body.data;
  /** 把已有的历史版本挪到 11 分钟前，下一次保存会再记一个自动版本 */
  const age = (id: string) => t.db.query(`UPDATE canvas_snapshots SET created_at = created_at - interval '11 minutes' WHERE canvas_id = $1`, [id]);

  it('自动版本：保存时距上一个版本超过 10 分钟，记录被覆盖的内容；空画布不记', async () => {
    const u = await login(t);
    const empty = (await t.http().post('/v1/projects').set(auth(u.token)).send({ name: '空白' }).expect(201)).body;
    await save(u.token, empty.id, 1, [node('a')]).expect(200);
    expect(await snapshots(u.token, empty.id)).toEqual([]);

    const c = await create(u.token, [node('a', '第一版')]);
    await save(u.token, c.id, 1, [node('a', '第二版')]).expect(200);
    await save(u.token, c.id, 2, [node('a', '第三版')]).expect(200); // 10 分钟内，不再记录
    let list = await snapshots(u.token, c.id);
    expect(list).toEqual([expect.objectContaining({ version: 1, node_count: 1, reason: 'auto' })]);
    await age(c.id);
    await save(u.token, c.id, 3, [node('a', '第四版'), node('b')]).expect(200);
    list = await snapshots(u.token, c.id);
    expect(list.map((s: { version: number }) => s.version)).toEqual([3, 1]);
    const v3 = (await t.http().get(`/v1/canvases/${c.id}/snapshots/${list[0].id}`).set(auth(u.token)).expect(200)).body;
    expect(v3.doc.nodes.map((n: { prompt: string }) => n.prompt)).toEqual(['第三版']);
  });

  it('手动版本与保留数量；恢复：先备份当前内容，版本号不一致返回 409；不能访问别人的版本', async () => {
    const u = await login(t);
    const other = await login(t);
    const c = await create(u.token, [node('a', '定稿前')]);
    const manual = (await t.http().post(`/v1/canvases/${c.id}/snapshots`).set(auth(u.token)).send({ label: '给客户看的版本' }).expect(201)).body;
    expect(manual).toMatchObject({ reason: 'manual', label: '给客户看的版本', version: 1 });
    await save(u.token, c.id, 1, [node('a', '改坏了'), node('b')]).expect(200);

    await t.http().post(`/v1/canvases/${c.id}/snapshots/${manual.id}/restore`).set(auth(u.token)).send({ version: 1 }).expect(409);
    const restored = (await t.http().post(`/v1/canvases/${c.id}/snapshots/${manual.id}/restore`).set(auth(u.token)).send({ version: 2 }).expect(200)).body;
    expect(restored.version).toBe(3);
    expect(restored.doc.nodes.map((n: { prompt: string }) => n.prompt)).toEqual(['定稿前']);
    const list = await snapshots(u.token, c.id);
    expect(list[0]).toMatchObject({ reason: 'restore', version: 2, node_count: 2 });
    expect(list[0].label).toContain('之前');

    await t.http().get(`/v1/canvases/${c.id}/snapshots`).set(auth(other.token)).expect(404);
    await t.http().get(`/v1/canvases/${c.id}/snapshots/${manual.id}`).set(auth(other.token)).expect(404);
    await t.http().post(`/v1/canvases/${c.id}/snapshots/${manual.id}/restore`).set(auth(other.token)).send({ version: 3 }).expect(404);

    // 手动版本最多保留 CANVAS_SNAPSHOT_LIMIT.manual 个，超出时删除最旧的
    for (let i = 0; i < CANVAS_SNAPSHOT_LIMIT.manual; i++) await t.http().post(`/v1/canvases/${c.id}/snapshots`).set(auth(u.token)).send({ label: `v${i}` }).expect(201);
    const manuals = (await snapshots(u.token, c.id)).filter((s: { reason: string }) => s.reason === 'manual');
    expect(manuals).toHaveLength(CANVAS_SNAPSHOT_LIMIT.manual);
    expect(manuals.some((s: { id: string }) => s.id === manual.id)).toBe(false);
  });

  it('分享链接：无需登录只读查看，默认隐藏提示词与小造对话；可改为展示提示词；关闭后失效', async () => {
    const u = await login(t);
    const task = await submit(t, u.token, { modality: 'image', prompt: '秋日咖啡馆海报', params: { count: 1 } }).expect(202);
    await drain(t);
    const c = (
      await t.http()
        .post('/v1/projects')
        .set(auth(u.token))
        .send({ name: '秋季上新', doc: { nodes: [node('a', '秋日咖啡馆海报', { taskId: task.body.id, status: 'succeeded' }), node('b', '草稿')], edges: [{ id: 'e', from: 'a', to: 'b' }], messages: [{ role: 'user', text: '私密对话' }] } })
        .expect(201)
    ).body;
    expect((await t.http().get(`/v1/canvases/${c.id}/share`).set(auth(u.token)).expect(200)).body.share).toBeNull();
    const share = (await t.http().put(`/v1/canvases/${c.id}/share`).set(auth(u.token)).send({}).expect(200)).body;
    expect(share).toMatchObject({ show_prompts: false, view_count: 0, path: `/#s/${share.token}` });
    expect((await t.http().put(`/v1/canvases/${c.id}/share`).set(auth(u.token)).send({}).expect(200)).body.token).toBe(share.token); // 重复创建返回同一链接

    const view = await t.http().get(`/v1/shared/canvases/${share.token}`).expect(200);
    expect(view.headers['x-robots-tag']).toBe('noindex');
    expect(view.body).toMatchObject({ name: '秋季上新', show_prompts: false, edges: [{ from: 'a', to: 'b' }] });
    expect(view.body.nodes[0]).toMatchObject({ id: 'a', prompt: null, status: 'succeeded' });
    expect(view.body.nodes[0].outputs[0].url).toMatch(/^\/v1\/files\//);
    expect(JSON.stringify(view.body)).not.toContain('私密对话');
    expect(JSON.stringify(view.body)).not.toContain('modelCode');
    // 分享页拿到的是带 AI 标识的交付文件
    const file = await t.http().get(view.body.nodes[0].outputs[0].url).expect(200);
    expect(file.text ?? file.body.toString()).toContain('AI 生成');

    await t.http().put(`/v1/canvases/${c.id}/share`).set(auth(u.token)).send({ show_prompts: true }).expect(200);
    expect((await t.http().get(`/v1/shared/canvases/${share.token}`).expect(200)).body.nodes.map((n: { prompt: string }) => n.prompt)).toEqual(['秋日咖啡馆海报', '草稿']);
    expect((await t.http().get(`/v1/canvases/${c.id}/share`).set(auth(u.token)).expect(200)).body.share.view_count).toBe(2);

    await t.http().delete(`/v1/canvases/${c.id}/share`).set(auth(u.token)).expect(204);
    await t.http().get(`/v1/shared/canvases/${share.token}`).expect(404);
    const again = (await t.http().put(`/v1/canvases/${c.id}/share`).set(auth(u.token)).send({}).expect(200)).body;
    expect(again.token).not.toBe(share.token); // 重新分享生成新链接
    await t.http().get('/v1/shared/canvases/not-a-token').expect(404);
  });

  it('项目删除或作者账号被限制后，分享链接不可访问', async () => {
    const u = await login(t);
    const c = await create(u.token, [node('a')]);
    const share = (await t.http().put(`/v1/canvases/${c.id}/share`).set(auth(u.token)).send({}).expect(200)).body;
    await t.http().get(`/v1/shared/canvases/${share.token}`).expect(200);
    await t.db.query(`UPDATE users SET status = 'frozen' WHERE id = $1`, [u.userId]);
    await t.http().get(`/v1/shared/canvases/${share.token}`).expect(404);
    await t.db.query(`UPDATE users SET status = 'active' WHERE id = $1`, [u.userId]);
    await t.http().get(`/v1/shared/canvases/${share.token}`).expect(200);
    await t.http().delete(`/v1/projects/${c.project_id}`).set(auth(u.token)).expect(204);
    await t.http().get(`/v1/shared/canvases/${share.token}`).expect(404);
  });
});
