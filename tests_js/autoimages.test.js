import test from 'node:test';
import assert from 'node:assert/strict';
import { entitiesOf, mentions, suggestImages } from '../api/_autoimages.js';
import { createPost, pendingSuggestions, textButtons, textCard } from '../api/_pipeline.js';

const search = async q => /дюна/i.test(q) ? [{ type: 'movie', id: 1, title: 'Дюна: Часть вторая', year: '2024' }]
  : /шаламе/i.test(q) ? [{ type: 'person', id: 2, title: 'Тимоти Шаламе' }] : [];
const list = async (type, id) => type === 'person' ? [{ kind: 'profile', url: 'https://image.tmdb.org/t/p/w780/p.jpg', thumb: 'https://image.tmdb.org/t/p/w342/p.jpg', source: 'TMDB' }]
  : [1, 2, 3, 4].map(n => ({ kind: 'backdrop', url: `https://image.tmdb.org/t/p/w1280/b${n}.jpg`, thumb: `https://image.tmdb.org/t/p/w342/b${n}.jpg`, source: 'TMDB' }));

test('auto images: title and actor from the post, one distinct still per slide, actor on his slide', async () => {
  const d = { tags: { titles: ['Дюна: Часть вторая'] }, credits: { lines: [{ name: 'Тимоти Шаламе', role: 'Пол' }] },
    slides: [{ title: 'Дюна возвращается' }, { title: 'Почему вторая часть сильнее' }, { title: 'Шаламе вырос как актёр' }, { title: 'Итог' }] };
  assert.equal(entitiesOf(d).length, 2);
  assert.ok(mentions('Шаламе вырос как актёр', { q: 'Тимоти Шаламе', kind: 'person' }));
  const sug = await suggestImages(d, { search, list });
  assert.equal(sug.length, 4);
  assert.equal(sug[2].kind, 'person');
  assert.equal(new Set(sug.map(x => x.url)).size, 4);
  const post = createPost({ posts: [] }, { draft: { format: 'portrait', ...d, caption: 'c', image_suggestions: [...sug, { slide: 2, url: 'https://evil.example/x.jpg' }] }, source: { kind: 'news' } }, '1');
  assert.equal(post.draft.image_suggestions.length, 4); // чужой хост отброшен
  post.bgs = { 0: 'media/posts/P0001/bg-own.jpg' };
  assert.equal(pendingSuggestions(post).length, 3); // на слайде 1 уже своя картинка
  assert.match(textButtons(post, 'h')[1][0].text, /Взять кадры \(3\)/);
  assert.match(textCard(post), /Нашёл кадры в TMDB/);
});

test('auto images: nothing to search → no suggestions', async () => {
  assert.deepEqual(await suggestImages({ slides: [{ title: 'a' }] }, { search, list }), []);
});
