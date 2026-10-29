import test from 'node:test';
import assert from 'node:assert/strict';
import { planVisuals, projectStatus, composePrompt, briefHeader } from '../api/_visual.js';
import { splitMessage, promptMessage, createPost, generateDraft } from '../api/_pipeline.js';

const fakePlan = (n, status = 'in_development') => async (msgs) => {
  const user = JSON.parse(msgs[1].content);
  assert.equal(user.N, n);
  assert.match(msgs[0].content, /STEP 1/);
  return {
    story: 'Детектив ищет пропавшую сестру в маленьком городе', conflict: 'Она подозревает собственную семью', setting: 'Северная Каролина, наши дни', status,
    characters: [{ id: 'the detective', look: 'woman in her late 30s, short dark hair, worn olive field jacket, scar above left eyebrow' }],
    facts: ['Amazon MGM разрабатывает сериал'], assumptions: ['внешность героини придумана'], style: 'muted teal and amber grade, 35mm anamorphic, fine grain',
    scenes: Array.from({ length: n }, (_, i) => ({ moment: `moment ${i + 1}: the detective finds a muddy child's shoe by a lake`, characters: ['the detective'], action: 'kneels and lifts the shoe', emotion: 'controlled dread', composition: 'low-angle medium shot, subject lower right, empty sky above', lighting: 'overcast dusk, cold rim light' })),
  };
};

test('status: projects in development become editorial concepts', () => {
  assert.equal(projectStatus('Amazon MGM разрабатывает сериал по триллеру', 'unknown'), 'in_development');
  assert.equal(projectStatus('Netflix set to star X in adaptation', ''), 'in_development');
  assert.equal(projectStatus('Вышел трейлер сериала', 'released'), 'released');
  assert.equal(projectStatus('почему мы пересматриваем любимые фильмы', 'evergreen'), 'evergreen');
});

test('carousel: analysis first, then a concrete scene per slide with locked characters and tech limits', async () => {
  const d = { format: 'portrait', topic: 'Amazon MGM разрабатывает сериал по триллеру Melinda Leigh', slides: [{ title: 'А', subtitle: '1' }, { title: 'Б', subtitle: '2' }, { title: 'В', subtitle: '3' }] };
  await planVisuals(d, { source: 'Amazon MGM разрабатывает сериал', json: fakePlan(3) });
  assert.equal(d.image_prompts.length, 3);
  for (const p of d.image_prompts) {
    assert.match(p, /^editorial concept art/);
    assert.match(p, /not a film still/);
    assert.match(p, /scar above left eyebrow/);           // персонаж закреплён
    assert.match(p, /series style: muted teal/);           // единый стиль
    assert.match(p, /no text, no letters, no numbers/);    // тех. ограничения
    assert.match(p, /upper third calm/);
    assert.match(p, /--ar 4:5$/);
  }
  assert.match(d.image_prompts[1], /moment 2/);
  assert.equal(d.visual_brief.status, 'in_development');
  assert.match(briefHeader(d), /Конфликт: Она подозревает/);
  assert.match(briefHeader(d), /редакционный концепт/);
});

test('reel and released titles: scene mode and 9:16', async () => {
  const d = { format: 'reel', topic: 'Вышел трейлер', slides: [{ title: 'А', subtitle: '' }] };
  await planVisuals(d, { json: fakePlan(1, 'released') });
  assert.match(d.image_prompt, /^cinematic editorial photograph/);
  assert.match(d.image_prompt, /--ar 9:16$/);
  assert.deepEqual(d.image_prompts, []);
});

test('long prompt lists are split into several Telegram messages without breaking blocks', async () => {
  const f = { state: { posts: [], next_id: 1 } };
  const slides = Array.from({ length: 7 }, (_, i) => ({ title: 'T' + i, subtitle: 's' }));
  const d = { format: 'portrait', topic: 'x разрабатывает', slides };
  await planVisuals(d, { json: fakePlan(7) });
  const post = createPost(f.state, { draft: { ...d, caption: 'c' }, source: { kind: 'auto' } }, '42');
  assert.equal(post.draft.image_prompts.length, 7);
  assert.ok(post.draft.visual_brief.story);
  const parts = splitMessage(promptMessage(post));
  assert.ok(parts.length >= 2);
  for (const p of parts) { assert.ok(p.length <= 3900); assert.equal((p.match(/<pre>/g) || []).length, (p.match(/<\/pre>/g) || []).length); }
});

test('generateDraft falls back to old prompts when the visual plan fails', async () => {
  const gen = async () => ({ format: 'portrait', slides: [{ title: 'a', subtitle: '' }], caption: 'c', image_prompt: 'old prompt' });
  const out = await generateDraft({ presetId: 'cinema_post', topic: 't', facts: '' }, gen, { rules: [] }, { planVisuals: async () => { throw new Error('groq down'); } });
  assert.equal(out.image_prompt, 'old prompt');
  const ok = await generateDraft({ presetId: 'cinema_post', topic: 't', facts: 'src' }, gen, { rules: [] }, { planVisuals: async (d, o) => { assert.equal(o.source, 'src'); d.image_prompt = 'new'; return d; } });
  assert.equal(ok.image_prompt, 'new');
});

test('composePrompt drops empty parts', () => {
  const p = composePrompt({ moment: 'a man waits at a bus stop' }, { status: 'unknown', characters: [] }, { format: 'portrait' });
  assert.ok(!/undefined|null/.test(p));
});

import { planProblems } from '../api/_visual.js';
test('bad plans are sent back: duplicates, industry scenes, real crew, Russian looks; then fall back', async () => {
  const bad = { style: 'x', characters: [{ id: 'martin', look: 'рыжий продюсер' }], scenes: Array.from({ length: 3 }, () => ({ moment: 'Martin Gero meets producers in a modern office' })) };
  const p = planProblems(bad, 3);
  assert.ok(p.some(x => /different moment/.test(x)));
  assert.ok(p.some(x => /story world/.test(x)));
  assert.ok(p.some(x => /English/.test(x)));
  let calls = 0;
  const d = { format: 'portrait', topic: 't', slides: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] };
  const good = await fakePlan(3)([{ content: 'STEP 1' }, { content: JSON.stringify({ N: 3 }) }]);
  await planVisuals(d, { json: async (msgs, opt) => { calls++; assert.ok(opt.models.includes('openai/gpt-oss-120b')); if (calls === 1) return bad; assert.match(msgs.at(-1).content, /Fix and return/); return good; } });
  assert.equal(calls, 2);
  assert.equal(new Set(d.image_prompts).size, 3);
  await assert.rejects(planVisuals({ ...d }, { json: async () => bad }), /visual plan/);
});
test('characters named in a scene keep their look even if not listed', () => {
  const p = composePrompt({ moment: 'Shadow watches Daisy from a rooftop', characters: ['shadow'] }, { status: 'released', characters: [{ id: 'daisy', look: 'red flag pin' }, { id: 'shadow', look: 'scar across left cheek' }] }, { format: 'portrait' });
  assert.match(p, /red flag pin/); assert.match(p, /scar across left cheek/);
});
