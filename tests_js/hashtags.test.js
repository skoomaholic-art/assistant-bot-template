import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHashtags, withHashtags, titleTag } from '../api/_hashtags.js';

test('long glued title replaced by short tags, series broad tags added', () => {
  const caption = 'Второй сезон уже вышел. Сериал лучше или хуже? Поделитесь мнением #монархнаследиемонстровсерии';
  const h = buildHashtags({ raw: [], tags: { genres: ['фантастика'], titles: ['Монарх: Наследие монстров'] }, caption, topic: 'Монарх: Наследие монстров, 2 сезон' });
  assert.ok(!h.includes('#монархнаследиемонстровсерии'));
  assert.ok(h.includes('#монарх'));
  assert.ok(h.includes('#фантастика'));
  assert.ok(h.includes('#сериалы'));
  assert.equal(h[h.length - 1], '#mybrand');
  assert.equal(h.length, 5);
  const c = withHashtags(caption, h);
  assert.doesNotMatch(c.split('\n\n')[0], /#/);
  assert.match(c, /Поделитесь мнением\n\n#/);
});

test('junk dropped, AI tags kept, dedup', () => {
  const h = buildHashtags({ raw: ['#love', 'Дюна', '#dune', '#дюна'], tags: { genres: ['фантастика'], titles: ['Дюна'] }, caption: 'Фильм', topic: 'Дюна' });
  assert.deepEqual(h, ['#дюна', '#фантастика', '#кино', '#dune', '#mybrand']);
});

test('titleTag', () => {
  assert.equal(titleTag('«Монарх: Наследие монстров»'), '#монарх');
  assert.equal(titleTag('Очень странные дела'), '#оченьстранныедела');
});
