// Общие функции мини-приложения пульта IGM (Vercel, без базы данных).
// Источник правды — приватный репозиторий instagram-growth-manager:
// data/telegram/review-queue.json. Пульт только записывает решения владельца,
// в Instagram ничего не публикует и не отправляет.
import crypto from 'node:crypto';

export const QUEUE_PATH = 'data/telegram/review-queue.json';
export const SNAPSHOT_DIR = 'data/snapshots';
export const ITEM_ID = /^[A-Za-z0-9_-]{3,36}$/;
export const KINDS = new Set(['reply', 'post', 'external_comment']);
export const BLOCKED_USERNAMES = new Set(['aika_st']);
export const INIT_MAX_AGE_MS = 6 * 3600 * 1000; // подпись Mini App живёт 6 часов, дальше — переоткрыть приложение

export class ReviewError extends Error {
  constructor(message, code = 400) { super(message); this.code = code; }
}

const env = name => String(process.env[name] || '').trim();
export const botToken = () => env('TG_BOT_TOKEN') || env('BOT_TOKEN');
export const ownerId = () => env('TG_OWNER_CHAT_ID');
export const igmRepo = () => env('IGM_REPOSITORY') || 'YOUR_GITHUB_LOGIN/insta-engine';

export const utcNow = () => new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
export const normalizeUsername = u => String(u ?? '').trim().replace(/^@+/, '').toLowerCase();
export const isBlockedUsername = u => BLOCKED_USERNAMES.has(normalizeUsername(u));

