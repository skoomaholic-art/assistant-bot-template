import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMedia, addOwnMedia, setCaption } from '../api/_own.js';
import { emptyState, act } from '../api/_pipeline.js';
import { handleUpdate } from '../api/bot.js';
import { labSummary } from '../api/_editor.js';

function fakePipe() {
  const state = emptyState();
  let busy = Promise.resolve();
  const pipe = mutate => (busy = busy.then(() => mutate(state)));
  return { state, pipe };
}
const photo = (id, extra = {}) => ({ message_id: id, from: { id: 42 }, chat: { id: 42, type: 'private' }, photo: [{ file_id: 's' + id, file_unique_id: 'us' + id, width: 90, height: 90 }, { file_id: 'b' + id, file_unique_id: 'ub' + id, width: 1280, height: 1600, file_size: 300000 }], ...extra });

test('media extraction picks largest photo, accepts video and image documents', () => {
  assert.equal(extractMedia(photo(1)).file_id, 'b1');
  assert.equal(extractMedia({ video: { file_id: 'v', file_unique_id: 'uv', file_size: 1000 } }).kind, 'video');
  assert.equal(extractMedia({ document: { file_id: 'd', file_unique_id: 'ud', mime_type: 'image/png' } }).ext, 'png');
  assert.equal(extractMedia({ document: { file_id: 'd', mime_type: 'application/pdf' } }), null);
  assert.equal(extractMedia({ text: 'hi' }), null);
});

test('album of photos becomes one carousel post; caption required before build', async () => {
  const f = fakePipe();
  const uploads = [];
  const deps = { pipe: f.pipe, download: async id => Buffer.from(id), putBinary: async (p) => uploads.push(p) };
  const r1 = await addOwnMedia(photo(10, { media_group_id: 'g1' }), '42', deps);
  const r2 = await addOwnMedia(photo(11, { media_group_id: 'g1', caption: 'Мои кадры недели' }), '42', deps);
  assert.equal(r1.created, true); assert.equal(r2.created, false);
  assert.equal(f.state.posts.length, 1);
  const p = f.state.posts[0];
  assert.deepEqual(p.own.files, ['media/posts/P0001/src-ub10.jpg', 'media/posts/P0001/src-ub11.jpg']);
  assert.equal(p.draft.caption, 'Мои кадры недели');
  assert.equal(p.source.kind, 'own');
  const solo = await addOwnMedia(photo(20), '42', deps);
  assert.throws(() => act(solo.post, 'approve_text', '42'), /Нет подписи/);
  await setCaption(solo.post.id, 'Подпись', '42', deps);
  act(f.state.posts[1], 'approve_text', '42');
  assert.equal(f.state.posts[1].status, 'rendering');
  await assert.rejects(addOwnMedia({ ...photo(30), photo: [{ file_id: 'x', file_unique_id: 'x', file_size: 30 * 1024 * 1024 }] }, '42', deps), /20 МБ/);
});

test('bot: photo → own card; reply sets caption; long text → post from owner text', async () => {
  const f = fakePipe();
  const gens = [];
  const deps = { pipe: f.pipe, download: async () => Buffer.from('x'), putBinary: async () => true, notify: () => {},
    generate: async p => { gens.push(p); return { format: 'reel', slides: [{ title: 'Т', subtitle: 'П' }], caption: 'Подпись из текста', tags: {} }; } };
  const ctx = { owner: '42', host: 'h', deps };
  const r1 = await handleUpdate({ message: photo(5) }, ctx);
  assert.match(r1[0].text, /Твой пост P0001 · фото/);
  assert.equal(r1[0].keyboard[0][0].callback_data, 'pl:P0001:approve_text');
  const r2 = await handleUpdate({ message: { text: 'Новая подпись', from: { id: 42 }, chat: { id: 42, type: 'private' }, reply_to_message: { text: r1[0].text } } }, ctx);
  assert.match(r2[0].text, /обновлена/);
  assert.equal(f.state.posts[0].draft.caption, 'Новая подпись');
  const long = 'Мне кажется, лучшие сериалы этого года — это те, что не боятся медленного темпа и тишины.';
  const r3 = await handleUpdate({ message: { text: long, from: { id: 42 }, chat: { id: 42, type: 'private' } } }, ctx);
  assert.match(r3[0].text, /P0002/);
  assert.equal(gens[0].owner_text, long);
  assert.equal(f.state.posts[1].source.kind, 'own_text');
  const short = await handleUpdate({ message: { text: 'привет', from: { id: 42 }, chat: { id: 42, type: 'private' } } }, ctx);
  assert.match(short[0].text, /Пришли фото/);
});

