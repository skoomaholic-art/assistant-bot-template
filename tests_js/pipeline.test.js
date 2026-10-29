import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createPost, emptyState, nextId, replaceDraft, sign, verifyMedia, mediaUrl, presetFor, textCard, textButtons, hookSignature } from '../api/_pipeline.js';
import { validHook } from '../api/pipeline-hook.js';
import { handleUpdate } from '../api/bot.js';
import { candidatesFrom, runEditor, recentTopics } from '../api/_editor.js';

const draft = (n = 1, fmt = 'reel') => ({ format: fmt, preset_id: 'cinema_opinion', visual_style: 'noir', slides: Array.from({ length: n }, (_, i) => ({ title: 'Заголовок ' + i, subtitle: 'Подзаголовок' })), caption: 'Подпись', video_script: 'Сценарий', verification_notes: ['проверить дату'] });

test('signature vector matches Python IGM pipeline', () => {
  assert.equal(sign('media/posts/P0001/1.jpg', 1700000000, 'secret'), 'f7f72bbba5fa45c479ebdf23f7d49c8e0d423258');
  const url = mediaUrl('h.app', 'media/posts/P0001/1.jpg', 3600, 'secret', 1700000000000);
  const q = new URL(url).searchParams;
  assert.equal(verifyMedia(q.get('p'), q.get('e'), q.get('s'), 'secret', 1700000000000), true);
  assert.equal(verifyMedia(q.get('p'), q.get('e'), q.get('s'), 'secret', 1700000000000 + 7200 * 1000), false);
  assert.equal(verifyMedia('data/secret.json', q.get('e'), q.get('s'), 'secret', 1700000000000), false);
  assert.equal(verifyMedia(q.get('p'), q.get('e'), q.get('s'), 'other', 1700000000000), false);
});

test('hook signature and freshness', () => {
  const ts = Math.floor(Date.now() / 1000);
  const sig = hookSignature('P0001', 'final_ready', ts, 'k'.repeat(32));
  assert.equal(validHook({ id: 'P0001', event: 'final_ready', ts }, sig, 'k'.repeat(32)), true);
  assert.equal(validHook({ id: 'P0001', event: 'published', ts }, sig, 'k'.repeat(32)), false);
  assert.equal(validHook({ id: 'P0001', event: 'final_ready', ts: ts - 3600 }, hookSignature('P0001', 'final_ready', ts - 3600, 'k'.repeat(32)), 'k'.repeat(32)), false);
});

test('two owner approvals are required, in order', () => {
  const s = emptyState();
  const p = createPost(s, { draft: draft(), source: { kind: 'bot', topic: 'тема' } }, '42');
  assert.equal(p.id, 'P0001'); assert.equal(nextId(s), 'P0002');
  assert.throws(() => act(p, 'approve_final', '42'), /не на согласовании/);
  act(p, 'approve_text', '42');
  assert.equal(p.status, 'rendering');
  assert.throws(() => act(p, 'approve_text', '42'));
  p.status = 'final_review'; p.media = { images: ['media/posts/P0001/1.jpg'] };
  act(p, 'approve_final', '42');
  assert.equal(p.status, 'publishing');
  assert.ok(p.approvals.text.by && p.approvals.final.by);
});

test('redo/retry/reject and draft replace reset approvals', () => {
  const s = emptyState();
  const p = createPost(s, { draft: draft(), source: {} }, '42');
  act(p, 'approve_text', '42'); p.status = 'failed'; p.error = { stage: 'render' };
  act(p, 'retry', '42'); assert.equal(p.status, 'rendering');
  p.status = 'failed'; p.error = { stage: 'publish' }; p.approvals.final = { by: '42' };
  act(p, 'retry', '42'); assert.equal(p.status, 'final_review'); assert.equal(p.approvals.final, undefined);
  replaceDraft(p, { draft: draft(3, 'portrait') }, '42');
  assert.equal(p.status, 'text_review'); assert.deepEqual(p.approvals, {});
  act(p, 'reject', '42'); assert.equal(p.status, 'rejected');
  assert.throws(() => createPost(s, { draft: { slides: [] } }, '42'));
  assert.throws(() => createPost(s, { draft: draft(), pages: [{ bgImage: 'data:image/png;base64,xx' }] }, '42'), /фото/);
});

