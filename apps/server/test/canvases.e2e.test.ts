import { drain, login, makeApp, submit, type TestApp } from './helpers';

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'image',
  title: '主视觉',
  prompt: '秋日咖啡馆海报',
  x: 0,
  y: 0,
  modelCode: 'seedream-4',
  params: { ratio: '3:4', resolution: '2k', count: 1 },
  count: 1,
  status: 'draft',
  ...extra,
});

describe('项目与画布', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it('新建项目附带画布；列表包含节点数', async () => {
    const u = await login(t);
    const c = (await t.http().post('/v1/projects').set(auth(u.token)).send({ name: '秋季上新', doc: { nodes: [node('n1'), node('n2')], edges: [{ id: 'e1', from: 'n1', to: 'n2' }] } }).expect(201)).body;
    expect(c).toMatchObject({ name: '秋季上新', version: 1 });
    expect(c.doc.nodes).toHaveLength(2);
    const list = (await t.http().get('/v1/projects').set(auth(u.token)).expect(200)).body.data;
    expect(list[0]).toMatchObject({ name: '秋季上新', canvases: [{ id: c.id, node_count: 2 }] });
    expect((await t.http().get('/v1/canvases/latest').set(auth(u.token)).expect(200)).body.id).toBe(c.id);
  });

  it('乐观锁：用旧版本号保存返回 409 与当前版本', async () => {
    const u = await login(t);
    const c = (await t.http().post('/v1/projects').set(auth(u.token)).send({ name: '画布' }).expect(201)).body;
    const s1 = await t.http().put(`/v1/canvases/${c.id}`).set(auth(u.token)).send({ doc: { nodes: [node('a')], edges: [] }, version: 1 }).expect(200);
    expect(s1.body.version).toBe(2);
    const conflict = await t.http().put(`/v1/canvases/${c.id}`).set(auth(u.token)).send({ doc: { nodes: [], edges: [] }, version: 1 }).expect(409);
    expect(conflict.body.error).toMatchObject({ code: 'CANVAS_VERSION_CONFLICT', details: { current_version: 2 } });
    expect((await t.http().get(`/v1/canvases/${c.id}`).set(auth(u.token))).body.doc.nodes).toHaveLength(1);
  });

  it('节点产物不落库，读取时按任务补全最新状态与签名地址', async () => {
    const u = await login(t);
    const task = await submit(t, u.token, { modality: 'image', prompt: '秋日咖啡馆海报', params: { count: 1 }, source: 'canvas' }).expect(202);
    const c = (await t.http().post('/v1/projects').set(auth(u.token)).send({ name: '补全' }).expect(201)).body;
    const fake = [{ asset_id: 'ast_fake', url: 'https://evil.example/x.png' }];
    await t.http().put(`/v1/canvases/${c.id}`).set(auth(u.token)).send({ doc: { nodes: [node('n1', { taskId: task.body.id, status: 'queued', outputs: fake })], edges: [], messages: [{ role: 'assistant', text: '你好' }] }, version: 1 }).expect(200);
    const [row] = await t.db.query<{ doc: { nodes: Record<string, unknown>[] } }>('SELECT doc FROM canvases WHERE id = $1', [c.id]);
    expect(row.doc.nodes[0].outputs).toBeUndefined();

    let got = (await t.http().get(`/v1/canvases/${c.id}`).set(auth(u.token))).body;
    expect(got.doc.nodes[0]).toMatchObject({ status: 'queued', outputs: [] });
    await drain(t);
    got = (await t.http().get(`/v1/canvases/${c.id}`).set(auth(u.token))).body;
    expect(got.doc.nodes[0].status).toBe('succeeded');
    expect(got.doc.nodes[0].outputs[0].url).toMatch(/^\/v1\/files\//);
    expect(got.doc.messages).toEqual([{ role: 'assistant', text: '你好' }]);

    // 修改提示词后节点变为草稿：保留上一次运行的产物用于展示
    await t.http().put(`/v1/canvases/${c.id}`).set(auth(u.token)).send({ doc: { nodes: [node('n1', { status: 'draft', prevTaskId: task.body.id })], edges: [] }, version: 2 }).expect(200);
    got = (await t.http().get(`/v1/canvases/${c.id}`).set(auth(u.token))).body;
    expect(got.doc.nodes[0].status).toBe('draft');
    expect(got.doc.nodes[0].outputs).toHaveLength(1);
  });

  it('文档校验：重复节点、悬空连线、节点过多、内容过大', async () => {
    const u = await login(t);
    const c = (await t.http().post('/v1/projects').set(auth(u.token)).send({ name: '校验' }).expect(201)).body;
    const put = (doc: unknown) => t.http().put(`/v1/canvases/${c.id}`).set(auth(u.token)).send({ doc, version: 1 });
    await put({ nodes: [node('a'), node('a')], edges: [] }).expect(400);
    await put({ nodes: [node('a')], edges: [{ id: 'e', from: 'a', to: 'ghost' }] }).expect(400);
    await put({ nodes: Array.from({ length: 501 }, (_, i) => node(`n${i}`)), edges: [] }).expect(400);
    const big = await put({ nodes: Array.from({ length: 270 }, (_, i) => node(`n${i}`, { prompt: '长'.repeat(1300) })), edges: [] });
    expect(big.status).toBe(413);
    const huge = await put({ nodes: Array.from({ length: 400 }, (_, i) => node(`n${i}`, { prompt: '长'.repeat(1300) })), edges: [] });
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const broken = await t.http().put(`/v1/canvases/${c.id}`).set(auth(u.token)).set('content-type', 'application/json').send('{"doc":');
    expect(broken.status).toBe(400);
  });

  it('越权访问返回 404；删除项目后画布不可访问', async () => {
    const u = await login(t);
    const c = (await t.http().post('/v1/projects').set(auth(u.token)).send({ name: '私有' }).expect(201)).body;
    const other = await login(t);
    await t.http().get(`/v1/canvases/${c.id}`).set(auth(other.token)).expect(404);
    await t.http().put(`/v1/canvases/${c.id}`).set(auth(other.token)).send({ doc: { nodes: [], edges: [] }, version: 1 }).expect(404);
    await t.http().delete(`/v1/projects/${c.project_id}`).set(auth(other.token)).expect(404);
    await t.http().delete(`/v1/projects/${c.project_id}`).set(auth(u.token)).expect(204);
    await t.http().get(`/v1/canvases/${c.id}`).set(auth(u.token)).expect(404);
    await t.http().get('/v1/canvases/latest').set(auth(u.token)).expect(404);
  });
});
