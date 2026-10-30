// Задачи из личного Gmail через Google Apps Script (apps-script/Code.gs).
// Письма не сохраняются ни в GitHub, ни на Vercel: каждый раз читаются из Gmail.
//
// POST { initData, action: 'list' }                              → { items, done }
// POST { initData, action: 'status', id, status: new|work|done } → сменить статус
// POST { initData, action: 'delete', id }                        → убрать из задач (письмо остаётся в почте)
// POST { initData, action: 'remind', id, minutes }               → спрятать и напомнить через N минут
// POST { initData, action: 'unremind', id }                      → отменить напоминание
// POST { key, action: 'due', items }                             → от Gmail-скрипта: прислать напоминания в Telegram
// POST { key, action: 'tick' }                                   → от Gmail-скрипта раз в 5 минут: пнуть робота IGM,
//                                                                  если отложенному посту пора или сборка зависла
import crypto from 'node:crypto';
import { authorize, botToken, ownerId, readBody, reply, fail, ReviewError } from './_lib.js';
import { tickRobot } from './_kick.js';

const env = n => String(process.env[n] || '').trim();
export const MAIL_ID = /^[0-9a-f]{8,24}$/i;
export const STATUSES = ['new', 'work', 'done'];
export const MAX_REMIND_MIN = 60 * 24 * 90;
const STATUS_RU = { new: 'новая', work: 'в работе', done: 'готово' };

// Apps Script при ошибках настройки отдаёт HTML-страницу вместо JSON — переводим её в понятную причину
export function diagnose(status, html) {
  const t = String(html || '');
  if (/accounts\.google\.com|ServiceLogin|Sign in|Войдите/i.test(t)) return 'Скрипт просит вход в Google: в Deploy → Manage deployments поставь «Who has access: Anyone» (именно Anyone, не «Anyone with Google account»)';
  if (/Script function not found|Функция скрипта не найдена|doPost/i.test(t)) return 'В развёртывании нет кода doPost: вставь код в Code.gs, сохрани (💾) и сделай Deploy → Manage deployments → ✏️ → Version: New version';
  if (/authoriz|авториз|разрешени/i.test(t)) return 'Скрипту не выданы права: открой script.google.com, выбери функцию setup → Run и разреши доступ к Gmail';
  if (status === 401 || status === 403) return 'Google не пускает к скрипту (HTTP ' + status + '): в Deploy → Manage deployments → ✏️ поставь «Who has access: Anyone» (именно «Все», не «Все, у кого есть аккаунт Google»), Version: New version → Deploy'
  if (status === 404) return 'Скрипт не найден (404): проверь, что MAIL_SCRIPT_URL — это адрес Web app, заканчивается на /exec';
  return `Gmail-скрипт ответил не так (HTTP ${status}). Проверь Deploy → Web app → Execute as: Me, Who has access: Anyone`;
}

export async function callScript(payload, fetchImpl = fetch) {
  const url = env('MAIL_SCRIPT_URL'), key = env('MAIL_SCRIPT_KEY');
  if (!url || !key) throw new ReviewError('Почта не подключена: задай MAIL_SCRIPT_URL и MAIL_SCRIPT_KEY на Vercel', 503);
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) throw new ReviewError('MAIL_SCRIPT_URL должен быть адресом веб-приложения Apps Script (…/exec)', 503);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  let data;
  try {
    // Apps Script отвечает редиректом 302 на googleusercontent — fetch проходит его сам
    const r = await fetchImpl(url, { method: 'POST', redirect: 'follow', signal: ctrl.signal, headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ...payload, key }) });
    const raw = await r.text();
    try { data = JSON.parse(raw); } catch { throw new ReviewError(diagnose(r.status, raw), 502); }
  } catch (err) {
    if (err instanceof ReviewError) throw err;
    throw new ReviewError(err?.name === 'AbortError' ? 'Gmail-скрипт не ответил за 9 секунд. Попробуй ещё раз' : 'Gmail-скрипт недоступен. Проверь адрес MAIL_SCRIPT_URL', 502);
  } finally { clearTimeout(timer); }
  if (!data?.ok) {
    if (data?.error === 'forbidden') throw new ReviewError('Ключ не совпадает: PULT_KEY в скрипте ≠ MAIL_SCRIPT_KEY на Vercel', 502);
    if (data?.error === 'unknown action') throw new ReviewError('В Gmail-скрипте старый код: вставь новый apps-script/Code.gs и сделай Deploy → Manage deployments → ✏️ → New version', 502);
    throw new ReviewError('Gmail-скрипт: ' + (data?.error || 'ошибка'), 502);
  }
  return data;
}

