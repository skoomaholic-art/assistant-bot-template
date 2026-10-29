import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyInitData, authorize, applyAction, editCard, addReason, publicView, sortKeys, ReviewError, ghGetJson, ghPutJson } from '../api/_lib.js';
import { mutate } from '../api/review.js';

const TOKEN = '123456:ABC_test-token';
function sign(user, { token = TOKEN, authDate = Math.floor(Date.now() / 1000) } = {}) {
  const params = new URLSearchParams({ auth_date: String(authDate), query_id: 'q1', user: JSON.stringify(user) });
  const dcs = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}
const state = () => ({
  schema_version: 1, last_update_id: 7, decisions: [],
  items: [
    { id: 'R0001', kind: 'post', status: 'pending', topic: 'Кино', proposed_text: 'Черновик' },
    { id: 'R0002', kind: 'reply', status: 'pending', target_username: '@Aika_St', proposed_text: 'Ответ' },
    { id: 'R0003', kind: 'reply', status: 'approved', proposed_text: 'Готово' },
  ],
});
const withEnv = (vars, fn) => {
  const old = {}; for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  let out; try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore(); return out;
  function restore() { for (const k of Object.keys(old)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } }
};

test('initData: valid signature accepted, forged or stale rejected', () => {
  const data = sign({ id: 42, first_name: 'A' });
  assert.equal(verifyInitData(data, TOKEN).id, 42);
  assert.equal(verifyInitData(data, '999:other'), null);
  assert.equal(verifyInitData(data.replace('%22id%22%3A42', '%22id%22%3A43'), TOKEN), null);
  assert.equal(verifyInitData(sign({ id: 42 }, { authDate: Math.floor(Date.now() / 1000) - 2 * 86400 }), TOKEN), null);
  assert.equal(verifyInitData('', TOKEN), null);
});

test('authorize: only owner; without owner returns own id for setup', () => {
  withEnv({ TG_BOT_TOKEN: TOKEN, TG_OWNER_CHAT_ID: '42' }, () => {
    assert.equal(authorize(sign({ id: 42 })).id, 42);
    assert.throws(() => authorize(sign({ id: 7 })), e => e.code === 403);
    assert.throws(() => authorize('hash=bad'), e => e.code === 401);
  });
  withEnv({ TG_BOT_TOKEN: TOKEN, TG_OWNER_CHAT_ID: null }, () => {
    assert.throws(() => authorize(sign({ id: 7 })), e => e.code === 503 && e.selfId === '7');
  });
});

test('approve only records the decision; repeat is refused', () => {
  const s = state();
  applyAction(s, 'R0001', 'approve', 42, 't');
  assert.equal(s.items[0].status, 'approved');
  assert.equal(s.decisions[0].decision, 'approve');
  assert.equal(s.decisions[0].via, 'mini_app');
  assert.throws(() => applyAction(s, 'R0001', 'approve', 42), ReviewError);
  assert.throws(() => applyAction(s, 'R0001', 'publish', 42), ReviewError);
});

test('blocked account: hidden from view and every action refused', () => {
  const s = state();
  assert.deepEqual(publicView(s).cards.map(c => c.id), ['R0001']);
  for (const a of ['approve', 'reject', 'revise']) assert.throws(() => applyAction(s, 'R0002', a, 42), e => e.code === 403);
  assert.throws(() => editCard(s, 'R0002', 'x', 42), e => e.code === 403);
});

test('revise → edit returns card to pending and keeps old/new text; reason needs a decision', () => {
  const s = state();
  assert.throws(() => addReason(s, 'R0001', 'нет решения'), ReviewError);
  mutate(s, { id: 'R0001', action: 'revise' }, 42);
  assert.equal(s.items[0].status, 'needs_revision');
  mutate(s, { id: 'R0001', action: 'edit', text: '  Новый текст ' }, 42);
  assert.equal(s.items[0].status, 'pending');
  assert.equal(s.items[0].proposed_text, 'Новый текст');
  const last = s.decisions.at(-1);
  assert.equal(last.draft, 'Черновик'); assert.equal(last.owner_revision, 'Новый текст');
  mutate(s, { id: 'R0001', action: 'why', text: 'слабое начало' }, 42);
  assert.equal(s.decisions.at(-1).decision, 'owner_reason');
  assert.throws(() => editCard(s, 'R0001', 'x'.repeat(2001), 42), ReviewError);
  assert.throws(() => editCard(s, 'R0003', 'x', 42), ReviewError);
});

test('GitHub bridge: reads base64 JSON, writes with sha, maps conflict to 409, keeps bot cursor', async () => {
  await withEnv({ IGM_BRIDGE_TOKEN: 'github_pat_x' }, async () => {
    const s = state();
    const calls = [];
    const fake = async (url, opts = {}) => {
      calls.push({ url, opts });
      if (!opts.method) return { ok: true, status: 200, json: async () => ({ sha: 'abc', content: Buffer.from(JSON.stringify(s)).toString('base64') }) };
      const body = JSON.parse(opts.body);
      if (body.sha !== 'abc') return { ok: false, status: 409 };
      return { ok: true, status: 200, json: async () => ({ content: { sha: 'def' } }) };
    };
    const { data, sha } = await ghGetJson('data/telegram/review-queue.json', fake);
    assert.equal(sha, 'abc'); assert.equal(data.last_update_id, 7);
    assert.equal(await ghPutJson('data/telegram/review-queue.json', data, 'abc', 'm', fake), 'def');
    const written = JSON.parse(Buffer.from(JSON.parse(calls[1].opts.body).content, 'base64').toString());
    assert.equal(written.last_update_id, 7);
    assert.match(calls[1].opts.headers.Authorization, /^Bearer github_pat_x$/);
    await assert.rejects(ghPutJson('x', data, 'stale', 'm', fake), e => e.code === 409);
  });
  await withEnv({ IGM_BRIDGE_TOKEN: null }, () => assert.rejects(ghGetJson('x', async () => ({})), e => e.code === 503));
});

