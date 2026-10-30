// ИИ-редактор: раз в день выбирает тему из свежих новостей и сохранённых идей и запускает конвейер поста.
import { ghGetJson, ghPutJson, ReviewError, sortKeys, utcNow } from './_lib.js';
import { cleanSources, fetchSource, mergeNews } from './_news.js';
import { createPost, generateDraft, presetFor, sendTextCard, tgCall, withPipe } from './_pipeline.js';
import { ownerId } from './_lib.js';
import { groqJSON } from './_groq.js';
import { loadLearning, withLearning } from './_learning.js';

export const LAB_PATH = 'data/pipeline/lab.json';
export async function loadLab(get = ghGetJson) {
  const { data } = await get(LAB_PATH).catch(() => ({ data: null }));
  return data && data.schema_version === 1 ? data : null;
}
// Короткая выжимка лаборатории для промпта
export function labSummary(lab) {
  if (!lab || !lab.posts_measured) return null;
  const dims = lab.dimensions || {};
  const seg = s => `${dims[s.dim] || s.dim}: ${s.value} (индекс ${s.index}, постов ${s.n})`;
  const thin = [];
  for (const [d, list] of Object.entries(lab.segments || {})) for (const x of list) if (x.verdict === 'мало данных') thin.push(`${dims[d] || d}: ${x.value}`);
  return {
    measured: lab.posts_measured, checkpoint: lab.checkpoint,
    leaders: (lab.leaders || []).map(seg), laggards: (lab.laggards || []).map(seg), little_data: thin.slice(0, 12),
    top_posts: (lab.top_posts || []).map(p => `${p.title} (индекс ${p.index})`),
  };
}

// Стратег: 3–5 выводов из лаборатории, обновляется, когда меняются данные
export async function updateStrategy(lab, { key = String(process.env.GROQ_API_KEY || '').trim(), fetchImpl = fetch, deps } = {}) {
  const summary = labSummary(lab);
  if (!summary || !key) return null;
  const learning = await loadLearning(deps?.get);
  if (learning.strategy?.for === lab.updated_at_utc) return learning.strategy;
  const sys = 'Ты аналитик Instagram-аккаунта о кино и сериалах. По итогам лаборатории (индекс 1.0 = медиана аккаунта; вердикт только при 3+ постах) дай стратегию. Не делай выводов из сегментов с малым числом постов, называй их гипотезами. Ответ только JSON: {"summary":"2 предложения","do_more":["до 3 пунктов"],"do_less":["до 3"],"next_tests":["2-3 гипотезы для проверки"]}.';
  try {
    const o = await groqJSON([{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify(summary) }], { key, fetchImpl, maxTokens: 1800, temperature: 0.3 });
    const arr = (v, n) => (Array.isArray(v) ? v : []).filter(x => typeof x === 'string').slice(0, n).map(x => x.slice(0, 200));
    const strategy = { for: lab.updated_at_utc, at: utcNow(), summary: String(o.summary || '').slice(0, 400), do_more: arr(o.do_more, 3), do_less: arr(o.do_less, 3), next_tests: arr(o.next_tests, 3) };
    await withLearning(l => { l.strategy = strategy; return { message: 'learning: strategy from lab' }; }, deps);
    return strategy;
  } catch { return null; }
}

export const SETTINGS_PATH = 'content/auto-editor.json';
const SAVED_PATH = 'data/news/saved.json';
const SOURCES_PATH = 'content/news-sources.json';
export const DEFAULT_SETTINGS = { enabled: true, per_day: 3, max_waiting: 6, formats: ['post', 'carousel', 'reel'] };