test('lab summary for the editor', () => {
  assert.equal(labSummary(null), null);
  const s = labSummary({ posts_measured: 4, checkpoint: 'h24', dimensions: { format: 'Формат' }, leaders: [{ dim: 'format', value: 'Reels', index: 1.6, n: 3 }], laggards: [], segments: { format: [{ value: 'Карусель', verdict: 'мало данных' }] }, top_posts: [] });
  assert.deepEqual(s.leaders, ['Формат: Reels (индекс 1.6, постов 3)']);
  assert.deepEqual(s.little_data, ['Формат: Карусель']);
});

import { attachBackground } from '../api/_own.js';
import { promptMessage, createPost } from '../api/_pipeline.js';
test('image prompt comes with the text; reply with a picture becomes the cover background', async () => {
  const f = fakePipe();
  const post = createPost(f.state, { draft: { format: 'reel', slides: [{ title: 'Т', subtitle: 'П' }], caption: 'c', image_prompt: 'dark cinematic <empty theater> --ar 9:16' }, source: { kind: 'bot' } }, '42');
  assert.match(promptMessage(post), /<pre>dark cinematic &lt;empty theater&gt;, --ar 9:16<\/pre>/);
  const deps = { pipe: f.pipe, download: async () => Buffer.from('img'), putBinary: async () => true, notify: () => {} };
  const r = await handleUpdate({ message: { ...photo(7), reply_to_message: { text: promptMessage(post).replace(/<[^>]+>/g, '') } } }, { owner: '42', host: 'h', deps });
  assert.match(r[0].text, /Картинка добавлена в обложку P0001/);
  assert.equal(f.state.posts[0].bg.path, 'media/posts/P0001/bg-ub7.jpg');
  assert.equal(promptMessage(f.state.posts[0]), null);
  f.state.posts[0].status = 'final_review'; f.state.posts[0].approvals = { text: { by: '42' } };
  const again = await attachBackground('P0001', photo(8), '42', deps);
  assert.equal(again.rerender, true);
  assert.equal(f.state.posts[0].status, 'rendering');
  await assert.rejects(attachBackground('P0001', { video: { file_id: 'v', file_unique_id: 'v' } }, '42', deps), /картинка/);
});

test('photo sent without reply can become the cover of the waiting AI post', async () => {
  const f = fakePipe();
  createPost(f.state, { draft: { format: 'portrait', slides: [{ title: 'Т', subtitle: '' }], caption: 'c', image_prompt: 'p --ar 4:5' }, source: { kind: 'bot' } }, '42');
  const deps = { pipe: f.pipe, download: async () => Buffer.from('x'), putBinary: async () => true, notify: () => {} };
  const ctx = { owner: '42', host: 'h', deps };
  const r = await handleUpdate({ message: photo(50) }, ctx);
  assert.equal(r[0].keyboard[0][0].callback_data, 'bg:P0002:P0001');
  const r2 = await handleUpdate({ callback_query: { id: 'c', data: 'bg:P0002:P0001', from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } }, ctx);
  assert.match(r2[1].text, /стала обложкой P0001/);
  assert.equal(r2[1].keyboard[0][0].callback_data, 'pl:P0001:approve_text');
  assert.equal(f.state.posts[0].bg.path, 'media/posts/P0002/src-ub50.jpg');
  assert.equal(f.state.posts[1].status, 'rejected');
});

