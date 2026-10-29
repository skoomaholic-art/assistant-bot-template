// Какой формат лучше для новости: пост-картинка, карусель или Reels.
// Считаем по фактам: объём материала, характер новости, «горячесть», выводы лаборатории и пробелы в плане.
export const FORMAT_LABEL = { post: '🖼 Пост', carousel: '📚 Карусель', reel: '🎬 Reels' };

const VIDEO = /трейлер|тизер|кадры|первый взгляд|фрагмент|сцен[аы]|ролик|видео|trailer|teaser|first look|clip|footage|sneak peek/i;
const LIST = /\b\d{1,2}\s+(лучших|фильмов|сериалов|причин|фактов|актёр|ролей|серий|things|best|films|movies|shows|reasons)|подборк|список|рейтинг|топ[- ]?\d|лучшие|каст|актёрский состав|в ролях|cast|lineup|ranking|ranked|every\b|все (фильмы|сезоны|части)/i;
const EXPLAIN = /почему|как |что известно|объясня|разбор|сюжет|теори|финал|концовк|explained|why |how |everything we know|ending|theory/i;
const BRIEF = /продлил|продлён|закрыт|отменил|дата выхода|перенес|назначил|умер|скончал|получил|номинац|премия|сборы|кассов|renewed|cancel|release date|dies|died|wins|box office|delayed|set to/i;

// item: {title, summary, hot, coverage}; article — текст статьи (может быть пустым)
export function scoreFormats(item, { article = '', lab = null, posts = [], planTotals = null, ownerPref = null } = {}) {
  const text = `${item.title || ''} ${item.summary || ''}`;
  const volume = (article || item.summary || '').length;
  const s = { post: 1, carousel: 1, reel: 1 };
  const why = { post: [], carousel: [], reel: [] };
  const add = (f, v, reason) => { s[f] += v; if (reason) why[f].push(reason); };

  // объём материала
  if (volume < 400) add('post', 1.5, 'материала немного, хватит одной картинки');
  else if (volume < 1500) { add('post', 0.5); add('carousel', 0.8, 'материала на несколько слайдов'); }
  else add('carousel', 1.6, 'много фактов, удобно разложить по слайдам');

  // характер новости
  if (VIDEO.test(text)) add('reel', 2, 'новость визуальная: трейлер или кадры лучше смотрятся в движении');
  if (LIST.test(text)) add('carousel', 2.2, 'это перечень или состав, его листают');
  if (EXPLAIN.test(text)) { add('carousel', 1, 'нужно объяснение по шагам'); add('reel', 0.6); }
  if (BRIEF.test(text)) add('post', 1.4, 'короткий факт, суть понятна сразу');

  // горячее: быстрая подача
  if (item.hot) { add('post', 0.6, `горячая тема (пишут ${item.coverage || 'несколько'} изданий), важно выйти быстро`); add('reel', 0.5); }

  // лаборатория: формат-лидер, только если охват уже осмысленный
  const fmtSeg = (lab?.segments?.format || []).filter(r => r.n >= (lab.min_posts_for_verdict || 3) && r.verdict !== 'мало данных');
  const live = posts.filter(p => p.status === 'published' && !p.ig?.missing);
  const reach = live.map(p => p.metrics?.latest?.reach).filter(x => typeof x === 'number').sort((a, b) => a - b);
  const median = reach.length ? reach[Math.floor(reach.length / 2)] : 0;
  const KEY = { 'Пост': 'post', 'Карусель': 'carousel', 'Reels': 'reel' };
  let labNote = null;
  if (median >= 50) {
    for (const r of fmtSeg) {
      const f = KEY[r.value]; if (!f) continue;
      if (r.index >= 1.15) add(f, 1.2, `в лаборатории ${r.value.toLowerCase()} набирает больше обычного (индекс ${r.index})`);
      if (r.index <= 0.85) add(f, -0.8);
    }
  } else labNote = 'охват пока слишком мал, чтобы лаборатория сравнивала форматы';

  // пробел в плане: каких форматов не хватает для честного сравнения
  if (planTotals) {
    const kind = p => p.draft?.format === 'reel' ? 'reel' : (p.draft?.slides || []).length > 1 ? 'carousel' : 'post';
    const have = { post: 0, carousel: 0, reel: 0 };
    for (const p of live) have[kind(p)]++;
    const need = { carousel: planTotals.carousels || 0, reel: planTotals.reels || 0 };
    for (const f of ['reel', 'carousel']) {
      const gap = need[f] - have[f];
      if (gap > 0 && have[f] < Math.max(1, have.post)) add(f, Math.min(1.2, gap / 10 + 0.4), `по плану не хватает: ${f === 'reel' ? 'Reels' : 'каруселей'} ${have[f]} из ${need[f]}`);
    }
  }

  // твои прошлые выборы: если часто меняешь совет на какой-то формат, он получает бонус
  const NAMES = { post: 'посты', carousel: 'карусели', reel: 'Reels' };
  for (const [f, n] of Object.entries(ownerPref || {})) if (s[f] != null && n > 0) add(f, Math.min(1, 0.3 * n), n >= 2 ? `ты часто выбираешь ${NAMES[f]}` : null);

  const order = Object.keys(s).sort((a, b) => s[b] - s[a]);
  const best = order[0];
  const margin = s[best] - s[order[1]];
  return { best, order, scores: s, reasons: why[best].slice(0, 3), confidence: margin >= 1.5 ? 'уверенно' : margin >= 0.6 ? 'скорее' : 'примерно равно', lab_note: labNote, volume };
}
