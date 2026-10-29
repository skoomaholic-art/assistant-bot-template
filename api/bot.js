// Telegram webhook бота-ассистента (мгновенные ответы вместо опроса раз в 30 минут).
// Переменные Vercel: TG_BOT_TOKEN, TG_OWNER_CHAT_ID, IGM_BRIDGE_TOKEN, TG_WEBHOOK_SECRET.
//
// GET  /api/bot                         → самопроверка: что задано и куда смотрит вебхук (без секретов)
// GET  /api/bot?install=<TG_WEBHOOK_SECRET> → подключить вебхук, кнопку «Instagram Manager» и меню команд
// POST /api/bot                         → обновления от Telegram (только с верным secret_token)
import crypto from 'node:crypto';
import {
  addReason, applyAction, botToken, checkSchema, editCard, ghGetJson, ghPutJson, ownerId,
  QUEUE_PATH, readBody, ReviewError, safeReviewItem,
} from './_lib.js';
import { runEditor } from './_editor.js';
import { mailCallback } from './mail.js';
import { factcheckPost, factcheckMessage } from './_gemini-factcheck.js';
import { groqJSON } from './_groq.js';
import { addMusic, attachClip, addOwnMedia, aiCaption, applySuggestedImages, attachBackground, extractAudio, extractMedia, ownButtons, ownCard, setCaption } from './_own.js';
import { draftDigest, learn, loadLearning, rate, withLearning } from './_learning.js';
import { planVisuals } from './_visual.js';
import { REEL_STYLES, mediaUrl, almatyTime, ensureSlidePrompts, sendPrompts, promptMessage, sendFinal, act, createPost, findPost, generateDraft, presetFor, regenerate, replaceDraft, summary, textButtons, textCard, withPipe } from './_pipeline.js';

const ITEM_ID = /^[A-Za-z0-9_-]{3,36}$/;
const MAX_SHOWN = 8;
const KIND = { post: 'Публикация', reply: 'Ответ', external_comment: 'Свой комментарий' };
const STATUS = { pending: 'ждёт', needs_revision: 'на доработке', approved: 'одобрено', rejected: 'отклонено' };
const COMMANDS = [
  ['post', 'Пост-картинка: /post тема'],
  ['carousel', 'Карусель: /carousel тема'],
  ['reel', 'Reels: /reel тема'],
  ['drafts', 'Посты в работе'],
  ['idea', 'ИИ-редактор: найти тему сейчас'],
  ['rules', 'Правила редакции, которые выучил ИИ'],
  ['lab', 'Лаборатория: что набирает просмотры'],
  ['start', 'Меню ассистента'],
  ['pending', 'Instagram: карточки на проверку'],
  ['status', 'Instagram: состояние очереди'],
];

// Посторонние видят в меню только это; полный список команд — только в чате владельца
const GUEST_COMMANDS = [
  ['start', 'Что это за бот'],
  ['guide', 'Гайд по установке (PDF)'],
];

// Меню команд: по умолчанию (для всех) — гостевое, в чате владельца — полное
export async function syncCommands(owner, call = tg) {
  const list = arr => arr.map(([command, description]) => ({ command, description }));
  const guest = await call('setMyCommands', { commands: list(GUEST_COMMANDS) });
  let mine = { ok: false, description: 'TG_OWNER_CHAT_ID не задан' };
  if (/^\d+$/.test(String(owner || ''))) mine = await call('setMyCommands', { commands: list(COMMANDS), scope: { type: 'chat', chat_id: Number(owner) } });
  return { ok: Boolean(guest.ok && mine.ok), description: guest.ok ? mine.description : guest.description };
}
let commandsSynced = false;

const secret = () => String(process.env.TG_WEBHOOK_SECRET || '').trim();
export function sameSecret(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

export async function tg(method, body, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${botToken()}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await r.json();
  } catch { return { ok: false, description: 'network' }; }
}

const appUrl = host => `https://${host}`;
export function mainKeyboard(host) {
  const url = appUrl(host);
  return [
    [{ text: '📷 Instagram Manager', web_app: { url: url + '/?section=ig' } }],
    [{ text: '🎨 Конструктор обложек', web_app: { url: url + '/cover-studio/' } }],
    [{ text: '📥 На проверку', callback_data: 'menu:pending' }, { text: '📊 Статус', callback_data: 'menu:status' }],
  ];
}
const reviewButtons = id => [[
  { text: '✅ Одобрить', callback_data: `review:${id}:approve` },
  { text: '✏️ Править', callback_data: `review:${id}:revise` },
  { text: '⏭ Отклонить', callback_data: `review:${id}:reject` },
]];

export function formatCard(item) {
  const lines = [`IGM • карточка ${item.id}`, `Тип: ${KIND[item.kind] || item.kind}`, `Тема: ${String(item.topic || 'без темы').slice(0, 70)}`];
  if (item.target_username) lines.push(`Автор: @${String(item.target_username).replace(/^@/, '').slice(0, 80)}`);
  if (item.original_comment) lines.push(`Исходный комментарий: ${String(item.original_comment).slice(0, 600)}`);
  lines.push('', 'Вариант:', String(item.proposed_text || '').slice(0, 1300), '', 'Одобрение только записывает решение. В Instagram ничего не уходит.');
  return lines.join('\n').slice(0, 3950);
}

function countStatus(state) {
  const c = {};
  for (const i of state.items) c[i.status || 'unknown'] = (c[i.status || 'unknown'] || 0) + 1;
  const parts = Object.entries(c).map(([k, v]) => `${STATUS[k] || k}: ${v}`);
  return 'Instagram (IGM) — очередь\n' + (parts.length ? parts.join('\n') : 'пусто') + '\n\nОтветы и публикации не отправляются автоматически.';
}