test('text card and buttons', () => {
  const s = emptyState();
  const p = createPost(s, { draft: draft(2, 'portrait'), source: {} }, '42');
  assert.match(textCard(p), /P0001 · Карусель/);
  const kb = textButtons(p, 'app.vercel.app');
  assert.equal(kb[0][0].callback_data, 'pl:P0001:approve_text');
  assert.equal(kb[3][0].web_app.url, 'https://app.vercel.app/cover-studio/?post=P0001');
  assert.equal(presetFor('carousel', 'новый сезон сериала'), 'series_carousel');
  assert.equal(presetFor('reel', 'фильм'), 'cinema_opinion');
  assert.equal(presetFor('post', 'фильм'), 'cinema_post');
  assert.equal(presetFor('post', 'сериал'), 'series_post');
});

// --- бот: /post и кнопки конвейера через подменённые зависимости ---
function fakePipe() {
  const state = emptyState();
  const writes = [];
  const pipe = async mutate => { const r = await mutate(state); if (r?.message) writes.push(r.message); return r; };
  return { state, writes, pipe };
}
const msg = text => ({ update_id: 1, message: { text, from: { id: 42 }, chat: { id: 42, type: 'private' } } });
const cb = data => ({ update_id: 2, callback_query: { id: 'c', data, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } });

test('bot /post → text card; approve → rendering; /fix rewrites', async () => {
  const f = fakePipe();
  const notes = [];
  const deps = { pipe: f.pipe, learn: async () => {}, notify: t => notes.push(t), generate: async p => ({ ...draft(), preset_id: p.presetId, topic: p.topic }), regenerate: async (post, fb) => ({ ...draft(), caption: 'Новая: ' + fb }) };
  const ctx = { owner: '42', host: 'h.app', deps };
  const r1 = await handleUpdate(msg('/post почему мы пересматриваем фильмы'), ctx);
  assert.match(r1[0].text, /P0001/);
  assert.equal(notes[0], '✍️ Пишу текст поста…');
  const r2 = await handleUpdate(cb('pl:P0001:approve_text'), ctx);
  assert.equal(f.state.posts[0].status, 'rendering');
  assert.match(r2.at(-1).text, /Собираю/);
  f.state.posts[0].status = 'text_review';
  const r3 = await handleUpdate(msg('/fix P0001 короче'), ctx);
  assert.match(r3[0].text, /Новая: короче/);
  const r4 = await handleUpdate(msg('/post ок'), ctx);
  assert.match(r4[0].text, /Напиши тему/);
  const r5 = await handleUpdate(msg('/drafts'), ctx);
  assert.match(r5[0].text, /P0001/);
});

test('editor: candidates prefer owner ideas; skips when queue is full', async () => {
  const c = candidatesFrom([{ status: 'idea', title: 'Идея', link: 'https://a' }, { status: 'used', title: 'X', link: 'https://b' }], [{ title: 'Новость', link: 'https://c' }, { title: 'Дубль', link: 'https://a' }]);
  assert.deepEqual(c.map(x => x.kind), ['idea', 'news']);
  const f = fakePipe();
  for (let i = 0; i < 6; i++) f.state.posts.push({ id: 'P000' + (i + 1), status: 'text_review', source: {} });
  const r = await runEditor({ host: 'h', deps: { pipe: f.pipe, get: async () => ({ data: null }), silent: true } });
  assert.match(r.skipped, /ждут/);
  f.state.posts.length = 0;
  const made = await runEditor({ host: 'h', deps: {
    pipe: f.pipe, get: async () => ({ data: null }), silent: true, news: async () => [{ title: 'Вышел трейлер', link: 'https://n', source_title: 'S' }],
    fetchArticle: async () => 'Текст статьи', loadLab: async () => null, updateStrategy: async () => null,
    pickTopic: async cands => ({ candidate: cands[0], topic: 'Почему трейлеры раскрывают слишком много', format: 'reel', why: '' }),
    generate: async p => ({ ...draft(), preset_id: p.presetId, topic: p.topic }),
  } });
  assert.equal(made.post, 'P0001');
  assert.equal(f.state.posts[0].source.kind, 'auto');
  assert.deepEqual(recentTopics(f.state.posts), ['Почему трейлеры раскрывают слишком много']);
});

