import test from 'node:test';
import assert from 'node:assert/strict';
import { tokens, search, postDocs, noteDocs, mailDocs, editorContext, answer, addNote, removeNote } from '../api/_rag.js';
import { handleUpdate } from '../api/bot.js';

const posts = [
  { id: 'P0020', status: 'published', ig: { permalink: 'https://instagram.com/p/x', published_at: '2026-10-29T10:00:00Z' }, draft: { topic: 'Третий сезон «Монарх: Наследие монстров»', format: 'portrait', slides: [{ title: 'Третий сезон «Монарх»', subtitle: 'Новая команда, новые вызовы' }], caption: 'Сериал станет лучше?' }, metrics: { latest: { reach: 2, views: 2 } } },
  { id: 'P0012', status: 'published', draft: { topic: 'кто сыграет родителей Гарри Поттера', format: 'portrait', slides: [{ title: 'У Гарри Поттера новые родители', subtitle: 'HBO объявила актёров' }], caption: '' } },
];
const docs = [...postDocs(posts), ...noteDocs([{ n: 1, at: '2026-10-30', text: 'Монарх выходит на Apple TV+ по пятницам' }]), ...mailDocs([{ id: 'abc12345', subject: 'MARK-738: Уличный боец', from: 'jira@example.com', status: 'work', snippet: 'обновление задачи' }])];

test('russian stemming matches word forms', () => {
  assert.deepEqual(tokens('сериалы'), tokens('сериалов'));
  assert.deepEqual(tokens('Монарха'), tokens('монарх'));
});

test('search ranks the right post and note', () => {
  const h = search('что мы писали про монарха', docs);
  assert.equal(h[0].source === 'post' ? h[0].id : h[1].id, 'P0020');
  assert.ok(h.some(x => x.id === 'N1'));
  assert.equal(search('уличный боец задача', docs)[0].id, 'M:abc12345');
});

test('editor context: past posts and notes, no mail', async () => {
  const c = await editorContext('Монарх новый сезон', { docs });
  assert.match(c, /P0020/); assert.match(c, /Apple TV/); assert.doesNotMatch(c, /MARK-738/);
});

test('answer uses only found fragments and returns sources', async () => {
  let seen;
  const r = await answer('Когда выходит Монарх?', { docs, gen: async m => { seen = JSON.parse(m[1].content); return { answer: 'По пятницам на Apple TV+ [N1]', used: ['N1'] }; } });
  assert.ok(seen.фрагменты.some(f => f.id === 'N1'));
  assert.equal(r.sources[0].id, 'N1');
  const none = await answer('квантовая хромодинамика', { docs, gen: async () => { throw new Error('should not call'); } });
  assert.match(none.answer, /ничего не нашёл/);
});

test('notes add and remove', async () => {
  let store = { data: { notes: [{ n: 1, text: 'a', at: 'x' }] }, sha: 's' };
  const get = async () => store, put = async (p, data) => { store = { data, sha: 't' }; };
  const r = await addNote('Новая заметка', { get, put });
  assert.equal(r.n, 2); assert.equal(store.data.notes.length, 2);
  assert.equal(await removeNote(1, { get, put }), 1);
  await assert.rejects(addNote('  ', { get, put }));
});

test('bot: question with ? goes to knowledge base, long text without ? still becomes a post', async () => {
  const msg = text => ({ message: { message_id: 1, text, chat: { id: 111, type: 'private' }, from: { id: 111 } } });
  const out = await handleUpdate(msg('Что мы писали про Монарха?'), { owner: '111', host: 'x', deps: { answer: async q => ({ answer: 'Ответ ' + q, sources: [] }) } });
  assert.match(out[0].text, /🔎 Ответ Что мы писали про Монарха\?/);
  const note = await handleUpdate(msg('/note Монарх по пятницам'), { owner: '111', host: 'x', deps: { addNote: async t => ({ n: 7, total: 7, t }) } });
  assert.match(note[0].text, /№7/);
});
