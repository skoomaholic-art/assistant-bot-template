import test from 'node:test';
import assert from 'node:assert/strict';
import { brainReport, levelOf, scoreOf } from '../api/_brain.js';

const pub = (i, extra = {}) => ({ id: 'P' + i, status: 'published', ig: { media_id: '1' + i, published_at: new Date().toISOString() }, draft: { slides: [{}] }, ...extra });

test('brain: honest low score for a young account, levels and forecast grow with pace', () => {
  const posts = Array.from({ length: 8 }, (_, i) => pub(i, { metrics: { latest: { reach: 1 } } }));
  const r = brainReport({ posts, learning: { rules: Array(24).fill('r'), visual_prefs: { portrait: {} }, stats: { text_first_ok: 4, text_changed: 12, final_first_ok: 8, final_changed: 2 }, strategy: {} },
    lab: { posts_measured: 7, min_posts_for_verdict: 3, segments: { format: [{ n: 4, verdict: 'лидер' }] } } });
  assert.ok(r.score >= 15 && r.score < 35, 'score ' + r.score);
  assert.equal(r.facts.meaningfulSegments, 0); // охват 1 человек — выводы лаборатории не считаются
  assert.equal(r.accuracy.text, 25);
  const [p1, , p3] = r.forecast;
  assert.ok(p1.points[0].score > r.score);
  assert.ok(p3.points[0].score > p1.points[0].score);
  assert.ok(p3.to_good < p1.to_good);
  assert.ok(p1.points[2].score <= 100);
});

test('brain: empty account is at the bottom, levels are ordered', () => {
  assert.equal(brainReport({}).score <= 10, true);
  assert.equal(levelOf(0).name, 'зачаточный');
  assert.equal(levelOf(70).name, 'хороший');
  assert.equal(scoreOf({ published: 365, rules: 60, visualFormats: 3, textOk: 400, textFix: 0, finalOk: 400, finalFix: 0, measured: 150, meaningfulSegments: 6, strategy: true }).score, 100);
});
