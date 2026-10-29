// Обучение на правках владельца: правила редакции + предпочтения вёрстки + статистика «принято без правок».
// Хранится в IGM data/pipeline/learning.json. Это память редакции, а не дообучение модели.
import { ghGetJson, ghPutJson, ReviewError, utcNow } from './_lib.js';
import { groqJSON } from './_groq.js';

export const LEARN_PATH = 'data/pipeline/learning.json';
export const MAX_RULES = 25;
export const VISUAL_FIELDS = ['stylePreset', 'bgMode', 'bgColor', 'theme', 'layout', 'typeface', 'titleAlign', 'titleY', 'titleSize', 'titleWidth', 'showLogo', 'logoPosition'];

export const emptyLearning = () => ({
  schema_version: 1,
  note: 'Память редакции: правила из замечаний владельца, предпочтения вёрстки, статистика правок. Правила можно смотреть /rules и удалять /forget N.',
  rules: [], visual_prefs: {}, events: [],
  stats: { text_first_ok: 0, text_changed: 0, final_first_ok: 0, final_changed: 0 },
});

const s = (v, n) => String(v ?? '').trim().slice(0, n);
export function draftDigest(d) {
  if (!d) return null;
  return { slides: (d.slides || []).map(x => ({ title: s(x.title, 110), subtitle: s(x.subtitle, 160) })), caption: s(d.caption, 1200), format: d.format };
}
export function textChanged(a, b) {
  return JSON.stringify(draftDigest(a)) !== JSON.stringify(draftDigest(b));
}
// Отличается ли вёрстка от автоматической: сравниваем визуальные поля первого слайда
export function visualDiff(pages, autoPages) {
  if (!Array.isArray(pages) || !pages.length) return null;
  const mine = pages[0], auto = autoPages?.[0] || {};
  const diff = {};
  for (const k of VISUAL_FIELDS) if (mine[k] !== undefined && JSON.stringify(mine[k]) !== JSON.stringify(auto[k])) diff[k] = mine[k];
  return Object.keys(diff).length ? diff : null;
}

export function addEvent(learn, ev) {
  learn.events.push({ at: utcNow(), ...ev });
  learn.events = learn.events.slice(-150);
}

// Обновить список правил по новому сигналу (ИИ). Без ключа — сохраняем замечание как правило дословно.
export async function distillRules(rules, signal, { key = String(process.env.GROQ_API_KEY || '').trim(), fetchImpl = fetch } = {}) {
  const fallback = () => {
    const r = s(signal.feedback || signal.reason, 160);
    return r ? [...rules.filter(x => x !== r), r].slice(-MAX_RULES) : rules;
  };
  if (!key) return fallback();
  const sys = `Ты ведёшь короткий свод редакционных правил для ИИ, который пишет посты Instagram-аккаунта о кино и сериалах. Владелец только что поправил или отклонил черновик, либо сам написал пост целиком (signal.type=owner_post: это эталон его стиля, выведи из него правила подачи). Выведи из этого общее правило стиля/подачи (а не факт о конкретном фильме) и обнови свод: добавь новое, уточни или объедини похожие, удали противоречащие новому сигналу. Каждое правило — одно короткое повелительное предложение до 140 знаков. Максимум ${MAX_RULES}. Если сигнал не даёт общего правила, верни свод без изменений. Ответ только JSON: {"rules":["..."]}.`;
  try {
    const out = await groqJSON([{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ current_rules: rules, signal }) }], { key, fetchImpl, maxTokens: 2000, temperature: 0.2 });
    if (!Array.isArray(out.rules)) return fallback();
    const clean = [...new Set(out.rules.map(r => s(r, 160)).filter(r => r.length >= 6))].slice(0, MAX_RULES);
    return clean.length || !rules.length ? clean : rules;
  } catch { return fallback(); }
}

export async function withLearning(mutate, deps = { get: ghGetJson, put: ghPutJson }) {
  for (let attempt = 0; ; attempt++) {
    const { data, sha } = await deps.get(LEARN_PATH).catch(() => ({ data: null, sha: null }));
    const learn = data && data.schema_version === 1 ? { ...emptyLearning(), ...data } : emptyLearning();
    const result = await mutate(learn);
    if (!result?.message) return result;
    try { await deps.put(LEARN_PATH, learn, sha || undefined, result.message); return result; }
    catch (err) { if (!(err instanceof ReviewError && err.code === 409) || attempt >= 2) throw err; }
  }
}

export async function loadLearning(get = ghGetJson) {
  const { data } = await get(LEARN_PATH).catch(() => ({ data: null }));
  return data && data.schema_version === 1 ? { ...emptyLearning(), ...data } : emptyLearning();
}

// Сигнал от владельца → событие (+ обновление правил, если это замечание/причина/правка текста)
export async function learn(signal, { deps, distill = distillRules } = {}) {
  const needsRules = ['text_feedback', 'reject_reason', 'text_edit', 'owner_post'].includes(signal.type);
  const current = needsRules ? (await loadLearning(deps?.get)).rules : null;
  const rules = needsRules ? await distill(current, signal) : null;
  return withLearning(l => {
    addEvent(l, signal);
    if (rules) l.rules = rules;
    if (signal.type === 'visual_edit' && signal.format && signal.diff) l.visual_prefs[signal.format] = { ...(l.visual_prefs[signal.format] || {}), ...signal.diff };
    if (signal.type === 'stat') l.stats[signal.key] = (l.stats[signal.key] || 0) + 1;
    if (signal.type === 'reel_style') l.reel_style_pref = { ...(l.reel_style_pref || {}), [signal.chosen]: ((l.reel_style_pref || {})[signal.chosen] || 0) + 1 };
    if (signal.type === 'format_choice') {
      l.stats[signal.recommended === signal.chosen ? 'format_agree' : 'format_override'] = (l.stats[signal.recommended === signal.chosen ? 'format_agree' : 'format_override'] || 0) + 1;
      if (signal.recommended !== signal.chosen) l.format_pref = { ...(l.format_pref || {}), [signal.chosen]: ((l.format_pref || {})[signal.chosen] || 0) + 1 };
    }
    if (signal.type === 'owner_post' && signal.after) { l.examples = [...(l.examples || []).filter(e => e.post !== signal.post), { post: signal.post, ...signal.after }].slice(-8); l.stats.owner_posts = (l.stats.owner_posts || 0) + 1; }
    return { message: `learning: ${signal.type}${signal.post ? ' ' + signal.post : ''}` };
  }, deps);
}

export function rate(stats, okKey, changedKey) {
  const ok = stats?.[okKey] || 0, ch = stats?.[changedKey] || 0;
  return ok + ch ? Math.round((ok / (ok + ch)) * 100) : null;
}
