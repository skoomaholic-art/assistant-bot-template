// Хэштеги для подписи: ровно до 5 (лимит Instagram), короткие, без склеенных длинных названий и мусора.
// ИИ иногда кладёт один тег прямо в подпись (например, склеенное название сериала), поэтому теги
// из подписи вынимаем и собираем набор заново: жанр, название коротко, широкие «что посмотреть», бренд.
const JUNK = /^#(love|instagood|followme|follow|like4like|likeforlike|photooftheday|instagram|reels|reel|viral|fyp|explore|trending)$/;
const MAX_LEN = 22; // длиннее — нечитаемая склейка, по ней никто не ищет
const BRAND = '#mybrand';

const GENRE = {
  'фантастика': '#фантастика', 'научная фантастика': '#фантастика', 'фэнтези': '#фэнтези', 'ужасы': '#ужасы', 'хоррор': '#хоррор',
  'триллер': '#триллер', 'драма': '#драма', 'комедия': '#комедия', 'боевик': '#боевик', 'детектив': '#детектив', 'криминал': '#криминал',
  'аниме': '#аниме', 'мультфильм': '#мультфильм', 'анимация': '#анимация', 'документальный': '#документалка', 'мелодрама': '#мелодрама',
  'приключения': '#приключения', 'супергероика': '#супергерои', 'супергерои': '#супергерои', 'мистика': '#мистика', 'военный': '#военноекино',
};

export const tag = h => '#' + String(h || '').replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase();
const okTag = h => h.length > 3 && h.length <= MAX_LEN + 1 && !JUNK.test(h) && !/^#\d+$/.test(h);

// Короткая форма названия: до двоеточия / тире, без «сериал», не длиннее MAX_LEN
export function titleTag(title) {
  const head = String(title || '').replace(/[«»"]/g, '').split(/[:—–(]| - /)[0].replace(/\b(сериал|фильм|сезон\s*\d*)\b/gi, '').trim();
  const t = tag(head);
  return okTag(t) ? t : null;
}

// Instagram разрешает не больше 5 хэштегов: 4 по теме + бренд.
// Приоритет: название тайтла, жанр, «сериалы»/«кино», лучший тег от ИИ, «что посмотреть»
export const MAX_TAGS = 5;
export function buildHashtags({ raw = [], tags = {}, caption = '', format = 'post', topic = '' } = {}) {
  const fromCaption = String(caption).match(/#[\p{L}\p{N}_]+/gu) || [];
  const ai = [...(Array.isArray(raw) ? raw : []), ...fromCaption].map(tag).filter(okTag).filter(h => h !== BRAND);
  const text = `${topic} ${caption} ${(tags.titles || []).join(' ')}`.toLowerCase();
  const isSeries = /сериал|сезон|серии|эпизод|series|season|шоу/.test(text);
  const genres = (tags.genres || []).map(g => GENRE[String(g).toLowerCase().trim()] || tag(g)).filter(okTag);
  const out = [];
  const add = h => { if (h && okTag(h) && h !== BRAND && !out.includes(h) && out.length < MAX_TAGS - 1) out.push(h); };
  add(titleTag((tags.titles || [])[0]) || ai[0]);
  add(genres[0]);
  add(isSeries ? '#сериалы' : '#кино');
  for (const h of ai) add(h);
  add('#чтопосмотреть');
  add(isSeries ? '#новыесериалы' : '#фильмы');
  return [...out, BRAND];
}

// Подпись без хэштегов внутри текста + набор в конце
export function withHashtags(caption, hashtags) {
  const body = String(caption || '').replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return (body + '\n\n' + hashtags.join(' ')).slice(0, 2200);
}

// Лимит Instagram — не больше 5 хэштегов в подписи. Если их больше: первые 4 по теме + бренд
// (или просто первые 5, если бренда нет). Текст подписи не трогаем, лишние теги убираем на месте
export function capHashtags(caption, max = MAX_TAGS) {
  const s = String(caption ?? '');
  const re = /(^|\s)(#[\p{L}\p{N}_]+)/gu;
  const all = [...s.matchAll(re)].map(m => m[2]);
  if (all.length <= max) return s;
  const low = all.map(h => h.toLowerCase());
  const hasBrand = low.includes(BRAND);
  const keep = new Set();
  const seen = new Set();
  all.forEach((h, i) => {
    if (seen.has(low[i])) return;
    if (hasBrand ? low[i] !== BRAND && keep.size < max - 1 : keep.size < max) { keep.add(i); seen.add(low[i]); }
  });
  if (hasBrand) { keep.add(low.indexOf(BRAND)); }
  let i = -1;
  const out = s.replace(re, (m, pre, h) => { i++; return keep.has(i) ? m : pre; });
  return out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
