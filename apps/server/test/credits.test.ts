import { addDays } from '../src/common/time';
import { makeApp, type TestApp } from './helpers';

describe('积分账务', () => {
  let t: TestApp;
  let n = 0;

  beforeAll(async () => {
    t = await makeApp();
  });
  afterAll(() => t.close());

  /** 新建一个只有指定批次的账户 */
  async function account(grants: { amount: number; days: number }[]) {
    const userId = `usr_test${n++}`;
    await t.db.query(`INSERT INTO users (id, nickname, phone_enc, phone_hash, phone_last4) VALUES ($1, 'x', 'x', $1, '0000')`, [userId]);
    const acc = await t.credits.accountIdFor(userId);
    for (const g of grants) {
      await t.db.tx((q) => t.credits.grant(q, acc, { amount: g.amount, source: 'admin', expiresAt: addDays(new Date(), g.days), memo: 'test' }));
    }
    return acc;
  }

  const grantsOf = async (acc: string) =>
    (await t.db.query<{ amount: number; remaining: number }>('SELECT amount, remaining FROM credit_grants WHERE account_id = $1 ORDER BY expires_at', [acc])).map((g) => g.remaining);

  it('冻结按"先过期先扣"拆分到多个批次', async () => {
    const acc = await account([
      { amount: 10, days: 1 },
      { amount: 50, days: 30 },
    ]);
    await t.db.tx((q) => t.credits.freeze(q, acc, 25, 'tsk_a', 'test'));
    expect(await grantsOf(acc)).toEqual([0, 35]);
    expect(await t.credits.balance(acc)).toMatchObject({ available: 35, frozen: 25 });
    expect((await t.credits.reconcile(acc)).ok).toBe(true);
  });

  it('结算按实际消耗扣除，差额退回有效期最长的批次', async () => {
    const acc = await account([
      { amount: 10, days: 1 },
      { amount: 50, days: 30 },
    ]);
    await t.db.tx((q) => t.credits.freeze(q, acc, 25, 'tsk_b', 'test'));
    const charged = await t.db.tx((q) => t.credits.settle(q, acc, 'tsk_b', 20, 'test'));
    expect(charged).toBe(20);
    expect(await grantsOf(acc)).toEqual([0, 40]);
    expect(await t.credits.balance(acc)).toMatchObject({ available: 40, frozen: 0 });
    // 重复结算不产生副作用
    expect(await t.db.tx((q) => t.credits.settle(q, acc, 'tsk_b', 20, 'test'))).toBe(0);
    expect((await t.credits.reconcile(acc)).ok).toBe(true);
  });

  it('退回把积分还给原批次，且只退一次', async () => {
    const acc = await account([
      { amount: 10, days: 1 },
      { amount: 50, days: 30 },
    ]);
    await t.db.tx((q) => t.credits.freeze(q, acc, 25, 'tsk_c', 'test'));
    expect(await t.db.tx((q) => t.credits.refund(q, acc, 'tsk_c', 'test'))).toBe(25);
    expect(await t.db.tx((q) => t.credits.refund(q, acc, 'tsk_c', 'test'))).toBe(0);
    expect(await grantsOf(acc)).toEqual([10, 50]);
    expect((await t.credits.reconcile(acc)).ok).toBe(true);
  });

  it('余额不足时拒绝冻结，事务内不留下任何变动', async () => {
    const acc = await account([{ amount: 10, days: 1 }]);
    await expect(t.db.tx((q) => t.credits.freeze(q, acc, 11, 'tsk_d', 'test'))).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS', details: { required: 11, available: 10 } });
    expect(await t.credits.balance(acc)).toMatchObject({ available: 10, frozen: 0 });
  });

  it('过期批次的剩余积分失效，冻结中的部分不受影响', async () => {
    const acc = await account([
      { amount: 10, days: 1 },
      { amount: 5, days: 3 },
    ]);
    await t.db.tx((q) => t.credits.freeze(q, acc, 4, 'tsk_e', 'test'));
    const expired = await t.db.tx((q) => t.credits.expireAccount(q, acc, addDays(new Date(), 2)));
    expect(expired).toBe(6);
    expect(await t.credits.balance(acc)).toMatchObject({ available: 5, frozen: 4 });
    expect((await t.credits.reconcile(acc)).ok).toBe(true);
  });

  it('带幂等键的发放只生效一次', async () => {
    const acc = await account([]);
    const g = () => t.db.tx((q) => t.credits.grant(q, acc, { amount: 7, source: 'pack', expiresAt: addDays(new Date(), 1), memo: 'x', idemKey: 'order:1' }));
    expect(await g()).toBe(true);
    expect(await g()).toBe(false);
    expect((await t.credits.balance(acc)).available).toBe(7);
  });

  it('随机操作序列后四方对账始终一致', async () => {
    const acc = await account([
      { amount: 40, days: 2 },
      { amount: 60, days: 20 },
      { amount: 25, days: 9 },
    ]);
    let seed = 42;
    const rand = (k: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % k;
    };
    const open: string[] = [];
    for (let i = 0; i < 60; i++) {
      const op = rand(3);
      if (op === 0 || open.length === 0) {
        const id = `tsk_r${i}`;
        const amount = 1 + rand(15);
        const ok = await t.db.tx((q) => t.credits.freeze(q, acc, amount, id, 'r')).then(
          () => true,
          () => false,
        );
        if (ok) open.push(id);
      } else {
        const id = open.splice(rand(open.length), 1)[0];
        if (op === 1) await t.db.tx((q) => t.credits.settle(q, acc, id, rand(10), 'r'));
        else await t.db.tx((q) => t.credits.refund(q, acc, id, 'r'));
      }
      const r = await t.credits.reconcile(acc);
      if (!r.ok) throw new Error(`第 ${i} 步对账失败：${JSON.stringify(r)}`);
    }
  });
});