export function candidatesFrom(saved, news, max = 30) {
  const out = [];
  for (const s of (saved || []).filter(x => x.status === 'idea').slice(-10).reverse()) {
    out.push({ kind: 'idea', title: s.title, link: s.link, source: s.source || '', note: s.note || '' });
  }
  const ordered = [...(news || []).filter(n => n.hot), ...(news || []).filter(n => !n.hot)]; // горячие — первыми
  for (const n of ordered.slice(0, 40)) {
    if (out.some(o => o.link === n.link)) continue;
    out.push({ kind: 'news', title: n.title, link: n.link, source: n.source_title || '', note: n.summary || '', hot: Boolean(n.hot), coverage: n.coverage || 1 });
  }
  return out.slice(0, max);
}

export function recentTopics(posts, n = 25) {
  return (posts || []).slice(-n).map(p => String(p.source?.topic || p.draft?.topic || p.draft?.slides?.[0]?.title || '')).filter(Boolean);
}

// Выбор темы ИИ; без ключа — первая сохранённая идея или первая новость
export async function pickTopic(candidates, recent, { key = String(process.env.GROQ_API_KEY || '').trim(), fetchImpl = fetch, formatHint = 'reel', lab = null, strategy = null, explore = false } = {}) {
  if (!candidates.length) throw new ReviewError('Нет свежих новостей и идей для темы', 404);
  if (!key) throw new ReviewError('На Vercel не задан GROQ_API_KEY — ИИ-редактор не может писать', 503);
  const list = candidates.map((c, i) => ({ i, kind: c.kind, title: c.title, source: c.source, note: String(c.note).slice(0, 200), ...(c.hot ? { hot: true, coverage: c.coverage } : {}) }));
  const sys = 'Ты главный редактор русскоязычного Instagram-аккаунта MyBrand о кино и сериалах. Выбери ОДНУ тему для поста на сегодня из списка кандидатов. Приоритет: идеи владельца (kind=idea), затем новости, которые дают повод для авторского мнения, разбора или полезной подборки — не пересказ пресс-релиза. Не повторяй недавние темы. Новости с hot=true (о них пишут несколько изданий, coverage — сколько) — горячие инфоповоды с большим шансом на охват: при прочих равных выбирай их, но стратегия и лаборатория важнее. Избегай политики, скандалов о личной жизни, смертей и трагедий, слухов. Сформулируй тему как угол подачи (до 200 знаков), а не как заголовок новости. Учитывай итоги лаборатории (что набирает просмотры) и стратегию, если они есть. Режим exploit — выбирай тему и формат в сторону сегментов-лидеров; режим explore — сознательно проверь гипотезу: сегмент с малыми данными, новый жанр, свежесть или формат. Ответ только JSON: {"index":число,"topic":"угол подачи","format":"post" (картинка в ленту), "carousel" или "reel","why":"одно предложение","hypothesis":"что этот пост проверяет, одной фразой"}.';
  const user = JSON.stringify({ candidates: list, recent_topics: recent.slice(-25), preferred_format: formatHint, mode: explore ? 'explore' : 'exploit',
    lab: labSummary(lab) || 'данных пока нет — все посты сейчас проверяют гипотезы', strategy: strategy ? { do_more: strategy.do_more, do_less: strategy.do_less, next_tests: strategy.next_tests } : null });
  const pick = await groqJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], { key, fetchImpl, maxTokens: 1500, temperature: 0.4 });
  const c = candidates[Number(pick.index)];
  const topic = String(pick.topic || '').trim().slice(0, 220);
  if (!c || topic.length < 5) throw new ReviewError('ИИ не выбрал тему', 502);
  return { candidate: c, topic, format: ['post', 'carousel', 'reel'].includes(pick.format) ? pick.format : 'post', why: String(pick.why || '').slice(0, 200), hypothesis: String(pick.hypothesis || '').slice(0, 200), explore };
}

async function loadNewsItems() {
  const cfg = await ghGetJson(SOURCES_PATH).then(r => r.data).catch(() => null);
  const sources = cleanSources(cfg?.sources);
  const results = await Promise.all(sources.map(s => fetchSource(s)));
  return mergeNews(results, sources);
}

