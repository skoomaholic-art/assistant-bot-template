// База знаний (RAG): перед ответом ИИ ищет в твоих данных и отвечает по найденному.
// Источники: посты (тексты, статусы, ссылки), правила редакции, стратегия, лаборатория, заметки владельца, письма-задачи.
// Поиск — BM25 по словам с простым русским стеммингом: бесплатно, без внешних сервисов, индекс строится на лету.
import { ghGetJson, ghPutJson, ReviewError } from './_lib.js';
import { groqJSON } from './_groq.js';

export const NOTES_PATH = 'data/knowledge/notes.json';
const POSTS = 'data/pipeline/posts.json', LEARN = 'data/pipeline/learning.json', LAB = 'data/pipeline/lab.json';
const MAX_NOTES = 500;

const STOP = new Set(('это как что для все его она они так уже или при над под без только тоже еще был была были быть есть нет '
  + 'там тут где когда чем кто чтобы если вот даже очень можно нужно свой своя мой моя наш ваш про the and for with from that this are was').split(' '));

function stem(w) {
  if (/^[a-z0-9]+$/.test(w)) return w.replace(/(ing|ed|es|s)$/, '').slice(0, 8) || w;
  const s = w.replace(/(иями|ями|ами|ого|его|ому|ему|ыми|ими|ией|ия|ие|ий|ый|ой|ая|яя|ое|ее|ые|ов|ев|ам|ям|ах|ях|ом|ем|ую|юю|ешь|ет|ут|ют|ать|ять|ить|ть|ся|сь|а|я|о|е|ы|и|у|ю|ь)$/, '');
  return (s.length >= 3 ? s : w).slice(0, 7);
}
export function tokens(text) {
  return (String(text || '').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) || [])
    .filter(w => w.length >= 3 && !STOP.has(w)).map(stem);
}

