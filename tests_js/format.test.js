import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreFormats } from '../api/_format.js';
import { learn } from '../api/_learning.js';

test('format advice: trailer → Reels, list → carousel, short fact → post', () => {
  assert.equal(scoreFormats({ title: 'Вышел первый трейлер «Дюны 3»', summary: 'Warner показала трейлер' }).best, 'reel');
  assert.equal(scoreFormats({ title: '10 лучших сериалов осени', summary: 'Подборка' }).best, 'carousel');
  assert.equal(scoreFormats({ title: 'HBO продлил «Одни из нас» на третий сезон', summary: '' }).best, 'post');
  assert.equal(scoreFormats({ title: 'Почему финал «Во все тяжкие» обсуждают', summary: '' }, { article: 'x'.repeat(1800) }).best, 'carousel');
});

test('format advice: plan gaps and owner habits shift the advice; lab ignored while reach is tiny', () => {
  const base = { title: 'Студия объявила дату выхода сериала', summary: 'коротко' };
  const r = scoreFormats(base, { planTotals: { reels: 12, carousels: 8 }, posts: [{ status: 'published', draft: { slides: [{}] }, metrics: { latest: { reach: 2 } } }],
    lab: { min_posts_for_verdict: 3, segments: { format: [{ value: 'Карусель', n: 5, index: 2, verdict: 'лидер' }] } } });
  assert.ok(r.lab_note);
  assert.ok(r.scores.reel > 1);
  const pref = scoreFormats(base, { ownerPref: { carousel: 5 } });
  assert.ok(pref.scores.carousel > scoreFormats(base).scores.carousel);
});

test('format choice is remembered', async () => {
  let saved = null;
  const deps = { get: async () => ({ data: null }), put: async (p, d) => { saved = d; } };
  await learn({ type: 'format_choice', post: 'P1', recommended: 'post', chosen: 'carousel' }, { deps });
  assert.equal(saved.stats.format_override, 1);
  assert.equal(saved.format_pref.carousel, 1);
});