// Полный текст статьи по ссылке, чтобы ИИ опирался на факты, а не только на анонс (Google News — пропуск: там редирект)
export function articleText(html, max = 2500) {
  const body = String(html).replace(/<(script|style|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ');
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 60 && !/cookie|подпис|subscribe|реклам/i.test(t));
  return paras.join('\n').slice(0, max);
}
// Загрузка статьи по ссылке из новостей (SSRF-защита): только https, без IP-адресов, localhost и
// внутренних имён; редиректы вручную (до 3), каждый шаг проверяется заново; только HTML и не больше 2 МБ
export const ARTICLE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_HOPS = 3;
export function isPrivateIp(ip) {
  const v = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const m = v.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (v.includes(':')) return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v) || /^64:ff9b:/.test(v) || /^::ffff:/.test(v);
  return false;
}
export function safeArticleUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h || !h.includes('.') || /^\[|:/.test(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^\d+$/.test(h) || /^0x/i.test(h)) return null;
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(h) || h === 'metadata.google.internal') return null;
  return u;
}
async function readCapped(r, max) {
  if (r.body?.getReader) {
    const reader = r.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
  }
  const t = await r.text();
  return t.length > max ? null : t;
}
export async function fetchArticle(link, fetchImpl = fetch, { lookup = null } = {}) {
  if (!/^https:\/\//.test(link) || /news\.google\.com/.test(link)) return '';
  // DNS проверяем по-настоящему только с обычным fetch (в тестах сети нет)
  const resolve = lookup || (fetchImpl === fetch ? async h => (await import('node:dns/promises')).lookup(h, { all: true }) : null);
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    let url = link;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const u = safeArticleUrl(url);
      if (!u) return '';
      if (resolve) {
        const addrs = await resolve(u.hostname).catch(() => []);
        if (!addrs.length || addrs.some(a => isPrivateIp(a.address || a))) return '';
      }
      const r = await fetchImpl(u.toString(), { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IGM-editor/1.0)', Accept: 'text/html' } });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers?.get?.('location');
        if (!loc || hop === MAX_HOPS) return '';
        url = new URL(loc, u).toString();
        continue;
      }
      if (!r.ok) return '';
      const type = String(r.headers?.get?.('content-type') || '');
      if (!/^\s*(text\/html|application\/xhtml\+xml)/i.test(type)) return '';
      const len = Number(r.headers?.get?.('content-length') || 0);
      if (len > ARTICLE_MAX_BYTES) return '';
      const html = await readCapped(r, ARTICLE_MAX_BYTES);
      return html ? articleText(html) : '';
    }
    return '';
  } catch { return ''; } finally { clearTimeout(t); }
}