// BM25: чем реже слово в базе и чем чаще в документе, тем выше вес; длинные документы не выигрывают за счёт длины
export function search(query, docs, k = 6) {
  const q = [...new Set(tokens(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map(d => tokens(`${d.title} ${d.title} ${d.text}`));
  const avg = toks.reduce((a, t) => a + t.length, 0) / toks.length || 1;
  const df = new Map();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
  const N = docs.length, k1 = 1.4, b = 0.75;
  return docs.map((d, i) => {
    const tf = new Map();
    for (const w of toks[i]) tf.set(w, (tf.get(w) || 0) + 1);
    let score = 0;
    for (const w of q) {
      const f = tf.get(w); if (!f) continue;
      const idf = Math.log(1 + (N - df.get(w) + 0.5) / (df.get(w) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * toks[i].length / avg));
    }
    return { ...d, score };
  }).filter(d => d.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

const STATUS = { published: 'опубликован', rejected: 'отклонён', text_review: 'текст на согласовании', final_review: 'финал на согласовании', scheduled: 'запланирован', rendering: 'собирается', failed: 'ошибка', handed_off: 'отдан владельцу' };
const day = iso => { const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return ''; const d = new Date(t + 5 * 3600e3); return `${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`; };

export function postDocs(posts) {
  return (posts || []).filter(p => p?.draft).map(p => {
    const d = p.draft, sl = d.slides || [];
    const m = p.metrics?.latest || p.metrics || {};
    const RU = { reach: 'охват', views: 'просмотры', likes: 'лайки', comments: 'комментарии', saved: 'сохранения', shares: 'репосты' };
    const stat = Object.keys(RU).filter(k => Number.isFinite(m[k])).map(k => `${RU[k]} ${m[k]}`).join(', ');
    return {
      id: p.id, source: 'post', date: p.ig?.published_at || p.updated_at_utc || p.created_at_utc, url: p.ig?.permalink || p.permalink || null,
      title: `${p.id} · ${String(sl[0]?.title || d.topic || '').slice(0, 120)}`,
      text: [`Статус: ${STATUS[p.status] || p.status}, ${day(p.ig?.published_at || p.updated_at_utc)}`, `Формат: ${d.format === 'reel' ? 'Reels' : sl.length > 1 ? 'карусель' : 'пост'}`,
        `Тема: ${d.topic || p.source?.topic || ''}`, ...sl.map(s => `${s.title || ''}. ${s.subtitle || ''}`), `Подпись: ${d.caption || ''}`, stat ? `Метрики: ${stat}` : '',
        p.source?.link ? `Источник: ${p.source.link}` : ''].filter(Boolean).join('\n').slice(0, 2500),
    };
  });
}

export function learningDocs(l) {
  if (!l) return [];
  const out = [];
  if (l.rules?.length) out.push({ id: 'rules', source: 'rules', title: 'Правила редакции владельца', text: l.rules.map((r, i) => `${i + 1}) ${r}`).join('\n') });
  if (l.strategy && typeof l.strategy === 'object') out.push({ id: 'strategy', source: 'strategy', title: 'Стратегия: что делать больше и меньше', text: JSON.stringify(l.strategy).slice(0, 2500) });
  return out;
}

export function labDocs(lab) {
  if (!lab) return [];
  const pick = k => (lab[k] == null ? '' : `${k}: ${JSON.stringify(lab[k]).slice(0, 700)}`);
  return [{ id: 'lab', source: 'lab', date: lab.updated_at_utc, title: 'Лаборатория: статистика, охват и просмотры, лучшие и худшие посты, форматы, жанры, крючки',
    text: ['median_score', 'leaders', 'laggards', 'top_posts', 'hypotheses', 'segments'].map(pick).filter(Boolean).join('\n').slice(0, 3000) }];
}

export const noteDocs = notes => (notes || []).map(n => ({ id: `N${n.n}`, source: 'note', date: n.at, title: `Заметка №${n.n}`, text: n.text }));
export const mailDocs = items => (items || []).map(x => ({ id: `M:${x.id}`, source: 'mail', date: x.date, url: x.link || null,
  title: `Письмо: ${x.subject}`, text: `От ${x.from}. Статус задачи: ${x.status === 'work' ? 'в работе' : 'новая'}. ${x.snippet || ''}` }));

// ---------- Заметки владельца ----------
export async function loadNotes(get = ghGetJson) {
  const { data, sha } = await get(NOTES_PATH);
  return { notes: Array.isArray(data?.notes) ? data.notes : [], sha };
}
// Запись заметок: sha || undefined (null GitHub не принимает, 422), при конфликте перечитываем и повторяем
const NOTES_NOTE = 'База знаний владельца: заметки для ИИ (/note, /notes, /unnote N)';
async function withNotes(mutate, { get = ghGetJson, put = ghPutJson, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    const { notes, sha } = await loadNotes(get);
    const r = mutate(notes);
    try { await put(NOTES_PATH, { schema_version: 1, note: NOTES_NOTE, notes: r.notes }, sha || undefined, r.message); return r; }
    catch (err) {
      if (!(err instanceof ReviewError && err.code === 409) || attempt >= 3) throw err;
      await sleep(150 + Math.floor(Math.random() * 450));
    }
  }
}
export async function addNote(text, deps = {}) {
  const clean = String(text || '').replace(/\s+\n/g, '\n').trim().slice(0, 3000);
  if (clean.length < 3) throw new ReviewError('Пустая заметка. Пример: /note Сериал «Монарх» выходит на Apple TV+ по пятницам');
  const r = await withNotes(notes => {
    const n = (notes.reduce((m, x) => Math.max(m, x.n || 0), 0) || 0) + 1;
    return { n, notes: [...notes, { n, at: new Date().toISOString(), text: clean }].slice(-MAX_NOTES), message: `knowledge: note ${n}` };
  }, deps);
  return { n: r.n, total: r.notes.length };
}
export async function removeNote(n, deps = {}) {
  const r = await withNotes(notes => {
    const next = notes.filter(x => x.n !== Number(n));
    if (next.length === notes.length) throw new ReviewError(`Нет заметки №${n}`);
    return { notes: next, message: `knowledge: remove note ${n}` };
  }, deps);
  return r.notes.length;
}

// ---------- Сбор базы ----------
export async function collectDocs({ get = ghGetJson, mail = null, withMail = true } = {}) {
  const safe = p => p.catch(() => ({ data: null }));
  const [posts, learning, lab, notes] = await Promise.all([safe(get(POSTS)), safe(get(LEARN)), safe(get(LAB)), safe(get(NOTES_PATH))]);
  let mailItems = [];
  if (withMail) {
    try {
      const load = mail || (async () => { const { callScript } = await import('./mail.js'); return (await callScript({ action: 'list' })).items; });
      mailItems = await load();
    } catch { mailItems = []; }
  }
  return [...postDocs(posts.data?.posts), ...learningDocs(learning.data), ...labDocs(lab.data), ...noteDocs(notes.data?.notes), ...mailDocs(mailItems)];
}

// ---------- Для ИИ-редактора: что уже было по теме и что владелец записал ----------
export function contextBlock(hits, max = 1600) {
  const lines = [];
  for (const h of hits) {
    const head = h.source === 'post' ? `Наш пост ${h.title} (${h.text.split('\n')[0].replace('Статус: ', '')})` : h.source === 'note' ? `Заметка владельца` : h.title;
    const body = h.source === 'post' ? h.text.split('\n').filter(l => !/^(Статус|Формат|Метрики|Источник)/.test(l)).join(' ') : h.text;
    lines.push(`- ${head}: ${body.replace(/\s+/g, ' ').slice(0, 320)}`);
    if (lines.join('\n').length > max) break;
  }
  return lines.join('\n').slice(0, max);
}
export async function editorContext(query, { docs = null, get = ghGetJson } = {}) {
  if (!docs && !String(process.env.IGM_BRIDGE_TOKEN || '').trim()) return '';
  const all = docs || await collectDocs({ get, withMail: false });
  // посты: только явно похожие (от трети лучшего совпадения); заметки владельца: любые совпавшие
  const posts = search(query, all.filter(d => d.source === 'post'), 3);
  const top = posts[0]?.score || 0;
  const notes = search(query, all.filter(d => d.source === 'note'), 3);
  return contextBlock([...notes, ...posts.filter(h => h.score >= Math.max(0.2, top * 0.35))]);
}

// ---------- Чат: ответ по базе ----------
const SYSTEM = 'Ты ассистент владельца Telegram-бота и Instagram-аккаунта про кино и сериалы. Отвечай по-русски, коротко и по делу, '
  + 'ТОЛЬКО на основе фрагментов из базы (посты, правила, лаборатория, заметки, письма). Если в фрагментах нет ответа, так и скажи и предложи, где посмотреть. '
  + 'Не выдумывай факты, цифры, даты и ссылки. Ссылайся на источники их id в квадратных скобках, например [P0012], [N3], [lab]. '
  + 'Стиль: без точки в конце абзацев, без длинного тире. Ответ строго JSON: {"answer":"текст до 1200 знаков","used":["id источников"]}';

export async function answer(question, { docs = null, get = ghGetJson, gen = groqJSON, mail = null } = {}) {
  const q = String(question || '').trim().slice(0, 600);
  if (q.length < 3) throw new ReviewError('Задай вопрос: /ask о чём был пост про «Монарха»?');
  const all = docs || await collectDocs({ get, mail });
  const hits = search(q, all, 7);
  if (!hits.length) return { answer: 'В базе ничего не нашёл по этому вопросу. Попробуй другие слова или добавь заметку: /note текст', sources: [] };
  const ctx = hits.map(h => ({ id: h.id, source: h.source, title: h.title, date: day(h.date), text: h.text.slice(0, 1200) }));
  const out = await gen([{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify({ вопрос: q, фрагменты: ctx }) }], { maxTokens: 900, temperature: 0.2, timeoutMs: 20000 });
  const used = new Set((Array.isArray(out?.used) ? out.used : []).map(String));
  const sources = hits.filter(h => used.has(h.id) || String(out?.answer || '').includes(`[${h.id}]`)).slice(0, 5);
  return { answer: String(out?.answer || '').trim().slice(0, 1500) || 'Не получилось сформулировать ответ', sources: (sources.length ? sources : hits.slice(0, 3)).map(h => ({ id: h.id, title: h.title, url: h.url || null })) };
}

export function answerText(r) {
  const src = r.sources.length ? '\n\n📎 ' + r.sources.map(s => s.url ? `${s.title} — ${s.url}` : s.title).join('\n📎 ') : '';
  return ('🔎 ' + r.answer + src).slice(0, 4000);
}
