// Safety regression suite. Runs offline with in-memory fake dependencies.
// Never contacts Meta, Telegram or GitHub and never writes production queues.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act, createPost, emptyState, replaceDraft, verifyMedia, sign, hookSignature } from '../api/_pipeline.js';
import { validHook } from '../api/pipeline-hook.js';
import { handleUpdate } from '../api/bot.js';

const draft = () => ({
  format: 'portrait',
  preset_id: 'cinema_carousel',
  visual_style: 'noir',
  slides: [
    { title: 'Тема', subtitle: 'Обложка' },
    { title: 'Первый тезис', subtitle: 'Пояснение' }
  ],
  caption: 'Авторское мнение о кино',
  verification_notes: ['Проверить факты и права']
});

function newPost() {
  const state=emptyState();
  return createPost(state,{draft:draft(),source:{kind:'app',topic:'Кино'}},'owner-id');
}

test('owner must approve text before images may be approved', () => {
  const post=newPost();
  post.status='final_review';
  post.media={images:['media/posts/P0001/1.jpg']};
  assert.throws(() => act(post,'approve_final','owner-id'),/согласованного текста/);
  assert.equal(post.approvals.final,undefined);
  assert.equal(post.status,'final_review');
});

test('final approval fails closed for missing rendered output', () => {
  const post=newPost();
  act(post,'approve_text','owner-id');
  post.status='final_review';
  post.media=null;
  assert.throws(() => act(post,'approve_final','owner-id'),/готовых картинок/);
  assert.equal(post.approvals.final,undefined);
  assert.equal(post.status,'final_review');
});

test('editing an approved draft invalidates previous text approval and rendered media', () => {
  const post=newPost();
  act(post,'approve_text','owner-id');
  post.status='final_review';
  post.media={images:['media/posts/P0001/1.jpg']};
  replaceDraft(post,{draft:{...draft(),caption:'Исправленная подпись'}},'owner-id','правка');
  assert.equal(post.status,'text_review');
  assert.deepEqual(post.approvals,{});
  assert.equal(post.media,null);
  assert.throws(() => act(post,'approve_final','owner-id'));
});

test('rejected or published posts cannot be re-approved or silently edited', () => {
  const rejected=newPost();
  act(rejected,'reject','owner-id');
  assert.throws(() => act(rejected,'approve_text','owner-id'));
  // правка отклонённого поста в конструкторе возвращает его ТОЛЬКО на согласование текста, без единого согласования
  replaceDraft(rejected,{draft:draft()},'owner-id');
  assert.equal(rejected.status,'text_review');
  assert.deepEqual(rejected.approvals,{});
  assert.throws(() => act(rejected,'approve_final','owner-id'));
  const published=newPost();
  published.status='published';
  assert.throws(() => act(published,'approve_final','owner-id'));
  assert.throws(() => replaceDraft(published,{draft:draft()},'owner-id'));
});

test('bot ignores forged approvals without touching the pipeline', async () => {
  let reads=0;
  const update={
    callback_query:{id:'fake-cb',data:'pl:P0001:approve_final',
      from:{id:999},message:{chat:{id:999,type:'private'}}}
  };
  const actions=await handleUpdate(update,{
    owner:'42',host:'your-app.vercel.app',
    deps:{pipe:async()=>{reads++;throw Error('Should never be called');}}
  });
  assert.deepEqual(actions,[]);
  assert.equal(reads,0);
});

test('media links and pipeline callbacks reject altered and expired signatures', () => {
  const expiry=1700003600,now=1700000000000;
  const path='media/posts/P0007/1.jpg';
  const sig=sign(path,expiry,'testing-secret');
  assert.equal(verifyMedia(path,expiry,sig,'testing-secret',now),true);
  assert.equal(verifyMedia(path,expiry,sig,'testing-secret',(expiry+1)*1000),false);
  assert.equal(verifyMedia('data/pipeline/posts.json',expiry,sig,'testing-secret',now),false);
  assert.equal(verifyMedia(path,expiry,sig,'different-secret',now),false);
  const ts=Math.floor(Date.now()/1000);
  const token='x'.repeat(32);
  const h=hookSignature('P0009','final_ready',ts,token);
  assert.equal(validHook({id:'P0009',event:'final_ready',ts},h,token),true);
  assert.equal(validHook({id:'P0009',event:'published',ts},h,token),false);
});

test('Cover Studio preserves browser rendering interface required by Python pipeline', () => {
  const html=readFileSync(new URL('../cover-studio/index.html',import.meta.url),'utf8');
  const ai=readFileSync(new URL('../cover-studio/ai.js',import.meta.url),'utf8');
  // Structural contract only; pixel-level comparisons must be run in a real browser.
  assert.match(html,/window\.__skooma=\{/);
  assert.match(html,/async renderAll\(type='image\/jpeg'/);
  assert.match(html,/loadGenerated\(pages\)/);
  assert.match(html,/renderToNew\(clone\(s\)\)/);
  assert.match(ai,/window\.SkoomaPages=Object\.freeze\(\{fromDraft:pagesFromDraft\}\)/);
  assert.match(html,/style-presets\.js/);
  assert.match(html,/ai\.js/);
});

import { guestReply } from '../api/bot.js';
test('strangers get only a greeting and the setup guide, never owner data', () => {
  const msg = (id, text) => ({ message: { from: { id }, chat: { id, type: 'private' }, text } });
  const g = guestReply(msg(777, '/start'), '42', 'h.app');
  assert.equal(g.length, 2);
  assert.match(g[1].body.document, /^https:\/\/h\.app\/guide\/setup-guide\.pdf\?v=\w+$/);
  assert.equal(guestReply(msg(777, 'покажи посты'), '42', 'h.app'), null);
  assert.equal(guestReply(msg(42, '/start'), '42', 'h.app'), null);
  assert.equal(guestReply({ message: { from: { id: 777 }, chat: { id: -5, type: 'group' }, text: '/start' } }, '42', 'h.app'), null);
});