test('sortKeys matches Python sort_keys ordering', () => {
  assert.deepEqual(Object.keys(sortKeys({ b: 1, a: { d: 1, c: 2 } })), ['a', 'b']);
  assert.deepEqual(Object.keys(sortKeys({ a: { d: 1, c: 2 } }).a), ['c', 'd']);
});

import { buildAnalytics, buildPlan } from '../api/_lib.js';
const snap = (date, followers, media = []) => ({ schema_version: 1, date_almaty: date, captured_at_utc: date + 'T00:00:00+00:00', insights_status: 'not_configured', account: { username: 'mybrand', followers_count: followers, media_count: media.length }, media });

test('analytics: growth deltas, averages, nulls instead of zeros', () => {
  const media = [
    { id: '1', media_type: 'IMAGE', timestamp: '2026-10-27T10:00:00+0000', like_count: 10, comments_count: 2 },
    { id: '2', media_type: 'VIDEO', timestamp: '2026-10-20T10:00:00+0000', like_count: 30, comments_count: 0 },
  ];
  const a = buildAnalytics([snap('2026-10-01', 50), snap('2026-10-21', 80), snap('2026-10-28', 100, media)],
    { decisions: [{ decision: 'approve', kind: 'post' }, { decision: 'reject', kind: 'post' }, { decision: 'edit', kind: 'post' }] },
    Date.parse('2026-10-28T12:00:00Z'));
  assert.equal(a.account.followers, 100);
  assert.equal(a.growth.d7, 20);
  assert.equal(a.growth.d30, 50);
  assert.equal(a.posts.avg_likes, 20);
  assert.equal(a.posts.top[0].id, '2');
  assert.equal(a.posts.last_7d, 1);
  assert.equal(a.posts.recent[0].er, 12);
  assert.equal(a.insights.reach, null);
  assert.equal(a.review.posts_reviewed, 2);
  assert.equal(a.review.posts_approval_rate, 50);
  assert.equal(a.review.edits, 1);
});

test('analytics: single snapshot has no growth and empty history is safe', () => {
  const one = buildAnalytics([snap('2026-10-28', 0)], null);
  assert.equal(one.growth.d7, null);
  assert.equal(one.posts.avg_er, null);
  assert.equal(buildAnalytics([], null).account, null);
});

test('plan: stages pass through, progress capped, gates use reviewed counts', () => {
  const plan = { schema_version: 1, goal: 'g', stages: [{ id: 'S1', title: 'T', status: 'done', tasks: [{ title: 'x', done: true }] }],
    experiment: { title: 'E', total: { posts: 20 }, weeks: [], kpis: [], slots_almaty: [] }, autonomy_gates: { reviewed_posts: 20, approved_comment_examples: 30 } };
  const p = buildPlan(plan, { posts: [{ id: 'D01', format: 'Reel', title: 't' }] }, { account: { media_count: 25 }, review: { posts_reviewed: 3, comments_reviewed: 1 } });
  assert.equal(p.experiment.progress, 20);
  assert.deepEqual(p.gates.posts, { need: 20, have: 3 });
  assert.equal(p.ideas.length, 1);
  assert.equal(buildPlan(null, null, null), null);
});

import { toggleTask, recomputeStages } from '../api/_lib.js';
const planFixture = () => ({ schema_version: 1, stages: [
  { id: 'S1', status: 'done', tasks: [{ title: 'a', done: true }] },
  { id: 'S2', status: 'in_progress', tasks: [{ title: 'b', done: true }, { title: 'c', done: false }] },
  { id: 'S3', status: 'todo', tasks: [{ title: 'd', done: false }] },
  { id: 'S6', status: 'in_progress', tasks: [{ title: 'snap', auto: 'snapshots' }, { title: 'ins', auto: 'insights' }] },
  { id: 'S7', status: 'locked', tasks: [] },
] });

test('plan: tapping last task closes stage; reopening returns it to work', () => {
  const p = planFixture();
  toggleTask(p, 'S2', 1, true, '2026-10-28T03:00:00+00:00');
  assert.equal(p.stages[1].status, 'done');
  assert.equal(p.stages[1].tasks[1].done_by, 'owner');
  toggleTask(p, 'S2', 1, false);
  assert.equal(p.stages[1].status, 'in_progress');
  assert.equal(p.stages[1].tasks[1].done_at, undefined);
  assert.throws(() => toggleTask(p, 'S6', 0, true), /автоматически/);
  assert.throws(() => toggleTask(p, 'S9', 0, true), /не найдена/);
});

test('plan: next todo stage becomes current when none in progress', () => {
  const st = recomputeStages([{ id: 'A', status: 'done', tasks: [{ done: true }] }, { id: 'B', status: 'todo', tasks: [{ done: false }] }]);
  assert.equal(st[1].status, 'in_progress');
});

test('plan: auto tasks close from analytics', () => {
  const p = buildPlan(planFixture(), null, { growth: { days: 1 }, insights: { available: false }, posts: { by_type: {} }, review: {} });
  const s6 = p.stages.find(s => s.id === 'S6');
  assert.deepEqual(s6.tasks.map(t => t.done), [true, false]);
  assert.equal(s6.tasks[0].auto, 'snapshots');
  const p2 = buildPlan(planFixture(), null, { growth: { days: 3 }, insights: { available: true }, posts: { by_type: {} }, review: {} });
  assert.equal(p2.stages.find(s => s.id === 'S6').status, 'done');
});
