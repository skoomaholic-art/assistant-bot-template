// Визуальный бриф: сначала разбор новости, потом промпты.
// Промпт отвечает не на «какую красивую картинку нарисовать», а на «какой конкретный момент или конфликт
// из этой истории показать, чтобы зритель заинтересовался даже без текста».
import { groqJSON } from './_groq.js';

const DEV_RE = /в разработке|разрабатыва|готовит(ся)?|экранизац|адаптац|анонс|объявил|утвержд|кастинг|сыграет|сыграют|получит роль|подписан|займётся|снимет|продлил|продлён|в производстве|съёмки начнутся|in development|developing|greenlit|green-lit|ordered|set to star|cast as|to direct|to helm|adaptation|announced|pre-production|in the works|pilot|options? rights/i;
const RELEASED_RE = /вышел|вышла|в прокате|премьера состоялась|трейлер|кадры|сборы|box office|trailer|first look|now streaming|released/i;

const clean = (v, n) => String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const list = (v, n, len) => (Array.isArray(v) ? v : []).map(x => (typeof x === 'string' ? clean(x, len) : x)).filter(Boolean).slice(0, n);

// Проект ещё не снят: картинки только как редакционный концепт
export function projectStatus(text, aiStatus) {
  const t = String(text || '');
  if (['in_development', 'announced'].includes(aiStatus)) return 'in_development';
  if (DEV_RE.test(t) && !RELEASED_RE.test(t)) return 'in_development';
  if (aiStatus === 'released') return 'released';
  return aiStatus === 'evergreen' ? 'evergreen' : 'unknown';
}

export const aspectOf = d => (d.format === 'reel' ? '9:16' : '4:5');
export function technicalTail(d) {
  const reel = d.format === 'reel';
  return [
    reel ? 'vertical 9:16 composition' : 'vertical 4:5 composition',
    reel ? 'keep the upper 35% calm and uncluttered for the headline' : 'keep the upper third calm and uncluttered for the headline',
    'no text, no letters, no numbers, no captions, no logos, no watermarks, no signage with writing',
    'no recognizable real actors or celebrities, original faces',
  ].join(', ');
}
const CONCEPT_PREFIX = 'editorial concept art, high-end magazine key illustration, clearly an artistic interpretation and not a film still, painterly cinematic realism';
const SCENE_PREFIX = 'cinematic editorial photograph, still-life of a story moment, photorealistic';

// Собирает финальный промпт из частей: режим + сцена + закреплённые персонажи + единый стиль + тех. ограничения
export function composePrompt(scene, plan, d) {
  const said = `${scene.moment} ${scene.action || ''}`.toLowerCase();
  const chars = (plan.characters || []).filter(c => (scene.characters || []).map(x => String(x).toLowerCase()).includes(c.id.toLowerCase()) || said.includes(c.id.toLowerCase())).map(c => `${c.id}: ${c.look}`);
  const parts = [
    plan.status === 'in_development' ? CONCEPT_PREFIX : SCENE_PREFIX,
    scene.moment,
    scene.action && `action: ${scene.action}`,
    scene.emotion && `emotion: ${scene.emotion}`,
    chars.length && `characters (keep identical across the series): ${chars.join('; ')}`,
    scene.composition && `composition: ${scene.composition}`,
    scene.lighting && `lighting: ${scene.lighting}`,
    plan.style && `series style: ${plan.style}`,
    technicalTail(d),
  ].filter(Boolean).map(x => clean(x, 400));
  return `${parts.join(', ')} --ar ${aspectOf(d)}`;
}

const SYSTEM = `You are the visual editor of a Russian-language Instagram account about film and TV. You do NOT write pretty-picture prompts. First you analyse the news, then you plan one concrete image per slide.

STEP 1, analysis (from SOURCE only):
- story: the central plot of the title in one sentence
- characters: up to 3 FICTIONAL characters of the story itself (the hero, the antagonist...), id = short English label like "the courier". NEVER real people: no producers, writers, directors, authors, actors, studio executives. Each gets a FIXED visual description IN ENGLISH (age range, build, hair, clothing, one distinctive detail) repeated on every slide. Original faces, never a real actor's likeness. If the source names no characters, invent a plausible protagonist from the premise and list that under assumptions
- conflict: the main dramatic conflict or stakes
- setting: place and era
- status: "released" (film/series already out), "in_development" (announced, being developed, casting, adaptation, not yet filmed or released), "evergreen" (essay/opinion not tied to a release), "unknown"
- facts: confirmed facts stated in SOURCE (short)
- assumptions: artistic liberties you take to visualise it (what is invented, not confirmed)

STEP 2, visual plan:
- style: ONE series style lock for all slides (palette, lens, film stock/grain, colour grade, light quality)
- scenes: EXACTLY N items, one per slide in order, ALL DIFFERENT moments. Always show the STORY WORLD (the plot of the title), never the industry: no offices, meetings, producers, film sets, cameras, storyboards, studio logos. A slide about the crew, the studio or the release still gets a story moment (e.g. the hero's key dilemma). Build a progression across the series: setup, the incident, pursuit or pressure, a twist, the peak of tension, an open question.
- Each scene must show a SPECIFIC moment, action or conflict from the story that matches THAT slide's text, so a viewer gets curious about the story even without the text. Not a mood board, not a generic metaphor. Fields: moment (what exactly happens, who and where), characters (array of character ids present), action (concrete physical action), emotion (what we read on faces/body), composition (shot size, angle, subject placement, keep the upper area clean for the headline), lighting (specific light).
- If status is in_development: it is NOT a real still. Show it as an editorial concept: key-art style, symbolic but still a concrete story moment. Never imply it is a frame from the unreleased show.
- No text, letters, numbers, logos, posters or UI anywhere in the image.

Write story, conflict, setting, facts, assumptions in Russian. Write characters[].look, style and all scene fields in ENGLISH only. Return ONLY JSON:
{"story":"","conflict":"","setting":"","status":"","characters":[{"id":"","look":""}],"facts":[""],"assumptions":[""],"style":"","scenes":[{"moment":"","characters":[""],"action":"","emotion":"","composition":"","lighting":""}]}`;