// Проверка подписи initData из Telegram Mini App (окно — 6 часов)
export function verifyInitData(initData, token = botToken(), now = Date.now()) {
  if (!initData || typeof initData !== 'string' || !token) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return null;
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const build = exclude => [...params.entries()]
    .filter(([k]) => !exclude.includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const matches = ex => {
    const calc = crypto.createHmac('sha256', secret).update(build(ex)).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
  };
  if (!matches(['hash']) && !matches(['hash', 'signature'])) return null;
  const authDate = Number(params.get('auth_date') || 0) * 1000;
  if (!authDate || now - authDate > INIT_MAX_AGE_MS) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch { return null; }
}

// Доступ только владельцу. Без настроенного владельца пульт показывает лишь свой ID.
export function authorize(initData) {
  if (!botToken()) throw new ReviewError('На Vercel не задан TG_BOT_TOKEN', 503);
  const user = verifyInitData(initData);
  if (!user) throw new ReviewError('Сессия устарела или пульт открыт не из Telegram. Переоткрой приложение из бота', 401);
  const owner = ownerId();
  if (!owner) {
    const err = new ReviewError('Владелец не настроен: добавь TG_OWNER_CHAT_ID на Vercel', 503);
    err.selfId = String(user.id);
    throw err;
  }
  if (!/^\d{1,25}$/.test(owner) || String(user.id) !== owner) throw new ReviewError('Доступ только у владельца', 403);
  return user;
}

// ---------- Те же правила, что в src/assistant_bot/telegram_control.py ----------
export function safeReviewItem(item) {
  if (!item || !['pending', 'needs_revision'].includes(item.status)) return false;
  if (!ITEM_ID.test(String(item.id ?? ''))) return false;
  if (!KINDS.has(item.kind)) return false;
  if (isBlockedUsername(item.target_username)) return false;
  return Boolean(String(item.proposed_text ?? '').trim());
}

const findItem = (state, id) => (state.items || []).find(i => i.id === id);
const STATUS = { approve: 'approved', reject: 'rejected', revise: 'needs_revision' };

export function applyAction(state, id, action, owner, when = utcNow()) {
  if (!STATUS[action] || !ITEM_ID.test(String(id))) throw new ReviewError('Неверное действие или ID');
  const item = findItem(state, id);
  if (!item || item.status !== 'pending') throw new ReviewError('Карточка уже решена или не найдена', 409);
  if (isBlockedUsername(item.target_username)) throw new ReviewError('Взаимодействие запрещено политикой аккаунта', 403);
  if (!safeReviewItem(item)) throw new ReviewError('Карточка неполная');
  item.status = STATUS[action];
  item.owner_review = { action, owner_id: String(owner), at_utc: when, via: 'mini_app' };
  (state.decisions ||= []).push({
    item_id: id,
    kind: item.kind,
    context: {
      topic: item.topic ?? null,
      situation: item.situation ?? null,
      target_username: item.target_username ?? null,
      original_comment: String(item.original_comment ?? '').slice(0, 1200),
    },
    draft: item.proposed_text,
    decision: action,
    at_utc: when,
    via: 'mini_app',
  });
  return item;
}

export function editCard(state, id, newText, owner, when = utcNow()) {
  const text = String(newText ?? '').trim();
  if (!ITEM_ID.test(String(id)) || !text || text.length > 2000) throw new ReviewError('Неверный ID или длина текста');
  const item = findItem(state, id);
  if (!item || !['pending', 'needs_revision'].includes(item.status)) throw new ReviewError('Править можно только ожидающие карточки', 409);
  if (isBlockedUsername(item.target_username)) throw new ReviewError('Взаимодействие запрещено политикой аккаунта', 403);
  const old = item.proposed_text ?? '';
  item.proposed_text = text;
  item.status = 'pending';
  delete item.owner_review;
  (state.decisions ||= []).push({
    item_id: id, kind: item.kind,
    context: { topic: item.topic ?? null, situation: item.situation ?? null, target_username: item.target_username ?? null },
    draft: old, owner_revision: text, decision: 'edit', at_utc: when, owner_id: String(owner), via: 'mini_app',
  });
  return item;
}

export function addReason(state, id, reason, when = utcNow()) {
  const text = String(reason ?? '').trim();
  if (!ITEM_ID.test(String(id)) || !text || text.length > 1000) throw new ReviewError('Причина: от 1 до 1000 символов');
  const item = findItem(state, id);
  if (!item || !(state.decisions || []).some(d => d.item_id === id)) throw new ReviewError('По этой карточке ещё нет решения', 409);
  state.decisions.push({
    item_id: id, decision: 'owner_reason', reason: text, at_utc: when, kind: item.kind,
    context: { topic: item.topic ?? null, situation: item.situation ?? null }, via: 'mini_app',
  });
  return item;
}

export function checkSchema(state) {
  if (!state || state.schema_version !== 1 || !Array.isArray(state.items) || !Array.isArray(state.decisions)) {
    throw new ReviewError('Неверная схема очереди', 502);
  }
  return state;
}

// Только то, что нужно экрану; заблокированные аккаунты не показываются вовсе
export function publicView(state) {
  const cards = state.items.filter(safeReviewItem).map(i => ({
    id: i.id, kind: i.kind, status: i.status, topic: i.topic ?? null, situation: i.situation ?? null,
    target_username: i.target_username ?? null, original_comment: i.original_comment ?? null,
    proposed_text: i.proposed_text, rationale: i.rationale ?? null, scheduled_for: i.scheduled_for ?? null,
    created_at_utc: i.created_at_utc ?? null,
  }));
  const counts = {};
  for (const i of state.items) counts[i.status || 'unknown'] = (counts[i.status || 'unknown'] || 0) + 1;
  const decisions = state.decisions.slice(-30).reverse().map(d => ({
    item_id: d.item_id, kind: d.kind ?? null, decision: d.decision, at_utc: d.at_utc ?? null,
    topic: d.context?.topic ?? null, reason: d.reason ?? null, via: d.via ?? 'bot',
    text: String(d.owner_revision ?? d.draft ?? '').slice(0, 280),
  }));
  return { cards, counts, decisions };
}

// ---------- GitHub Contents API (мост IGM_BRIDGE_TOKEN) ----------
function ghHeaders() {
  const token = env('IGM_BRIDGE_TOKEN');
  if (!token) throw new ReviewError('На Vercel не задан IGM_BRIDGE_TOKEN', 503);
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mybrand-igm-mini-app',
  };
}
const ghUrl = path => `https://api.github.com/repos/${igmRepo()}/contents/${path}`;

