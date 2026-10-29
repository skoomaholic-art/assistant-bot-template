import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { attachStudioBackground } from '../api/_own.js';
import { createPost, emptyState } from '../api/_pipeline.js';

await import('../cover-studio/image-sync.js');
const imageSync = globalThis.SkoomaImageSync;
const img = suffix => `data:image/jpeg;base64,${suffix}`;

function fakePipe() {
  const state=emptyState();
  const pipe=async mutate => mutate(state);
  return { state, pipe };
}
function newPost(f) {
  return createPost(f.state,{draft:{format:'portrait',slides:[{title:'1'},{title:'2'},{title:'3'}],caption:'Проверка'},source:{kind:'studio'}},'42');
}
function jpeg() {
  const buf=Buffer.alloc(512,0x11);
  buf[0]=0xff;buf[1]=0xd8;buf[2]=0xff;
  return 'data:image/jpeg;base64,'+buf.toString('base64');
}

test('unsaved preview backgrounds are not silently dropped',()=>{
  const saved=new Map(), refs=new Map(), a=img('abc'), b=img('def');
  const actions=imageSync.plan([{bgImage:a},{bgImage:b},{bgImage:null}],saved,refs);
  assert.deepEqual(actions.map(a=>({type:a.type,index:a.index})),[
    {type:'upload',index:0},{type:'upload',index:1}
  ]);
  const html=readFileSync(new URL('../cover-studio/index.html',import.meta.url),'utf8');
  const ai=readFileSync(new URL('../cover-studio/ai.js',import.meta.url),'utf8');
  assert.ok(html.indexOf('/cover-studio/image-sync.js') < html.indexOf('/cover-studio/ai.js'));
  assert.match(ai,/defer_notify:true/);
  assert.match(ai,/await images\.sync\(/);
  assert.ok(ai.indexOf('await images.sync(') < ai.indexOf("action:approve?'approve_text':'notify_text'"));
  assert.match(ai,/window\.__skoomaPostId=data\.post\.id/);
});

test('existing saved backgrounds are never uploaded again unchanged',()=>{
  const a=img('abc'), b=img('def');
  const saved=new Map([[0,a],[1,b]]);
  assert.deepEqual(imageSync.plan([{bgImage:a},{bgImage:b}],saved,new Map()),[]);
});

test('new externally sourced picture uses the existing checked-URL upload',async()=>{
  const a=img('abc');
  const saved=new Map(),selected=new Map([[0,{image:a,url:'https://image.tmdb.org/t/p/w1280/test.jpg',source:'TMDB',title:'Movie'}]]);
  let requests=[];
  await imageSync.sync({postId:'P0013',slides:[{bgImage:a}],saved,selected,
    call:async x=>{requests.push(x);return {ok:true};},confirmRights:true});
  assert.equal(requests.length,1);
  assert.equal(requests[0].action,'set_bg');
  assert.equal(requests[0].slide,1);
  assert.equal(requests[0].rights,true);
  assert.equal(saved.get(0),a);
});

test('manual pictures are compressed and attached per slide before approval',async()=>{
  const previousImage=globalThis.Image,previousDocument=globalThis.document;
  const encoded=jpeg();
  globalThis.Image=class {naturalWidth=800;naturalHeight=600;set src(value){this.onload?.();}};
  globalThis.document={createElement:()=>({getContext:()=>({fillRect(){},drawImage(){}}),toDataURL:()=>encoded})};
  try {
    const saved=new Map(),calls=[];
    await imageSync.sync({postId:'P0013',slides:[{bgImage:img('fromLocal')}],saved,selected:new Map(),
      call:async x=>{calls.push(x);return {ok:true};},confirmRights:true});
    assert.equal(calls[0].action,'set_bg_data');
    assert.equal(calls[0].data,encoded);
    assert.equal(calls[0].slide,1);
    assert.ok(saved.has(0));
  } finally {globalThis.Image=previousImage;globalThis.document=previousDocument;}
});

test('partial upload failure never marks the missing image saved',async()=>{
  const saved=new Map(),selected=new Map();
  const a=img('first'),b=img('second');
  selected.set(0,{image:a,url:'https://image.tmdb.org/t/p/w1280/one.jpg',source:'TMDB'});
  selected.set(1,{image:b,url:'https://assets.fanart.tv/test.png',source:'fanart.tv'});
  await assert.rejects(imageSync.sync({postId:'P0005',slides:[{bgImage:a},{bgImage:b}],saved,selected,
    call:async x=>{if(x.slide===2)throw Error('network offline');},confirmRights:true}),/network offline/);
  assert.equal(saved.get(0),a);
  assert.equal(saved.has(1),false);
});

test('TMDB/fanart image without rights is rejected before any server call; own pictures need no checkbox',async()=>{
  let count=0;
  const x=img('x');
  await assert.rejects(imageSync.sync({postId:'P0002',slides:[{bgImage:x}],
    saved:new Map(),selected:new Map([[0,{image:x,url:'https://image.tmdb.org/t/p/w1280/a.jpg',source:'TMDB'}]]),call:async()=>{count++},confirmRights:false}),/прав/);
  assert.equal(count,0);
  assert.equal(imageSync.plan([{bgImage:img('own')}],new Map(),new Map())[0].source,null);
});

test('image removed in editor is cleared in IGM, without re-sending other images',async()=>{
  const a=img('keep'),b=img('removed'),saved=new Map([[0,a],[1,b]]);
  const calls=[];
  await imageSync.sync({postId:'P0003',slides:[{bgImage:a},{bgImage:null}],saved,selected:new Map(),
    call:async payload=>calls.push(payload),confirmRights:false});
  assert.deepEqual(calls,[{action:'clear_bg',id:'P0003',slide:2}]);
  assert.equal(saved.has(1),false);
});

test('stored JPG payload accepted and committed before slot assignment',async()=>{
  const f=fakePipe(),post=newPost(f),writes=[];
  const r=await attachStudioBackground(post.id,2,jpeg(),'42',{pipe:f.pipe,putBinary:async(path,buf,msg)=>{writes.push({path,buf,msg});}});
  assert.equal(r.slide,2);
  assert.equal(r.post.bgs[1],writes[0].path);
  assert.match(writes[0].path,/^media\/posts\/P0001\/bg-studio-[a-f0-9]{16}\.jpg$/);
  assert.equal(writes[0].buf[0],0xff);
  assert.equal(r.post.status,'text_review');
  assert.deepEqual(r.post.approvals,{});
});

test('malformed and oversized data are rejected without writing anything',async()=>{
  const f=fakePipe(),post=newPost(f);
  let writes=0;
  const deps={pipe:f.pipe,putBinary:async()=>{writes++}};
  for(const bad of ['data:image/svg+xml;base64,PHN2Zz4=','data:image/jpeg;base64,YWJj','wrong',
    'data:image/jpeg;base64,'+'a'.repeat(2_800_100)]) {
    await assert.rejects(attachStudioBackground(post.id,1,bad,'42',deps));
  }
  assert.equal(writes,0);
});

test('uploading images after final review resets final approval and asks for new rendering',async()=>{
  const f=fakePipe(),post=newPost(f);
  post.status='final_review';post.approvals={text:{by:'42',at:'now'},final:{by:'42',at:'now'}};
  const r=await attachStudioBackground(post.id,1,jpeg(),'42',{pipe:f.pipe,putBinary:async()=>{}});
  assert.equal(r.rerender,true);
  assert.equal(r.post.status,'rendering');
  assert.equal(r.post.approvals.final,undefined);
});

test('existing final_review previews stage every photo before changing post status', () => {
  const js=readFileSync(new URL('../cover-studio/ai.js',import.meta.url),'utf8');
  const block=js.slice(js.indexOf('async function applyImage('),js.indexOf("if(new URLSearchParams(location.search).get('images')"));
  assert.match(block,/selectedImages\.set\(slideNo-1/);
  assert.doesNotMatch(block,/pipeCall\(\{action:'set_bg'/);
  const send=js.slice(js.indexOf('async function submit(approve)'),js.indexOf("$('pipeSend').onclick"));
  assert.ok(send.indexOf('await images.sync(') < send.indexOf("action:approve?'approve_text':'notify_text'"));
});