function reviewList(state, kind) {
  let cards = state.items.filter(i => i.status === 'pending' && safeReviewItem(i));
  if (kind === 'posts') cards = cards.filter(c => c.kind === 'post');
  if (kind === 'comments') cards = cards.filter(c => c.kind !== 'post');
  if (!cards.length) return [{ text: 'Instagram: новых карточек нет.' }];
  return cards.slice(0, MAX_SHOWN).map(c => ({ text: formatCard(c), keyboard: reviewButtons(c.id) }));
}

const HELP = 'Instagram Manager\n\nСвой контент: пришли фото, альбом, видео (до 20 МБ) или текст — бот сделает пост и пришлёт на согласование. Подпись: ответь на карточку текстом, /cap ID текст, /aicap ID о чём пост.\n\nПосты (ИИ → согласование текста → сборка → согласование финала → публикация):\n/post тема — пост-картинка\n/carousel тема — карусель\n/reel тема — Reels\n/fix ID что изменить — переписать текст\n/drafts — посты в работе\n/idea — ИИ-редактор найдёт тему в новостях сейчас (сам он приходит раз в день утром)\n/no ID причина — почему отклонил (ИИ учтёт)\n/rules — что ИИ выучил · /forget N — забыть правило\n\nКнопки «📷 Instagram Manager» и «🎨 Конструктор обложек» открывают приложение.\n\nКоманды Instagram (IGM):\n/pending — все карточки\n/posts — публикации\n/comments — ответы и свои комментарии\n/status — состояние\n/edit ID текст — исправить\n/why ID причина — объяснить решение';

// Только личный чат владельца
export function isOwnerUpdate(update, owner) {
  const cb = update.callback_query;
  const msg = update.message || cb?.message || {};
  const actor = cb?.from || msg.from || {};
  const chat = msg.chat || {};
  return Boolean(owner) && String(actor.id) === owner && String(chat.id) === owner && chat.type === 'private';
}

// Очередь IGM: прочитать, изменить, сохранить (повтор при конфликте с другими записями)
async function withQueue(mutate, deps) {
  for (let attempt = 0; ; attempt++) {
    const { data, sha } = await deps.get(QUEUE_PATH);
    const state = checkSchema(data);
    const result = mutate(state);
    if (!result?.changed) return result;
    try { await deps.put(QUEUE_PATH, state, sha, result.message); return result; }
    catch (err) { if (!(err instanceof ReviewError && err.code === 409) || attempt >= 2) throw err; }
  }
}

// Возвращает список действий: [{type:'send', text, keyboard?} | {type:'ack', text}]
async function safeLearn(deps, signal) {
  try { await (deps.learn || learn)(signal, { deps: deps.learnDeps }); } catch (err) { console.error('learn', err?.message); }
}

// Решение по посту из кнопки или /fix
async function pipelineAction(id, action, feedback, { owner, host, deps }, fromButton) {
  const pipe = deps.pipe || withPipe;
  const ack = fromButton ? [{ type: 'ack', text: '' }] : [];
  try {
    if (action === 'regen') {
      await deps.notify?.(`✍️ Переписываю ${id}…`);
      const cur = await pipe(st => ({ post: findPost(st, id) }));
      const draft = await (deps.regenerate || regenerate)(cur.post, feedback);
      const r = await pipe(st => ({ post: replaceDraft(findPost(st, id), { draft, pages: null }, owner, feedback || 'другой вариант'), message: `pipeline: regen ${id}` }));
      if (feedback) await safeLearn(deps, { type: 'text_feedback', post: id, feedback, before: draftDigest(cur.post.draft) });
      return [...ack, { type: 'send', text: textCard(r.post), keyboard: textButtons(r.post, host), after: promptMessage(r.post) }];
    }
    const r = await pipe(st => ({ post: act(findPost(st, id), action, owner), message: `pipeline: ${action} ${id}` }));
    const p = r.post;
    if (p.learn_stat && ['approve_text', 'approve_final'].includes(action)) await safeLearn(deps, { type: 'stat', key: p.learn_stat, post: id });
    const msg = {
      approve_text: `🎨 ${id}: текст согласован. Собираю пост в конструкторе — финал пришлю через ~2 минуты.`,
      approve_final: p.status === 'scheduled' ? `🕒 ${id}: финал согласован. Опубликую ${almatyTime(p.scheduled_at)} (по Алматы, в течение ~20 минут после этого часа). Ссылку пришлю` : `📤 ${id}: публикую в Instagram. Ссылку пришлю, когда выйдет.`,
      reject: `❌ ${id} отклонён. Напиши, почему — ИИ учтёт в следующих постах:\n/no ${id} причина`,
      retry: p.status === 'rendering' ? `🔄 ${id}: собираю заново.` : `🔄 ${id}: финал снова ждёт согласования.`,
      handoff: `📥 ${id}: робот публиковать не будет. Ниже файлы в полном качестве и подпись.\nКак выложить: сохрани файл → Instagram → + → ${p.draft?.format === 'reel' ? 'Reels' : 'Публикация'} → выбери файл${p.draft?.format === 'reel' ? '' : 'ы по порядку'} → добавь музыку из библиотеки Instagram → вставь подпись → «Поделиться» или «Сохранить черновик»`,
    }[action];
    if (action === 'handoff') {
      const files = p.draft?.format === 'reel' && p.media?.video ? [p.media.video] : (p.media?.images || []);
      return [...ack, { type: 'send', text: msg }, { type: 'docs', urls: files.map(f => mediaUrl(host, f, 7 * 24 * 3600)) }, { type: 'send', text: p.draft?.caption || '' }];
    }
    if (p.status === 'text_review') return [...ack, { type: 'send', text: textCard(p), keyboard: p.source?.kind === 'own' ? ownButtons(p) : textButtons(p, host), after: promptMessage(p) }];
    if (action === 'retry' && p.status === 'final_review') return [...ack, { type: 'send', text: msg }, { type: 'final', post: p }];
    return [...ack, { type: 'send', text: msg }];
  } catch (err) {
    const t = err instanceof ReviewError ? err.message : 'Не получилось';
    return fromButton ? [{ type: 'ack', text: t }] : [{ type: 'send', text: t }];
  }
}

