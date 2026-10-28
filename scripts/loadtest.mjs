#!/usr/bin/env node
// 压测脚本（只依赖 Node 22 内置 fetch）：并发提交生成任务或调用读接口，压测结束后触发一次全量对账。
//
//   node scripts/loadtest.mjs --base http://localhost:8080 --scenario submit --users 200 --concurrency 100 --duration 30
//   node scripts/loadtest.mjs --base http://localhost:8080 --scenario read --users 50 --concurrency 100 --duration 30
//   加 --sse true 时每个用户保持一条服务端推送连接（与真实用户一致），并统计收到的事件
//   node scripts/loadtest.mjs --base http://localhost:8080 --scenario mix --users 20 --mix video:1,image:3,text:8
//   mix：每个用户按比例提交一批不同模态的任务，等待全部结束，按模态统计从提交到结束的耗时（考察 Worker 容量）；
//   加 --shuffle true 时每个用户的任务随机交错提交（接近真实到达顺序），否则按 --mix 中的模态顺序提交
//
// 需要目标环境：短信为开发模式（验证码随响应返回）、设置了 ADMIN_PHONES（用于对账）；
// 压测提交接口时调高 GENERATION_RATE_PER_MIN / MAX_INFLIGHT_TASKS，否则会被按用户限流。
// 每个新用户有 120 积分，submit 场景提交 1 积分的文本任务。

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(' ')
    .split('--')
    .filter(Boolean)
    .map((s) => s.trim().split(/\s+/))
    .map(([k, v]) => [k, v ?? 'true']),
);
const BASE = (args.base ?? 'http://localhost:8080').replace(/\/$/, '');
const SCENARIO = args.scenario ?? 'submit';
const USERS = Number(args.users ?? 100);
const CONCURRENCY = Number(args.concurrency ?? 50);
const DURATION = Number(args.duration ?? 30) * 1000;
const ADMIN = args.admin ?? process.env.LOADTEST_ADMIN_PHONE;
const SSE = args.sse === 'true';
const MIX = (args.mix ?? 'video:1,image:3,text:8').split(',').map((s) => s.split(':')).map(([m, n]) => [m, Number(n)]);
const MIX_PARAMS = { video: { duration: 5 }, image: { count: 1 }, text: {}, audio: {} };

