import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emptyState, createPost, setArchiveMarker, copyToDraft, act, summary, replaceDraft } from '../api/_pipeline.js';

const draft = () => ({
  format:'portrait',slides:[{title:'Обложка',subtitle:'Оригинал'},{title:'Слайд 2',subtitle:'Текст'}],
  caption:'Оригинальная подпись', visual_style:'blue', visual_prefs:{ titleY:45 },
});
function makePublished(state, kind='studio') {
  const post=createPost(state,{draft:draft(),pages:[{title:'1'},{title:'2'}],source:{kind,topic:'Кино'}},'42');
  post.status='published';
  post.ig={media_id:'17900000000001',permalink:'https://www.instagram.com/p/real/'};
  post.approvals={text:{by:'42'},final:{by:'42'}};
  post.media={images:[`media/posts/${post.id}/1.jpg`]};
  post.bgs={0:`media/posts/${post.id}/bg-original.jpg`};
  post.bg={path:post.bgs[0]};
  post.image_sources=[{slide:1,source:'TMDB'}];
  post.history.push({event:'published',by:'pipeline'});
  return post;
}
test('mark archived does not change published status, Instagram ID, approvals or history',()=>{
  const s=emptyState(),p=makePublished(s);
  const before={status:p.status,ig:JSON.stringify(p.ig),approvals:JSON.stringify(p.approvals),media:JSON.stringify(p.media)};
  setArchiveMarker(p,true,'42');
  assert.equal(p.status,before.status);
  assert.equal(JSON.stringify(p.ig),before.ig);
  assert.equal(JSON.stringify(p.approvals),before.approvals);
  assert.equal(JSON.stringify(p.media),before.media);
  assert.ok(p.ig_archived_at_utc);
  assert.equal(summary(p).status_label,'📦 Архивировано');
  assert.equal(summary(p).archived,true);
  assert.throws(()=>act(p,'approve_final','42'));
  const once=p.history.length;
  setArchiveMarker(p,true,'42');
  assert.equal(p.history.length,once,'idempotent archive marker');
  setArchiveMarker(p,false,'42');
  assert.equal(p.status,'published');
  assert.equal(summary(p).status_label,'✅ опубликован');
});
test('manual archive never affects drafts and does not contact Instagram',()=>{
  const s=emptyState(),p=createPost(s,{draft:draft(),source:{kind:'studio'}},'42');
  assert.throws(()=>setArchiveMarker(p,true,'42'),/только ранее опубликованный/);
  p.status='rejected';
  assert.throws(()=>setArchiveMarker(p,true,'42'));
});
test('copying published or archived original creates an editable new draft with separate identity',()=>{
  const s=emptyState(),p=makePublished(s);
  setArchiveMarker(p,true,'42');
  const before=JSON.stringify(p);
  const q=copyToDraft(s,p,'42');
  assert.equal(JSON.stringify(p),before);
  assert.equal(s.posts.length,2);
  assert.equal(q.id,'P0002');
  assert.equal(q.copied_from,'P0001');
  assert.equal(q.status,'text_review');
  assert.equal(q.ig,null);
  assert.equal(q.media,null);
  assert.deepEqual(q.approvals,{});
  assert.deepEqual(q.pages,p.pages);
  assert.deepEqual(q.bgs,p.bgs);
  assert.equal(q.ig_archived_at_utc,undefined);
  q.draft.caption='Новая подпись';
  q.pages[0].title='Изменено';
  assert.equal(p.draft.caption,'Оригинальная подпись');
  assert.equal(p.pages[0].title,'1');
  act(q,'approve_text','42');
  assert.equal(q.status,'rendering');
  assert.equal(p.status,'published');
});
test('clone of an own-image post retains original media but requires fresh approvals',()=>{
  const s=emptyState(),p=makePublished(s,'own');
  p.own={files:['media/posts/P0001/src-1.jpg'],kind:'photo'};
  const q=copyToDraft(s,p,'42');
  assert.equal(q.source.kind,'own');
  assert.deepEqual(q.own.files,p.own.files);
  assert.deepEqual(q.approvals,{});
  act(q,'approve_text','42');
  assert.equal(q.status,'rendering');
  assert.equal(p.status,'published');
});
test('copying active or incomplete own media is prevented',()=>{
  const s=emptyState(),p=createPost(s,{draft:draft(),source:{kind:'studio'}},'42');
  assert.throws(()=>copyToDraft(s,p,'42'),/опубликованный|отклонённый/);
  p.status='published';p.source.kind='own';
  assert.throws(()=>copyToDraft(s,p,'42'),/исходные файлы/);
});
test('IGM dashboard contains manual archive, filter, copy and fresh edit routing',()=>{
  const ui=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const api=readFileSync(new URL('../api/pipeline.js',import.meta.url),'utf8');
  assert.match(ui,/\['arch', '📦 Архив'/);
  assert.match(ui,/\['copy_post', '⧉ Копия'\]/);
  assert.match(ui,/data-pa="\$\{a\}"/);
  assert.match(ui,/mark_archived/);
  assert.match(ui,/mark_restored/);
  assert.match(ui,/location\.href = '\/cover-studio\/\?post='/);
  assert.match(api,/action === 'copy_post'/);
  assert.match(api,/action === 'mark_archived'/);
  assert.match(api,/action === 'mark_restored'/);
});