export async function ghGetJson(path, fetchImpl = fetch) {
  const r = await fetchImpl(ghUrl(path), { headers: ghHeaders() });
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new ReviewError('IGM недоступен (GitHub ' + r.status + ')', 502);
  const body = await r.json();
  if (Array.isArray(body)) return { data: body, sha: null };
  const data = JSON.parse(Buffer.from(body.content || '', 'base64').toString('utf8'));
  return { data, sha: body.sha };
}

export async function ghPutJson(path, data, sha, message, fetchImpl = fetch) {
  const content = Buffer.from(JSON.stringify(sortKeys(data), null, 2) + '\n').toString('base64');
  const r = await fetchImpl(ghUrl(path), {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha, content }),
  });
  if (r.status === 409 || r.status === 422) throw new ReviewError('Очередь изменилась, повтори', 409);
  if (!r.ok) throw new ReviewError('Запись в IGM не удалась (GitHub ' + r.status + ')', 502);
  return (await r.json()).content.sha;
}

// Бинарный файл (фото/видео владельца) в IGM
export async function ghPutBinary(path, buffer, message, fetchImpl = fetch) {
  const r = await fetchImpl(ghUrl(path), {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: Buffer.from(buffer).toString('base64') }),
  });
  if (r.status === 422) {
    // 422 бывает и «файл уже есть» (без sha), и ошибка запроса: считаем загруженным, только если файл реально лежит по пути
    const head = await fetchImpl(ghUrl(path), { headers: ghHeaders() }).catch(() => null);
    if (head?.ok) { const meta = await head.json().catch(() => null); if (meta && !Array.isArray(meta) && meta.type === 'file') return true; }
    throw new ReviewError('Не удалось сохранить файл в IGM (GitHub 422)', 502);
  }
  if (!r.ok) throw new ReviewError('Не удалось сохранить файл в IGM (GitHub ' + r.status + ')', 502);
  return true;
}

// Python пишет json.dumps(sort_keys=True) — сохраняем тот же порядок, чтобы диффы были чистыми
export function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}

export async function latestSnapshot(fetchImpl = fetch) {
  const { data: list } = await ghGetJson(SNAPSHOT_DIR, fetchImpl);
  if (!Array.isArray(list)) return null;
  const files = list.map(f => f.name).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort();
  if (!files.length) return null;
  const { data } = await ghGetJson(`${SNAPSHOT_DIR}/${files.at(-1)}`, fetchImpl);
  if (!data) return null;
  return {
    date: data.date_almaty ?? files.at(-1).slice(0, 10),
    captured_at_utc: data.captured_at_utc ?? null,
    username: data.account?.username ?? null,
    followers: data.account?.followers_count ?? null,
    media_count: data.account?.media_count ?? null,
    insights_status: data.insights_status ?? null,
    media: (data.media || []).slice(0, 12).map(m => ({
      id: m.id, caption: String(m.caption ?? '').slice(0, 120), like_count: m.like_count ?? null,
      comments_count: m.comments_count ?? null, timestamp: m.timestamp ?? null, permalink: m.permalink ?? null,
    })),
    history_days: files.length,
  };
}

// ---------- HTTP ----------
export function readBody(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  try { return JSON.parse(Buffer.isBuffer(b) ? b.toString('utf8') : b); } catch { return {}; }
}

