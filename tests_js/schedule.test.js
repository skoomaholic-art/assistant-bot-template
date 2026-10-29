import test from 'node:test';
import assert from 'node:assert/strict';
import { act, cleanSchedule, createPost, setSchedule, almatyTime, finalButtons, textCard } from '../api/_pipeline.js';

const hourAlm = (days, h) => { const d = new Date(Date.now() + 5 * 3600e3 + days * 86400e3); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h) - 5 * 3600e3).toISOString(); };

test('schedule: whole hours 08–23 Almaty, at least 30 min ahead, at most 30 days', () => {
  assert.equal(cleanSchedule(null), null);
  const ok = hourAlm(1, 18);
  assert.equal(cleanSchedule(ok), ok);
  assert.throws(() => cleanSchedule(hourAlm(1, 3)), /08:00 до 23:00/);
  assert.throws(() => cleanSchedule(new Date(Date.parse(ok) + 15 * 60e3).toISOString()), /целый час/);
  assert.throws(() => cleanSchedule(hourAlm(40, 18)), /30 дней/);
  assert.equal(almatyTime(ok).endsWith('18:00'), true);
});

test('approved final with a future time waits in the queue; publish now and unschedule work', () => {
  const st = { posts: [] };
  const post = createPost(st, { draft: { format: 'portrait', slides: [{ title: 'a', subtitle: 'b' }], caption: 'c' }, source: { kind: 'news' } }, '1');
  setSchedule(post, hourAlm(1, 18), '1');
  assert.match(textCard(post), /🕒 Публикация:/);
  act(post, 'approve_text', '1');
  post.status = 'final_review'; post.media = { images: ['x.jpg'] };
  assert.match(finalButtons(post, 'h')[0][0].text, /Публиковать .*18:00/);
  act(post, 'approve_final', '1');
  assert.equal(post.status, 'scheduled');
  act(post, 'publish_now', '1');
  assert.equal(post.status, 'publishing');
  assert.equal(post.scheduled_at, undefined);
  post.status = 'scheduled'; post.scheduled_at = hourAlm(1, 18);
  setSchedule(post, null, '1');
  assert.equal(post.status, 'publishing');
  post.status = 'published';
  assert.throws(() => setSchedule(post, hourAlm(1, 18), '1'), /уже не назначить/);
});

test('handoff: final goes to the owner instead of publishing', () => {
  const post = createPost({ posts: [] }, { draft: { format: 'reel', slides: [{ title: 'a' }], caption: 'c' }, source: { kind: 'news' } }, '1');
  assert.throws(() => act(post, 'handoff', '1'), /готовый финал/);
  post.status = 'final_review'; post.media = { images: ['media/posts/P0001/1.jpg'], video: 'media/posts/P0001/reel.mp4' };
  act(post, 'handoff', '1');
  assert.equal(post.status, 'handed_off');
  assert.match(finalButtons({ ...post, status: 'final_review' }, 'h').flat().map(b => b.text).join(' '), /Опубликую сам/);
});
