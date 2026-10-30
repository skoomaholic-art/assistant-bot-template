// POST { initData, action: 'list' }                 → новости из RSS + статус каждого источника + сохранённые идеи
// POST { initData, action: 'save', item:{title,link,source_title,date}, note? } → идея в IGM data/news/saved.json
// POST { initData, action: 'unsave', link }          → убрать из сохранённых
import { authorize, ghGetJson, ghPutJson, readBody, reply, fail, ReviewError, sortKeys, utcNow } from './_lib.js';
import { cleanSources, fetchSource, mergeNews, storyTokens } from './_news.js';
import { fetchImage, listImages, searchTitles } from './_images.js';
import { peopleOfDay } from './_people.js';
import { FORMAT_LABEL, scoreFormats } from './_format.js';
import { fetchArticle } from './_editor.js';
import { groqJSON } from './_groq.js';
// { action:'recommend', item } → какой формат лучше для новости (пост, карусель, Reels) и почему
import { PIPE_PATH } from './_pipeline.js';
// { action:'people' } → некролог (14 дней) и дни рождения сегодня из Википедии
// Кадры и постеры для конструктора (TMDB + fanart.tv):
// { action:'img_search', q }         → тайтлы и актёры
// { action:'img_list', type, id }    → кадры, постеры, логотипы или фото
// { action:'img_fetch', url }        → картинка как data URL для предпросмотра

const SOURCES_PATH = 'content/news-sources.json';
const SAVED_PATH = 'data/news/saved.json';
const TTL_MS = 10 * 60 * 1000;
let cache = null; // тёплая функция Vercel держит ленты 10 минут
let peopleCache = null; // некролог и ДР: 3 часа

// Какие новости уже стали постами: опубликован / в работе. Отклонённые, удалённые и архивные — без отметки
// Новость — продолжение истории, по которой уже был пост (опубликован или в работе)
export function relatedPosts(items, posts, marks = {}) {
  const live = (posts || []).filter(p => !['rejected'].includes(p.status) && !p.ig_archived_at_utc && !p.ig?.missing && ['published', 'text_review', 'rendering', 'final_review'].includes(p.status));
  const sigs = live.map(p => {
    const tok = storyTokens([p.source?.topic, p.draft?.slides?.[0]?.title, String(p.source?.facts || '').slice(0, 220)].join(' '));
    for (const t of p.draft?.tags?.titles || []) tok.add('q:' + String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
    return { p, tok };
  });
  const out = {};
  for (const it of items || []) {
    if (marks[it.link]) continue;
    const t = storyTokens(it.title);
    let best = null;
    for (const { p, tok } of sigs) {
      let score = 0;
      for (const w of t) if (tok.has(w)) score += w.startsWith('q:') ? 2 : 1;
      if (score >= 2 && (!best || score > best.score)) best = { score, p };
    }
    if (best) {
      const p = best.p;
      out[it.link] = { id: p.id, state: p.status === 'published' ? 'published' : 'in_work', title: p.draft?.slides?.[0]?.title || '', topic: p.source?.topic || '',
        news_link: p.source?.link || null, permalink: p.ig?.permalink || null, at: p.ig?.published_at || p.created_at_utc || null };
    }
  }
  return out;
}

export function postMarks(posts) {
  const marks = {};
  for (const p of posts || []) {
    const link = p.source?.link;
    if (!link || p.status === 'rejected' || p.ig_archived_at_utc || p.ig?.missing) continue;
    const mark = p.status === 'published'
      ? { state: 'published', id: p.id, permalink: p.ig?.permalink || null }
      : ['text_review', 'rendering', 'final_review', 'publishing', 'publishing_in_progress', 'failed'].includes(p.status) ? { state: 'in_work', id: p.id } : null;
    if (!mark) continue;
    if (!marks[link] || mark.state === 'published') marks[link] = mark;
  }
  return marks;
}

// Дата новости от клиента: только настоящая дата, в ISO; всё прочее отбрасываем
export const newsDate = v => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

const emptySaved = () => ({ schema_version: 1, note: 'Новости, отмеченные владельцем в пульте как идеи для постов. Факты перед публикацией проверять по первоисточнику.', items: [] });

async function loadNews(force) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache;
  const cfg = await ghGetJson(SOURCES_PATH).then(r => r.data).catch(() => null);
  const sources = cleanSources(cfg?.sources);
  const results = await Promise.all(sources.map(s => fetchSource(s)));
  cache = {
    at: Date.now(),
    items: mergeNews(results, sources),
    sources: sources.map(s => { const r = results.find(x => x.id === s.id); return { id: s.id, title: s.title, lang: s.lang, ok: r.ok, error: r.error, count: r.items.length }; }),
  };
  return cache;
}

