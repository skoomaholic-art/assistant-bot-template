import test from 'node:test';
import assert from 'node:assert/strict';
import { learn, distillRules, visualDiff, textChanged, emptyLearning, rate } from '../api/_learning.js';
import { handleUpdate } from '../api/bot.js';
import { emptyState, createPost, act, replaceDraft } from '../api/_pipeline.js';

function store() {
  let doc = null, sha = 0;
  return { get doc() { return doc; }, get: async () => ({ data: doc ? JSON.parse(JSON.stringify(doc)) : null, sha: doc ? 's' + sha : null }), put: async (p, d) => { doc = JSON.parse(JSON.stringify(d)); sha++; return 's' + sha; } };
}
const draft = t => ({ format: 'reel', slides: [{ title: t, subtitle: 's' }], caption: 'c' });

test('feedback becomes a rule (AI distill), stats and layout prefs accumulate', async () => {
  const st = store();
  const distill = async (rules, sig) => ({ op: 'add', rule: 'Пиши заголовки без вопросов: ' + sig.feedback });
  await learn({ type: 'text_feedback', post: 'P0001', feedback: 'без вопросов' }, { deps: st, distill });
  assert.deepEqual(st.doc.rules, ['Пиши заголовки без вопросов: без вопросов']);
  await learn({ type: 'stat', key: 'text_first_ok' }, { deps: st, distill });
  await learn({ type: 'stat', key: 'text_changed' }, { deps: st, distill });
  assert.equal(rate(st.doc.stats, 'text_first_ok', 'text_changed'), 50);
  await learn({ type: 'visual_edit', format: 'reel', diff: { titleSize: 120 } }, { deps: st, distill });
  await learn({ type: 'visual_edit', format: 'reel', diff: { theme: 'blue' } }, { deps: st, distill });
  assert.deepEqual(st.doc.visual_prefs.reel, { titleSize: 120, theme: 'blue' });
  assert.equal(st.doc.events.length, 5);
});

test('distill falls back to verbatim rule without AI key', async () => {
  const r = await distillRules(['a rule'], { type: 'text_feedback', feedback: 'короче подпись' }, { key: '' });
  assert.deepEqual(r, { op: 'add', rule: 'короче подпись' });
});

test('diff helpers', () => {
  assert.equal(textChanged(draft('A'), draft('A')), false);
  assert.equal(textChanged(draft('A'), draft('B')), true);
  assert.deepEqual(visualDiff([{ titleSize: 100, theme: 'orange' }], [{ titleSize: 90, theme: 'orange' }]), { titleSize: 100 });
  assert.equal(visualDiff([{ theme: 'x' }], [{ theme: 'x' }]), null);
  assert.equal(emptyLearning().rules.length, 0);
});

test('first-try vs changed stats are derived from post history', () => {
  const s = emptyState();
  const p = createPost(s, { draft: draft('A'), source: {} }, '42');
  act(p, 'approve_text', '42'); assert.equal(p.learn_stat, 'text_first_ok');
  const q = createPost(s, { draft: draft('A'), source: {} }, '42');
  replaceDraft(q, { draft: draft('B') }, '42'); act(q, 'approve_text', '42'); assert.equal(q.learn_stat, 'text_changed');
  q.status = 'final_review'; q.media = { images: ['x'] };
  replaceDraft(q, { draft: draft('C') }, '42'); // правка вёрстки на финале
  act(q, 'approve_text', '42'); q.status = 'final_review'; q.media = { images: ['x'] };
  act(q, 'approve_final', '42'); assert.equal(q.learn_stat, 'final_changed');
});

test('bot /no records reason, /rules shows, /forget removes', async () => {
  const signals = [];
  const l = { ...emptyLearning(), rules: ['Без кликбейта', 'Короткие заголовки'], stats: { text_first_ok: 3, text_changed: 1 } };
  const deps = {
    pipe: async m => m({ ...emptyState(), posts: [{ id: 'P0001', draft: draft('A') }] }),
    learn: async sig => signals.push(sig), loadLearning: async () => l,
    withLearning: async m => m(l),
  };
  const ctx = { owner: '42', host: 'h', deps };
  const msg = text => ({ message: { text, from: { id: 42 }, chat: { id: 42, type: 'private' } } });
  const r1 = await handleUpdate(msg('/no P0001 слишком банально'), ctx);
  assert.equal(signals[0].type, 'reject_reason'); assert.match(r1[0].text, /Учёл/);
  const r2 = await handleUpdate(msg('/rules'), ctx);
  assert.match(r2[0].text, /75%/); assert.match(r2[0].text, /2\. Короткие заголовки/);
  const r3 = await handleUpdate(msg('/forget 1'), ctx);
  assert.match(r3[0].text, /Без кликбейта/); assert.deepEqual(l.rules, ['Короткие заголовки']);
});
