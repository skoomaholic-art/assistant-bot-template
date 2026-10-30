// POST { initData } → карточки на проверке, счётчики, последние решения и снимок аккаунта
import { fetchService } from './_services.js';
import { authorize, checkSchema, ghGetJson, latestSnapshot, publicView, QUEUE_PATH, readBody, reply, fail } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
  try {
    const body = readBody(req);
    authorize(body.initData);
    if (body.action === 'svc') { // страница другого проекта (🧩 Ещё), только владельцу
      const r = await fetchService(String(body.id || ''), body.params || {});
      return reply(res, 200, { ok: Boolean(r.html), html: r.html, status: r.status, error: r.error });
    }
    const [{ data }, snapshot] = await Promise.all([ghGetJson(QUEUE_PATH), latestSnapshot().catch(() => null)]);
    reply(res, 200, { ok: true, ...publicView(checkSchema(data)), snapshot });
  } catch (err) { fail(res, err); }
}
