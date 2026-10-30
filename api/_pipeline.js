// Конвейер постов: текст (согласование) → сборка в Cover Studio (робот IGM) → финал (согласование) → публикация.
// Очередь — IGM data/pipeline/posts.json. Vercel меняет статусы по решениям владельца,
// а workflow pipeline.yml в IGM рендерит и публикует (там лежит токен Instagram).
import crypto from 'node:crypto';
import { botToken, ghGetJson, ghPutJson, ownerId, ReviewError, utcNow } from './_lib.js';
import { generateAI, PRESETS } from './ai-draft.js';
import { groqJSON } from './_groq.js';
import { loadLearning, VISUAL_FIELDS } from './_learning.js';
import { briefHeader, planVisuals } from './_visual.js';
import { suggestImages } from './_autoimages.js';
import { warningsText } from './_editorial-preflight.js';
import { capHashtags } from './_hashtags.js';
import { backoff, kickRobot, postsNeedingRobot, statusSnapshot } from './_kick.js';

export const PIPE_PATH = 'data/pipeline/posts.json';
export const POST_ID = /^P\d{4,6}$/;
export const MEDIA_PATH = /^media\/posts\/P\d{4,6}\/(\d{1,2}\.jpg|reel\.mp4|bg-[A-Za-z0-9_-]{1,60}\.(?:jpg|png))$/;
const env = n => String(process.env[n] || '').trim();
export const pipelineSecret = () => env('PIPELINE_SECRET');

export const STATUS_LABEL = {
  text_review: '📝 текст на согласовании', rendering: '🎨 собирается в конструкторе', final_review: '🖼 финал на согласовании', scheduled: '🕒 запланирован', handed_off: '📥 у тебя: публикуешь сам',
  publishing: '📤 публикуется', publishing_in_progress: '📤 публикуется', published: '✅ опубликован', rejected: '❌ отклонён', failed: '⚠️ ошибка',
};
const FORMAT_LABEL = { reel: 'Reels', portrait: 'Карусель', square: 'Квадрат' };
const formatLabel = d => d.format === 'portrait' && (d.slides || []).length === 1 ? 'Пост' : (FORMAT_LABEL[d.format] || d.format);

