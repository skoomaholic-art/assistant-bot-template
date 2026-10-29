import test from 'node:test';
import assert from 'node:assert/strict';
import { checkGemini, factcheckPost, factcheckMessage, fingerprint, needsFactcheck } from '../api/_gemini-factcheck.js';
import { createPost, emptyState, replaceDraft, act, textCard, textButtons } from '../api/_pipeline.js';
import { handleUpdate } from '../api/bot.js';

const draft=(caption='HBO официально объявил премьеру в 2027 году')=>({
  format:'portrait',slides:[{title:'Новый сериал',subtitle:'Премьера 2027'}],caption
});
function fakePipe(){
  const state=emptyState();
  return {state,pipe:async mutate=>mutate(state)};
}
function newPost(f){
  return createPost(f.state,{draft:draft(),source:{kind:'news',topic:'Премьера',link:'https://example.org/news'}},'42');
}
const grounded={
  candidates:[{content:{parts:[{text:'Утверждение о премьере требует сверки с официальным анонсом.'}]},
    groundingMetadata:{webSearchQueries:['HBO 2027 premiere announcement'],
      groundingChunks:[{web:{title:'HBO pressroom',uri:'https://www.hbo.com/press/news'}},
        {web:{title:'HBO pressroom duplicate',uri:'https://www.hbo.com/press/news'}}]}}],
};
test('Gemini request uses Google Search and no Groq or Instagram endpoint',async()=>{
  const f=fakePipe(),post=newPost(f);
  let requests=[];
  const checked=await checkGemini(post,{key:'test-key',fetchImpl:async(url,opts)=>{
    requests.push({url,headers:opts.headers,body:JSON.parse(opts.body)});
    return {ok:true,json:async()=>grounded};
  }});
  assert.equal(requests.length,1);
  assert.match(requests[0].url,/gemini-2\.5-flash:generateContent/);
  assert.deepEqual(requests[0].body.tools,[{google_search:{}}]);
  assert.equal(requests[0].headers['x-goog-api-key'],'test-key');
  assert.equal(checked.kind,'grounded_review');
  assert.equal(checked.sources.length,1);
  assert.match(factcheckMessage(post.id,checked),/https:\/\/www.hbo.com/);
  assert.doesNotMatch(requests[0].url,/groq|instagram/i);
});
test('ungrounded model opinion never gets labelled verified',async()=>{
  const p=newPost(fakePipe());
  const r=await checkGemini(p,{key:'test-key',fetchImpl:async()=>({
    ok:true,json:async()=>({candidates:[{content:{parts:[{text:'Факт достоверен'}]}}]})
  })});
  assert.equal(r.kind,'unverified');
  assert.equal(r.sources.length,0);
  assert.match(factcheckMessage(p.id,r),/Ссылок на источники нет/i);
});
test('no claims means Gemini does not perform a web call',async()=>{
  const p=createPost(emptyState(),{draft:{format:'portrait',slides:[{title:'Моё мнение'}],caption:'Кино меня тронуло'},source:{}},'42');
  let calls=0;
  assert.equal(needsFactcheck(p),false);
  const r=await checkGemini(p,{key:'test',fetchImpl:async()=>{calls++}});
  assert.equal(r.kind,'no_claims');
  assert.equal(calls,0);
});
test('factcheck reuses cached report on unchanged draft, preserving approvals',async()=>{
  const f=fakePipe(),p=newPost(f);
  let calls=0;
  const checker=async()=>{calls++;return {kind:'grounded_review',report:'Нужно проверить',sources:[],checked_at_utc:new Date().toISOString()};};
  await factcheckPost(p.id,{pipe:f.pipe,checker,actor:'42'});
  const before=JSON.stringify(p.approvals);
  await factcheckPost(p.id,{pipe:f.pipe,checker,actor:'42'});
  assert.equal(calls,1);
  assert.equal(p.status,'text_review');
  assert.equal(JSON.stringify(p.approvals),before);
  assert.equal(p.factcheck.fingerprint,fingerprint(p));
  replaceDraft(p,{draft:draft('Другой сериал выйдет в 2028 году')},'42');
  assert.equal(p.factcheck,undefined);
});
test('Gemini availability failure does not fall back to Groq or change post',async()=>{
  const f=fakePipe(),p=newPost(f),before=JSON.stringify(p);
  await assert.rejects(factcheckPost(p.id,{pipe:f.pipe,checker:async()=>{throw new Error('offline')}}),/offline/);
  assert.equal(JSON.stringify(p),before);
});
test('existing approvals are unchanged after manual factcheck',async()=>{
  const f=fakePipe(),p=newPost(f);
  act(p,'approve_text','42');
  p.status='final_review';
  p.media={images:['media/posts/P0001/1.jpg']};
  const before=JSON.stringify(p.approvals);
  await factcheckPost(p.id,{pipe:f.pipe,checker:async()=>({
    kind:'unverified',report:'Сверь самостоятельно',sources:[],checked_at_utc:new Date().toISOString()
  })});
  assert.equal(JSON.stringify(p.approvals),before);
  assert.equal(p.status,'final_review');
});
test('Telegram callback checks facts only for owner and sends source links',async()=>{
  const f=fakePipe(),p=newPost(f);
  const make=id=>({callback_query:{id:'cb1',from:{id},message:{chat:{id,type:'private'}},data:`fc:${p.id}`}});
  let calls=0;
  const deps={pipe:f.pipe,factcheckChecker:async()=>{calls++;return {kind:'grounded_review',report:'Сверено',checked_at_utc:new Date().toISOString(),sources:[{title:'Studio',url:'https://studio.example.org'}]}}};
  const bad=await handleUpdate(make(43),{owner:'42',host:'example.org',deps});
  assert.equal(bad.length,0);
  const good=await handleUpdate(make(42),{owner:'42',host:'example.org',deps});
  assert.equal(calls,1);
  assert.ok(good.some(x=>x.type==='send'&&x.text.includes('https://studio.example.org')));
  assert.match(textButtons(p,'example.org').flat().map(x=>x.callback_data).join(','),/fc:P0001/);
});
test('preflight warning is advisory and factual checks are never an approval gate',()=>{
  const f=fakePipe(),p=newPost(f);
  assert.match(textCard(p),/Предпубликационная проверка/);
  act(p,'approve_text','42');
  assert.equal(p.status,'rendering');
});