const CYR = /[А-Яа-яЁё]/;
const INDUSTRY = /\b(office|meeting|producer|producers|executive|boardroom|film set|on set|camera crew|clapperboard|storyboard|studio lot|conference)\b/i;
const key = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 70);

// Проверка плана: ровно N разных сцен, мир истории, английский язык. Возвращает список проблем
export function planProblems(o, n) {
  const problems = [];
  const scenes = Array.isArray(o?.scenes) ? o.scenes.filter(x => x && clean(x.moment, 10)) : [];
  if (scenes.length !== n) problems.push(`return exactly ${n} scenes, you returned ${scenes.length}`);
  const uniq = new Set(scenes.map(x => key(x.moment)));
  if (scenes.length && uniq.size < scenes.length) problems.push('every scene must be a different moment, some are repeated');
  if (scenes.some(x => INDUSTRY.test([x.moment, x.action, x.composition].join(' ')))) problems.push('show the story world only, not offices, meetings, producers or film sets');
  const looks = (Array.isArray(o?.characters) ? o.characters : []).map(c => String(c?.look || ''));
  if ([o?.style, ...looks, ...scenes.map(x => [x.moment, x.action, x.emotion, x.composition, x.lighting].join(' '))].some(t => CYR.test(String(t || '')))) problems.push('write character looks, style and scene fields in English');
  if ((Array.isArray(o?.characters) ? o.characters : []).some(c => /producer|director|writer|author|actor|executive|showrunner/i.test(String(c?.id || '') + ' ' + String(c?.look || '')))) problems.push('characters must be fictional story characters, not real crew or actors');
  return problems;
}

export const VISUAL_MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b'];

// d — черновик (slides, format, topic); source — статья/факты. Возвращает d с visual_brief, image_prompt(s)
export async function planVisuals(d, { source = '', avoid = [], json = groqJSON } = {}) {
  const slides = (d.slides || []).map((s, i) => ({ n: i + 1, title: s.title, text: s.subtitle || '' }));
  const n = Math.max(1, slides.length);
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify({
      N: n, format: d.format === 'reel' ? 'Reels cover 9:16' : n > 1 ? 'carousel 4:5' : 'single feed image 4:5',
      topic: d.topic || '', slides, SOURCE: String(source || '').slice(0, 2500),
      ...(avoid.length ? { previous_prompts_to_avoid: avoid.slice(0, 10).map(x => String(x).slice(0, 200)), note: 'Choose DIFFERENT moments than the previous prompts' } : {}),
    }) },
  ];
  let o = null, problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    o = await json(messages, { maxTokens: 4000, temperature: avoid.length ? 0.8 : 0.5, models: VISUAL_MODELS, timeoutMs: 25000 });
    problems = planProblems(o, n);
    if (!problems.length) break;
    messages.push({ role: 'assistant', content: JSON.stringify(o).slice(0, 6000) }, { role: 'user', content: 'Fix and return the full JSON again: ' + problems.join('; ') });
  }
  const scenes = (Array.isArray(o?.scenes) ? o.scenes : []).filter(x => x && clean(x.moment, 10)).slice(0, n).map(x => ({
    moment: clean(x.moment, 300), characters: list(x.characters, 3, 60), action: clean(x.action, 180),
    emotion: clean(x.emotion, 120), composition: clean(x.composition, 180), lighting: clean(x.lighting, 140),
  }));
  // не годится: меньше N разных сцен — лучше старый способ, чем шесть одинаковых картинок
  if (scenes.length < n || new Set(scenes.map(x => key(x.moment))).size < n) throw new Error('visual plan: ' + (problems.join('; ') || 'not enough scenes'));
  const plan = {
    story: clean(o.story, 300), conflict: clean(o.conflict, 300), setting: clean(o.setting, 200),
    status: projectStatus(`${d.topic || ''} ${source}`, String(o.status || '')),
    characters: (Array.isArray(o.characters) ? o.characters : []).filter(c => c && clean(c.id, 1) && clean(c.look, 1)).slice(0, 3).map(c => ({ id: clean(c.id, 40), look: clean(c.look, 180) })),
    facts: list(o.facts, 6, 200), assumptions: list(o.assumptions, 6, 200), style: clean(o.style, 220),
  };
  const prompts = scenes.map(s => composePrompt(s, plan, d));
  d.visual_brief = { ...plan, moments: scenes.map(s => s.moment) };
  d.image_prompt = prompts[0];
  d.image_prompts = n > 1 ? prompts : [];
  return d;
}

// Короткая шапка над промптами в боте: что показываем и почему
export function briefHeader(d) {
  const b = d.visual_brief;
  if (!b) return '';
  const mode = b.status === 'in_development' ? '🧪 Проект ещё не снят: картинки как редакционный концепт, не «кадры»' : '';
  return [
    b.story && `🎯 Сюжет: ${b.story}`,
    b.conflict && `⚔️ Конфликт: ${b.conflict}`,
    b.setting && `📍 Место: ${b.setting}`,
    mode,
    b.assumptions?.length ? `🎨 Допущения художника: ${b.assumptions.slice(0, 3).join('; ')}` : '',
  ].filter(Boolean).join('\n');
}