test('carousel: one prompt per slide, album fills slides in order, caption number picks a slide', async () => {
  const f = fakePipe();
  const post = createPost(f.state, { draft: { format: 'portrait', slides: [1, 2, 3, 4].map(i => ({ title: 'С' + i, subtitle: '' })), caption: 'c', image_prompt: 'cover', image_prompts: ['p1', 'p2', 'p3', 'p4'] }, source: { kind: 'bot' } }, '42');
  const pm = promptMessage(post);
  assert.match(pm, /слайдов: 4/); assert.match(pm, /<pre>p3, --ar 4:5<\/pre>/);
  const deps = { pipe: f.pipe, download: async () => Buffer.from('x'), putBinary: async () => true };
  const a = await attachBackground('P0001', photo(60, { media_group_id: 'g' }), '42', deps);
  const b = await attachBackground('P0001', photo(61, { media_group_id: 'g' }), '42', deps);
  assert.deepEqual([a.slide, b.slide], [1, 2]);
  const c = await attachBackground('P0001', photo(62, { caption: '4' }), '42', deps);
  assert.equal(c.slide, 4);
  assert.deepEqual(Object.keys(f.state.posts[0].bgs), ['0', '1', '3']);
  assert.match(promptMessage(f.state.posts[0]), /3\n<pre>p3, --ar 4:5<\/pre>/);
  await assert.rejects(attachBackground('P0001', photo(63, { caption: '9' }), '42', deps), /от 1 до 4/);
});

import { attachImageBackground, clearBackground } from '../api/_own.js';
import { searchTitles, listImages, fetchImage } from '../api/_images.js';
test('TMDB search, image list and stills on a slide with a source credit', async () => {
  process.env.TMDB_API_KEY = 'k'.repeat(32);
  process.env.FANART_API_KEY = 'f';
  const calls = [];
  const fx = async url => {
    calls.push(url);
    const json = o => ({ ok: true, status: 200, json: async () => o });
    if (url.includes('/search/multi')) return json({ results: [{ media_type: 'movie', id: 238, title: 'Крёстный отец', release_date: '1972-03-14', poster_path: '/p.jpg' }, { media_type: 'person', id: 3084, name: 'Марлон Брандо', profile_path: '/m.jpg', known_for: [{ title: 'Крёстный отец' }] }, { media_type: 'company', id: 1 }] });
    if (url.includes('/movie/238/images')) return json({ backdrops: [{ file_path: '/b.jpg', width: 1920, height: 1080 }], posters: [{ file_path: '/p.jpg' }], logos: [] });
    if (url.includes('fanart.tv')) return json({ moviebackground: [{ url: 'https://assets.fanart.tv/fanart/movies/238/moviebackground/x.jpg' }, { url: 'https://evil.example/x.jpg' }] });
    if (url.includes('/person/3084/images')) return json({ profiles: [{ file_path: '/m.jpg' }] });
    return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const found = await searchTitles('крёстный', fx);
  assert.equal(found.length, 2);
  assert.equal(found[1].known_for, 'Крёстный отец');
  assert.match(calls[0], /api_key=k+/);
  const imgs = await listImages('movie', 238, fx);
  assert.deepEqual(imgs.map(i => i.source), ['TMDB', 'TMDB', 'fanart.tv']);
  assert.equal(imgs[0].url, 'https://image.tmdb.org/t/p/w1280/b.jpg');
  assert.equal((await listImages('person', 3084, fx))[0].kind, 'profile');
  await assert.rejects(fetchImage('https://evil.example/x.jpg', fx), /разрешённого/);
  const image = await fetchImage(imgs[0].url, fx);

  const f = fakePipe();
  createPost(f.state, { draft: { format: 'portrait', slides: [{ title: 'А', subtitle: '1' }, { title: 'Б', subtitle: '2' }], caption: 'c' }, source: { kind: 'auto' } }, '42');
  const deps = { pipe: f.pipe, putBinary: async () => true };
  const r = await attachImageBackground('P0001', 2, image, { source: 'TMDB', title: 'Крёстный отец', url: imgs[0].url }, '42', deps);
  assert.equal(r.slide, 2);
  const post = f.state.posts[0];
  assert.match(post.bgs[1], /^media\/posts\/P0001\/bg-db-[a-f0-9]{12}\.jpg$/);
  assert.deepEqual(post.image_sources.map(x => [x.slide, x.source]), [[2, 'TMDB']]);
  await assert.rejects(attachImageBackground('P0001', 5, image, {}, '42', deps), /от 1 до 2/);
  await clearBackground('P0001', 2, '42', deps);
  assert.equal(post.bgs[1], undefined);
  assert.equal(post.image_sources, undefined);
  delete process.env.TMDB_API_KEY; delete process.env.FANART_API_KEY;
  await assert.rejects(searchTitles('крёстный', fx), /TMDB_API_KEY/);
});