async function request(method, path, token, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function login(phone) {
  const sent = await request('POST', '/v1/auth/sms/send', null, { phone });
  if (!sent.data?.dev_code) throw new Error(`获取验证码失败（${sent.status}）：目标环境需要 SMS_MODE=dev`);
  const r = await request('POST', '/v1/auth/sms/login', null, { phone, code: sent.data.dev_code });
  if (r.status !== 200) throw new Error(`登录失败（${r.status}）`);
  return r.data.access_token;
}

/** 打开一条推送连接，按事件类型计数；返回用于断开的 AbortController */
async function openStream(token, counts) {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/v1/events?access_token=${token}`, { signal: ctrl.signal, headers: { accept: 'text/event-stream' } });
  if (res.status !== 200) throw new Error(`推送连接失败（${res.status}）`);
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const type = /"type":"([a-z.]+)"/.exec(buf.slice(0, i))?.[1];
          if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
          buf = buf.slice(i + 2);
        }
      }
    } catch {}
  })();
  return ctrl;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

async function main() {
  console.log(`目标 ${BASE} · 场景 ${SCENARIO} · 用户 ${USERS} · 并发 ${CONCURRENCY} · 时长 ${DURATION / 1000}s`);
  const prefix = `19${String(Date.now()).slice(-5)}`;
  const tokens = [];
  for (let i = 0; i < USERS; i += 20) {
    const batch = Array.from({ length: Math.min(20, USERS - i) }, (_, k) => login(`${prefix}${String(i + k).padStart(4, '0')}`));
    tokens.push(...(await Promise.all(batch)));
  }
  console.log(`已登录 ${tokens.length} 个用户`);
  if (SCENARIO === 'mix') return mix(tokens);
  const events = new Map();
  const streams = SSE ? await Promise.all(tokens.map((t) => openStream(t, events))) : [];
  if (SSE) console.log(`已建立 ${streams.length} 条推送连接`);

  const latencies = [];
  const codes = new Map();
  let seq = 0;
  const end = Date.now() + DURATION;
  const started = Date.now();

  async function once(worker) {
    const token = tokens[(worker + seq) % tokens.length];
    const n = seq++;
    const t0 = performance.now();
    let r;
    if (SCENARIO === 'submit') {
      r = await request('POST', '/v1/generations', token, { modality: 'text', prompt: `压测文案 ${n}`, params: { chars: 800 } }, { 'idempotency-key': `load-${prefix}-${n}` });
    } else {
      const paths = ['/v1/me', '/v1/generations?limit=20', '/v1/assets?limit=50', '/v1/feed?tab=recommend', '/v1/credits/ledger'];
      r = await request('GET', paths[n % paths.length], token);
    }
    latencies.push(performance.now() - t0);
    const key = r.status < 300 ? String(r.status) : `${r.status} ${r.data?.error?.code ?? ''}`.trim();
    codes.set(key, (codes.get(key) ?? 0) + 1);
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async (_, w) => {
      while (Date.now() < end) {
        try {
          await once(w);
        } catch (e) {
          codes.set(`network ${e.cause?.code ?? e.message}`, (codes.get(`network ${e.cause?.code ?? e.message}`) ?? 0) + 1);
        }
      }
    }),
  );

  const elapsed = (Date.now() - started) / 1000;
  const sorted = latencies.sort((a, b) => a - b);
  const ok = [...codes].filter(([k]) => /^2/.test(k)).reduce((a, [, v]) => a + v, 0);
  console.log(`\n请求 ${sorted.length} 次，成功 ${ok} 次，耗时 ${elapsed.toFixed(1)}s`);
  console.log(`吞吐 ${(sorted.length / elapsed).toFixed(1)} 次/秒（成功 ${(ok / elapsed).toFixed(1)} 次/秒）`);
  console.log(`延迟 p50 ${pct(sorted, 50).toFixed(0)}ms · p95 ${pct(sorted, 95).toFixed(0)}ms · p99 ${pct(sorted, 99).toFixed(0)}ms · 最大 ${sorted.at(-1)?.toFixed(0) ?? 0}ms`);
  console.log('状态码：', Object.fromEntries(codes));
  if (SSE) {
    await new Promise((r) => setTimeout(r, 3000));
    streams.forEach((c) => c.abort());
    console.log('推送事件：', Object.fromEntries(events));
  }

  if (ADMIN) {
    const admin = await login(ADMIN);
    const rec = await request('POST', '/v1/admin/reconcile/run', admin, {});
    if (rec.status !== 200) console.log(`对账请求失败（${rec.status}）`);
    else console.log(`对账：${rec.data.accounts} 个账户，不一致 ${rec.data.mismatches}，残留冻结 ${rec.data.stale_holds}`);
    if (rec.data?.mismatches || rec.data?.stale_holds) process.exitCode = 1;
  }
}

/** 混合模态：提交一批任务后等待全部结束，用服务端的 created_at / finished_at 统计 */
async function mix(tokens) {
  const started = Date.now();
  const ids = (
    await Promise.all(
      tokens.map(async (token, u) => {
        const mine = [];
        const plan = MIX.flatMap(([modality, n]) => Array.from({ length: n }, (_, i) => [modality, i]));
        if (args.shuffle === 'true') {
          for (let i = plan.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [plan[i], plan[j]] = [plan[j], plan[i]];
          }
        }
        for (const [modality, i] of plan) {
          const r = await request('POST', '/v1/generations', token, { modality, prompt: `混合压测 ${modality} ${u}-${i}`, params: MIX_PARAMS[modality] ?? {} }, { 'idempotency-key': `mix-${started}-${u}-${modality}-${i}` });
          if (r.status !== 202) throw new Error(`提交失败（${r.status} ${r.data?.error?.code ?? ''}）`);
          mine.push(r.data.id);
        }
        return { token, ids: mine };
      }),
    )
  ).filter((x) => x.ids.length);
  const total = ids.reduce((a, x) => a + x.ids.length, 0);
  console.log(`已提交 ${total} 个任务（${MIX.map(([m, n]) => `${m}×${n}`).join('、')} / 用户），用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

  const done = new Map();
  while (done.size < total) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const { token, ids: mine } of ids) {
      if (mine.every((id) => done.has(id))) continue;
      const page = await request('GET', '/v1/generations?limit=50', token);
      for (const t of page.data?.data ?? []) if (mine.includes(t.id) && t.finished_at) done.set(t.id, t);
    }
    if (Date.now() - started > 30 * 60_000) throw new Error('30 分钟内没有全部结束');
  }
  const all = [...done.values()];
  const first = Math.min(...all.map((t) => Date.parse(t.created_at)));
  const last = Math.max(...all.map((t) => Date.parse(t.finished_at)));
  console.log(`\n全部结束：${total} 个任务，总耗时 ${((last - first) / 1000).toFixed(1)}s，吞吐 ${(total / ((last - first) / 1000)).toFixed(2)} 个/秒`);
  for (const [modality] of MIX) {
    const ts = all.filter((t) => t.modality === modality);
    const d = ts.map((t) => Date.parse(t.finished_at) - Date.parse(t.created_at)).sort((a, b) => a - b);
    const statuses = Object.entries(ts.reduce((a, t) => ({ ...a, [t.status]: (a[t.status] ?? 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join('，');
    console.log(`  ${modality.padEnd(5)} ${String(ts.length).padStart(4)} 个 · 提交到结束 p50 ${(pct(d, 50) / 1000).toFixed(1)}s · p95 ${(pct(d, 95) / 1000).toFixed(1)}s · 最慢 ${((d.at(-1) ?? 0) / 1000).toFixed(1)}s · ${statuses}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