// ---------- подпись ссылок на медиа (тот же алгоритм в IGM src/igm/pipeline.py) ----------
export function sign(path, exp, secret = pipelineSecret()) {
  return crypto.createHmac('sha256', secret).update(`${path}:${Math.floor(exp)}`).digest('hex').slice(0, 40);
}
export function mediaUrl(host, path, ttl = 24 * 3600, secret = pipelineSecret(), now = Date.now()) {
  const exp = Math.floor(now / 1000) + ttl;
  return `https://${host}/api/media?p=${path}&e=${exp}&s=${sign(path, exp, secret)}`;
}
export function verifyMedia(path, exp, s, secret = pipelineSecret(), now = Date.now()) {
  if (!secret || !MEDIA_PATH.test(String(path)) || !/^\d{9,11}$/.test(String(exp)) || !/^[a-f0-9]{40}$/.test(String(s))) return false;
  if (Number(exp) * 1000 < now) return false;
  const a = Buffer.from(sign(path, Number(exp), secret)), b = Buffer.from(String(s));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Хук от IGM: подпись строки id:event:ts
export function hookSignature(id, event, ts, secret = pipelineSecret()) {
  return crypto.createHmac('sha256', secret).update(`${id}:${event}:${ts}`).digest('hex');
}

// ---------- модель ----------
export const emptyState = () => ({ schema_version: 1, posts: [], note: 'Конвейер постов MyBrand' });
export function nextId(state) {
  const max = state.posts.reduce((m, p) => Math.max(m, Number(String(p.id).slice(1)) || 0), 0);
  return 'P' + String(max + 1).padStart(4, '0');
}
const log = (post, event, by, note) => {
  (post.history ||= []).push({ at: utcNow(), event, by: String(by), ...(note ? { note: String(note).slice(0, 300) } : {}) });
  post.updated_at_utc = utcNow();
};
export const findPost = (state, id) => {
  const post = state.posts.find(p => p.id === id);
  if (!post) throw new ReviewError('Пост не найден', 404);
  return post;
};

function cleanBrief(b) {
  if (!b || typeof b !== 'object') return null;
  const s = (v, n) => String(v ?? '').trim().slice(0, n);
  const arr = (v, k, n) => (Array.isArray(v) ? v : []).slice(0, k).map(x => s(x, n)).filter(Boolean);
  return {
    story: s(b.story, 300), conflict: s(b.conflict, 300), setting: s(b.setting, 200),
    status: ['in_development', 'released', 'evergreen', 'unknown'].includes(b.status) ? b.status : 'unknown',
    characters: (Array.isArray(b.characters) ? b.characters : []).slice(0, 4).map(c => ({ id: s(c?.id, 40), look: s(c?.look, 260) })).filter(c => c.id && c.look),
    facts: arr(b.facts, 6, 200), assumptions: arr(b.assumptions, 6, 200), style: s(b.style, 300), moments: arr(b.moments, 10, 400),
  };
}
function cleanDraft(d) {
  if (!d || !Array.isArray(d.slides) || !d.slides.length || d.slides.length > 10) throw new ReviewError('Черновик без слайдов');
  const s = (v, n) => String(v ?? '').trim().slice(0, n);
  const fmt = ['reel', 'portrait', 'square'].includes(d.format) ? d.format : 'reel';
  return {
    preset_id: s(d.preset_id, 40) || null, visual_style: s(d.visual_style, 20) || 'noir', topic: s(d.topic, 220),
    format: fmt, category: s(d.category, 20) || 'cinema', theme: s(d.theme, 20) || 'orange', layout: s(d.layout, 20) || 'editorial',
    slides: d.slides.map(x => ({ title: s(x?.title, 110), subtitle: s(x?.subtitle, 300) })),
    caption: capHashtags(s(d.caption, 2200)), video_script: s(d.video_script, 2900),
    verification_notes: (Array.isArray(d.verification_notes) ? d.verification_notes : []).slice(0, 6).map(x => s(x, 180)),
    visual_prefs: cleanVisual(d.visual_prefs),
    tags: cleanTags(d.tags),
    image_prompt: s(d.image_prompt, 1200) || null,
    image_prompts: (Array.isArray(d.image_prompts) ? d.image_prompts : []).map(x => s(x, 1200)).filter(Boolean).slice(0, 10),
    visual_brief: cleanBrief(d.visual_brief),
    music_mood: ['tense', 'calm', 'epic', 'sad', 'upbeat', 'mystery'].includes(d.music_mood) ? d.music_mood : null,
    reel_style: Object.keys(REEL_STYLES).includes(d.reel_style) ? d.reel_style : null,
    bg_mono: d.bg_mono === true, // чёрно-белые фото (некрологи)
    image_suggestions: (Array.isArray(d.image_suggestions) ? d.image_suggestions : []).filter(x => x && /^https:\/\/(image\.tmdb\.org|assets\.fanart\.tv)\//.test(x.url) && Number.isInteger(x.slide) && x.slide >= 1 && x.slide <= 10)
      .slice(0, 10).map(x => ({ slide: x.slide, url: s(x.url, 300), thumb: /^https:\/\/(image\.tmdb\.org|assets\.fanart\.tv)\//.test(x.thumb) ? s(x.thumb, 300) : null, source: s(x.source, 20) || 'TMDB', title: s(x.title, 120), kind: x.kind === 'person' ? 'person' : 'title' })),
    credits: d.credits && Array.isArray(d.credits.lines) ? { title: s(d.credits.title, 80), lines: d.credits.lines.map(l => ({ name: s(l?.name, 50), role: s(l?.role, 50) })).filter(l => l.name).slice(0, 8) } : null,
    credits_on: Boolean(d.credits_on && d.credits?.lines?.length),
  };
}
function cleanPages(pages) {
  if (pages == null) return null;
  if (!Array.isArray(pages) || !pages.length || pages.length > 10) throw new ReviewError('Некорректные слайды конструктора');
  const json = JSON.stringify(pages);
  if (json.length > 60000) throw new ReviewError('Слайды слишком большие: убери загруженные фото, фон соберётся строгим стилем');
  if (/data:/.test(json)) throw new ReviewError('Загруженные фото пока не поддерживаются в автосборке — используй строгий фон');
  return JSON.parse(json);
}

export function cleanTags(t) {
  if (!t || typeof t !== 'object') return {};
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase().slice(0, n) : null);
  const list = (v, k) => (Array.isArray(v) ? v : []).map(x => str(x, 60)).filter(Boolean).slice(0, k);
  return { genres: list(t.genres, 3), titles: list(t.titles, 4), freshness: str(t.freshness, 20), angle: str(t.angle, 20), hook: str(t.hook, 20) };
}

export function cleanVisual(v) {
  if (!v || typeof v !== 'object') return null;
  const out = {};
  for (const k of VISUAL_FIELDS) {
    const x = v[k];
    if (typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 2000) out[k] = x;
    else if (typeof x === 'boolean') out[k] = x;
    else if (typeof x === 'string' && /^[#\w -]{1,40}$/.test(x)) out[k] = x;
  }
  return Object.keys(out).length ? out : null;
}

export function createPost(state, { draft, pages = null, source }, by) {
  const post = {
    id: nextId(state), status: 'text_review', created_at_utc: utcNow(), updated_at_utc: utcNow(),
    source: { kind: source?.kind || 'bot', topic: String(source?.topic || draft?.topic || '').slice(0, 220), facts: String(source?.facts || '').slice(0, 1500),
      preset_id: source?.preset_id || draft?.preset_id || null, style_id: source?.style_id || draft?.visual_style || null, voice: source?.voice || 'thoughtful', link: source?.link || null,
      hypothesis: source?.hypothesis ? String(source.hypothesis).slice(0, 200) : null, mode: source?.mode || null },
    draft: cleanDraft(draft), pages: cleanPages(pages), approvals: {}, media: null, ig: null, error: null, history: [],
  };
  log(post, 'created', by, post.source.kind);
  state.posts.push(post);
  state.posts = state.posts.slice(-200);
  return post;
}

export function replaceDraft(post, { draft, pages }, by, note) {
  if (['publishing', 'publishing_in_progress'].includes(post.status)) throw new ReviewError('Пост уже публикуется, менять поздно', 409);
  if (post.status === 'published') throw new ReviewError('Пост уже опубликован. Чтобы сделать новый на его основе, нажми «Копия» в Instagram Manager', 409);
  if (post.status === 'rendering') throw new ReviewError('Пост сейчас собирается. Дождись финала (2–3 минуты) и правь уже его', 409);
  if (!['text_review', 'failed', 'final_review', 'rejected', 'scheduled'].includes(post.status)) throw new ReviewError('Этот пост сейчас нельзя менять', 409);
  if (post.status === 'final_review') log(post, 'layout_updated', by);
  if (post.status === 'rejected') log(post, 'reopened', by, 'правка в конструкторе после отклонения');
  const wasMono = post.draft?.bg_mono === true;
  post.draft = cleanDraft(draft);
  // Ч/Б фото некролога сохраняется при «Другом варианте», смене формата и правке, если новый черновик его не задаёт
  if (wasMono && !(draft && 'bg_mono' in draft)) post.draft.bg_mono = true;
  if (pages !== undefined) post.pages = cleanPages(pages);
  delete post.factcheck; // any prior fact check belongs to a different draft
  post.status = 'text_review'; post.approvals = {}; post.media = null; post.error = null;
  log(post, 'text_updated', by, note);
  return post;
}

// Instagram Graph API does not reliably expose a separate archive state.
// This is an OWNER-MANAGED marker, not a mutation of Instagram content or
// the existing publishing state machine. Keep status='published'.
export function setArchiveMarker(post, archived, by) {
  if (post.status !== 'published' || !post.ig?.media_id)
    throw new ReviewError('Архивировать можно только ранее опубликованный пост', 409);
  if (Boolean(post.ig_archived_at_utc) === Boolean(archived)) return post;
  if (archived) post.ig_archived_at_utc = utcNow();
  else delete post.ig_archived_at_utc;
  log(post, archived ? 'marked_archived' : 'marked_unarchived', by,
    'Отметка владельца — перенос в Instagram не выполняется');
  return post;
}

// Re-edit by creating a NEW draft. The published original and all its
// history, Instagram ids, media and analytics are never touched.
// Original image files remain referenced read-only; new generated files
// belong to the new post id. All approvals must happen again.
export function copyToDraft(state, original, by) {
  if (!['published','rejected'].includes(original.status))
    throw new ReviewError('Копировать можно опубликованный или отклонённый пост', 409);
  if (original.source?.kind === 'own' && !original.own?.files?.length)
    throw new ReviewError('Для копии не найдены исходные файлы', 409);
  const source = {
    ...(original.source || {}), kind: original.source?.kind === 'own' ? 'own' : 'studio',
    topic: original.source?.topic || original.draft?.topic || '',
  };
  const cloned = createPost(state, {
    draft: structuredClone(original.draft),
    pages: original.pages ? structuredClone(original.pages) : null,
    source,
  }, by);
  cloned.copied_from = original.id;
  if (original.studio_sync === 1) cloned.studio_sync = 1;
  if (original.bg?.path) cloned.bg = structuredClone(original.bg);
  if (original.bgs) cloned.bgs = structuredClone(original.bgs);
  if (original.image_sources) cloned.image_sources = structuredClone(original.image_sources);
  if (original.own) cloned.own = structuredClone(original.own);
  // New clone is never considered published, even when original is archived.
  cloned.approvals = {};
  cloned.media = null;
  cloned.ig = null;
  log(cloned, 'copied_from', by, original.id);
  return cloned;
}

// Решения владельца. Возвращает пост; запись в IGM делает вызывающий.
export const OWNER_MADE = ['manual', 'own', 'own_text'];
// Пресеты Reels (темп, переходы, движение, музыка) — те же ключи, что в IGM src/igm/reel.py
export const REEL_STYLES = { dynamic: '⚡ Динамичный', calm: '🌙 Спокойный', epic: '🏔 Эпичный', thriller: '🔪 Напряжённый', nostalgic: '📼 Ностальгия', mystery: '🕯 Загадочный' };
export const REEL_STYLE_HINT = { dynamic: 'быстрые сцены, резкие переходы', calm: 'длинные сцены, мягкие растворения', epic: 'мощные наезды, затемнения', thriller: 'рваный темп, тёмные переходы', nostalgic: 'медленно, светлые растворения', mystery: 'медленный наезд, растворения' };
// Короткий id сборки: финал согласуется только тот, что владелец видел (кнопки несут rid)
export const renderId = post => post?.media?.rendered_at ? crypto.createHash('sha1').update(String(post.media.rendered_at)).digest('hex').slice(0, 8) : null;
export const STALE_FINAL = 'Финал обновился, открой последнюю карточку';
export function act(post, action, by, opts = {}) {
  const st = post.status;
  if (action === 'approve_text') {
    if (st !== 'text_review') throw new ReviewError('Текст уже не на согласовании', 409);
    if (post.source?.kind === 'own') {
      if (!post.own?.files?.length) throw new ReviewError('Файлы ещё загружаются — подожди пару секунд', 409);
      if (!String(post.draft.caption || '').trim()) throw new ReviewError('Нет подписи: ответь на карточку текстом или /aicap ' + post.id + ' о чём пост', 409);
    }
    post.approvals = { text: { by: String(by), at: utcNow() } };
    post.status = 'rendering'; post.error = null;
    // точность ИИ считаем только по его постам: свои посты владельца в статистику не идут
    post.learn_stat = OWNER_MADE.includes(post.source?.kind) ? null : (post.history || []).some(h => ['text_updated'].includes(h.event)) ? 'text_changed' : 'text_first_ok';
  } else if (action === 'approve_final') {
    if (st !== 'final_review') throw new ReviewError('Финал уже не на согласовании', 409);
    if (!post.approvals?.text?.by || !post.media?.images?.length) throw new ReviewError('Нет согласованного текста или готовых картинок', 409);
    const rid = renderId(post);
    if (rid && opts.rid !== rid) throw new ReviewError(STALE_FINAL, 409);
    post.approvals.final = { by: String(by), at: utcNow(), ...(post.media?.rendered_at ? { rid: String(post.media.rendered_at) } : {}) };
    // отложенная публикация: робот выпустит пост сам, когда наступит время
    post.status = post.scheduled_at && Date.parse(post.scheduled_at) > Date.now() + 5 * 60e3 ? 'scheduled' : 'publishing';
    post.learn_stat = OWNER_MADE.includes(post.source?.kind) ? null : (post.history || []).some(h => ['redo', 'layout_updated'].includes(h.event)) ? 'final_changed' : 'final_first_ok';
  } else if (action === 'redo') {
    if (!['final_review', 'failed', 'scheduled'].includes(st)) throw new ReviewError('Нечего переделывать', 409);
    post.status = 'text_review'; post.approvals = {}; post.error = null;
  } else if (action === 'retry') {
    if (st !== 'failed') throw new ReviewError('Пост не в ошибке', 409);
    if (post.error?.stage === 'publish') { post.status = 'final_review'; post.approvals = { text: post.approvals?.text }; }
    else { post.status = post.approvals?.text?.by ? 'rendering' : 'text_review'; }
    post.error = null;
  } else if (action === 'handoff') {
    // «Опубликую сам»: робот не публикует, файлы уходят владельцу (черновик в Instagram, своя музыка)
    if (!['final_review', 'scheduled'].includes(st)) throw new ReviewError('Отдать можно только готовый финал', 409);
    if (!post.media?.images?.length) throw new ReviewError('Нет готовых файлов', 409);
    post.status = 'handed_off'; delete post.scheduled_at;
  } else if (action === 'publish_now') {
    if (st !== 'scheduled') throw new ReviewError('Пост не запланирован', 409);
    post.status = 'publishing'; delete post.scheduled_at;
  } else if (action === 'reject') {
    if (!['text_review', 'final_review', 'failed', 'scheduled'].includes(st)) throw new ReviewError('Пост уже нельзя отклонить', 409);
    post.status = 'rejected';
  } else {
    throw new ReviewError('Неизвестное действие');
  }
  log(post, action, by);
  return post;
}

// ---------- отложенная публикация ----------
export const almatyTime = iso => { const d = new Date(Date.parse(iso) + 5 * 3600e3); return `${d.getUTCDate()}.${String(d.getUTCMonth() + 1).padStart(2, '0')} в ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
// Время публикации: целый час 08:00–23:00 по Алматы, от «через 30 минут» до 30 дней. null — сразу после согласования
export function cleanSchedule(at, now = Date.now()) {
  if (at == null || at === '') return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) throw new ReviewError('Неверное время публикации');
  const local = new Date(t + 5 * 3600e3);
  if (local.getUTCMinutes() !== 0) throw new ReviewError('Время публикации — целый час (робот проверяет очередь раз в час)');
  if (local.getUTCHours() < 8 || local.getUTCHours() > 23) throw new ReviewError('Публикация по расписанию возможна с 08:00 до 23:00 по Алматы');
  if (t < now + 30 * 60e3) throw new ReviewError('Выбери время хотя бы через полчаса');
  if (t > now + 30 * 86400e3) throw new ReviewError('Не дальше чем на 30 дней вперёд');
  return new Date(t).toISOString();
}
export function setSchedule(post, at, by) {
  if (['published', 'publishing', 'publishing_in_progress', 'rejected'].includes(post.status)) throw new ReviewError('Этому посту время уже не назначить', 409);
  const clean = cleanSchedule(at);
  if (clean) post.scheduled_at = clean; else delete post.scheduled_at;
  // уже согласован и ждёт: снять расписание = публиковать сейчас; перенос остаётся в очереди
  if (post.status === 'scheduled' && !clean) post.status = 'publishing';
  log(post, clean ? 'scheduled' : 'unscheduled', by, clean ? almatyTime(clean) : '');
  return post;
}

// ---------- запись в IGM ----------
// Запись с повтором при конфликте (до 6 попыток, пауза 150–600 мс). Замыкание выполняется заново
// на свежем состоянии, поэтому всё, что нужно вызывающему, возвращайте из него, а не через внешние переменные.
// После записи: если пост ушёл в сборку/публикацию или отложенному пора, пинаем робота (kick.json).
export const PIPE_ATTEMPTS = 6;
const DEFAULT_PIPE_DEPS = { get: ghGetJson, put: ghPutJson };
export async function withPipe(mutate, deps = DEFAULT_PIPE_DEPS) {
  const kick = 'kick' in deps ? deps.kick : (deps.get === ghGetJson ? kickRobot : null);
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const { data, sha } = await deps.get(PIPE_PATH);
    const state = data && Array.isArray(data.posts) ? data : emptyState();
    const before = statusSnapshot(state);
    const result = await mutate(state);
    if (!result?.message) return result;
    try { await deps.put(PIPE_PATH, state, sha || undefined, result.message); }
    catch (err) {
      if (!(err instanceof ReviewError && err.code === 409) || attempt >= PIPE_ATTEMPTS - 1) throw err;
      await sleep(backoff());
      continue;
    }
    const ids = kick ? postsNeedingRobot(before, state) : [];
    if (ids.length) { try { await kick(result.message, ids); } catch (err) { console.error('kick', err?.message); } }
    return result;
  }
}

// ---------- генерация ----------
export function presetFor(kind, topic) {
  const series = /сериал|сезон|шоу|series/i.test(String(topic));
  if (kind === 'carousel') return series ? 'series_carousel' : 'cinema_carousel';
  if (kind === 'reel') return series ? 'series_analysis' : 'cinema_opinion';
  return series ? 'series_post' : 'cinema_post'; // обычный пост-картинка в ленту
}
// У карусели свой промпт на каждый слайд, разные сцены в одном стиле. Если ИИ их не дал — просим отдельно
export async function ensureSlidePrompts(d, json = groqJSON) {
  const n = (d.slides || []).length;
  if (n < 2) { d.image_prompts = []; return d; }
  const uniq = new Set((d.image_prompts || []).map(x => String(x).trim()));
  if ((d.image_prompts || []).length >= n && uniq.size >= Math.min(n, 3)) return d;
  const o = await json([
    { role: 'system', content: 'You write image-generation prompts (Midjourney/Flux) for an Instagram carousel about film and TV. One prompt per slide, in English. Each prompt shows a SPECIFIC moment, action or conflict from that slide\'s text (who, what they do, emotion, composition, lighting), not a generic pretty picture. Keep the same characters (same described appearance) and one visual style across all slides. If the project is announced or in development, make it editorial concept art, never pretend to be a real still. No text, letters or numbers, no logos, no real actors, no movie stills or posters. Vertical 4:5 with a calm empty upper third for the headline. Return only JSON: {"prompts":["..."]}' },
    { role: 'user', content: JSON.stringify({ base_style: d.image_prompt || '', slides: d.slides.map(x => x.title + (x.subtitle ? ' — ' + x.subtitle : '')) }) },
  ], { maxTokens: 2000, temperature: 0.6 });
  const list = (Array.isArray(o?.prompts) ? o.prompts : []).map(x => String(x || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 600)).filter(Boolean);
  if (list.length) d.image_prompts = list.slice(0, n);
  return d;
}

export async function generateDraft(params, gen = generateAI, learning = null, deps = {}) {
  const l = learning || await loadLearning().catch(() => null);
  // База знаний: прошлые посты по теме и заметки владельца, чтобы не повторяться и опираться на проверенное
  if (params.context == null) {
    const ctx = deps.editorContext || (async q => (await import('./_rag.js')).editorContext(q));
    params = { ...params, context: await ctx(`${params.topic || ''} ${String(params.facts || '').slice(0, 400)}`).catch(() => '') };
  }
  // timeoutMs: в чате бота ждём ИИ меньше (на попытку ~15 с), чтобы уложиться в лимит функции
  const d = await gen(params, { rules: l?.rules || [], examples: l?.examples || [], ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}) });
  const prefs = l?.visual_prefs?.[d.format];
  const out = { ...d, preset_id: params.presetId, topic: params.topic, ...(prefs ? { visual_prefs: prefs } : {}) };
  // Промпты: сначала разбор новости (сюжет, персонажи, конфликт, факты/допущения), потом сцена на каждый слайд
  try { await (deps.planVisuals || planVisuals)(out, { source: params.facts || '' }); }
  catch (err) { console.error('visual plan', err?.message); await ensureSlidePrompts(out).catch(() => {}); }
  // кадры из TMDB по фильмам и актёрам из текста (ставятся только после «Взять кадры»)
  out.image_suggestions = await (deps.suggestImages || suggestImages)(out).catch(() => []);
  return out;
}
export const postKind = d => d.format === 'reel' ? 'reel' : (d.slides || []).length > 1 ? 'carousel' : 'post';
export async function regenerate(post, feedback, gen = generateAI, kind = null, opts = {}) {
  const topic = post.source?.topic || post.draft.topic || post.draft.slides[0].title;
  const presetId = kind ? presetFor(kind, topic + ' ' + (post.draft.category === 'series' ? 'сериал' : '')) : (post.draft.preset_id || post.source?.preset_id);
  if (!PRESETS[presetId]) throw new ReviewError('Для этого поста нет пресета ИИ — поправь текст в конструкторе', 409);
  const fb = kind ? `Переделай в формат: ${{ post: 'пост-картинка (одна обложка, мысль в подписи)', carousel: 'карусель из нескольких слайдов', reel: 'Reels (одна обложка 9:16 и сценарий озвучки)' }[kind]}. Сохрани тему, факты и подачу.` : feedback;
  return generateDraft({ presetId, styleId: post.draft.visual_style, topic, facts: post.source?.facts || '', voice: post.source?.voice, feedback: fb, previous: kind ? null : post.draft, ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}) }, gen);
}
const FORMAT_SWITCH = { post: '🖼 В пост', carousel: '📚 В карусель', reel: '🎬 В Reels' };

// ---------- Telegram ----------
export async function tgCall(method, body, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${botToken()}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false, description: 'network' }; }
}

export function textCard(post) {
  const d = post.draft;
  if (post.source?.kind === 'own') return ownCard(post);
  const lines = [...(post._intro ? [post._intro, ''] : []), `📝 Пост ${post.id} · ${formatLabel(d)} · текст на согласование`, ...(post.scheduled_at ? [`🕒 Публикация: ${almatyTime(post.scheduled_at)} по Алматы`] : []), ''];
  d.slides.forEach((s, i) => lines.push(`${d.slides.length > 1 ? `${i + 1}. ` : ''}${s.title}${s.subtitle ? '\n   ' + s.subtitle : ''}`));
  lines.push('', 'Подпись:', d.caption || '—');
  if (d.video_script) lines.push('', 'Сценарий Reels:', d.video_script.slice(0, 900));
  if (d.credits?.lines?.length) lines.push('', `🎞 Титры ${d.credits_on ? '(последний слайд)' : '(выключены)'}${d.credits.title ? ': ' + d.credits.title : ''}`, ...d.credits.lines.map(l => `${l.name}${l.role ? ' · ' + l.role : ''}`));
  if (d.format === 'reel') {
    const MOOD = { tense: 'напряжённое', calm: 'спокойное', epic: 'эпичное', sad: 'грустное', upbeat: 'бодрое', mystery: 'загадочное' };
    const rs = d.reel_style || 'dynamic';
    lines.push('', `🎛 Стиль монтажа: ${REEL_STYLES[rs]} (${REEL_STYLE_HINT[rs]}). Сменить: кнопки ниже`);
    lines.push(post.music?.title ? `🎵 Музыка: «${post.music.title}» (твой выбор)` : `🎵 Музыка: подберу ${MOOD[d.music_mood] || 'спокойное'} настроение из библиотеки. Свой трек: пришли аудио ответом на эту карточку`,
      `🎬 Свои видео: пришли клип ответом на эту карточку (номер сцены в подписи), он заменит фон сцены. Сцены с фото оживут в 2.5D`,
      `🎬 Ролик: ${d.slides.length} сцен с движением и переходами, ~${Math.round(d.slides.reduce((n, x, i) => n + (i ? Math.min(7, Math.max(3, 2.2 + String(x.title + ' ' + (x.subtitle || '')).split(/\s+/).length * 0.38)) : 3.2), 0) - 0.5 * (d.slides.length - 1))} сек`);
  }
  const sug = pendingSuggestions(post);
  if (sug.length) lines.push('', `🎬 Нашёл кадры в TMDB (${sug.length}): ` + sug.map(x => `${x.slide} · ${x.title}`).join(', '), 'Нажимая «Взять кадры», подтверждаешь право их использовать. В подпись добавится «© правообладатели»');
  if (d.verification_notes?.length) lines.push('', 'Проверить:', ...d.verification_notes.map(n => '• ' + n));
  if (warningsText(post)) lines.push(warningsText(post));
  if (post.factcheck) lines.push('', '🔎 Gemini:', post.factcheck.kind === 'grounded_review' ? 'Проверка выполнена, источники смотри в отдельном сообщении.' : 'Факты не подтверждены источниками.');
  else lines.push('', '🔎 Фактчек Gemini запускается отдельно, не расходует лимиты Groq.');
  const have = Object.keys(slideBgs(post)).length;
  lines.push('', d.slides.length > 1
    ? `🖼 Картинки: ${have} из ${d.slides.length} (промпты для каждого слайда — ниже; обязательна только обложка)`
    : (have ? '🖼 Картинка для обложки добавлена.' : '🖼 Нужна картинка на обложку? Пришли её ответом на это сообщение (промпт для генерации — ниже). Без картинки соберу строгий фон.'));
  lines.push('', `Поправить: /fix ${post.id} что изменить`);
  return lines.join('\n').slice(0, 4000);
}
// Предложенные кадры, которые ещё не стоят на слайдах
export const pendingSuggestions = post => (post.draft?.image_suggestions || []).filter(x => !slideBgs(post)[x.slide - 1] && x.slide <= (post.draft?.slides || []).length);
export const textButtons = (post, host) => [
  [{ text: '✅ Текст ок — собрать', callback_data: `pl:${post.id}:approve_text` }],
  ...(pendingSuggestions(post).length ? [[{ text: `🎬 Взять кадры (${pendingSuggestions(post).length})`, callback_data: `ia:${post.id}` }]] : []),
  ...(post.draft?.format === 'reel' ? [Object.keys(REEL_STYLES).filter(k => k !== (post.draft.reel_style || 'dynamic')).slice(0, 3).map(k => ({ text: REEL_STYLES[k], callback_data: `rs:${post.id}:${k}` })),
    Object.keys(REEL_STYLES).filter(k => k !== (post.draft.reel_style || 'dynamic')).slice(3).map(k => ({ text: REEL_STYLES[k], callback_data: `rs:${post.id}:${k}` }))] : []),
  [{ text: '🔁 Другой вариант', callback_data: `pl:${post.id}:regen` }, { text: '❌ Отклонить', callback_data: `pl:${post.id}:reject` }],
  [...Object.keys(FORMAT_SWITCH).filter(k => k !== postKind(post.draft)).map(k => ({ text: FORMAT_SWITCH[k], callback_data: `fmt:${post.id}:${k}` })),
    ...(postKind(post.draft) === 'carousel' ? [{ text: post.draft.credits_on ? '🎞 Без титров' : '🎞 + Титры', callback_data: `cred:${post.id}` }] : [])],
  [{ text: '🎨 Править в конструкторе', web_app: { url: `https://${host}/cover-studio/?post=${post.id}` } }, { text: '🎬 Кадры', web_app: { url: `https://${host}/cover-studio/?post=${post.id}&images=1` } }],
  [{ text: '🔎 Проверить факты через Gemini', callback_data: `fc:${post.id}` }],
];
// у своего контента нет конструктора: кнопки другие (см. _own.js)
export const finalButtons = (post, host) => [
  [{ text: post.scheduled_at ? `✅ Публиковать ${almatyTime(post.scheduled_at)}` : '✅ Публиковать', callback_data: `pl:${post.id}:approve_final${renderId(post) ? ':' + renderId(post) : ''}` },
    ...(host ? [{ text: '🕒 Время', web_app: { url: `https://${host}/?post=${post.id}&schedule=1` } }] : [])],
  ...(host ? [[{ text: '🎨 Вёрстка', web_app: { url: `https://${host}/cover-studio/?post=${post.id}` } }, { text: '🎬 Кадры', web_app: { url: `https://${host}/cover-studio/?post=${post.id}&images=1` } }]] : []),
  [{ text: '📥 Опубликую сам', callback_data: `pl:${post.id}:handoff` }],
  [{ text: '🔁 Переделать текст', callback_data: `pl:${post.id}:redo` }, { text: '❌ Отклонить', callback_data: `pl:${post.id}:reject` }],
  [{ text: '🔎 Проверить факты через Gemini', callback_data: `fc:${post.id}` }],
];
export const failedButtons = post => [
  [{ text: '🔄 Повторить', callback_data: `pl:${post.id}:retry` }, { text: '📝 К тексту', callback_data: `pl:${post.id}:redo` }],
];

export function ownCard(post) {
  const files = post.own?.files?.length || 0;
  const what = post.draft.format === 'reel' ? 'видео → Reels' : files > 1 ? `${files} фото → карусель` : 'фото';
  return [
    `📥 Твой пост ${post.id} · ${what}`, '',
    'Подпись:', post.draft.caption || '— нет —', '',
    warningsText(post).trim(),
    'Изменить подпись: ответь на это сообщение текстом.',
    `ИИ-подпись: /aicap ${post.id} о чём пост`,
    post.own?.media_group_id ? 'Альбом: дождись, пока придут все фото, потом жми «Собрать».' : '',
  ].filter(x => x !== '').join('\n');
}
export const ownButtons = post => [[{ text: '✅ Собрать финал', callback_data: `pl:${post.id}:approve_text` }, { text: '❌ Отмена', callback_data: `pl:${post.id}:reject` }]];

export const aspectFor = d => (d.format === 'reel' ? '9:16' : '4:5');
export function fixAspect(prompt, d) {
  const p = String(prompt || '').replace(/,?\s*--ar\s*\d+\s*:\s*\d+/gi, '').trim().replace(/[,\s]+$/, '');
  return p ? `${p}, --ar ${aspectFor(d)}` : '';
}
export const escHtml = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
// Картинки по слайдам: bgs {индекс: путь}; bg — старое поле = обложка
export const slideBgs = post => ({ ...(post.bg?.path ? { 0: post.bg.path } : {}), ...(post.bgs || {}) });
export function promptMessage(post) {
  if (post.source?.kind === 'own') return null;
  const d = post.draft || {};
  const n = (d.slides || []).length, have = slideBgs(post);
  if (n > 1) {
    const prompts = (d.image_prompts?.length ? d.image_prompts : (d.image_prompt ? [d.image_prompt] : [])).map(x => fixAspect(x, d));
    if (!prompts.length) return null;
    const head = briefHeader(d);
    const lines = [`🖼 Картинки для карусели ${post.id} — слайдов: ${n}. Обязательна только обложка (1), остальные по желанию: без картинки слайд будет со строгим фоном.`, '', ...(head ? [escHtml(head), ''] : [])];
    for (let i = 0; i < n; i++) {
      const p = prompts[i] || prompts[0];
      lines.push(`${i + 1}${i === 0 ? ' · обложка' : ''}${have[i] ? ' ✅ есть' : ''}`, `<pre>${escHtml(p)}</pre>`, '');
    }
    lines.push(`Как прислать: ответь на это сообщение альбомом (фото лягут по слайдам по порядку) или по одной картинке с номером слайда в подписи, например «3». Пост ${post.id}`);
    return lines.join('\n');
  }
  if (!d.image_prompt || have[0]) return null;
  const head = briefHeader(d);
  return `🖼 Промпт для картинки ${post.id} — нажми «Копировать» на блоке, сгенерируй и пришли картинку ответом на это сообщение:\n\n${head ? escHtml(head) + '\n\n' : ''}<pre>${escHtml(fixAspect(d.image_prompt, d))}</pre>`;
}
// Telegram: до 4096 знаков в сообщении — режем по пустым строкам, не разрывая блоки <pre>
export function splitMessage(text, max = 3900) {
  const out = [];
  let cur = '';
  for (const block of String(text || '').split('\n\n')) {
    const add = cur ? cur + '\n\n' + block : block;
    if (add.length <= max) { cur = add; continue; }
    if (cur) out.push(cur);
    cur = block.length > max ? block.slice(0, max) : block;
  }
  if (cur) out.push(cur);
  return out;
}
// Отправить промпты (несколько сообщений при необходимости); кнопка «Другие промпты» — на последнем
export async function sendPrompts(text, postId, tg = tgCall, chatId = Number(ownerId())) {
  const parts = splitMessage(text);
  let last = null;
  for (let i = 0; i < parts.length; i++) {
    last = await tg('sendMessage', { chat_id: chatId, text: parts[i], parse_mode: 'HTML',
      ...(i === parts.length - 1 && postId ? { reply_markup: { inline_keyboard: [[{ text: '🔄 Другие промпты', callback_data: 'pr:' + postId }]] } } : {}) });
  }
  return last;
}
export async function sendSuggestionsPreview(post, tg = tgCall) {
  const sug = pendingSuggestions(post).filter(x => x.thumb);
  if (sug.length < 1) return null;
  const media = sug.slice(0, 10).map((x, i) => ({ type: 'photo', media: x.thumb, ...(i === 0 ? { caption: `🎬 Кадры для ${post.id}: ` + sug.map(y => `${y.slide} · ${y.title}`).join(', ').slice(0, 900) } : {}) }));
  return media.length > 1 ? tg('sendMediaGroup', { chat_id: Number(ownerId()), media }) : tg('sendPhoto', { chat_id: Number(ownerId()), photo: media[0].media, caption: media[0].caption });
}
export async function sendTextCard(post, host, tg = tgCall) {
  await sendSuggestionsPreview(post, tg).catch(() => null);
  const pm = promptMessage(post);
  if (pm) { const r = await tg('sendMessage', { chat_id: Number(ownerId()), text: textCard(post), disable_web_page_preview: true, reply_markup: { inline_keyboard: textButtons(post, host) } }); await sendPrompts(pm, post.id, tg); return r; }
  if (post.source?.kind === 'own') return tg('sendMessage', { chat_id: Number(ownerId()), text: ownCard(post), reply_markup: { inline_keyboard: ownButtons(post) } });
  return tg('sendMessage', { chat_id: Number(ownerId()), text: textCard(post), disable_web_page_preview: true, reply_markup: { inline_keyboard: textButtons(post, host) } });
}

export async function sendFinal(post, host, tg = tgCall) {
  const chat = Number(ownerId());
  const imgs = post.media?.images || [];
  if (post.draft.format === 'reel' && post.media?.video) {
    const v = await tg('sendVideo', { chat_id: chat, video: mediaUrl(host, post.media.video), supports_streaming: true, width: 1080, height: 1920 });
    // видео отдаётся редиректом на GitHub: если Telegram его не принял, даём ссылку, чтобы финал можно было посмотреть
    if (v && v.ok === false) await tg('sendMessage', { chat_id: chat, text: `🎬 Ролик ${post.id}: Telegram не показал видео, открой по ссылке (действует сутки)\n${mediaUrl(host, post.media.video)}`, disable_web_page_preview: true });
  } else if (imgs.length > 1) {
    await tg('sendMediaGroup', { chat_id: chat, media: imgs.slice(0, 10).map(p => ({ type: 'photo', media: mediaUrl(host, p) })) });
  } else if (imgs.length) {
    await tg('sendPhoto', { chat_id: chat, photo: mediaUrl(host, imgs[0]) });
  }
  const when = post.scheduled_at ? `«Публиковать» поставит пост в очередь: выйдет ${almatyTime(post.scheduled_at)} по Алматы.` : '«Публиковать» отправит пост в Instagram сразу. «🕒 Время» — отложить публикацию.';
  const text = `🖼 Пост ${post.id} собран — финал на согласование${warningsText(post)}\n\nПодпись:\n${post.draft.caption}\n\n${when}`;
  return tg('sendMessage', { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true, reply_markup: { inline_keyboard: finalButtons(post, host) } });
}

export async function sendStatus(post, tg = tgCall) {
  const chat = Number(ownerId());
  if (post.status === 'published') {
    return tg('sendMessage', { chat_id: chat, text: `✅ Пост ${post.id} опубликован${post.ig?.permalink ? '\n' + post.ig.permalink : ''}` });
  }
  if (post.status === 'failed') {
    const where = post.error?.stage === 'publish' ? 'публикации' : 'сборке';
    const extra = post.error?.stage === 'publish' ? '\n\nПеред повтором загляни в профиль: если пост всё же появился, повтор не нужен.' : '';
    return tg('sendMessage', { chat_id: chat, text: `⚠️ Пост ${post.id}: ошибка при ${where}\n${post.error?.message || ''}${extra}`, reply_markup: { inline_keyboard: failedButtons(post) } });
  }
  return null;
}

export function summary(post) {
  return {
    id: post.id, kind: post.source?.kind || null, status: post.status, status_label: post.ig_archived_at_utc ? '📦 Архивировано' : (STATUS_LABEL[post.status] || post.status), format: post.draft?.format,
    archived: Boolean(post.ig_archived_at_utc), archived_at_utc: post.ig_archived_at_utc || null, copied_from: post.copied_from || null,
    title: post.draft?.slides?.[0]?.title || '', updated_at_utc: post.updated_at_utc, permalink: post.ig?.permalink || null,
    error: post.error?.message || null, scheduled_at: post.scheduled_at || null, suggested_images: pendingSuggestions(post).length, rid: renderId(post),
  };
}
