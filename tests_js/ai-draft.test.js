import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, validateRequest, sanitizeOutput, generateAI } from '../api/ai-draft.js';

const slides=(count)=>Array.from({length:count},(_,i)=>({title:'Тезис '+(i+1),subtitle:'Содержательное пояснение '+(i+1)}));
const response=(data,ok=true,status=200)=>({ok,status,json:async()=>({choices:[{message:{content:JSON.stringify(data)}}]})});
const sample=(n=5)=>({cover:{title:'Почему мы смотрим кино снова',subtitle:'Не только из-за ностальгии'},slides:slides(n),caption:'Разберём, почему знакомые истории работают иначе при повторном просмотре.',video_script:'Мы помним финал, но обращаем внимание на другие детали.',verification_notes:['Не заявлять конкретных фактов без источников.']});

test('eight editorial preset types (posts, carousels, Reels) and short constrained inputs',()=>{
  assert.equal(Object.keys(PRESETS).length,8);
  assert.equal(PRESETS.cinema_post.format,'portrait'); assert.equal(PRESETS.cinema_post.slides,1);
  for(const id of Object.keys(PRESETS)){
    const x=validateRequest({presetId:id,topic:'Кино без спойлеров'});
    assert.equal(x.presetId,id);
  }
  assert.throws(()=>validateRequest({presetId:'wrong',topic:'Кино'}));
  assert.throws(()=>validateRequest({presetId:'cinema_opinion',topic:'no'}));
});

test('carousel takes 2+ body slides; output blocked from auto publishing',()=>{
  const p=PRESETS.cinema_carousel;
  const result=sanitizeOutput(sample(5),p,'Что смотреть');
  assert.equal(result.slides.length,6);
  assert.equal(result.format,'portrait');
  assert.equal(result.owner_approved,false);
  assert.equal(result.rights_cleared,false);
  assert.equal(result.status,'draft');
  assert.equal(result.needs_fact_check,true);
  assert.equal(sanitizeOutput(sample(4),p,'Что смотреть').slides.length,5);
  assert.throws(()=>sanitizeOutput(sample(1),p,'Что смотреть'));
});

test('Reels have one cover; voice-over script is optional',()=>{
  const result=sanitizeOutput({...sample(0),slides:[]},PRESETS.series_analysis,'Сериалы');
  assert.equal(result.slides.length,1);
  assert.equal(result.format,'reel');
  assert.ok(result.video_script);
  assert.equal(sanitizeOutput({...sample(0),video_script:''},PRESETS.series_analysis,'Сериалы').video_script,'');
});

test('AI generator refuses missing key and handles free-tier rate limiting',async()=>{
  await assert.rejects(generateAI({presetId:'cinema_carousel',topic:'Почему мы любим кино'},{key:''}),e=>e.code===503);
  await assert.rejects(generateAI({presetId:'cinema_carousel',topic:'Почему мы любим кино'},{
    key:'test',fetchImpl:async()=>({ok:false,status:429})
  }),e=>e.code===429);
});

test('uses verified free-tier model and produces review-only structured draft',async()=>{
  let args;
  const result=await generateAI({presetId:'cinema_carousel',topic:'Почему зрители любят детали'},{
    key:'test',fetchImpl:async(url,opts)=>{args={url,opts};return response(sample(5));}
  });
  assert.equal(args.url,'https://api.groq.com/openai/v1/chat/completions');
  const body=JSON.parse(args.opts.body);
  assert.equal(body.model,'openai/gpt-oss-20b');
  assert.equal(body.response_format.type,'json_object');
  assert.equal(result.slides.length,6);
  assert.equal(result.source,'groq-draft');
});

import { humanize } from '../api/ai-draft.js';
test('owner style: no long dashes, no final period, ellipsis kept',()=>{
  assert.equal(humanize('Это кино — про семью.\n\nВторой абзац.'),'Это кино - про семью\n\nВторой абзац');
  assert.equal(humanize('Ну и что...'),'Ну и что...');
  assert.equal(humanize('Сезон 2–3 вышел.'),'Сезон 2 - 3 вышел');
  assert.ok(!/[—–]/.test(humanize('а — б – в')));
});

test('Reels drafts are multi-scene with a music mood', () => {
  const scenes = [1, 2, 3, 4].map(i => ({ title: 'Сцена ' + i, subtitle: 'текст ' + i }));
  const r = sanitizeOutput({ ...sample(0), slides: scenes, music_mood: 'EPIC' }, PRESETS.cinema_opinion, 'Кино');
  assert.equal(r.slides.length, 5);
  assert.equal(r.music_mood, 'epic');
  assert.equal(sanitizeOutput({ ...sample(0), slides: [] }, PRESETS.cinema_opinion, 'Кино').music_mood, 'calm');
});
