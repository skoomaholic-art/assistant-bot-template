// «Мозг» ИИ-редактора: насколько он обучен. Считается только по фактам:
// опыт (опубликованные посты), обучение на правках владельца, точность с первого раза, понимание аудитории.
export const LEVELS = [
  { min: 0, name: 'зачаточный', age: 'как у младенца', note: 'знает буквы, но ещё не понимает, что тебе нравится' },
  { min: 10, name: 'крайне низкий', age: 'как у ребёнка 3 лет', note: 'повторяет правила, но часто ошибается' },
  { min: 20, name: 'низкий', age: 'как у первоклассника', note: 'выучил базовые правила стиля, вкус аудитории пока не чувствует' },
  { min: 35, name: 'ниже среднего', age: 'как у школьника 12 лет', note: 'пишет прилично, но правки ещё нужны часто' },
  { min: 50, name: 'средний', age: 'как у старшеклассника', note: 'чаще попадает с первого раза, понимает форматы' },
  { min: 65, name: 'хороший', age: 'как у студента-журналиста', note: 'правки редкие, темы выбирает по данным' },
  { min: 80, name: 'высокий', age: 'как у опытного редактора', note: 'знает аудиторию и почти не ошибается' },
  { min: 92, name: 'экспертный', age: 'как у шеф-редактора', note: 'можно доверять почти без проверки' },
];
export const levelOf = score => [...LEVELS].reverse().find(l => score >= l.min);

const cap = (v, max) => Math.max(0, Math.min(1, v / max));
const sqcap = (v, max) => Math.sqrt(cap(v, max));
const logcap = (v, max) => Math.max(0, Math.min(1, Math.log(1 + Math.max(0, v)) / Math.log(1 + max)));

// Сырые факты → баллы по четырём частям (сумма 100)
export function scoreOf(f) {
  const decisions = f.textOk + f.textFix + f.finalOk + f.finalFix;
  const textAcc = f.textOk + f.textFix ? f.textOk / (f.textOk + f.textFix) : 0;
  const finalAcc = f.finalOk + f.finalFix ? f.finalOk / (f.finalOk + f.finalFix) : 0;
  const reliability = cap(decisions, 80); // мало решений — точность ближе к «не знаем» (20%)
  const acc = ((textAcc + finalAcc) / 2) * reliability + 0.2 * (1 - reliability);
  const parts = {
    experience: { label: 'Опыт', hint: 'сколько постов вышло', max: 25, value: 25 * sqcap(f.published, 365) },
    learning: { label: 'Обучение на твоих правках', hint: 'правила стиля, вёрстка, решения', max: 30,
      value: 12 * cap(f.rules, 60) + 4 * cap(f.visualFormats, 3) + 14 * sqcap(decisions, 800) },
    accuracy: { label: 'Точность с первого раза', hint: 'текст и финал без правок', max: 30, value: 30 * acc },
    audience: { label: 'Понимание аудитории', hint: 'замеры, выводы лаборатории, стратегия', max: 15,
      value: 8 * cap(f.measured, 150) + 4 * cap(f.meaningfulSegments, 6) + (f.strategy ? (f.meaningfulSegments ? 3 : 1) : 0) },
  };
  for (const p of Object.values(parts)) p.value = Math.round(p.value * 10) / 10;
  const score = Math.round(Object.values(parts).reduce((n, p) => n + p.value, 0));
  return { score, parts, accuracy: { text: Math.round(textAcc * 100), final: Math.round(finalAcc * 100), decisions } };
}

// Факты из конвейера, обучения и лаборатории
export function factsOf({ posts = [], learning = {}, lab = null, followers = null }) {
  const live = posts.filter(p => p.status === 'published' && p.ig?.media_id && !p.ig?.missing && !p.ig_archived_at_utc);
  const st = learning.stats || {};
  const medianReach = (() => {
    const r = live.map(p => p.metrics?.latest?.reach).filter(x => typeof x === 'number').sort((a, b) => a - b);
    return r.length ? r[Math.floor(r.length / 2)] : 0;
  })();
  // выводы лаборатории считаем осмысленными, только когда у постов есть охват
  const verdicts = Object.values(lab?.segments || {}).flat().filter(r => r && r.n >= (lab.min_posts_for_verdict || 3) && r.verdict !== 'мало данных').length;
  const weekAgo = Date.now() - 7 * 86400e3;
  return {
    published: live.length, created: posts.length,
    rules: (learning.rules || []).length, visualFormats: Object.keys(learning.visual_prefs || {}).length,
    textOk: st.text_first_ok || 0, textFix: st.text_changed || 0, finalOk: st.final_first_ok || 0, finalFix: st.final_changed || 0,
    measured: lab?.posts_measured || 0, meaningfulSegments: medianReach >= 50 ? verdicts : 0, medianReach,
    strategy: Boolean(learning.strategy), followers,
    pace: Math.round(live.filter(p => Date.parse(p.ig?.published_at || 0) > weekAgo).length / 7 * 10) / 10,
  };
}

// Прогноз: что будет при темпе pace постов в день через days дней
export function projectFacts(f, pace, days) {
  const added = pace * days;
  const perPost = f.created ? Math.max(1, (f.textOk + f.textFix + f.finalOk + f.finalFix) / f.created) : 2;
  const addDec = added * perPost;
  const decisions = f.textOk + f.textFix + f.finalOk + f.finalFix;
  const accNow = decisions ? (f.textOk + f.finalOk) / decisions : 0.3;
  const accLater = 0.8 - (0.8 - accNow) * Math.exp(-addDec / 400); // с каждой правкой ошибок меньше, предел ~80%
  const total = decisions + addDec;
  const ok = Math.round(total * accLater);
  const published = f.published + added;
  return {
    ...f, published, created: f.created + added,
    rules: Math.min(60, f.rules + addDec * 0.06), visualFormats: Math.min(3, f.visualFormats + (days > 14 ? 1 : 0) + (days > 45 ? 1 : 0)),
    textOk: Math.round(ok / 2), textFix: Math.round((total - ok) / 2), finalOk: ok - Math.round(ok / 2), finalFix: total - ok - Math.round((total - ok) / 2),
    measured: Math.max(f.measured, published - pace), meaningfulSegments: Math.min(6, Math.floor(published / 40)), strategy: true,
  };
}

export function brainReport(input) {
  const f = factsOf(input);
  const now = scoreOf(f);
  const lvl = levelOf(now.score);
  const paces = [1, 2, 3, 5];
  const horizons = [30, 90, 180];
  const forecast = paces.map(pace => ({
    pace,
    points: horizons.map(days => { const s = scoreOf(projectFacts(f, pace, days)).score; const l = levelOf(s); return { days, score: s, level: l.name, age: l.age }; }),
    // через сколько дней «хороший» уровень (65)
    to_good: (() => { for (let d = 1; d <= 730; d++) if (scoreOf(projectFacts(f, pace, d)).score >= 65) return d; return null; })(),
  }));
  const next = LEVELS.find(l => l.min > now.score) || null;
  return {
    score: now.score, level: lvl.name, age: lvl.age, note: lvl.note, next: next ? { name: next.name, at: next.min } : null,
    parts: now.parts, accuracy: now.accuracy, facts: f, forecast, levels: LEVELS.map(l => ({ min: l.min, name: l.name, age: l.age })),
  };
}