const isoOrNull = v => (v && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const gmailLink = v => (/^https:\/\/mail\.google\.com\//.test(String(v || '')) ? String(v) : null);

// Пересланные с рабочей почты письма: настоящий отправитель — в строке «Отправитель: …», а в тексте
// мусор Outlook (предупреждения о внешней почте, ссылки в <…>, cid-картинки). Показываем суть.
const NOISE = [
  /Вы не часто получаете электронную почту от[^]*?почему это важно/gi,
  /EXTERNAL EMAIL:[^]*?know the content is safe\.?/gi,
  /ВНЕШНЯЯ ПОЧТА:[^]*?содержимое безопасно\.?/gi,
  /\[cid:[^\]]*\]/gi,
  /<(?:https?:|mailto:)[^>]*>/gi,
];
export function cleanMail(from, snippet) {
  let text = String(snippet || '');
  let sender = String(from || '');
  const m = text.match(/^\s*Отправитель:\s*<?([^\s<>]+@[^\s<>]+)>?/i);
  if (m) { sender = m[1].toLowerCase().replace(/[.,;:]+$/, ''); text = text.slice(m[0].length); }
  for (const re of NOISE) text = text.replace(re, ' ');
  return { from: sender.trim().slice(0, 80), snippet: text.replace(/\s+/g, ' ').trim().slice(0, 280) };
}

export function cleanItem(x) {
  const c = cleanMail(x?.from, x?.snippet);
  return {
    id: String(x?.id || ''), status: STATUSES.includes(x?.status) ? x.status : 'new',
    subject: String(x?.subject || '').slice(0, 200), from: c.from,
    date: isoOrNull(x?.date), snippet: c.snippet, messages: Number(x?.messages) || 1,
    unread: Boolean(x?.unread), starred: Boolean(x?.starred), remindAt: isoOrNull(x?.remindAt), link: gmailLink(x?.link),
  };
}

export function checkId(id) {
  const s = String(id || '');
  if (!MAIL_ID.test(s)) throw new ReviewError('Неверный ID письма');
  return s;
}

export function checkMinutes(m) {
  const n = Math.round(Number(m));
  if (!Number.isFinite(n) || n < 1 || n > MAX_REMIND_MIN) throw new ReviewError('Напомнить можно через 1 минуту — 90 дней');
  return n;
}

// Минуты до завтрашних 9:00 по Алматы (UTC+5)
export function minutesToTomorrow9(now = Date.now()) {
  const shift = 5 * 3600e3;
  const local = new Date(now + shift);
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 9, 0) - shift;
  return Math.max(1, Math.round((target - now) / 60000));
}

export function humanDelay(min) {
  if (min < 60) return `${min} мин`;
  if (min < 1440) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h} ч ${m} мин` : `${h} ч`; }
  const d = Math.floor(min / 1440), h = Math.round((min % 1440) / 60);
  return h ? `${d} дн ${h} ч` : `${d} дн`;
}

// ---------- Telegram: напоминания и кнопки ----------

export function reminderButtons(item) {
  const id = item.id;
  const rows = [
    [{ text: '✅ Готово', callback_data: `mt:${id}:done` }, item.status === 'work' ? { text: '↩️ В новые', callback_data: `mt:${id}:new` } : { text: '🔧 В работу', callback_data: `mt:${id}:work` }],
    [{ text: '⏰ +1 ч', callback_data: `mt:${id}:r60` }, { text: '⏰ +3 ч', callback_data: `mt:${id}:r180` }, { text: '⏰ Завтра 9:00', callback_data: `mt:${id}:tmr` }],
  ];
  if (item.link) rows.push([{ text: '📬 Открыть письмо', url: item.link }]);
  return rows;
}

export function reminderText(item) {
  return [`⏰ Напоминание по задаче`, `«${item.subject || '(без темы)'}»`, item.from ? `от ${item.from}` : '', `Статус: ${STATUS_RU[item.status] || 'новая'}`].filter(Boolean).join('\n');
}

// Нажатие кнопки под напоминанием: mt:<id>:<op>. Возвращает текст для всплывашки и новый текст сообщения.
export async function mailCallback(data, call = callScript, now = Date.now()) {
  const m = String(data || '').match(/^mt:([0-9a-f]{8,24}):(done|work|new|r\d{1,6}|tmr)$/i);
  if (!m) return null;
  const [, id, op] = m;
  if (op === 'done' || op === 'work' || op === 'new') {
    await call({ action: 'status', id, status: op });
    const label = { done: '✅ Готово', work: '🔧 Взял в работу', new: '↩️ Вернул в новые' }[op];
    return { ack: label, edit: label };
  }
  const minutes = checkMinutes(op === 'tmr' ? minutesToTomorrow9(now) : Number(op.slice(1)));
  await call({ action: 'remind', id, minutes });
  const when = op === 'tmr' ? 'завтра в 9:00' : 'через ' + humanDelay(minutes);
  return { ack: `Напомню ${when}`, edit: `⏰ Напомню ${when}` };
}

async function tgSend(body, fetchImpl = fetch) {
  try {
    const r = await fetchImpl(`https://api.telegram.org/bot${botToken()}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
  } catch { return { ok: false }; }
}

