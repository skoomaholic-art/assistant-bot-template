import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createPost } from '../api/_pipeline.js';
import { learn } from '../api/_learning.js';

test('own post from the studio: no AI accuracy stats, becomes a style example', async () => {
  const st = { posts: [] };
  const post = createPost(st, { draft: { format: 'portrait', slides: [{ title: 'Мой', subtitle: 'текст' }], caption: 'c' }, source: { kind: 'manual' } }, '1');
  act(post, 'approve_text', '1');
  assert.equal(post.learn_stat, null);
  let saved = null;
  const deps = { get: async () => ({ data: null, sha: null }), put: async (path, data) => { saved = data; } };
  await learn({ type: 'owner_post', post: post.id, after: { slides: [{ title: 'Мой', subtitle: 'текст' }], caption: 'c', format: 'portrait' } }, { deps, distill: async rules => rules });
  assert.equal(saved.examples.length, 1);
  assert.equal(saved.stats.owner_posts, 1);
});
