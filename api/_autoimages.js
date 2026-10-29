// Автоподбор кадров: в тексте поста есть фильм, сериал или актёр → ищем в TMDB и предлагаем картинку на каждый слайд.
// Ставятся они только после «🎬 Взять кадры» владельца: права на кадры у правообладателей.
import { listImages, searchTitles } from './_images.js';

const norm = t => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Кого и что искать: названия из тегов и имена из титров
export function entitiesOf(d) {
  const out = [];
  for (const t of (d.tags?.titles || []).slice(0, 3)) if (String(t).trim().length > 1) out.push({ q: String(t).trim(), kind: 'title' });
  for (const l of (d.credits?.lines || []).slice(0, 6)) if (String(l.name || '').trim().length > 3) out.push({ q: String(l.name).trim(), kind: 'person' });
  const seen = new Set();
  return out.filter(e => { const k = norm(e.q); if (seen.has(k)) return false; seen.add(k); return true; });
}

// Упоминается ли сущность в тексте слайда: полное имя, фамилия или значимое слово названия
export function mentions(text, e) {
  const t = norm(text), q = norm(e.q);
  if (!q) return false;
  if (t.includes(q)) return true;
  const words = q.split(' ').filter(w => w.length >= 4);
  if (e.kind === 'person') return words.length > 1 && t.includes(words[words.length - 1]);
  return words.length > 0 && words.every(w => t.includes(w.slice(0, Math.max(4, w.length - 2))));
}

// План: на каждый слайд своя картинка; сначала совпадение по тексту слайда, иначе главный тайтл (разные кадры)
export async function suggestImages(d, { search = searchTitles, list = listImages, max = 10 } = {}) {
  if (!String(process.env.TMDB_API_KEY || '').trim() && search === searchTitles) return [];
  const ents = entitiesOf(d);
  if (!ents.length) return [];
  const found = [];
  for (const e of ents.slice(0, 5)) {
    try {
      const res = (await search(e.q)).filter(r => (e.kind === 'person' ? r.type === 'person' : r.type !== 'person'));
      const hit = res[0];
      if (!hit) continue;
      const imgs = (await list(hit.type, hit.id)).filter(x => (e.kind === 'person' ? x.kind === 'profile' : x.kind === 'backdrop'));
      if (imgs.length) found.push({ ...e, title: hit.title + (hit.year ? ` (${hit.year})` : ''), imgs, used: 0 });
    } catch { /* TMDB недоступен — просто без кадров */ }
  }
  if (!found.length) return [];
  const main = found.find(f => f.kind === 'title') || found[0];
  const slides = (d.slides || []).slice(0, max);
  const used = new Set();
  const out = [];
  slides.forEach((s, i) => {
    const text = `${s.title || ''} ${s.subtitle || ''}`;
    const pick = found.find(f => f !== main && mentions(text, f)) || (mentions(text, main) || i === 0 ? main : null) || main;
    let img = null;
    for (let k = 0; k < pick.imgs.length; k++) { const c = pick.imgs[(pick.used + k) % pick.imgs.length]; if (!used.has(c.url)) { img = c; pick.used = (pick.used + k + 1); break; } }
    if (!img) return;
    used.add(img.url);
    const url = d.format === 'reel' && img.source === 'TMDB' ? img.url.replace(/\/t\/p\/w\d+\//, '/t/p/original/') : img.url;
    out.push({ slide: i + 1, url, thumb: img.thumb, source: img.source || 'TMDB', title: pick.title, kind: pick.kind });
  });
  return out;
}
