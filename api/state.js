// POST { initData } → карточки на проверке, счётчики, последние решения и снимок аккаунта
import { authorize, checkSchema, ghGetJson, latestSnapshot, publicView, QUEUE_PATH, readBody, reply, fail } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
  try {
    authorize(readBody(req).initData);
    const [{ data }, snapshot] = await Promise.all([ghGetJson(QUEUE_PATH), latestSnapshot().catch(() => null)]);
    reply(res, 200, { ok: true, ...publicView(checkSchema(data)), snapshot });
  } catch (err) { fail(res, err); }
}