export function sameKey(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length >= 24 && crypto.timingSafeEqual(x, y);
}

// Gmail-скрипт сообщает, что пора напомнить. Отвечаем списком реально отправленных ID.
export async function sendDue(body, fetchImpl = fetch) {
  if (!sameKey(body?.key, env('MAIL_SCRIPT_KEY'))) throw new ReviewError('forbidden', 403);
  const owner = ownerId();
  if (!botToken() || !/^\d{1,25}$/.test(owner)) throw new ReviewError('Бот не настроен', 503);
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 10).map(cleanItem).filter(x => MAIL_ID.test(x.id));
  const sent = [];
  for (const item of items) {
    const r = await tgSend({ chat_id: Number(owner), text: reminderText(item), disable_web_page_preview: true, reply_markup: { inline_keyboard: reminderButtons(item) } }, fetchImpl);
    if (r?.ok) sent.push(item.id);
  }
  return sent;
}

// Пульс от Gmail-скрипта: тот же ключ, что у 'due'. Ответ { ok, kicked, due:[id] }
export async function sendTick(body, deps = {}) {
  if (!sameKey(body?.key, env('MAIL_SCRIPT_KEY'))) throw new ReviewError('forbidden', 403);
  const r = await (deps.tick || tickRobot)(deps);
  return { kicked: Boolean(r.kicked), due: r.due || [] };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
  try {
    const body = readBody(req);
    if (body.action === 'due') return reply(res, 200, { ok: true, sent: await sendDue(body) });
    if (body.action === 'tick') return reply(res, 200, { ok: true, ...(await sendTick(body)) });
    authorize(body.initData);
    const action = body.action || 'list';
    if (action === 'list') {
      const data = await callScript({ action: 'list' });
      const items = (Array.isArray(data.items) ? data.items : []).map(cleanItem).filter(x => MAIL_ID.test(x.id));
      const done = (Array.isArray(data.done) ? data.done : []).map(x => ({ id: String(x?.id || ''), subject: String(x?.subject || '').slice(0, 200), date: isoOrNull(x?.date) })).filter(x => MAIL_ID.test(x.id));
      return reply(res, 200, { ok: true, items, done });
    }
    if (action === 'status' || action === 'done') {
      const status = action === 'done' ? 'done' : String(body.status || '');
      if (!STATUSES.includes(status)) throw new ReviewError('Неверный статус');
      const r = await callScript({ action: 'status', id: checkId(body.id), status });
      return reply(res, 200, { ok: true, item: r.item?.status === 'done' ? { id: r.item.id, status: 'done' } : r.item ? cleanItem(r.item) : null });
    }
    if (action === 'delete') {
      await callScript({ action: 'delete', id: checkId(body.id) });
      return reply(res, 200, { ok: true });
    }
    if (action === 'remind') {
      const r = await callScript({ action: 'remind', id: checkId(body.id), minutes: checkMinutes(body.minutes) });
      return reply(res, 200, { ok: true, remindAt: isoOrNull(r.remindAt) });
    }
    if (action === 'unremind') {
      await callScript({ action: 'unremind', id: checkId(body.id) });
      return reply(res, 200, { ok: true });
    }
    throw new ReviewError('Неизвестное действие');
  } catch (err) { fail(res, err); }
}
