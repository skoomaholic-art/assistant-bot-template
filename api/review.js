// POST { initData, id, action: approve|reject|revise|edit|why, text? }
// Записывает решение владельца в IGM. Ничего не публикует в Instagram.
import { addReason, applyAction, authorize, checkSchema, editCard, ghGetJson, ghPutJson, publicView, QUEUE_PATH, readBody, reply, fail, ReviewError } from './_lib.js';

const ACTIONS = new Set(['approve', 'reject', 'revise', 'edit', 'why']);

export function mutate(state, { id, action, text }, owner) {
  if (action === 'edit') return editCard(state, id, text, owner);
  if (action === 'why') return addReason(state, id, text);
  return applyAction(state, id, action, owner);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
  try {
    const body = readBody(req);
    const user = authorize(body.initData);
    if (!ACTIONS.has(body.action)) throw new ReviewError('Неизвестное действие');
    // Бот в GitHub Actions пишет в тот же файл: при конфликте перечитываем и пробуем ещё раз
    for (let attempt = 0; ; attempt++) {
      const { data, sha } = await ghGetJson(QUEUE_PATH);
      const state = checkSchema(data);
      const card = mutate(state, body, user.id);
      try {
        await ghPutJson(QUEUE_PATH, state, sha, `mini-app: ${body.action} ${card.id}`);
        return reply(res, 200, { ok: true, card: { id: card.id, status: card.status }, ...publicView(state) });
      } catch (err) {
        if (!(err instanceof ReviewError && err.code === 409) || attempt >= 2) throw err;
      }
    }
  } catch (err) { fail(res, err); }
}
