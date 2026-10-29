// Новости о кино и сериалах из открытых RSS/Atom — источник идей для постов.
// Без базы и без платных сервисов: ленты читаются при открытии вкладки и кэшируются CDN Vercel.
export const DEFAULT_SOURCES = [
  { id: 'gn-kino', title: 'Google Новости · кино', lang: 'ru', url: 'https://news.google.com/rss/search?q=%D0%BA%D0%B8%D0%BD%D0%BE+%D0%BF%D1%80%D0%B5%D0%BC%D1%8C%D0%B5%D1%80%D0%B0+when:3d&hl=ru&gl=KZ&ceid=KZ:ru' },
  { id: 'gn-serial', title: 'Google Новости · сериалы', lang: 'ru', url: 'https://news.google.com/rss/search?q=%D1%81%D0%B5%D1%80%D0%B8%D0%B0%D0%BB+%D1%81%D0%B5%D0%B7%D0%BE%D0%BD+when:3d&hl=ru&gl=KZ&ceid=KZ:ru' },
  { id: 'kinonews', title: 'KinoNews', lang: 'ru', url: 'https://www.kinonews.ru/rss/' },
  { id: 'filmru', title: 'Film.ru', lang: 'ru', url: 'https://www.film.ru/rss.xml' },
  { id: 'variety', title: 'Variety', lang: 'en', url: 'https://variety.com/feed/' },
  { id: 'deadline', title: 'Deadline', lang: 'en', url: 'https://deadline.com/feed/' },
  { id: 'indiewire', title: 'IndieWire', lang: 'en', url: 'https://www.indiewire.com/feed/' },
  { id: 'thr', title: 'The Hollywood Reporter', lang: 'en', url: 'https://www.hollywoodreporter.com/feed/' },
];

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
export function decode(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
const strip = s => decode(decode(s).replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
};
const safeUrl = u => (/^https?:\/\/[^\s<>"]+$/i.test(u) ? u : null);

// RSS 2.0 и Atom, без зависимостей. Возвращает [{title, link, date, summary}]
export function parseFeed(xml, limit = 15) {
  const out = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, limit)) {
    let link = strip(tag(b, 'link'));
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? decode(m[1]) : ''; }
    const when = strip(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date'));
    const t = Date.parse(when);
    const title = strip(tag(b, 'title'));
    if (!title || !safeUrl(link)) continue;
    out.push({
      title: title.slice(0, 220),
      link,
      date: Number.isFinite(t) ? new Date(t).toISOString() : null,
      summary: strip(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content')).slice(0, 280),
    });
  }
  return out;
}

export function cleanSources(list) {
  if (!Array.isArray(list)) return DEFAULT_SOURCES;
  const ok = list.filter(s => s && /^[a-z0-9-]{2,30}$/.test(s.id) && safeUrl(s.url) && s.url.startsWith('https://') && s.enabled !== false)
    .slice(0, 15).map(s => ({ id: s.id, title: String(s.title || s.id).slice(0, 60), lang: s.lang === 'en' ? 'en' : 'ru', url: s.url }));
  return ok.length ? ok : DEFAULT_SOURCES;
}

export async function fetchSource(src, fetchImpl = fetch, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(src.url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IGM-news/1.0)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
    if (!r.ok) return { id: src.id, ok: false, error: 'HTTP ' + r.status, items: [] };
    const items = parseFeed(await r.text());
    return { id: src.id, ok: items.length > 0, error: items.length ? null : 'лента пустая', items };
  } catch (e) {
    return { id: src.id, ok: false, error: e.name === 'AbortError' ? 'таймаут' : 'недоступен', items: [] };
  } finally { clearTimeout(timer); }
}

// Google News добавляет « - Издание» в конец заголовка: выносим в источник
function splitPublisher(item, srcId) {
  if (!srcId.startsWith('gn-')) return item;
  const m = item.title.match(/^(.*\S)\s+-\s+([^-]{2,60})$/);
  return m ? { ...item, title: m[1], publisher: m[2] } : item;
}

export function mergeNews(results, sources, max = 80) {
  const byId = Object.fromEntries(sources.map(s => [s.id, s]));
  const seen = new Set();
  const items = [];
  const ad = /\b(deals?|sale|markdowns?|shopping|coupon|discount|best[- ]selling|buy now|gift guide|amazon prime day|black friday)\b|скидк|распродаж|промокод|купить/i;
  for (const r of results) for (const it of r.items) {
    if (ad.test(it.title) || ad.test(it.summary || '')) continue; // рекламные подборки и шопинг — не инфоповоды
    const src = byId[r.id];
    const x = splitPublisher(it, r.id);
    const key = x.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ ...x, source: src.id, source_title: x.publisher || src.title, lang: src.lang });
  }
  items.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return markHot(items).slice(0, max);
}

// ---------- «Горячие» новости: одну историю пишут сразу несколько изданий ----------
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'about', 'after', 'over', 'will', 'new', 'first', 'season', 'series', 'movie', 'film', 'trailer', 'review', 'star', 'stars', 'netflix', 'hbo', 'amazon', 'disney', 'apple', 'sets', 'set', 'gets', 'his', 'her', 'their', 'как', 'что', 'это', 'для', 'при', 'его', 'она', 'они', 'фильм', 'фильма', 'сериал', 'сериала', 'сезон', 'новый', 'новая', 'трейлер', 'кино', 'года', 'после', 'который', 'стал', 'стала', 'будет']);
export function storyTokens(title) {
  const t = String(title || '');
  const quoted = [...t.matchAll(/[«"“']([^»"”']{3,60})[»"”']/g)].map(m => 'q:' + m[1].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
  const words = t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
  return new Set([...quoted, ...words.map(w => w.slice(0, 7))]); // обрезка ≈ основа слова: «Пачино»/«Пачино,»/«Пачинo»
}
export function markHot(items, now = Date.now()) {
  const toks = items.map(x => storyTokens(x.title));
  return items.map((x, i) => {
    const sources = new Set([x.source_title || x.source]);
    toks.forEach((t, j) => {
      if (i === j) return;
      let shared = 0;
      for (const w of toks[i]) if (t.has(w)) shared += w.startsWith('q:') ? 2 : 1;
      if (shared >= 2) sources.add(items[j].source_title || items[j].source);
    });
    const ageH = x.date ? (now - Date.parse(x.date)) / 3600e3 : 99;
    const coverage = sources.size;
    const hot = coverage >= 3 || (coverage >= 2 && ageH <= 12);
    return { ...x, coverage, hot, ...(hot ? { hot_reason: `пишут ${coverage} ${coverage < 5 ? 'издания' : 'изданий'}${ageH <= 12 ? ', свежее' : ''}` } : {}) };
  });
}