async function updateSaved(mutator) {
  for (let attempt = 0; ; attempt++) {
    const { data, sha } = await ghGetJson(SAVED_PATH);
    const state = data && Array.isArray(data.items) ? data : emptySaved();
    mutator(state);
    try {
      await ghPutJson(SAVED_PATH, sortKeys(state), sha || undefined, 'mini-app: news ideas');
      return state;
    } catch (err) {
      if (!(err instanceof ReviewError && err.code === 409) || attempt >= 2) throw err;
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
  try {
    const body = readBody(req);
    authorize(body.initData);
    const action = body.action || 'list';
    if (action === 'list') {
      const [news, saved, pipe] = await Promise.all([loadNews(Boolean(body.force)), ghGetJson(SAVED_PATH).then(r => r.data).catch(() => null), ghGetJson(PIPE_PATH).then(r => r.data).catch(() => null)]);
      return reply(res, 200, { ok: true, fetched_at: new Date(news.at).toISOString(), items: news.items, sources: news.sources, saved: (saved?.items || []).slice(-50).reverse(), ...(() => { const marks = postMarks(pipe?.posts); return { marks, related: relatedPosts(news.items, pipe?.posts, marks) }; })() });
    }
    if (action === 'recommend') {
      const it = body.item || {};
      const link = String(it.link || '');
      const [article, lab, pipe, plan] = await Promise.all([
        Promise.race([fetchArticle(link), new Promise(r => setTimeout(() => r(''), 4000))]).catch(() => ''),
        ghGetJson('data/pipeline/lab.json').then(r => r.data).catch(() => null),
        ghGetJson(PIPE_PATH).then(r => r.data).catch(() => null),
        ghGetJson('content/growth-plan.json').then(r => r.data).catch(() => null),
      ]);
      const learning = await ghGetJson('data/pipeline/learning.json').then(r => r.data).catch(() => null);
      const item = { title: String(it.title || '').slice(0, 220), summary: String(it.summary || '').slice(0, 400), hot: Boolean(it.hot), coverage: Number(it.coverage) || 1 };
      const sc = scoreFormats(item, { article, lab, posts: pipe?.posts || [], planTotals: plan?.experiment?.total || null, ownerPref: learning?.format_pref || null });
      let format = sc.best, why = sc.reasons.join(', ');
      try {
        // ИИ взвешивает расчёт и сам материал и объясняет одной фразой
        const o = await Promise.race([groqJSON([
          { role: 'system', content: 'Ты редактор Instagram-аккаунта о кино и сериалах. Выбери лучший формат подачи новости: post (одна картинка в ленту: короткий факт), carousel (листаемые слайды: много фактов, список, разбор), reel (видео 9:16: визуальная новость, трейлер, эмоция). Учитывай объём материала, важность, расчёт и пробелы плана. Ответ только JSON: {"format":"post|carousel|reel","why":"одна фраза до 150 знаков по-русски, без длинных тире, без точки в конце"}' },
          { role: 'user', content: JSON.stringify({ news: item, article_excerpt: String(article || '').slice(0, 1200), heuristic: { scores: sc.scores, best: sc.best, reasons: sc.reasons, lab_note: sc.lab_note } }) },
        ], { maxTokens: 600, temperature: 0.2, timeoutMs: 7000 }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]);
        if (['post', 'carousel', 'reel'].includes(o?.format)) { format = o.format; why = String(o.why || why).replace(/\s*[—–]\s*/g, ', ').replace(/\.$/, '').slice(0, 170); }
      } catch {}
      return reply(res, 200, { ok: true, format, label: FORMAT_LABEL[format], why: why || 'подходит по объёму и характеру новости', confidence: sc.confidence,
        order: [format, ...sc.order.filter(f => f !== format)], lab_note: sc.lab_note,
        facts: article ? `${item.title}. ${article}`.slice(0, 1400) : null });
    }
    if (action === 'people') {
      if (body.force || !peopleCache || Date.now() - peopleCache.at > 3 * 3600e3) peopleCache = { at: Date.now(), data: await peopleOfDay() };
      return reply(res, 200, { ok: true, ...peopleCache.data });
    }
    if (action === 'save') {
      const it = body.item || {};
      const link = String(it.link || '');
      if (!/^https:\/\/[^\s<>"]+$/.test(link) || !String(it.title || '').trim()) throw new ReviewError('Нужны заголовок и https-ссылка');
      const state = await updateSaved(s => {
        if (s.items.some(x => x.link === link)) return;
        s.items.push({
          title: String(it.title).trim().slice(0, 220), link, source: String(it.source_title || '').slice(0, 80),
          published: newsDate(it.date), note: String(body.note || '').trim().slice(0, 500) || null,
          saved_at_utc: utcNow(), status: 'idea',
        });
        s.items = s.items.slice(-300);
      });
      return reply(res, 200, { ok: true, saved: state.items.slice(-50).reverse() });
    }
    if (action === 'unsave') {
      const link = String(body.link || '');
      const state = await updateSaved(s => { s.items = s.items.filter(x => x.link !== link); });
      return reply(res, 200, { ok: true, saved: state.items.slice(-50).reverse() });
    }
    if (action === 'img_search') return reply(res, 200, { ok: true, results: await searchTitles(body.q) });
    if (action === 'img_list') return reply(res, 200, { ok: true, images: await listImages(String(body.type), body.id) });
    if (action === 'img_fetch') {
      const img = await fetchImage(String(body.url || ''));
      return reply(res, 200, { ok: true, data: `data:${img.type.split(';')[0]};base64,${img.buf.toString('base64')}` });
    }
    throw new ReviewError('Неизвестное действие');
  } catch (err) { fail(res, err); }
}
