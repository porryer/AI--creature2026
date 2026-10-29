import { LIBRARY_QUOTA } from '@creature/shared';
import { drain, login, makeApp, submit, type TestApp } from './helpers';
import { png } from './images';

describe('角色库与品牌套件', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ moderationExtraWords: ['事后禁词'] });
  });
  afterAll(() => t.close());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const binary = (r: import('supertest').Test) =>
    r.buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  const balance = async (token: string) => (await t.http().get('/v1/credits/balance').set(auth(token)).expect(200)).body.available as number;
  const setPlan = (userId: string, plan: string, days = 30) => t.db.query(`UPDATE users SET plan_code = $2, plan_expires_at = now() + ($3 || ' days')::interval WHERE id = $1`, [userId, plan, String(days)]);

  let seq = 0;
  /** 上传一张图片；每次尺寸不同，文件内容也不同 */
  async function upload(token: string) {
    const data = png(100 + seq++, 120);
    const ticket = (await t.http().post('/v1/assets/uploads').set(auth(token)).send({ filename: 'ref.png', mime: 'image/png', size: data.length }).expect(201)).body;
    await t.http().put(ticket.upload_url).set('content-type', 'image/png').send(data).expect(204);
    const asset = (await t.http().post(`/v1/assets/uploads/${ticket.upload_id}/complete`).set(auth(token)).expect(200)).body;
    return { id: asset.id as string, data };
  }
  const uploads = (token: string, n: number) => Promise.all(Array.from({ length: n }, () => upload(token)));

  async function proUser() {
    const u = await login(t);
    await setPlan(u.userId, 'pro');
    return u;
  }

  it('套餐：免费版只能查看，创建与生成时引用返回 PLAN_FEATURE_REQUIRED，不冻结积分', async () => {
    const u = await login(t);
    expect((await t.http().get('/v1/characters').set(auth(u.token)).expect(200)).body).toEqual({ data: [], quota: { used: 0, limit: 0 } });
    expect((await t.http().get('/v1/brand-kits').set(auth(u.token)).expect(200)).body.quota).toEqual({ used: 0, limit: 0 });
    const refs = await uploads(u.token, 3);
    const r = await t.http().post('/v1/characters').set(auth(u.token)).send({ name: '林夏', likeness: 'none', refs: refs.map((x) => ({ asset_id: x.id })) }).expect(403);
    expect(r.body.error).toMatchObject({ code: 'PLAN_FEATURE_REQUIRED', details: { required_plan: 'pro' } });
    await t.http().post('/v1/brand-kits').set(auth(u.token)).send({ name: '山野咖啡' }).expect(403);
    const before = await balance(u.token);
    expect((await submit(t, u.token, { modality: 'image', prompt: '海报', context: { brand_kit_id: 'bk_x' } }).expect(403)).body.error.code).toBe('PLAN_FEATURE_REQUIRED');
    expect(await balance(u.token)).toBe(before);
  });

  it('角色：3–8 张本人图像；肖像授权材料须是本人上传的图片；文字过审；增删改查与配额', async () => {
    const u = await proUser();
    const other = await login(t);
    const [a, b, c, d] = await uploads(u.token, 4);
    const [theirs] = await uploads(other.token, 1);
    const create = (body: Record<string, unknown>) => t.http().post('/v1/characters').set(auth(u.token)).send({ name: '林夏', likeness: 'none', ...body });

    expect((await create({ refs: [{ asset_id: a.id }, { asset_id: b.id }] }).expect(400)).body.error.message).toContain('3–8');
    expect((await create({ refs: [a, b, theirs].map((x) => ({ asset_id: x.id })) }).expect(400)).body.error.message).toContain('参考图不存在');
    expect((await create({ refs: [a, a, b].map((x) => ({ asset_id: x.id })) }).expect(400)).body.error.message).toContain('不能重复');
    const refs = [a, b, c].map((x) => ({ asset_id: x.id }));
    expect((await create({ likeness: 'authorized', refs }).expect(400)).body.error.message).toContain('授权材料');
    // 生成的图片不能作为授权材料
    const gen = await submit(t, u.token, { modality: 'image', prompt: '授权书', params: { count: 1 } }).expect(202);
    await drain(t);
    const genAsset = (await t.http().get(`/v1/generations/${gen.body.id}`).set(auth(u.token))).body.outputs[0].asset_id;
    expect((await create({ likeness: 'authorized', consent_asset_id: genAsset, refs }).expect(400)).body.error.message).toContain('你上传的图片');
    // 文字审核
    const blocked = await create({ description: '违规内容', refs }).expect(422);
    expect(blocked.body.error.code).toBe('CONTENT_REJECTED');
    const [mod] = await t.db.query<{ target_type: string }>(`SELECT target_type FROM moderation_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [u.userId]);
    expect(mod.target_type).toBe('character');

    const ch = (await create({ description: '25 岁生活方式博主，短发、圆框眼镜', likeness: 'authorized', consent_asset_id: d.id, refs: [{ asset_id: a.id, view: 'side' }, { asset_id: b.id, view: 'front' }, { asset_id: c.id }] }).expect(201)).body;
    expect(ch).toMatchObject({ name: '林夏', likeness: 'authorized', used_count: 0 });
    expect(ch.refs.map((r: { asset_id: string; view: string | null }) => [r.asset_id, r.view])).toEqual([
      [a.id, 'side'],
      [b.id, 'front'],
      [c.id, null],
    ]);
    expect(ch.refs[0].url).toMatch(/^\/v1\/files\//);

    const patched = (await t.http().patch(`/v1/characters/${ch.id}`).set(auth(u.token)).send({ name: '林夏 2.0', refs: [b, c, d].map((x) => ({ asset_id: x.id })) }).expect(200)).body;
    expect(patched.name).toBe('林夏 2.0');
    expect(patched.description).toBe('25 岁生活方式博主，短发、圆框眼镜');
    expect(patched.refs.map((r: { asset_id: string }) => r.asset_id)).toEqual([b.id, c.id, d.id]);
    await t.http().get(`/v1/characters/${ch.id}`).set(auth(other.token)).expect(404);
    expect((await t.http().get('/v1/characters').set(auth(u.token)).expect(200)).body.quota).toEqual({ used: 1, limit: LIBRARY_QUOTA.pro.characters });

    // 配额：直接补足到上限后再创建
    await t.db.query(
      `INSERT INTO characters (id, user_id, name, likeness) SELECT 'chr_fill_' || n, $1, '占位', 'none' FROM generate_series(1, $2::int) n`,
      [u.userId, LIBRARY_QUOTA.pro.characters - 1],
    );
    expect((await create({ refs }).expect(409)).body.error.code).toBe('LIBRARY_LIMIT');
    await t.db.query(`DELETE FROM characters WHERE id LIKE 'chr_fill_%'`);

    await t.http().delete(`/v1/characters/${ch.id}`).set(auth(u.token)).expect(204);
    expect((await t.http().get('/v1/characters').set(auth(u.token))).body.data).toEqual([]);
  });

  it('品牌套件：标准色、字体、禁用元素与 Logo 校验；颜色统一为大写', async () => {
    const u = await proUser();
    const [logo, mono] = await uploads(u.token, 2);
    const create = (body: Record<string, unknown>) => t.http().post('/v1/brand-kits').set(auth(u.token)).send({ name: '山野咖啡', ...body });
    await create({ colors: [{ name: '焦糖', hex: 'B5652B' }] }).expect(400);
    await create({ colors: Array.from({ length: 9 }, (_, i) => ({ name: `色${i}`, hex: '#000000' })) }).expect(400);
    expect((await create({ logos: [{ asset_id: logo.id, variant: 'primary' }, { asset_id: mono.id, variant: 'primary' }] }).expect(400)).body.error.message).toContain('Logo 版本');
    expect((await create({ banned: ['色情'] }).expect(422)).body.error.code).toBe('CONTENT_REJECTED');

    const kit = (
      await create({
        tone: '温暖、自然、有手作感',
        colors: [
          { name: '焦糖', hex: '#b5652b' },
          { name: '燕麦', hex: '#EBDDC5' },
          { name: '松针', hex: '#2F5D46' },
        ],
        fonts: ['思源宋体 · 标题'],
        banned: ['冷色调', '塑料质感'],
        logos: [{ asset_id: logo.id, variant: 'primary' }],
      }).expect(201)
    ).body;
    expect(kit.colors[0]).toEqual({ name: '焦糖', hex: '#B5652B' });
    expect(kit.logos).toEqual([{ asset_id: logo.id, url: expect.stringMatching(/^\/v1\/files\//), variant: 'primary' }]);
    const patched = (await t.http().patch(`/v1/brand-kits/${kit.id}`).set(auth(u.token)).send({ logos: [{ asset_id: logo.id, variant: 'primary' }, { asset_id: mono.id, variant: 'mono' }] }).expect(200)).body;
    expect(patched.logos.map((l: { variant: string }) => l.variant)).toEqual(['primary', 'mono']);
    expect(patched.tone).toBe('温暖、自然、有手作感');
    await t.http().delete(`/v1/brand-kits/${kit.id}`).set(auth(u.token)).expect(204);
    await t.http().get(`/v1/brand-kits/${kit.id}`).set(auth(u.token)).expect(404);
  });

  /** 一个专业版用户，带两个角色与一个有 Logo 的品牌套件 */
  async function setup() {
    const u = await proUser();
    const imgs = await uploads(u.token, 7);
    const mk = async (name: string, refs: { asset_id: string; view?: string }[]) =>
      (await t.http().post('/v1/characters').set(auth(u.token)).send({ name, description: `${name}的设定`, likeness: 'none', refs }).expect(201)).body;
    // 角色 A 的参考图顺序为 侧面、正面、全身、背面：生成时按 正面 → 全身 → 侧面 挑选
    const a = await mk('林夏', [
      { asset_id: imgs[0].id, view: 'side' },
      { asset_id: imgs[1].id, view: 'front' },
      { asset_id: imgs[2].id, view: 'full_body' },
      { asset_id: imgs[3].id, view: 'back' },
    ]);
    const b = await mk('阿橘', [{ asset_id: imgs[4].id }, { asset_id: imgs[5].id }, { asset_id: imgs[0].id }]);
    const kit = (
      await t.http()
        .post('/v1/brand-kits')
        .set(auth(u.token))
        .send({ name: '山野咖啡', tone: '温暖自然', colors: [{ name: '焦糖', hex: '#B5652B' }, { name: '松针', hex: '#2F5D46' }], banned: ['冷色调'], logos: [{ asset_id: imgs[6].id, variant: 'primary' }] })
        .expect(201)
    ).body;
    return { u, imgs, a, b, kit };
  }

  it('生成：引用两个角色与品牌套件并放置 Logo；快照随任务保存，模型收到注入后的提示词与参考图', async () => {
    const { u, imgs, a, b, kit } = await setup();
    const res = await submit(t, u.token, {
      modality: 'image',
      prompt: '两人在秋日咖啡馆窗边聊天',
      params: { count: 1 },
      context: { character_ids: [a.id, b.id], brand_kit_id: kit.id, place_logo: true },
    }).expect(202);
    expect(res.body.prompt).toBe('两人在秋日咖啡馆窗边聊天'); // 任务保留用户原始提示词
    expect(res.body.context).toEqual({ characters: [{ id: a.id, name: '林夏' }, { id: b.id, name: '阿橘' }], brand_kit: { id: kit.id, name: '山野咖啡' }, place_logo: true });
    const [row] = await t.db.query<{ context: { characters: { ref_asset_ids: string[] }[] } }>('SELECT context FROM generation_tasks WHERE id = $1', [res.body.id]);
    expect(row.context.characters[0].ref_asset_ids).toEqual([imgs[1].id, imgs[2].id, imgs[0].id]);

    // 之后修改与删除角色不影响已提交的任务
    await t.http().patch(`/v1/characters/${a.id}`).set(auth(u.token)).send({ name: '改名了' }).expect(200);
    await t.http().delete(`/v1/characters/${b.id}`).set(auth(u.token)).expect(204);

    const generate = jest.spyOn(t.app.get((await import('../src/gateway/model-gateway.service')).ModelGateway), 'generate');
    await drain(t);
    const req = generate.mock.calls[0][1];
    generate.mockRestore();
    expect(req.prompt).toContain('两人在秋日咖啡馆窗边聊天\n【角色】林夏：林夏的设定；阿橘：阿橘的设定');
    expect(req.prompt).toContain('主色调使用标准色 焦糖 #B5652B、松针 #2F5D46');
    expect(req.prompt).toContain('画面中不要出现：冷色调');
    expect(req.prompt).toContain('右上角放置品牌 Logo');
    expect(req.palette).toEqual(['#B5652B', '#2F5D46']);
    expect(req.references.map((r) => [r.role, r.group])).toEqual([
      ['character', a.id],
      ['character', a.id],
      ['character', a.id],
      ['character', b.id],
      ['character', b.id],
      ['character', b.id],
      ['logo', undefined],
    ]);

    const task = (await t.http().get(`/v1/generations/${res.body.id}`).set(auth(u.token))).body;
    expect(task.status).toBe('succeeded');
    expect(task.context.characters[0].name).toBe('林夏');
    const svg = (await binary(t.http().get(task.outputs[0].url)).expect(200)).body.toString();
    expect(svg).toContain(imgs[1].data.toString('base64')); // 角色 A 的正面参考图
    expect(svg).not.toContain(imgs[3].data.toString('base64')); // 背面没有被选中
    expect(svg).toContain(imgs[4].data.toString('base64')); // 角色 B 的第一张
    expect(svg).toContain('id="brand-logo"');
    expect(svg).toContain(imgs[6].data.toString('base64'));
    expect(svg).toContain('#B5652B'); // 按品牌标准色作图

    const used = (await t.http().get(`/v1/characters/${a.id}`).set(auth(u.token))).body.used_count;
    const kitUsed = (await t.http().get(`/v1/brand-kits/${kit.id}`).set(auth(u.token))).body.used_count;
    expect([used, kitUsed]).toEqual([1, 1]);
  });

  it('生成：非法引用在冻结积分前拒绝；写作可以使用品牌套件；提示词与品牌内容一起审核', async () => {
    const { u, a, b, kit } = await setup();
    const other = await proUser();
    const before = await balance(u.token);
    const bad = async (body: Record<string, unknown>, text: string) =>
      expect((await submit(t, u.token, { modality: 'image', prompt: '海报', params: { count: 1 }, ...body }).expect(400)).body.error.message).toContain(text);
    const c3 = (await t.http().post('/v1/characters').set(auth(u.token)).send({ name: '第三个', likeness: 'none', refs: a.refs.map((r: { asset_id: string }) => ({ asset_id: r.asset_id })) }).expect(201)).body;
    await bad({ context: { character_ids: [a.id, b.id, c3.id] } }, '最多引用 2 个角色');
    await bad({ context: { place_logo: true } }, '需要同时选择品牌套件');
    await bad({ context: { character_ids: ['chr_nope'] } }, '角色不存在');
    const theirs = (await t.http().post('/v1/brand-kits').set(auth(other.token)).send({ name: '别人的' }).expect(201)).body;
    await bad({ context: { brand_kit_id: theirs.id } }, '品牌套件不存在');
    await bad({ context: { brand_kit_id: theirs.id, place_logo: true } }, '品牌套件不存在');
    const noLogo = (await t.http().post('/v1/brand-kits').set(auth(u.token)).send({ name: '无 Logo' }).expect(201)).body;
    await bad({ context: { brand_kit_id: noLogo.id, place_logo: true } }, '还没有 Logo');
    expect((await submit(t, u.token, { modality: 'text', prompt: '新品文案', context: { character_ids: [a.id] } }).expect(400)).body.error.message).toContain('只有图像与视频');
    expect((await submit(t, u.token, { modality: 'video', prompt: '短片', params: { duration: 5 }, context: { brand_kit_id: kit.id, place_logo: true } }).expect(400)).body.error.message).toContain('只有图像可以放置');
    const src = a.refs[0].asset_id;
    expect(
      (await submit(t, u.token, { modality: 'image', operation: 'edit', params: { tool: 'cutout' }, references: [{ asset_id: src, role: 'source' }], context: { brand_kit_id: kit.id } }).expect(400)).body.error.message,
    ).toContain('图像编辑不支持');
    expect(await balance(u.token)).toBe(before);

    // 写作：注入品牌调性与禁用元素，不包含配色
    const writing = await submit(t, u.token, { modality: 'text', prompt: '秋季新品文案', params: { template: 'ad' }, context: { brand_kit_id: kit.id } }).expect(202);
    const generate = jest.spyOn(t.app.get((await import('../src/gateway/model-gateway.service')).ModelGateway), 'generate');
    await drain(t);
    expect(generate.mock.calls[0][1].prompt).toBe('秋季新品文案\n【品牌规范】品牌「山野咖啡」；调性：温暖自然；文中不要出现：冷色调');
    generate.mockRestore();
    const done = (await t.http().get(`/v1/generations/${writing.body.id}`).set(auth(u.token))).body;
    expect(done.status).toBe('succeeded');
    expect(done.outputs[0].text.split('\n')[0]).toContain('秋季新品文案');
    expect(done.outputs[0].text).not.toContain('品牌规范');

    // 保存后才加入审核规则的词：生成时与提示词一起审核
    await t.db.query(`UPDATE brand_kits SET tone = '事后禁词' WHERE id = $1`, [kit.id]);
    expect((await submit(t, u.token, { modality: 'image', prompt: '海报', params: { count: 1 }, context: { brand_kit_id: kit.id } }).expect(422)).body.error.code).toBe('CONTENT_REJECTED');
  });

  it('套餐到期：已有角色仍可查看与删除，不能编辑或在生成时引用', async () => {
    const { u, a } = await setup();
    await setPlan(u.userId, 'pro', -1);
    expect((await t.http().get('/v1/characters').set(auth(u.token)).expect(200)).body.quota.limit).toBe(0);
    expect((await t.http().patch(`/v1/characters/${a.id}`).set(auth(u.token)).send({ name: '新名字' }).expect(403)).body.error.code).toBe('PLAN_FEATURE_REQUIRED');
    expect((await submit(t, u.token, { modality: 'image', prompt: '海报', params: { count: 1 }, context: { character_ids: [a.id] } }).expect(403)).body.error.code).toBe('PLAN_FEATURE_REQUIRED');
    await t.http().delete(`/v1/characters/${a.id}`).set(auth(u.token)).expect(204);
  });
});