// Один запуск редактора: до per_day постов в день (каждый — отдельная тема). deps позволяют тестировать без сети.
export async function runEditor({ host, force = false, limit = 5, deps = {} } = {}) {
  const get = deps.get || ghGetJson;
  const settings = { ...DEFAULT_SETTINGS, ...((await get(SETTINGS_PATH).then(r => r.data).catch(() => null)) || {}) };
  if (!settings.enabled && !force) return { skipped: 'выключен в content/auto-editor.json' };
  const pipe = deps.pipe || withPipe;
  const state = await pipe(s => ({ posts: s.posts }));
  const waiting = state.posts.filter(p => p.status === 'text_review').length;
  const today = utcNow().slice(0, 10);
  const madeToday = state.posts.filter(p => p.source?.kind === 'auto' && String(p.created_at_utc).startsWith(today)).length;
  const count = force ? 1 : Math.min(settings.per_day - madeToday, settings.max_waiting - waiting, 5, Math.max(1, limit));
  if (count <= 0) return { skipped: waiting >= settings.max_waiting ? `уже ждут согласования: ${waiting}` : 'норма на сегодня выполнена' };

  const [saved, news] = await Promise.all([
    get(SAVED_PATH).then(r => r.data?.items || []).catch(() => []),
    (deps.news || loadNewsItems)(),
  ]);
  const lab = await (deps.loadLab || loadLab)(get).catch(() => null);
  const strategy = await (deps.updateStrategy || updateStrategy)(lab, { deps: deps.learnDeps }).catch(() => null);
  const used = new Set(state.posts.filter(p => p.status !== 'rejected' && p.source?.link).map(p => p.source.link));
  let candidates = candidatesFrom(saved, news).filter(c => !used.has(c.link));
  const recent = recentTopics(state.posts);
  const autoCount = state.posts.filter(p => p.source?.kind === 'auto').length;
  const picks = [];
  for (let i = 0; i < count && candidates.length; i++) {
    const formatHint = settings.formats[(autoCount + i) % Math.max(1, settings.formats.length)] || 'reel';
    let pick;
    const explore = count > 1 ? i === count - 1 : (autoCount % 3 === 2); // 2 поста по лидерам, 1 — проверка гипотезы
    try { pick = await (deps.pickTopic || pickTopic)(candidates, recent, { formatHint, lab, strategy, explore }); }
    catch (err) { if (!picks.length) throw err; break; }
    picks.push(pick);
    recent.push(pick.topic);
    candidates = candidates.filter(c => c.link !== pick.candidate.link);
  }
  // Тексты пишутся параллельно; статья подтягивается для фактов
  const drafts = await Promise.all(picks.map(async pick => {
    const article = await (deps.fetchArticle || fetchArticle)(pick.candidate.link);
    const presetId = presetFor(pick.format, pick.topic + ' ' + pick.candidate.title);
    const facts = (`Повод: «${pick.candidate.title}» (${pick.candidate.source || 'источник'}) ${pick.candidate.link}.` +
      (article ? `\nТекст статьи (единственный источник фактов, ничего сверх него не утверждать):\n${article}` : `\n${pick.candidate.note || ''}\nФакты сверх заголовка не подтверждены — не утверждать.`)).slice(0, 1500);
    try { return { pick, presetId, facts, draft: await (deps.generate || generateDraft)({ presetId, topic: pick.topic, facts }) }; }
    catch (err) { return { pick, error: err }; }
  }));
  const made = [];
  for (const d of drafts.filter(x => x.draft)) {
    const r = await pipe(s => {
      const post = createPost(s, { draft: d.draft, source: { kind: 'auto', topic: d.pick.topic, facts: d.facts, preset_id: d.presetId, link: d.pick.candidate.link, hypothesis: d.pick.hypothesis || null, mode: d.pick.explore ? 'explore' : 'exploit' } }, 'auto-editor');
      return { post, message: `pipeline: auto-editor ${post.id}` };
    });
    if (d.pick.candidate.kind === 'idea') await markIdeaUsed(d.pick.candidate.link, r.post.id, deps).catch(() => {});
    if (!deps.silent) await sendTextCard({ ...r.post, _intro: `🗞 Тема от ИИ-редактора: «${d.pick.candidate.title}»${d.pick.why ? '\n' + d.pick.why : ''}${d.pick.hypothesis ? `\n${d.pick.explore ? '🧪 Проверяем' : '📈 Ставка'}: ${d.pick.hypothesis}` : ''}\n${d.pick.candidate.link}` }, host);
    made.push(r.post.id);
  }
  if (!made.length) throw drafts.find(x => x.error)?.error || new ReviewError('Не удалось написать ни одного поста', 502);
  return { post: made[0], posts: made };
}

async function markIdeaUsed(link, postId, deps) {
  const get = deps.get || ghGetJson, put = deps.put || ghPutJson;
  const { data, sha } = await get(SAVED_PATH);
  if (!data?.items) return;
  const it = data.items.find(x => x.link === link);
  if (!it) return;
  it.status = 'used'; it.post_id = postId;
  await put(SAVED_PATH, sortKeys(data), sha, `auto-editor: idea used in ${postId}`);
}
