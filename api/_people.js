// «Некролог» и «ДР»: люди кино из Википедии (бесплатно, без ключей).
// Умершие — страница «Deaths in <Month> <Year>», дни рождения — страница даты («October 29»).
// Известность — число языковых версий статьи (Wikidata sitelinks), русское имя — из Wikidata.
const UA = { 'User-Agent': 'MyBrandAssistant/1.0 (personal Instagram helper)', Accept: 'application/json' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const FILM_RE = /\b(actor|actress|film director|director|filmmaker|screenwriter|showrunner|television presenter|comedian|voice actor|cinematographer|film producer|animator)\b/i;

const plain = s => String(s || '')
  .replace(/<ref[\s\S]*?(<\/ref>|\/>)/gi, '')
  .replace(/\{\{(?:snd|ndash|spaced ndash)\}\}/gi, ' – ')
  .replace(/\{\{[^{}]*\}\}/g, '')
  .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
  .replace(/'{2,}/g, '')
  .replace(/\s+/g, ' ').trim();
const linkTitle = s => (String(s).match(/\[\[([^|\]#]+)/) || [])[1]?.trim() || null;

// «*[[Name]], 85, American actor (''[[Film]]''), cancer.» под заголовками ===27===
export function parseDeaths(wikitext, { year, month, fromDay = 1, toDay = 31 } = {}) {
  const out = [];
  let day = null;
  for (const line of String(wikitext).split('\n')) {
    const h = line.match(/^===\s*(\d{1,2})\s*===/);
    if (h) { day = Number(h[1]); continue; }
    if (!day || day < fromDay || day > toDay || !/^\*\s*\[\[/.test(line)) continue;
    const title = linkTitle(line);
    const text = plain(line.replace(/^\*\s*/, ''));
    const m = text.match(/^([^,]+),\s*(\d{1,3})\s*,\s*(.+)$/);
    if (!title || !m || !FILM_RE.test(m[3])) continue;
    out.push({ title, name: m[1].trim(), age: Number(m[2]), about: m[3].replace(/\.$/, '').replace(/\)\s*,[^()]*$/, ')').slice(0, 220), /* причину смерти не показываем */ date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` });
  }
  return out;
}

// «* [[1947]] – [[Richard Dreyfuss]], American actor» в разделе == Births ==
export function parseBirths(wikitext, { year }) {
  const sec = String(wikitext).split(/^==\s*Births\s*==\s*$/m)[1]?.split(/^==\s*Deaths\s*==\s*$/m)[0] || '';
  const out = [];
  for (const line of sec.split('\n')) {
    if (!/^\*/.test(line)) continue;
    const y = Number((line.match(/^\*\s*\[\[(\d{3,4})\]\]/) || line.match(/^\*\s*(\d{3,4})\b/) || [])[1]);
    if (!y || y < 1900) continue;
    const rest = line.replace(/^\*\s*(?:\[\[\d{3,4}\]\]|\d{3,4})\s*(?:\{\{snd\}\}|–|&ndash;|-)\s*/i, '');
    const title = linkTitle(rest);
    const text = plain(rest);
    const m = text.match(/^([^,]+),\s*(.+)$/);
    if (!title || !m || !FILM_RE.test(m[2])) continue;
    const died = (m[2].match(/\((?:d\.|died)\s*(\d{4})\)/) || [])[1];
    out.push({ title, name: m[1].trim(), born: y, age: died ? null : year - y, died: died ? Number(died) : null, about: m[2].replace(/\s*\((?:d\.|died)\s*\d{4}\)/, '').slice(0, 200) });
  }
  return out;
}

async function wikitext(page, fetchImpl) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json&formatversion=2&redirects=1`;
  const r = await fetchImpl(url, { headers: UA });
  if (!r.ok) throw new Error('wikipedia ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('wikipedia: ' + j.error.code);
  return j.parse?.wikitext || '';
}

// Русские имена, ссылки и известность (число языковых версий) — одним запросом на 50 человек
export async function enrich(people, fetchImpl = fetch) {
  const byTitle = new Map();
  for (let i = 0; i < people.length; i += 50) {
    const titles = people.slice(i, i + 50).map(p => p.title).join('|');
    const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&sites=enwiki&titles=${encodeURIComponent(titles)}&props=labels|sitelinks&languages=ru|en&format=json`;
    const r = await fetchImpl(url, { headers: UA }).catch(() => null);
    if (!r?.ok) continue;
    const j = await r.json().catch(() => ({}));
    for (const e of Object.values(j.entities || {})) {
      const t = e.sitelinks?.enwiki?.title;
      if (!t) continue;
      // известность = число Википедий (без Викицитатника/Викисклада)
      const langs = Object.keys(e.sitelinks || {}).filter(k => /wiki$/.test(k) && !/^(commons|species|meta|wikidata)wiki$/.test(k)).length;
      byTitle.set(t, { ru: e.labels?.ru?.value || null, ruwiki: e.sitelinks?.ruwiki?.title || null, langs });
    }
  }
  return people.map(p => {
    const x = byTitle.get(p.title.replace(/_/g, ' ')) || {};
    return {
      ...p, name_ru: x.ru || null, fame: x.langs || 0,
      link: x.ruwiki ? `https://ru.wikipedia.org/wiki/${encodeURIComponent(x.ruwiki.replace(/ /g, '_'))}` : `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
    };
  });
}

// Умершие за последние days дней + дни рождения сегодня (по Алматы)
export async function peopleOfDay({ now = new Date(), days = 14, fetchImpl = fetch } = {}) {
  const local = new Date(now.getTime() + 5 * 3600e3); // UTC+5
  const y = local.getUTCFullYear(), m = local.getUTCMonth() + 1, d = local.getUTCDate();
  const from = new Date(local.getTime() - days * 86400e3);
  const pages = [{ y, m, fromDay: from.getUTCMonth() + 1 === m ? from.getUTCDate() : 1, toDay: d }];
  if (from.getUTCMonth() + 1 !== m) pages.push({ y: from.getUTCFullYear(), m: from.getUTCMonth() + 1, fromDay: from.getUTCDate(), toDay: 31 });
  const [deathsRaw, birthsRaw] = await Promise.all([
    Promise.all(pages.map(p => wikitext(`Deaths in ${MONTHS[p.m - 1]} ${p.y}`, fetchImpl).then(t => parseDeaths(t, { year: p.y, month: p.m, fromDay: p.fromDay, toDay: p.toDay })).catch(() => []))).then(a => a.flat()),
    wikitext(`${MONTHS[m - 1]} ${d}`, fetchImpl).then(t => parseBirths(t, { year: y })).catch(() => []),
  ]);
  const [deaths, births] = await Promise.all([enrich(deathsRaw, fetchImpl), enrich(birthsRaw, fetchImpl)]);
  return {
    date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    obits: deaths.filter(p => p.fame >= 8).sort((a, b) => b.date.localeCompare(a.date) || b.fame - a.fame).slice(0, 25),
    birthdays: births.filter(p => p.fame >= 15).sort((a, b) => (a.died ? 1 : 0) - (b.died ? 1 : 0) || b.fame - a.fame).slice(0, 25),
  };
}