export function reply(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

export function fail(res, err) {
  const code = err instanceof ReviewError ? err.code : 500;
  const out = { ok: false, code, error: err instanceof ReviewError ? err.message : 'Внутренняя ошибка' };
  if (err?.selfId) out.self_id = err.selfId;
  if (code === 500) console.error(err);
  reply(res, code, out);
}

// ---------- Аналитика и план (вкладки «Аналитика» и «План») ----------
export const PLAN_PATH = 'content/growth-plan.json';
export const CONTENT_PLAN_PATH = 'content/content-plan.json';
const MAX_SNAPSHOTS = 60;

export async function snapshotHistory(fetchImpl = fetch) {
  const { data: list } = await ghGetJson(SNAPSHOT_DIR, fetchImpl);
  if (!Array.isArray(list)) return [];
  const files = list.map(f => f.name).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().slice(-MAX_SNAPSHOTS);
  const docs = await Promise.all(files.map(n => ghGetJson(`${SNAPSHOT_DIR}/${n}`, fetchImpl).then(r => r.data).catch(() => null)));
  return docs.filter(d => d && d.schema_version === 1 && d.account);
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

// Чистая функция: из снимков и очереди — цифры для экрана. Нет данных → null, не ноль.
export function buildAnalytics(snapshots, queue, now = Date.now()) {
  const days = snapshots.map(s => ({
    date: s.date_almaty, followers: num(s.account.followers_count), media: num(s.account.media_count),
  }));
  const last = snapshots.at(-1) || null;
  const lastDay = days.at(-1) || null;
  const deltaOver = n => {
    if (!lastDay || lastDay.followers == null) return null;
    const cutoff = new Date(new Date(lastDay.date + 'T00:00:00+05:00').getTime() - n * 86400000).toISOString().slice(0, 10);
    const base = days.find(d => d.date >= cutoff && d.followers != null);
    return base && base.date !== lastDay.date ? lastDay.followers - base.followers : null;
  };
  const media = (last?.media || []).map(m => {
    const likes = num(m.like_count), comments = num(m.comments_count);
    const followers = lastDay?.followers;
    return {
      id: m.id, type: m.media_type ?? null, timestamp: m.timestamp ?? null, permalink: m.permalink ?? null,
      caption: String(m.caption ?? '').slice(0, 120), likes, comments,
      er: followers && likes != null ? round(((likes + (comments || 0)) / followers) * 100, 2) : null,
    };
  }).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const withLikes = media.filter(m => m.likes != null);
  const avg = key => (withLikes.length ? round(withLikes.reduce((s, m) => s + (m[key] || 0), 0) / withLikes.length) : null);
  const weekAgo = now - 7 * 86400000;
  const decisions = (queue?.decisions || []);
  const finals = decisions.filter(d => ['approve', 'reject', 'revise'].includes(d.decision));
  const byKind = k => finals.filter(d => (k === 'post' ? d.kind === 'post' : d.kind !== 'post'));
  const rate = list => (list.length ? Math.round((list.filter(d => d.decision === 'approve').length / list.length) * 100) : null);
  const byType = {};
  for (const m of media) byType[m.type || 'UNKNOWN'] = (byType[m.type || 'UNKNOWN'] || 0) + 1;
  return {
    account: last ? {
      username: last.account.username ?? null, followers: lastDay.followers, media_count: lastDay.media,
      captured_at_utc: last.captured_at_utc ?? null, insights_status: last.insights_status ?? null,
    } : null,
    growth: { d7: deltaOver(7), d30: deltaOver(30), days: days.length },
    series: days.slice(-30),
    posts: {
      shown: media.length, avg_likes: avg('likes'), avg_comments: avg('comments'),
      avg_er: media.some(m => m.er != null) ? round(media.filter(m => m.er != null).reduce((s, m) => s + m.er, 0) / media.filter(m => m.er != null).length, 2) : null,
      last_7d: media.filter(m => m.timestamp && Date.parse(m.timestamp) >= weekAgo).length,
      by_type: byType,
      top: [...withLikes].sort((a, b) => (b.likes + (b.comments || 0)) - (a.likes + (a.comments || 0))).slice(0, 5),
      recent: media.slice(0, 10),
    },
    insights: { reach: null, views: null, saves: null, shares: null, available: last?.insights_status === 'configured' },
    review: {
      total: finals.length,
      posts_reviewed: byKind('post').length, posts_approval_rate: rate(byKind('post')),
      comments_reviewed: byKind('comment').length, comments_approval_rate: rate(byKind('comment')),
      edits: decisions.filter(d => d.decision === 'edit').length,
      reasons: decisions.filter(d => d.decision === 'owner_reason').length,
    },
  };
}

// Автозакрытие: условие → выполнено ли оно по данным аналитики
// Задачи плана, которые закрываются по факту: снимки, конвейер постов (x.pipe) и лаборатория (x.lab)
const pubPosts = x => (x?.pipe?.posts || []).filter(p => p.status === 'published' && p.ig?.media_id && !p.ig?.missing && !p.ig_archived_at_utc);
const reelsN = x => pubPosts(x).filter(p => p.draft?.format === 'reel').length;
export const AUTO_RULES = {
  snapshots: a => (a?.growth?.days ?? 0) >= 1,
  insights: (a, x) => Boolean(a?.insights?.available) || x?.lab?.metric_source === 'insights' || pubPosts(x).some(p => p.metrics?.latest?.source === 'insights'),
  reels_published: (a, x) => Boolean(a?.posts?.by_type?.VIDEO || a?.posts?.by_type?.REELS) || pubPosts(x).some(p => p.draft?.format === 'reel'),
  api_publish: (a, x) => pubPosts(x).length > 0,
  lab_checkpoints: (a, x) => pubPosts(x).some(p => p.metrics?.h24),
  published_20: (a, x) => pubPosts(x).length >= 20,
  reels_3: (a, x) => reelsN(x) >= 3,
  lab_report_20: (a, x) => (x?.lab?.posts_measured || 0) >= 20,
  replies_30: a => (a?.review?.comments_reviewed || 0) >= 30,
  followers_1000: a => (a?.account?.followers ?? 0) >= 1000,
  lab_compare: (a, x) => Object.values(x?.lab?.segments || {}).some(list => (list || []).some(r => r.n >= (x.lab.min_posts_for_verdict || 3) && r.verdict !== 'мало данных')),
};
export const AUTO_LABEL = { snapshots: 'по ежедневным снимкам', insights: 'когда лаборатория получит охваты', reels_published: 'после первого Reels через робота',
  api_publish: 'после первой публикации роботом', lab_checkpoints: 'после первого замера через 24 ч', lab_compare: 'когда в сегменте наберётся 3+ поста',
  published_20: 'по числу опубликованных постов', reels_3: 'по числу опубликованных Reels', lab_report_20: 'когда лаборатория замерит 20 постов',
  replies_30: 'по числу одобренных ответов', followers_1000: 'по числу подписчиков' };
// Статистика конвейера для вкладки «План»
export function pipelineStats(posts, analytics) {
  const live = p => p.status === 'published' && !p.ig?.missing && !p.ig_archived_at_utc;
  const kind = p => p.draft?.format === 'reel' ? 'reel' : (p.draft?.slides || []).length > 1 ? 'carousel' : 'post';
  const pub = posts.filter(live);
  const weekAgo = Date.now() - 7 * 86400e3;
  const cnt = (arr, f) => arr.filter(f).length;
  const SRC = { manual: 'сам в конструкторе', auto: 'ИИ-редактор', news: 'из новостей', bot: 'тема из бота', app: 'из Instagram Manager', studio: 'конструктор', own: 'свои фото/видео', own_text: 'свой текст' };
  const bySource = {};
  for (const p of pub) { const k = SRC[p.source?.kind] || 'другое'; bySource[k] = (bySource[k] || 0) + 1; }
  return {
    published: pub.length, posts: cnt(pub, p => kind(p) === 'post'), carousels: cnt(pub, p => kind(p) === 'carousel'), reels: cnt(pub, p => kind(p) === 'reel'),
    slides: pub.reduce((n, p) => n + Math.max(1, (p.draft?.slides || []).length), 0),
    week: cnt(pub, p => Date.parse(p.ig?.published_at || 0) > weekAgo),
    waiting: cnt(posts, p => ['text_review', 'final_review'].includes(p.status)), scheduled: cnt(posts, p => p.status === 'scheduled'), building: cnt(posts, p => ['rendering', 'publishing', 'publishing_in_progress'].includes(p.status)),
    failed: cnt(posts, p => p.status === 'failed'), rejected: cnt(posts, p => p.status === 'rejected'),
    deleted: cnt(posts, p => p.status === 'published' && p.ig?.missing), archived: cnt(posts, p => p.status === 'published' && p.ig_archived_at_utc),
    created: posts.length, by_source: bySource,
    with_db_images: cnt(pub, p => (p.image_sources || []).length > 0),
    followers: analytics?.account?.followers ?? null,
  };
}
// Прогресс счётных задач: «10 / 20»
export const AUTO_PROGRESS = {
  published_20: (a, x) => [pubPosts(x).length, 20], reels_3: (a, x) => [reelsN(x), 3], lab_report_20: (a, x) => [x?.lab?.posts_measured || 0, 20],
  replies_30: a => [a?.review?.comments_reviewed || 0, 30], followers_1000: a => [a?.account?.followers ?? 0, 1000],
};

// Статус этапа по задачам. locked не трогаем; один этап «в работе» — первый незавершённый.
export function recomputeStages(stages) {
  for (const s of stages) {
    if (s.status === 'locked' || !s.tasks?.length) continue;
    const done = s.tasks.filter(t => t.done).length;
    if (done === s.tasks.length) s.status = 'done';
    else if (done > 0 || s.status === 'done') s.status = 'in_progress';
  }
  if (!stages.some(s => s.status === 'in_progress')) {
    const next = stages.find(s => s.status === 'todo');
    if (next) next.status = 'in_progress';
  }
  return stages;
}

export function buildPlan(plan, contentPlan, analytics, extra = {}) {
  if (!plan || plan.schema_version !== 1) return null;
  const gates = plan.autonomy_gates || {};
  const published = extra.pipe ? pubPosts(extra).length : (analytics?.account?.media_count ?? null);
  const stages = recomputeStages((plan.stages || []).map(s => ({
    id: s.id, title: s.title, status: s.status, summary: s.summary ?? null,
    tasks: (s.tasks || []).map((t, i) => {
      const auto = AUTO_RULES[t.auto] ? t.auto : null;
      const autoDone = auto ? AUTO_RULES[auto](analytics, extra) : false;
      const prog = auto && AUTO_PROGRESS[auto] ? AUTO_PROGRESS[auto](analytics, extra) : null;
      const who = ['owner', 'auto', 'claude'].includes(t.who) ? t.who : auto ? 'auto' : 'owner';
      const isNew = Boolean(t.added_at) && Date.now() - Date.parse(t.added_at) < 7 * 86400e3; // NEW неделю после добавления
      return { i, title: t.title, done: Boolean(t.done) || autoDone, auto, auto_label: auto ? AUTO_LABEL[auto] : null, who, is_new: isNew, progress: prog ? { have: Math.min(prog[0], prog[1]), need: prog[1] } : null };
    }),
  })));
  return {
    goal: plan.goal ?? null,
    updated: plan.updated ?? null,
    stages,
    experiment: plan.experiment ? {
      ...plan.experiment,
      published, // фактически выпущено (по последнему снимку)
      progress: published == null ? null : Math.min(published, plan.experiment.total?.posts ?? 20),
    } : null,
    stats: extra.pipe ? pipelineStats(extra.pipe.posts || [], analytics) : null,
    gates: {
      posts: { need: gates.reviewed_posts ?? 20, have: extra.pipe ? pubPosts(extra).length : (analytics?.review?.posts_reviewed ?? 0) },
      comments: { need: gates.approved_comment_examples ?? 30, have: analytics?.review?.comments_reviewed ?? 0 },
    },
    ideas: (contentPlan?.posts || []).slice(0, 40).map(p => ({ id: p.id, format: p.format, title: p.title, hook: p.hook ?? null })),
    ideas_note: 'Старый AI-план. Заменится сеткой о кино и сериалах на этапе 3.',
  };
}

// Отметка задачи владельцем: меняет content/growth-plan.json в IGM
export function toggleTask(plan, stageId, index, done, when = utcNow()) {
  if (!plan || plan.schema_version !== 1) throw new ReviewError('План не найден', 404);
  const stage = (plan.stages || []).find(s => s.id === stageId);
  const task = stage?.tasks?.[index];
  if (!task || !Number.isInteger(index)) throw new ReviewError('Задача не найдена', 404);
  if (stage.status === 'locked') throw new ReviewError('Этап закрыт: он открывается отдельным решением', 409);
  if (task.auto && AUTO_RULES[task.auto]) throw new ReviewError('Эта задача закрывается автоматически', 409);
  task.done = Boolean(done);
  if (task.done) { task.done_at = when; task.done_by = 'owner'; } else { delete task.done_at; delete task.done_by; }
  recomputeStages(plan.stages);
  plan.updated = when.slice(0, 10);
  return { stage, task };
}
