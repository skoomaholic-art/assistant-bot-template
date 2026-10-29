import test from 'node:test';
import assert from 'node:assert/strict';
import { addMusic, extractAudio, moodOf } from '../api/_own.js';
import { createPost, textCard } from '../api/_pipeline.js';

test('music: mood from caption, library and per-reel track', async () => {
  assert.equal(moodOf('напряжённое, для триллеров'), 'tense');
  assert.equal(moodOf('что-то загадочное'), 'mystery');
  assert.equal(extractAudio({ photo: [{}] }), null);
  const m = { audio: { file_id: 'f', file_unique_id: 'u1', file_size: 1000, title: 'Night', performer: 'Band', mime_type: 'audio/mpeg' }, caption: 'эпичное автор: Band, CC BY' };
  let lib = null;
  const deps = { download: async () => Buffer.from('x'), putBinary: async () => true, get: async () => ({ data: { tracks: [] }, sha: 's' }), put: async (p, d) => { lib = d; } };
  const r = await addMusic(m, '1', { deps });
  assert.equal(r.track.mood, 'epic');
  assert.equal(lib.tracks[0].credit, 'Band, CC BY');
  const st = { posts: [] };
  const post = createPost(st, { draft: { format: 'reel', slides: [{ title: 'a' }, { title: 'b', subtitle: 'c' }], caption: 'c', music_mood: 'tense' }, source: { kind: 'news' } }, '1');
  assert.match(textCard(post), /напряжённое настроение/);
  const pipe = async fn => fn(st);
  const r2 = await addMusic(m, '1', { postId: post.id, deps: { ...deps, pipe } });
  assert.equal(st.posts[0].music.title, 'Band — Night');
  assert.match(textCard(st.posts[0]), /твой выбор/);
});

import { attachClip } from '../api/_own.js';
test('owner video becomes a Reels scene; only for reels', async () => {
  const st = { posts: [] };
  const reel = createPost(st, { draft: { format: 'reel', slides: [{ title: 'a' }, { title: 'b' }, { title: 'c' }], caption: 'c' }, source: { kind: 'news' } }, '1');
  const post = createPost(st, { draft: { format: 'portrait', slides: [{ title: 'a' }], caption: 'c' }, source: { kind: 'news' } }, '1');
  const deps = { pipe: async fn => fn(st), download: async () => Buffer.from('v'), putBinary: async () => true };
  const v = (uid, caption) => ({ video: { file_id: 'f', file_unique_id: uid, file_size: 10 }, caption });
  const r = await attachClip(reel.id, v('c1'), '1', deps);
  assert.equal(r.scene, 1);
  const r2 = await attachClip(reel.id, v('c2', '3'), '1', deps);
  assert.equal(r2.scene, 3);
  assert.equal(Object.keys(st.posts[0].clips).length, 2);
  await assert.rejects(attachClip(post.id, v('c3'), '1', deps), /только в Reels/);
  await assert.rejects(attachClip(reel.id, v('c4', '9'), '1', deps), /от 1 до 3/);
});

import { handleUpdate } from '../api/bot.js';
import { textButtons as tb } from '../api/_pipeline.js';
test('reel style: AI default shown, owner switches with a button and it is remembered', async () => {
  const st = { posts: [] };
  const reel = createPost(st, { draft: { format: 'reel', slides: [{ title: 'a' }, { title: 'b' }], caption: 'c', reel_style: 'epic' }, source: { kind: 'news' } }, '42');
  assert.match(textCard(reel), /Эпичный/);
  const styleButtons = tb(reel, 'h').flat().filter(b => String(b.callback_data).startsWith('rs:'));
  assert.equal(styleButtons.length, 5);
  let learned = null;
  const deps = { pipe: async fn => fn(st), learn: async s => { learned = s; } };
  const upd = { callback_query: { id: 'x', from: { id: 42 }, message: { chat: { id: 42, type: 'private' } }, data: `rs:${reel.id}:calm` } };
  await handleUpdate(upd, { owner: '42', host: 'h', deps });
  assert.equal(st.posts[0].draft.reel_style, 'calm');
});