import { articleText } from '../api/_editor.js';
test('editor: three distinct topics a day, article text extracted', async () => {
  const f = fakePipe();
  const gens = [];
  const r = await runEditor({ host: 'h', deps: {
    pipe: f.pipe, get: async () => ({ data: null }), silent: true,
    news: async () => ['A', 'B', 'C', 'D'].map(x => ({ title: 'Новость ' + x, link: 'https://n/' + x, source_title: 'S' })),
    fetchArticle: async link => 'Факт из ' + link,
    loadLab: async () => null, updateStrategy: async () => null,
    pickTopic: async (cands, rec, o) => ({ candidate: cands[0], topic: 'Угол про ' + cands[0].title, format: 'carousel', why: '', hypothesis: o.explore ? 'проверка' : 'ставка', explore: o.explore }),
    generate: async p => { gens.push(p); return { ...draft(2, 'portrait'), preset_id: p.presetId, topic: p.topic }; },
  } });
  assert.deepEqual(r.posts, ['P0001', 'P0002', 'P0003']);
  assert.equal(new Set(f.state.posts.map(p => p.source.link)).size, 3);
  assert.match(gens[0].facts, /Факт из https:\/\/n\/A/);
  const html = '<html><script>x</script><p>Короткий</p><p>Премьера третьей части назначена на декабрь, сообщила студия на пресс-конференции.</p><footer><p>Подпишитесь на рассылку и получайте новости каждый день</p></footer></html>';
  assert.equal(articleText(html), 'Премьера третьей части назначена на декабрь, сообщила студия на пресс-конференции.');
});

test('format switch buttons and callback regenerate in another format', async () => {
  const f = fakePipe();
  const p = createPost(f.state, { draft: draft(1, 'portrait'), source: { kind: 'news', topic: 'Новость о фильме' } }, '42');
  const kb = textButtons(p, 'h');
  assert.deepEqual(kb[2].map(b => b.callback_data), ['fmt:P0001:carousel', 'fmt:P0001:reel']);
  let asked = null;
  const deps = { pipe: f.pipe, notify: () => {}, regenerate: async (post, fb, g, kind) => { asked = kind; return { ...draft(4, 'portrait'), preset_id: 'cinema_carousel' }; } };
  const r = await handleUpdate(cb('fmt:P0001:carousel'), { owner: '42', host: 'h', deps });
  assert.equal(asked, 'carousel');
  assert.match(r[1].text, /Карусель/);
  assert.equal(f.state.posts[0].draft.slides.length, 4);
});

import { fixAspect } from '../api/_pipeline.js';
test('prompts always carry the right aspect; new prompts button regenerates', async () => {
  assert.equal(fixAspect('x, --ar 9:16', { format: 'portrait' }), 'x, --ar 4:5');
  assert.equal(fixAspect('x', { format: 'reel' }), 'x, --ar 9:16');
  const f = fakePipe();
  createPost(f.state, { draft: { ...draft(3, 'portrait'), image_prompt: 'same', image_prompts: ['same', 'same', 'same'] }, source: {} }, '42');
  const deps = { pipe: f.pipe, ensureSlidePrompts: async d => { d.image_prompts = ['a', 'b', 'c']; return d; } };
  const r = await handleUpdate(cb('pr:P0001'), { owner: '42', host: 'h', deps });
  assert.match(r[1].after, /<pre>b, --ar 4:5<\/pre>/);
});

test('credits slide toggle on carousels', async () => {
  const f = fakePipe();
  createPost(f.state, { draft: { ...draft(3, 'portrait'), credits: { title: 'Фильм (1972)', lines: [{ name: 'А', role: 'Р1' }, { name: 'Б', role: 'Р2' }] }, credits_on: true }, source: {} }, '42');
  const kb = textButtons(f.state.posts[0], 'h');
  assert.ok(kb[2].some(b => b.callback_data === 'cred:P0001' && /Без титров/.test(b.text)));
  assert.match(textCard(f.state.posts[0]), /🎞 Титры \(последний слайд\)/);
  const r = await handleUpdate(cb('cred:P0001'), { owner: '42', host: 'h', deps: { pipe: f.pipe } });
  assert.equal(f.state.posts[0].draft.credits_on, false);
  assert.match(r[0].text, /убраны/);
});

test('a rejected post edited in the studio comes back for approval; published and rendering are refused clearly', async () => {
  const { createPost, replaceDraft } = await import('../api/_pipeline.js');
  const st = { posts: [] };
  const draft = { format: 'portrait', slides: [{ title: 'a', subtitle: 'b' }], caption: 'c' };
  const post = createPost(st, { draft, source: { kind: 'auto' } }, '42');
  post.status = 'rejected';
  replaceDraft(post, { draft: { ...draft, caption: 'new' } }, '42', 'конструктор');
  assert.equal(post.status, 'text_review');
  assert.equal(post.draft.caption, 'new');
  assert.ok(post.history.some(h => h.event === 'reopened'));
  post.status = 'rendering';
  assert.throws(() => replaceDraft(post, { draft }, '42'), /собирается/);
  post.status = 'published';
  assert.throws(() => replaceDraft(post, { draft }, '42'), /Копия/);
});
