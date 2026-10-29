// POST { initData } → аналитика по снимкам Instagram и план роста. Только чтение.
import { brainReport } from './_brain.js';
import { authorize, buildAnalytics, buildPlan, CONTENT_PLAN_PATH, ghGetJson, PLAN_PATH, QUEUE_PATH, readBody, reply, fail, snapshotHistory } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
  try {
    authorize(readBody(req).initData);
    const [snapshots, queue, plan, contentPlan] = await Promise.all([
      snapshotHistory(),
      ghGetJson(QUEUE_PATH).then(r => r.data).catch(() => null),
      ghGetJson(PLAN_PATH).then(r => r.data).catch(() => null),
      ghGetJson(CONTENT_PLAN_PATH).then(r => r.data).catch(() => null),
    ]);
    const analytics = buildAnalytics(snapshots, queue);
    const [lab, learning, pipe] = await Promise.all([
      ghGetJson('data/pipeline/lab.json').then(r => r.data).catch(() => null),
      ghGetJson('data/pipeline/learning.json').then(r => r.data).catch(() => null),
      ghGetJson('data/pipeline/posts.json').then(r => r.data).catch(() => null),
    ]);
    const st = learning?.stats || {};
    const pct = (a, b) => (a + b ? Math.round(a / (a + b) * 100) : null);
    reply(res, 200, { ok: true, analytics, plan: buildPlan(plan, contentPlan, analytics, { lab, pipe }), lab: lab && lab.schema_version === 1 ? lab : null,
      strategy: learning?.strategy || null,
      brain: brainReport({ posts: pipe?.posts || [], learning: learning || {}, lab, followers: analytics?.account?.followers ?? null }),
      learning: { rules: (learning?.rules || []).length, text_first_ok: pct(st.text_first_ok || 0, st.text_changed || 0), final_first_ok: pct(st.final_first_ok || 0, st.final_changed || 0) } });
  } catch (err) { fail(res, err); }
}
