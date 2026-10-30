import { REPLIES_PREVIEW } from '@creature/shared';
import { AccountService } from '../src/users/account.service';
import { drain, login, makeApp, submit, type TestApp } from './helpers';

const ADMIN = '13700000061';
const DAY = 86_400_000;

describe('广场评论与关注', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await makeApp({ adminPhones: [ADMIN] });
    await t.app.listen(0); // 断言失败时 supertest 能输出真实错误
  });
  afterAll(() => t.close());
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  /** 生成一张图并发布，返回作品 */
  async function post(token: string, title = '秋日') {
    const task = await submit(t, token, { modality: 'image', prompt: '秋日咖啡馆海报', params: { count: 1 } }).expect(202);
    await drain(t);
    const asset = (await t.http().get(`/v1/generations/${task.body.id}`).set(auth(token))).body.outputs[0].asset_id;
    return (await t.http().post('/v1/posts').set(auth(token)).send({ asset_id: asset, title }).expect(201)).body as { id: string; comment_count: number };
  }
  const comment = (token: string, postId: string, body: string, parent_id?: string) => t.http().post(`/v1/posts/${postId}/comments`).set(auth(token)).send({ body, parent_id });
  const thread = async (token: string, postId: string) => (await t.http().get(`/v1/posts/${postId}/comments`).set(auth(token)).expect(200)).body;
  const count = async (token: string, postId: string) => (await t.http().get(`/v1/posts/${postId}`).set(auth(token)).expect(200)).body.comment_count;

  it('评论与回复：一层回复（回复的回复挂到顶层并记录被回复者）、最新在前、计数；机审拦截；长度校验', async () => {
    const author = await login(t);
    const a = await login(t);
    const b = await login(t);
    const p = await post(author.token);
    const c1 = (await comment(a.token, p.id, '配色好舒服').expect(201)).body;
    expect(c1).toMatchObject({ author: { id: a.userId }, reply_to: null, body: '配色好舒服', can_delete: true, mine: true });
    const c2 = (await comment(b.token, p.id, '求同款咖啡馆').expect(201)).body;
    const r1 = (await comment(author.token, p.id, '谢谢喜欢', c1.id).expect(201)).body;
    const r2 = (await comment(a.token, p.id, '期待更多', r1.id).expect(201)).body;
    expect(r2.reply_to).toEqual({ id: author.userId, nickname: expect.any(String) });
    for (let i = 0; i < REPLIES_PREVIEW; i++) await comment(b.token, p.id, `楼中楼 ${i}`, c1.id).expect(201);

    const list = await thread(b.token, p.id);
    expect(list.data.map((c: { id: string }) => c.id)).toEqual([c2.id, c1.id]);
    const top = list.data[1];
    expect(top.reply_count).toBe(2 + REPLIES_PREVIEW);
    expect(top.replies.map((r: { id: string }) => r.id).slice(0, 2)).toEqual([r1.id, r2.id]);
    expect(top.replies).toHaveLength(REPLIES_PREVIEW);
    expect(top.can_delete).toBe(false); // b 不是评论作者也不是作品作者
    const all = (await t.http().get(`/v1/comments/${c1.id}/replies?limit=50`).set(auth(b.token)).expect(200)).body.data;
    expect(all).toHaveLength(2 + REPLIES_PREVIEW);
    expect(await count(b.token, p.id)).toBe(4 + REPLIES_PREVIEW);

    expect((await comment(a.token, p.id, '这是违规内容').expect(422)).body.error.code).toBe('CONTENT_REJECTED');
    await comment(a.token, p.id, '   ').expect(400);
    await comment(a.token, p.id, '长'.repeat(501)).expect(400);
    await comment(a.token, 'pst_ghost', '你好').expect(404);
    await comment(a.token, p.id, '回复不存在的评论', 'cmt_ghost').expect(404);
  });

  it('删除：评论作者或作品作者可删；删除顶层评论连同回复；撤回的作品不能再评论', async () => {
    const author = await login(t);
    const a = await login(t);
    const b = await login(t);
    const p = await post(author.token);
    const c1 = (await comment(a.token, p.id, '第一条').expect(201)).body;
    await comment(b.token, p.id, '回复一', c1.id).expect(201);
    const c2 = (await comment(b.token, p.id, '第二条').expect(201)).body;
    expect(await count(a.token, p.id)).toBe(3);

    await t.http().delete(`/v1/comments/${c2.id}`).set(auth(a.token)).expect(403);
    await t.http().delete(`/v1/comments/${c2.id}`).set(auth(author.token)).expect(204); // 作品作者可删
    await t.http().delete(`/v1/comments/${c1.id}`).set(auth(a.token)).expect(204); // 评论作者可删，回复一并删除
    expect(await count(a.token, p.id)).toBe(0);
    expect((await thread(a.token, p.id)).data).toEqual([]);
    await t.http().delete(`/v1/comments/${c1.id}`).set(auth(a.token)).expect(404);

    await t.http().delete(`/v1/posts/${p.id}`).set(auth(author.token)).expect(204);
    await comment(a.token, p.id, '还在吗').expect(404);
    await t.http().get(`/v1/posts/${p.id}/comments`).set(auth(a.token)).expect(404);
  });

  it('举报评论：累计 3 人自动隐藏并进入后台复核；通过恢复、下架删除', async () => {
    const author = await login(t);
    const bad = await login(t);
    const p = await post(author.token);
    const c = (await comment(bad.token, p.id, '加我私聊领福利').expect(201)).body;
    const c2 = (await comment(bad.token, p.id, '再来一条广告').expect(201)).body;
    await t.http().post('/v1/reports').set(auth(bad.token)).send({ target_type: 'comment', target_id: c.id, reason: 'ad' }).expect(400);
    for (const id of [c.id, c2.id]) {
      for (let i = 0; i < 3; i++) {
        const r = await login(t);
        await t.http().post('/v1/reports').set(auth(r.token)).send({ target_type: 'comment', target_id: id, reason: 'ad' }).expect(201);
      }
    }
    expect((await thread(author.token, p.id)).data).toEqual([]);
    expect(await count(author.token, p.id)).toBe(0);

    const user = await login(t);
    await t.http().get('/v1/admin/comment-reviews').set(auth(user.token)).expect(403);
    const admin = await login(t, ADMIN);
    const queue = (await t.http().get('/v1/admin/comment-reviews').set(auth(admin.token)).expect(200)).body.data;
    const item = queue.find((x: { comment: { id: string } }) => x.comment.id === c.id);
    expect(item).toMatchObject({ post: { id: p.id }, report_count: 3, reasons: [{ reason: 'ad', count: 3 }], comment: { status: 'hidden', body: '加我私聊领福利' } });

    await t.http().post(`/v1/admin/comments/${c.id}/decision`).set(auth(admin.token)).send({ action: 'approve' }).expect(204);
    await t.http().post(`/v1/admin/comments/${c2.id}/decision`).set(auth(admin.token)).send({ action: 'remove', note: '广告' }).expect(204);
    await t.http().post(`/v1/admin/comments/${c2.id}/decision`).set(auth(admin.token)).send({ action: 'remove' }).expect(409);
    expect((await thread(author.token, p.id)).data.map((x: { id: string }) => x.id)).toEqual([c.id]);
    expect(await count(author.token, p.id)).toBe(1);
    const [rep] = await t.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM reports WHERE target_id = $1 AND status = 'resolved'`, [c2.id]);
    expect(rep.n).toBe(3);
  });

  it('关注：关注 / 取消（幂等）、不能关注自己、创作者主页统计、关注流、作品带关注状态', async () => {
    const creator = await login(t);
    const fan = await login(t);
    const other = await login(t);
    const p1 = await post(creator.token, '作品一');
    await post(other.token, '别人的作品');
    await t.http().put(`/v1/posts/${p1.id}/like`).set(auth(fan.token)).expect(200);

    expect((await t.http().get('/v1/feed?tab=following').set(auth(fan.token)).expect(200)).body.data).toEqual([]);
    await t.http().put(`/v1/creators/${fan.userId}/follow`).set(auth(fan.token)).expect(400);
    await t.http().put('/v1/creators/usr_ghost/follow').set(auth(fan.token)).expect(404);
    const c = (await t.http().put(`/v1/creators/${creator.userId}/follow`).set(auth(fan.token)).expect(200)).body;
    expect(c).toMatchObject({ id: creator.userId, follower_count: 1, following_count: 0, post_count: 1, like_count: 1, followed: true, mine: false });
    await t.http().put(`/v1/creators/${creator.userId}/follow`).set(auth(fan.token)).expect(200);
    expect((await t.http().get(`/v1/creators/${fan.userId}`).set(auth(fan.token)).expect(200)).body).toMatchObject({ following_count: 1, mine: true });

    const p2 = await post(creator.token, '作品二');
    const following = (await t.http().get('/v1/feed?tab=following').set(auth(fan.token)).expect(200)).body.data;
    expect(following.map((x: { id: string }) => x.id)).toEqual([p2.id, p1.id]);
    expect(following[0].author).toMatchObject({ id: creator.userId, followed: true });
    // 创作者主页的作品
    const theirs = (await t.http().get(`/v1/feed?author=${creator.userId}`).set(auth(other.token)).expect(200)).body.data;
    expect(theirs.map((x: { id: string }) => x.id)).toEqual([p2.id, p1.id]);
    expect(theirs[0].author.followed).toBe(false);

    expect((await t.http().delete(`/v1/creators/${creator.userId}/follow`).set(auth(fan.token)).expect(200)).body).toMatchObject({ follower_count: 0, followed: false });
    expect((await t.http().get('/v1/feed?tab=following').set(auth(fan.token)).expect(200)).body.data).toEqual([]);
  });

  it('注销匿名化：评论（含其下的回复）删除并同步计数，关注关系清除', async () => {
    const author = await login(t);
    const leaving = await login(t);
    const stay = await login(t);
    const p = await post(author.token);
    const c = (await comment(leaving.token, p.id, '我要走了').expect(201)).body;
    await comment(stay.token, p.id, '一路顺风', c.id).expect(201);
    await comment(stay.token, p.id, '独立的评论').expect(201);
    await t.http().put(`/v1/creators/${author.userId}/follow`).set(auth(leaving.token)).expect(200);
    await t.http().put(`/v1/creators/${leaving.userId}/follow`).set(auth(stay.token)).expect(200);

    await t.db.query(`UPDATE users SET status = 'deleting', deletion_requested_at = now() WHERE id = $1`, [leaving.userId]);
    await t.app.get(AccountService).finalizeDue(new Date(Date.now() + 16 * DAY));
    expect(await count(author.token, p.id)).toBe(1);
    expect((await thread(author.token, p.id)).data.map((x: { body: string }) => x.body)).toEqual(['独立的评论']);
    expect((await t.http().get(`/v1/creators/${author.userId}`).set(auth(author.token)).expect(200)).body.follower_count).toBe(0);
    await t.http().get(`/v1/creators/${leaving.userId}`).set(auth(stay.token)).expect(404);
  });
});
