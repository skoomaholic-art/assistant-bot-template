import test from 'node:test';
import assert from 'node:assert/strict';
import { handleUpdate, isOwnerUpdate, sameSecret, mainKeyboard } from '../api/bot.js';

const OWNER = '42';
const queue = () => ({ schema_version: 1, last_update_id: 0, decisions: [], items: [
  { id: 'R0001', kind: 'post', status: 'pending', topic: 'Кино', proposed_text: 'Черновик' },
  { id: 'R0002', kind: 'reply', status: 'pending', target_username: 'aika_st', proposed_text: 'Нет' },
] });
function deps(state = queue()) {
  const puts = [];
  return { puts, state, get: async () => ({ data: JSON.parse(JSON.stringify(state)), sha: 's' }), put: async (p, data) => { puts.push(data); Object.assign(state, data); return 's2'; } };
}
const msg = (text, from = 42, chat = 42, type = 'private') => ({ update_id: 1, message: { text, from: { id: from }, chat: { id: chat, type } } });
const cb = data => ({ update_id: 2, callback_query: { id: 'c', data, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } });
const ctx = d => ({ owner: OWNER, host: 'app.vercel.app', deps: d });

test('only owner in private chat is served', async () => {
  assert.equal(isOwnerUpdate(msg('/start'), OWNER), true);
  assert.equal(isOwnerUpdate(msg('/start', 7, 7), OWNER), false);
  assert.equal(isOwnerUpdate(msg('/start', 42, -100, 'group'), OWNER), false);
  assert.deepEqual(await handleUpdate(msg('/start', 7, 7), ctx(deps())), []);
});

test('/start shows Instagram Manager and the cover studio', async () => {
  const [a] = await handleUpdate(msg('/start'), ctx(deps()));
  assert.match(a.text, /Instagram Manager/);
  assert.equal(a.keyboard[0][0].web_app.url, 'https://app.vercel.app/?section=ig');
  assert.equal(a.keyboard[0].length, 1);
  assert.equal(a.keyboard[1][0].web_app.url, 'https://app.vercel.app/cover-studio/');
});

test('/pending hides blocked account; approve callback writes decision', async () => {
  const d = deps();
  const list = await handleUpdate(msg('/pending'), ctx(d));
  assert.equal(list.length, 1);
  assert.match(list[0].text, /R0001/);
  const r = await handleUpdate(cb('review:R0001:approve'), ctx(d));
  assert.equal(r[0].type, 'ack');
  assert.equal(d.puts.length, 1);
  assert.equal(d.state.items[0].status, 'approved');
  const again = await handleUpdate(cb('review:R0001:approve'), ctx(d));
  assert.match(again[0].text, /уже решена/);
  const blocked = await handleUpdate(cb('review:R0002:approve'), ctx(d));
  assert.match(blocked[0].text, /запрещено/);
  assert.equal(d.puts.length, 1);
});

test('/edit and /why', async () => {
  const d = deps();
  const e = await handleUpdate(msg('/edit R0001 Новый текст'), ctx(d));
  assert.match(e[0].text, /Новый текст/);
  await handleUpdate(cb('review:R0001:reject'), ctx(d));
  const w = await handleUpdate(msg('/why R0001 скучно'), ctx(d));
  assert.match(w[0].text, /записана/);
  assert.equal(d.state.decisions.at(-1).decision, 'owner_reason');
  const bad = await handleUpdate(msg('/edit'), ctx(d));
  assert.match(bad[0].text, /Используй/);
});

test('secret comparison', () => {
  assert.equal(sameSecret('abc', 'abc'), true);
  assert.equal(sameSecret('abc', 'abd'), false);
  assert.equal(sameSecret('', ''), false);
  assert.equal(mainKeyboard('h').length, 3);
  assert.equal(mainKeyboard('h')[1][0].web_app.url, 'https://h/cover-studio/');
});
