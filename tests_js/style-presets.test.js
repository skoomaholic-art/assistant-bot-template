import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRESETS, validateRequest, sanitizeOutput } from '../api/ai-draft.js';

globalThis.window={};
await import('../cover-studio/style-presets.js');
const visuals=globalThis.window.SkoomaStyles;

test('six strict background packs and image-generation prompts',()=>{
  assert.equal(Object.keys(visuals.styles).length,6);
  for(const id of ['noir','projector','frame','grain','blue','reel']){
    const p=visuals.get(id);
    assert.equal(p.id,id);
    assert.match(p.bgColor,/^#[0-9a-f]{6}$/i);
    assert.match(visuals.prompt(id,'reel','критический разбор'),/9:16/);
    assert.match(visuals.prompt(id,'portrait','критический разбор'),/4:5/);
    assert.match(visuals.prompt(id),/no watermarks/i);
  }
  assert.match(visuals.prompt('blue'),/dark cold-blue/i);
  assert.match(visuals.prompt('frame'),/no text/i);
});

test('AI validates style and returns explicit visual_style in drafts',()=>{
  assert.equal(validateRequest({presetId:'series_analysis',styleId:'blue',topic:'Как сериалы меняют зрительские привычки'}).styleId,'blue');
  assert.equal(validateRequest({presetId:'cinema_opinion',topic:'Кино и наше восприятие'}).styleId,'noir');
  assert.throws(()=>validateRequest({presetId:'cinema_opinion',styleId:'pastel_vaporwave',topic:'Кино и наше восприятие'}));
  const data={cover:{title:'Не каждый фильм работает',subtitle:'Оценка не решает'},
    slides:[],caption:'Поговорим о субъективном восприятии кино',video_script:'Знакомая история может работать совершенно по-разному',verification_notes:[]};
  const result=sanitizeOutput(data,PRESETS.cinema_opinion,'Увлекательное кино','projector');
  assert.equal(result.visual_style,'projector');
  assert.equal(result.rights_cleared,false);
  assert.equal(result.owner_approved,false);
});

test('editor loads visual style library before AI panel and renders procedural backgrounds',()=>{
  const html=readFileSync(new URL('../cover-studio/index.html',import.meta.url),'utf8');
  const ai=readFileSync(new URL('../cover-studio/ai.js',import.meta.url),'utf8');
  assert.ok(html.indexOf('style-presets.js')<html.indexOf('ai.js'));
  assert.match(html,/s\.bgMode==='vignette'/);
  assert.match(html,/s\.bgMode==='beam'/);
  assert.match(html,/s\.bgMode==='grain'/);
  assert.match(html,/applyVisualStyle\(/);
  assert.match(ai,/editor\.loadGenerated\(pages\)/);
  assert.match(ai,/Копировать промпт фона/);
  assert.match(ai,/styleId:\$\('aiVisualStyle'\)\.value/);
});
