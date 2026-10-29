// POST { initData, stage: 'S2', task: 3, done: true } → отметить задачу плана в IGM content/growth-plan.json
import { authorize, ghGetJson, ghPutJson, PLAN_PATH, readBody, reply, fail, ReviewError, toggleTask } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
  try {
    const body = readBody(req);
    authorize(body.initData);
    const stageId = String(body.stage || ''), index = Number(body.task);
    if (!/^S\d{1,2}$/.test(stageId)) throw new ReviewError('Неверный этап');
    for (let attempt = 0; ; attempt++) {
      const { data, sha } = await ghGetJson(PLAN_PATH);
      const { task } = toggleTask(data, stageId, index, Boolean(body.done));
      try {
        await ghPutJson(PLAN_PATH, data, sha, `mini-app: ${task.done ? 'done' : 'reopen'} ${stageId}#${index}`);
        return reply(res, 200, { ok: true });
      } catch (err) {
        if (!(err instanceof ReviewError && err.code === 409) || attempt >= 2) throw err;
      }
    }
  } catch (err) { fail(res, err); }
}