// Посторонние: только приветствие и PDF-гайд по установке своей копии. Никаких данных и кнопок владельца
export function guestReply(update, owner, host) {
  const m = update?.message;
  if (!m || isOwnerUpdate(update, owner) || m.chat?.type !== 'private') return null;
  if (!/^\/(start|help|guide)\b/.test(String(m.text || ''))) return null;
  const chat = m.chat.id;
  return [
    { method: 'sendMessage', body: { chat_id: chat, disable_web_page_preview: true, text: 'Привет! Это личный ИИ-помощник для Instagram, он работает только для своего владельца.\n\nХочешь такой же себе? Он называется Instagram Manager. Ниже пошаговый гайд: как создать своего бота, подключить Instagram, GitHub и Vercel, где взять ключи и что делать при ошибках. Всё на бесплатных тарифах, программировать не нужно' } },
    { method: 'sendDocument', body: { chat_id: chat, document: `https://${host}/guide/setup-guide.pdf`, caption: 'Instagram Manager: гайд по установке, 9 шагов, 1,5–2 часа' } },
  ];
}

export async function handleUpdate(update, { owner, host, deps }) {
  if (!isOwnerUpdate(update, owner)) return [];
  const cb = update.callback_query;
  const out = [];
  if (cb) {
    // Кнопки под напоминанием о задаче из Gmail: mt:<id>:done|work|new|r<мин>|tmr
    if (/^mt:/.test(String(cb.data || ''))) {
      try {
        const r = await mailCallback(cb.data, deps.mailCall);
        if (!r) return [{ type: 'ack', text: 'Неизвестная кнопка' }];
        return [{ type: 'ack', text: r.ack }, { type: 'edit', text: `${String(cb.message?.text || '').split('\n').slice(0, 3).join('\n')}\n\n${r.edit}` }];
      } catch (err) { return [{ type: 'ack', text: err instanceof ReviewError ? err.message.slice(0, 180) : 'Gmail недоступен' }]; }
    }
    const fc = String(cb.data || '').match(/^fc:(P\d{4,6})$/);
    if (fc) {
      try {
        const check = await factcheckPost(fc[1],{
          pipe:deps.pipe || withPipe,checker:deps.factcheckChecker,actor:String(owner)
        });
        return [{type:'ack',text:'Фактчек готов'}, {type:'send',
          text:factcheckMessage(fc[1],check)}];
      } catch(err) {
        return [{type:'ack',text:'Проверка не выполнена'},{type:'send',
          text:'🔎 Фактчек Gemini: '+(err instanceof ReviewError ? err.message : 'Недоступен, проверь вручную')}];
      }
    }
    const crm = String(cb.data || '').match(/^cred:(P\d{4,6})$/);
    if (crm) {
      try {
        const cur = await (deps.pipe || withPipe)(st => ({ post: findPost(st, crm[1]) }));
        let credits = cur.post.draft.credits;
        if (!cur.post.draft.credits_on && !credits?.lines?.length) {
          await deps.notify?.('🎞 Собираю титры…');
          const o = await (deps.json || groqJSON)([{ role: 'system', content: 'Составь титры для последнего слайда карусели о фильме/сериале: только люди, о ком говорится в слайдах (актёр и его роль, режиссёр), 2-6 строк. Имена только если абсолютно уверен или они есть в фактах; иначе пустой список. Без длинных тире. JSON: {"title":"Название (год)","lines":[{"name":"","role":""}]}' }, { role: 'user', content: JSON.stringify({ topic: cur.post.source?.topic, facts: cur.post.source?.facts, slides: cur.post.draft.slides }) }], { maxTokens: 1200, temperature: 0.2 });
          credits = { title: String(o?.title || '').slice(0, 80), lines: (Array.isArray(o?.lines) ? o.lines : []).map(l => ({ name: String(l?.name || '').slice(0, 50), role: String(l?.role || '').slice(0, 50) })).filter(l => l.name).slice(0, 8) };
          if (credits.lines.length < 2) return [{ type: 'ack', text: '' }, { type: 'send', text: `🎞 ${crm[1]}: ИИ не уверен в именах, титры не добавил. Можно вписать вручную в конструкторе последним слайдом` }];
        }
        const r = await (deps.pipe || withPipe)(st => {
          const p = findPost(st, crm[1]);
          if (!['text_review', 'final_review', 'failed'].includes(p.status)) throw new ReviewError('Пост уже публикуется', 409);
          p.draft.credits = credits; p.draft.credits_on = !p.draft.credits_on;
          if (p.draft.credits_on && !(p.draft.verification_notes || []).some(n => /титр/i.test(n))) (p.draft.verification_notes ||= []).push('Проверить титры: имена и роли');
          let rerender = false;
          if (p.status === 'final_review' && p.approvals?.text?.by) { p.status = 'rendering'; p.approvals = { text: p.approvals.text }; rerender = true; }
          return { post: p, rerender, message: `pipeline: credits ${p.draft.credits_on ? 'on' : 'off'} ${p.id}` };
        });
        return [{ type: 'ack', text: r.post.draft.credits_on ? 'Титры добавлены' : 'Титры убраны' }, r.rerender ? { type: 'send', text: `🎞 ${crm[1]}: пересобираю финал с титрами` } : { type: 'send', text: textCard(r.post), keyboard: textButtons(r.post, host) }];
      } catch (err) { return [{ type: 'ack', text: err instanceof ReviewError ? err.message : 'Ошибка ИИ' }]; }
    }
    const rsm = String(cb.data || '').match(/^rs:(P\d{4,6}):(dynamic|calm|epic|thriller|nostalgic|mystery)$/);
    if (rsm) {
      try {
        const r = await (deps.pipe || withPipe)(st => {
          const p = findPost(st, rsm[1]);
          if (p.draft?.format !== 'reel') throw new ReviewError('Это не Reels');
          if (!['text_review', 'final_review', 'failed'].includes(p.status)) throw new ReviewError('Reels уже публикуется', 409);
          p.draft.reel_style = rsm[2];
          let rerender = false;
          if (p.status === 'final_review' && p.approvals?.text?.by) { p.status = 'rendering'; p.approvals = { text: p.approvals.text }; rerender = true; }
          (p.history ||= []).push({ at: new Date().toISOString(), event: 'reel_style', by: owner, note: rsm[2] });
          return { post: p, rerender, message: `pipeline: reel style ${rsm[1]} ${rsm[2]}` };
        });
        await safeLearn(deps, { type: 'reel_style', post: rsm[1], chosen: rsm[2] });
        return [{ type: 'ack', text: 'Стиль: ' + REEL_STYLES[rsm[2]] }, r.rerender ? { type: 'send', text: `🎛 ${rsm[1]}: стиль ${REEL_STYLES[rsm[2]]}, пересобираю ролик` } : { type: 'send', text: textCard(r.post), keyboard: textButtons(r.post, host) }];
      } catch (err) { return [{ type: 'ack', text: err instanceof ReviewError ? err.message : 'Ошибка' }]; }
    }
    const iam = String(cb.data || '').match(/^ia:(P\d{4,6})$/);
    if (iam) {
      try {
        const r = await (deps.applySuggestedImages || applySuggestedImages)(iam[1], owner, deps);
        const p = await (deps.pipe || withPipe)(st => ({ post: findPost(st, iam[1]) }));
        return [{ type: 'ack', text: 'Кадры поставлены' }, { type: 'send', text: `🎬 ${iam[1]}: кадры на слайдах ${r.slides.join(', ')}${r.slides.length < r.total ? ` (${r.total - r.slides.length} не скачались)` : ''}. В подпись добавится «© правообладатели».${r.rerender ? ' Пересобираю финал, пришлю через ~2 минуты' : ' Жми «✅ Текст ок», когда готов'}`, ...(r.rerender ? {} : { keyboard: textButtons(p.post, host) }) }];
      } catch (err) { return [{ type: 'ack', text: err instanceof ReviewError ? err.message.slice(0, 190) : 'Не получилось' }]; }
    }
    const prm = String(cb.data || '').match(/^pr:(P\d{4,6})$/);
    if (prm) {
      try {
        const cur = await (deps.pipe || withPipe)(st => ({ post: findPost(st, prm[1]) }));
        const prev = [cur.post.draft.image_prompt, ...(cur.post.draft.image_prompts || [])].filter(Boolean);
        const d = { ...cur.post.draft, image_prompts: [] };
        let planned = false;
        try { await (deps.planVisuals || planVisuals)(d, { source: cur.post.source?.facts || '', avoid: prev }); planned = true; } catch (err) { console.error('visual plan', err?.message); }
        if (planned) { /* новые сцены по разбору новости */ }
        else if ((d.slides || []).length > 1) await (deps.ensureSlidePrompts || ensureSlidePrompts)(d);
        else d.image_prompt = (await (deps.json || groqJSON)([{ role: 'system', content: 'Write ONE new image-generation prompt in English for an Instagram cover about film/TV: a different cinematic scene-metaphor, no text, no logos, no real actors or famous characters, no movie stills, dark tones, empty space for a title. JSON: {"prompt":"..."}' }, { role: 'user', content: JSON.stringify({ title: d.slides?.[0]?.title, previous: d.image_prompt }) }], { maxTokens: 800 }))?.prompt || d.image_prompt;
        const r = await (deps.pipe || withPipe)(st => { const p = findPost(st, prm[1]); p.draft.image_prompts = d.image_prompts; p.draft.image_prompt = d.image_prompt; if (d.visual_brief) p.draft.visual_brief = d.visual_brief; return { post: p, message: `pipeline: new prompts ${prm[1]}` }; });
        const pm = promptMessage(r.post);
        return [{ type: 'ack', text: '' }, ...(pm ? [{ type: 'send', text: '🔄 Новые промпты:', after: pm }] : [{ type: 'send', text: 'Все картинки уже есть' }])];
      } catch (err) { return [{ type: 'ack', text: err instanceof ReviewError ? err.message : 'Ошибка ИИ' }]; }
    }
    const fm = String(cb.data || '').match(/^fmt:(P\d{4,6}):(post|carousel|reel)$/);
    if (fm) {
      try {
        const label = { post: 'пост-картинку', carousel: 'карусель', reel: 'Reels' }[fm[2]];
        await deps.notify?.(`🔄 Переделываю ${fm[1]} в ${label}…`);
        const cur = await (deps.pipe || withPipe)(st => ({ post: findPost(st, fm[1]) }));
        const draft = await (deps.regenerate || regenerate)(cur.post, '', undefined, fm[2]);
        const r = await (deps.pipe || withPipe)(st => {
          const p = findPost(st, fm[1]);
          const bg = p.bg;
          const out = replaceDraft(p, { draft, pages: null }, owner, 'формат → ' + fm[2]);
          const cover = (p.bgs && p.bgs[0]) || bg?.path;
          out.bgs = cover ? { 0: cover } : {}; out.bg = cover ? { path: cover, at: new Date().toISOString() } : null; // обложка сохраняется
          return { post: out, message: `pipeline: format ${fm[1]} → ${fm[2]}` };
        });
        return [{ type: 'ack', text: '' }, { type: 'send', text: textCard(r.post), keyboard: textButtons(r.post, host), after: promptMessage(r.post) }];
      } catch (err) { return [{ type: 'ack', text: err instanceof ReviewError ? err.message : 'Ошибка' }]; }
    }
    const bgm = String(cb.data || '').match(/^bg:(P\d{4,6}):(P\d{4,6})$/);
    if (bgm) {
      try {
        const r = await (deps.pipe || withPipe)(st => {
          const own = findPost(st, bgm[1]), target = findPost(st, bgm[2]);
          const file = own.own?.files?.[0];
          if (!file) throw new ReviewError('Картинка ещё загружается — нажми через пару секунд', 409);
          if (!['text_review', 'final_review', 'failed'].includes(target.status)) throw new ReviewError('Пост уже публикуется', 409);
          target.bg = { path: file, at: new Date().toISOString() };
          (target.history ||= []).push({ at: new Date().toISOString(), event: 'background_added', by: owner });
          let rerender = false;
          if (target.status === 'final_review' && target.approvals?.text?.by) { target.status = 'rendering'; target.approvals = { text: target.approvals.text }; rerender = true; }
          own.status = 'rejected';
          (own.history ||= []).push({ at: new Date().toISOString(), event: 'reject', by: owner, note: 'картинка ушла в обложку ' + target.id });
          return { target, rerender, message: `pipeline: ${own.id} → cover of ${target.id}` };
        });
        return [{ type: 'ack', text: 'Готово' }, { type: 'send', text: r.rerender ? `🖼 Картинка стала обложкой ${bgm[2]}. Пересобираю финал — ~2 минуты.` : `🖼 Картинка стала обложкой ${bgm[2]}. Теперь жми «✅ Текст ок — собрать» в карточке ${bgm[2]}.`, keyboard: r.rerender ? null : textButtons(r.target, host).slice(0, 1) }];
      } catch (err) { return [{ type: 'ack', text: err instanceof ReviewError ? err.message : 'Ошибка' }]; }
    }
    const pl = String(cb.data || '').match(/^pl:(P\d{4,6}):(approve_text|approve_final|redo|retry|reject|regen|handoff)$/);
    if (pl) return pipelineAction(pl[1], pl[2], '', { owner, host, deps }, true);
    const parts = String(cb.data || '').split(':');
    if (parts[0] === 'menu' && ['pending', 'posts', 'comments'].includes(parts[1])) {
      const r = await withQueue(s => ({ cards: reviewList(s, parts[1] === 'pending' ? null : parts[1]) }), deps);
      return [{ type: 'ack', text: 'Список открыт' }, ...r.cards.map(c => ({ type: 'send', ...c }))];
    }
    if (parts[0] === 'menu' && parts[1] === 'status') {
      const r = await withQueue(s => ({ text: countStatus(s) }), deps);
      return [{ type: 'ack', text: 'Статус' }, { type: 'send', text: r.text, keyboard: mainKeyboard(host) }];
    }
    if (parts.length === 3 && parts[0] === 'review') {
      const [, id, action] = parts;
      try {
        const r = await withQueue(s => {
          const card = applyAction(s, id, action, owner);
          return { changed: true, card, message: `telegram: ${action} ${id}` };
        }, deps);
        let text = `Карточка ${id}: ${STATUS[r.card.status] || r.card.status}. Решение записано.`;
        if (action === 'revise') text += `\nНапиши: /edit ${id} новый текст — или поправь в приложении.`;
        return [{ type: 'ack', text: 'Готово' }, { type: 'send', text }];
      } catch (err) {
        return [{ type: 'ack', text: err instanceof ReviewError ? err.message : 'Ошибка' }];
      }
    }
    return [{ type: 'ack', text: '' }];
  }

  const m = update.message || {};
  const text = String(m.text || '').trim();
  const cmd = (text.match(/^\/([a-z]+)(?:@\w+)?/i) || [])[1]?.toLowerCase();
  const pipe = deps.pipe || withPipe;
  const cardFor = p => p.source?.kind === 'own' ? { type: 'send', text: ownCard(p), keyboard: ownButtons(p) } : { type: 'send', text: textCard(p), keyboard: textButtons(p, host), after: promptMessage(p) };
  const replied = String(m.reply_to_message?.text || '');
  const repliedId = (replied.match(/(?:Твой пост|Пост|картинки|карусели) (P\d{4,6})/) || [])[1];

  // Аудио: ответом на карточку Reels → музыка этого ролика; без ответа → в библиотеку
  if (extractAudio(m)) {
    try {
      if (repliedId) {
        const r = await (deps.addMusic || addMusic)(m, owner, { postId: repliedId, deps });
        return [{ type: 'send', text: `🎵 ${repliedId}: в ролике будет «${r.track.title}».${r.rerender ? ' Пересобираю финал, пришлю через ~3 минуты' : ''}${r.track.credit ? '' : '\nЕсли трек требует указать автора, пришли его заново с подписью «автор: …»'}` }];
      }
      const r = await (deps.addMusic || addMusic)(m, owner, { deps });
      const MOOD = { tense: 'напряжённое', calm: 'спокойное', epic: 'эпичное', sad: 'грустное', upbeat: 'бодрое', mystery: 'загадочное' };
      return [{ type: 'send', text: `🎵 Трек «${r.track.title}» добавлен в библиотеку Reels (настроение: ${MOOD[r.track.mood]}, всего треков: ${r.total}).\nНастроение задаётся подписью к файлу: напряжённое, спокойное, эпичное, грустное, бодрое, загадочное. Автора для подписи поста: «автор: …»` }];
    } catch (err) { return [{ type: 'send', text: 'Не получилось: ' + (err instanceof ReviewError ? err.message : 'ошибка загрузки') }]; }
  }
  // Видео ответом на карточку Reels → сцена ролика
  if (extractMedia(m)?.kind === 'video' && repliedId && !/Твой пост/.test(replied)) {
    try {
      const r = await (deps.attachClip || attachClip)(repliedId, m, owner, deps);
      return [{ type: 'send', text: `🎬 ${repliedId}: видео стало сценой ${r.scene} из ${r.total} (клипов: ${r.filled}). ${r.rerender ? 'Пересобираю ролик, пришлю через ~3 минуты' : 'Жми «✅ Текст ок», когда готов'}\nДругая сцена: пришли видео с номером в подписи, например «3»` }];
    } catch (err) { return [{ type: 'send', text: 'Не получилось: ' + (err instanceof ReviewError ? err.message : 'ошибка загрузки') }]; }
  }
  // Картинка ответом на карточку поста ИИ → фон обложки
  if (extractMedia(m) && repliedId && !/Твой пост/.test(replied)) {
    try {
      const r = await (deps.attachBackground || attachBackground)(repliedId, m, owner, deps);
      const where = r.total > 1 ? `на слайд ${r.slide} (картинок ${r.filled} из ${r.total})` : 'в обложку';
      if (m.media_group_id && r.total > 1 && r.filled < r.total && !r.rerender) return [{ type: 'send', text: `🖼 ${repliedId}: слайд ${r.slide} ✓` }];
      return [{ type: 'send', text: r.rerender ? `🖼 Картинка добавлена ${where} ${repliedId}. Пересобираю финал — пришлю через ~2 минуты.` : `🖼 Картинка добавлена ${where} ${repliedId}. Жми «✅ Текст ок» в карточке, когда готов.` }];
    } catch (err) { return [{ type: 'send', text: 'Не получилось: ' + (err instanceof ReviewError ? err.message : 'ошибка загрузки') }]; }
  }
  // Своё фото/видео/альбом → пост
  if (extractMedia(m)) {
    try {
      const r = await (deps.addOwnMedia || addOwnMedia)(m, owner, deps);
      if (!r.created) return [];
      const card = cardFor(r.post);
      // Похоже на картинку к ждущему посту ИИ? Предложить сделать её обложкой
      if (r.post.own?.kind === 'photo' && !m.media_group_id) {
        const waiting = await pipe(st => ({ post: [...st.posts].reverse().find(p => p.status === 'text_review' && !['own', 'own_text'].includes(p.source?.kind) && !p.bg?.path && p.draft?.image_prompt && Date.now() - Date.parse(p.created_at_utc) < 6 * 3600e3) }));
        if (waiting.post) card.keyboard = [[{ text: `🖼 Это обложка для ${waiting.post.id}`, callback_data: `bg:${r.post.id}:${waiting.post.id}` }], ...card.keyboard];
      }
      return [card];
    } catch (err) {
      return [{ type: 'send', text: 'Не получилось: ' + (err instanceof ReviewError ? err.message : 'ошибка загрузки') }];
    }
  }
  // Ответ на карточку поста → новая подпись
  if (repliedId && text && !cmd) {
    try {
      const r = await (deps.setCaption || setCaption)(repliedId, text, owner, deps);
      return [{ type: 'send', text: `✍️ Подпись ${repliedId} обновлена.` }, cardFor(r.post)];
    } catch (err) { return [{ type: 'send', text: err instanceof ReviewError ? err.message : 'Не получилось' }]; }
  }
  if (cmd === 'cap' || cmd === 'aicap') {
    const mm = text.match(/^\/\w+(?:@\w+)?\s+(P\d{4,6})\s+([\s\S]{2,2200})$/);
    if (!mm) return [{ type: 'send', text: cmd === 'cap' ? 'Используй: /cap P0001 текст подписи' : 'Используй: /aicap P0001 о чём пост (ИИ напишет подпись)' }];
    try {
      let caption = mm[2].trim();
      if (cmd === 'aicap') { await deps.notify?.('✍️ Пишу подпись…'); caption = (await (deps.aiCaption || aiCaption)(caption)).caption; }
      const r = await (deps.setCaption || setCaption)(mm[1], caption, owner, deps);
      return [cardFor(r.post)];
    } catch (err) { return [{ type: 'send', text: 'Не получилось: ' + (err instanceof ReviewError ? err.message : 'ошибка') }]; }
  }
  // Свой текст (не команда, от 40 знаков) → пост из твоего текста
  if (!cmd && text.length >= 40) {
    await deps.notify?.('🎨 Делаю пост из твоего текста…');
    try {
      const presetId = presetFor(text.length > 450 ? 'carousel' : 'post', text);
      const draft = await (deps.generate || generateDraft)({ presetId, topic: text.replace(/\s+/g, ' ').slice(0, 200), owner_text: text });
      const r = await pipe(st => {
        const post = createPost(st, { draft, source: { kind: 'own_text', topic: text.slice(0, 200), facts: text.slice(0, 1500), preset_id: presetId } }, owner);
        return { post, message: `pipeline: own text ${post.id}` };
      });
      return [cardFor(r.post)];
    } catch (err) { return [{ type: 'send', text: 'Не получилось: ' + (err instanceof ReviewError ? err.message : 'ошибка ИИ') }]; }
  }
  if (!cmd || cmd === 'start' || cmd === 'help') {
    out.push({ type: 'send', text: cmd ? HELP : 'Пришли фото, видео или текст от 40 знаков — сделаю пост. Или /post тема. Меню — /start', keyboard: mainKeyboard(host) });
    return out;
  }
  if (['pending', 'posts', 'comments'].includes(cmd)) {
    const r = await withQueue(s => ({ cards: reviewList(s, cmd === 'pending' ? null : cmd) }), deps);
    return r.cards.map(c => ({ type: 'send', ...c }));
  }
  if (cmd === 'post' || cmd === 'carousel' || cmd === 'reel') {
    const topic = text.replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
    if (topic.length < 5) return [{ type: 'send', text: `Напиши тему: /${cmd} почему мы пересматриваем любимые фильмы` }];
    const presetId = presetFor(cmd, topic);
    await deps.notify?.('✍️ Пишу текст поста…');
    try {
      const draft = await (deps.generate || generateDraft)({ presetId, topic });
      const r = await (deps.pipe || withPipe)(st => {
        const post = createPost(st, { draft, source: { kind: 'bot', topic, preset_id: presetId } }, owner);
        return { post, message: `pipeline: new ${post.id}` };
      });
      return [{ type: 'send', text: textCard(r.post), keyboard: textButtons(r.post, host), after: promptMessage(r.post) }];
    } catch (err) {
      return [{ type: 'send', text: 'Не получилось: ' + (err instanceof ReviewError ? err.message : 'ошибка ИИ') }];
    }
  }
  if (cmd === 'fix') {
    const m = text.match(/^\/\w+(?:@\w+)?\s+(P\d{4,6})\s+([\s\S]{2,600})$/);
    if (!m) return [{ type: 'send', text: 'Используй: /fix P0001 что изменить (например: короче заголовок, без вопросов)' }];
    return pipelineAction(m[1], 'regen', m[2].trim(), { owner, host, deps }, false);
  }
  if (cmd === 'no') {
    const m = text.match(/^\/\w+(?:@\w+)?\s+(P\d{4,6})\s+([\s\S]{2,600})$/);
    if (!m) return [{ type: 'send', text: 'Используй: /no P0001 причина (например: слишком банально, без вопросов в заголовке)' }];
    const cur = await (deps.pipe || withPipe)(st => ({ post: findPost(st, m[1]) })).catch(() => null);
    await safeLearn(deps, { type: 'reject_reason', post: m[1], reason: m[2].trim(), before: draftDigest(cur?.post?.draft) });
    return [{ type: 'send', text: `Учёл: «${m[2].trim().slice(0, 200)}». Правила — /rules` }];
  }
  if (cmd === 'lab') {
    const lab = await (deps.loadLab || (async () => (await import('./_editor.js')).loadLab()))();
    if (!lab?.posts_measured) return [{ type: 'send', text: 'Лаборатория ждёт первых опубликованных постов: замеры через 24 ч, 72 ч и 7 дней. Подробно — Instagram Manager → Instagram → Аналитика.', keyboard: mainKeyboard(host) }];
    const dims = lab.dimensions || {};
    const fmt = x => `• ${dims[x.dim] || x.dim}: ${x.value} — индекс ${x.index} (n=${x.n})`;
    const l = await (deps.loadLearning || loadLearning)();
    const st = l.strategy;
    return [{ type: 'send', text: [`🧪 Лаборатория · постов с замерами: ${lab.posts_measured}`, '',
      '📈 Лидеры:', ...(lab.leaders?.length ? lab.leaders.slice(0, 5).map(fmt) : ['пока нет — нужно 3+ поста в сегменте']),
      '', '📉 Аутсайдеры:', ...(lab.laggards?.length ? lab.laggards.slice(0, 5).map(fmt) : ['пока нет']),
      ...(st ? ['', 'Выводы ИИ: ' + st.summary, ...(st.next_tests || []).map(t => '🧪 ' + t)] : [])].join('\n').slice(0, 4000), keyboard: mainKeyboard(host) }];
  }
  if (cmd === 'rules') {
    const l = await (deps.loadLearning || loadLearning)();
    const tr = rate(l.stats, 'text_first_ok', 'text_changed'), fr = rate(l.stats, 'final_first_ok', 'final_changed');
    const head = `Что ИИ выучил из твоих правок\nТексты без правок: ${tr == null ? '—' : tr + '%'} · финалы без правок: ${fr == null ? '—' : fr + '%'}`;
    const rules = l.rules.length ? l.rules.map((r, i) => `${i + 1}. ${r}`).join('\n') : 'Правил пока нет — они появятся из /fix, /no и правок в конструкторе.';
    const prefs = Object.keys(l.visual_prefs || {}).length ? '\n\nВёрстка запомнена для: ' + Object.keys(l.visual_prefs).map(f => ({ reel: 'Reels', portrait: 'карусели', square: 'квадрата' }[f] || f)).join(', ') : '';
    return [{ type: 'send', text: `${head}\n\n${rules}${prefs}\n\nУдалить правило: /forget N` }];
  }
  if (cmd === 'forget') {
    const n = Number((text.match(/\s(\d{1,2})\b/) || [])[1]);
    if (!n) return [{ type: 'send', text: 'Используй: /forget 3 (номер из /rules)' }];
    const r = await (deps.withLearning || withLearning)(l => {
      if (!l.rules[n - 1]) return { removed: null };
      const [removed] = l.rules.splice(n - 1, 1);
      return { removed, message: `learning: forget rule ${n}` };
    });
    return [{ type: 'send', text: r.removed ? `Забыл: «${r.removed}»` : 'Нет правила с таким номером. /rules' }];
  }
  if (cmd === 'idea') {
    await deps.notify?.('🗞 Ищу тему в свежих новостях и твоих идеях…');
    try {
      const r = await (deps.editor || runEditor)({ host, force: true });
      return r.post ? [] : [{ type: 'send', text: 'Редактор пропустил запуск: ' + (r.skipped || 'нет темы') }];
    } catch (err) {
      return [{ type: 'send', text: 'Не получилось: ' + (err instanceof ReviewError ? err.message : 'ошибка') }];
    }
  }
  if (cmd === 'drafts') {
    const r = await (deps.pipe || withPipe)(st => ({ posts: st.posts.filter(p => !['published', 'rejected'].includes(p.status)).slice(-10).map(summary) }));
    if (!r.posts.length) return [{ type: 'send', text: 'Постов в работе нет. Новый: /post тема' }];
    return [{ type: 'send', text: 'Посты в работе:\n\n' + r.posts.map(p => `${p.id} · ${p.status_label}\n${p.title}`).join('\n\n') }];
  }
  if (cmd === 'status') {
    const r = await withQueue(s => ({ text: countStatus(s) }), deps);
    return [{ type: 'send', text: r.text, keyboard: mainKeyboard(host) }];
  }
  if (cmd === 'edit' || cmd === 'why') {
    const m = text.match(/^\/\w+(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/);
    if (!m || !ITEM_ID.test(m[1])) return [{ type: 'send', text: cmd === 'edit' ? 'Используй: /edit ID новый текст' : 'Используй: /why ID причина' }];
    try {
      const r = await withQueue(s => {
        const card = cmd === 'edit' ? editCard(s, m[1], m[2], owner) : addReason(s, m[1], m[2]);
        return { changed: true, card, message: `telegram: ${cmd} ${m[1]}` };
      }, deps);
      return cmd === 'edit'
        ? [{ type: 'send', text: formatCard(r.card), keyboard: reviewButtons(r.card.id) }]
        : [{ type: 'send', text: `Причина решения по ${m[1]} записана.` }];
    } catch (err) {
      return [{ type: 'send', text: err instanceof ReviewError ? err.message : 'Не получилось' }];
    }
  }
  return [{ type: 'send', text: 'Не знаю такой команды. /start — меню.', keyboard: mainKeyboard(host) }];
}

async function install(host) {
  const url = `${appUrl(host)}/api/bot`;
  const hook = await tg('setWebhook', { url, secret_token: secret(), allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
  const cmds = await syncCommands(ownerId());
  let menu = { ok: false, description: 'TG_OWNER_CHAT_ID не задан' };
  if (/^\d+$/.test(ownerId())) {
    menu = await tg('setChatMenuButton', { chat_id: Number(ownerId()), menu_button: { type: 'web_app', text: 'Instagram Manager', web_app: { url: appUrl(host) } } });
  }
  return [
    `Вебхук → ${url}: ${hook.ok ? '✅' : '❌ ' + (hook.description || '')}`,
    `Команды бота: ${cmds.ok ? '✅' : '❌ ' + (cmds.description || '')}`,
    `Кнопка «Instagram Manager»: ${menu.ok ? '✅' : '❌ ' + (menu.description || '')}`,
    '',
    hook.ok ? 'Готово. Напиши боту /start — ответ придёт сразу.' : 'Вебхук не подключён.',
  ].join('\n');
}

const text = (res, code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(body); };

export default async function handler(req, res) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (req.method !== 'POST') {
    const q = new URL(req.url, 'https://x').searchParams;
    if (q.has('install')) {
      if (!secret() || !sameSecret(q.get('install'), secret())) return text(res, 403, 'Неверный ключ установки.');
      if (!botToken()) return text(res, 503, 'TG_BOT_TOKEN не задан на Vercel.');
      return text(res, 200, await install(host));
    }
    let info = 'TG_BOT_TOKEN не задан';
    if (botToken()) {
      const me = await tg('getMe', {});
      const wh = await tg('getWebhookInfo', {});
      const expected = `${appUrl(host)}/api/bot`;
      info = (me.ok ? `Бот: @${me.result.username} ✅` : 'Токен неверный ❌') + '\n' +
        `Вебхук: ${wh.result?.url === expected ? 'подключён к этому проекту ✅' : wh.result?.url ? 'смотрит на другой адрес ⚠️' : 'не подключён ❌'}` +
        (wh.result?.last_error_message ? `\nПоследняя ошибка Telegram: ${wh.result.last_error_message}` : '');
    }
    return text(res, 200, [
      'Instagram Manager — самопроверка', '', info,
      `TG_OWNER_CHAT_ID: ${ownerId() ? 'задан ✅' : 'не задан ❌'}`,
      `IGM_BRIDGE_TOKEN: ${process.env.IGM_BRIDGE_TOKEN ? 'задан ✅' : 'не задан ❌'}`,
      `TG_WEBHOOK_SECRET: ${secret().length >= 24 ? 'задан ✅' : 'не задан или короче 24 символов ❌'}`,
      `GROQ_API_KEY: ${process.env.GROQ_API_KEY ? 'задан ✅' : 'не задан ❌ (ИИ не пишет тексты)'}`,
      `PIPELINE_SECRET: ${String(process.env.PIPELINE_SECRET || '').trim().length >= 24 ? 'задан ✅' : 'не задан ❌ (робот сборки не сможет прислать финал)'}`,
      `CRON_SECRET: ${process.env.CRON_SECRET ? 'задан ✅' : 'не задан ❌ (ИИ-редактор не запустится по утрам)'}`,
      '', 'Подключить: /api/bot?install=<TG_WEBHOOK_SECRET>',
    ].join('\n'));
  }

  // Без секрета обновления не принимаются: иначе любой мог бы прислать «апдейт от владельца»
  if (!secret()) return text(res, 503, 'TG_WEBHOOK_SECRET is not set');
  if (!sameSecret(req.headers['x-telegram-bot-api-secret-token'], secret())) return text(res, 401, 'bad secret');

  // Telegram повторяет запрос при не-200, поэтому ошибки обработки логируем и всё равно отвечаем 200
  try {
    const update = readBody(req);
    const owner = ownerId();
    const guest = guestReply(update, owner, host);
    if (guest) { for (const g of guest) await tg(g.method, g.body); return text(res, 200, 'ok'); }
    // Один раз на запуск сервера обновляем меню команд: посторонним — только /start и /guide
    if (!commandsSynced) { commandsSynced = true; syncCommands(owner).catch(() => { commandsSynced = false; }); }
    const notify = t => tg('sendMessage', { chat_id: Number(owner), text: t });
    const actions = await handleUpdate(update, { owner, host, deps: { get: ghGetJson, put: ghPutJson, notify } });
    const chatId = Number(owner);
    for (const a of actions) {
      if (a.type === 'ack' && update.callback_query) await tg('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: String(a.text || '').slice(0, 180) });
      if (a.type === 'edit' && update.callback_query?.message) await tg('editMessageText', { chat_id: chatId, message_id: update.callback_query.message.message_id, text: a.text.slice(0, 4000) });
      if (a.type === 'final') await sendFinal(a.post, host);
      if (a.type === 'docs') for (const u of a.urls || []) await tg('sendDocument', { chat_id: chatId, document: u });
      if (a.type === 'send') await tg('sendMessage', { chat_id: chatId, text: a.text.slice(0, 4000), disable_web_page_preview: true, ...(a.keyboard ? { reply_markup: { inline_keyboard: a.keyboard } } : {}) });
      if (a.type === 'send' && a.after) await sendPrompts(a.after, (a.after.match(/P\d{4,6}/) || [])[0] || '', tg, chatId);
    }
  } catch (err) {
    console.error('bot update failed', err?.message || err);
    const chat = req.body?.message?.chat?.id;
    if (String(chat) === ownerId()) await tg('sendMessage', { chat_id: chat, text: 'Не получилось: ' + (err instanceof ReviewError ? err.message : 'внутренняя ошибка') });
  }
  return text(res, 200, 'ok');
}
