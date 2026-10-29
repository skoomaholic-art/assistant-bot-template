// Конвейер постов из Instagram Manager и конструктора (только владелец, вход по initData).
//  { action:'list' }                                         → последние посты со статусами
//  { action:'get', id }                                      → пост целиком (для конструктора)
//  { action:'create', presetId, styleId?, topic, facts?, voice?, link? } → ИИ пишет текст → карточка на согласование в бот
//  { action:'submit', id?, draft, pages? }                   → текст из конструктора на согласование (новый или правка)
//  { action:'approve_text'|'approve_final'|'redo'|'retry'|'reject', id }
//  { action:'regen', id, feedback? }                         → ИИ переписывает текст
//  { action:'set_bg', id, slide, url, source, title, rights:true } → кадр/постер из TMDB или fanart.tv на слайд
//  { action:'clear_bg', id, slide }                            → убрать картинку со слайда
import { authorize, readBody, reply, fail, ReviewError } from './_lib.js';
import { draftDigest, learn, textChanged } from './_learning.js';
import { cleanVisual, mediaUrl } from './_pipeline.js';
import { applySuggestedImages, attachImageBackground, attachStudioBackground, clearBackground } from './_own.js';
import { factcheckPost, factcheckMessage } from './_gemini-factcheck.js';
import { fetchImage } from './_images.js';
import { storyTokens } from './_news.js';

// Дубли: та же новость или та же тема у живых постов. Более поздний помечается «похоже на …»
export function findDuplicates(posts) {
  const live = posts.filter(p => p.status !== 'rejected');
  const sig = p => {
    const t = storyTokens([p.source?.topic, p.draft?.topic, p.draft?.slides?.[0]?.title].filter(Boolean).join(' '));
    for (const x of p.draft?.tags?.titles || []) t.add('q:' + String(x).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
    return t;
  };
  const sigs = live.map(p => ({ p, t: sig(p) }));
  const out = {};
  sigs.forEach((a, i) => {
    for (let j = 0; j < i; j++) {
      const b = sigs[j];
      const sameLink = a.p.source?.link && a.p.source.link === b.p.source?.link;
      let score = 0;
      for (const w of a.t) if (b.t.has(w)) score += w.startsWith('q:') ? 2 : 1;
      if (sameLink || score >= 3) { out[a.p.id] = { id: b.p.id, status: b.p.status, reason: sameLink ? 'та же новость' : 'та же тема' }; }
    }
  });
  return out;
}

const safeLearn = async signal => { try { await learn(signal); } catch (err) { console.error('learn', err?.message); } };
import { act, copyToDraft, createPost, findPost, generateDraft, POST_ID, presetFor, regenerate, replaceDraft, sendTextCard, setArchiveMarker, summary, tgCall, withPipe } from './_pipeline.js';

const host = req => String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();

export default async function handler(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
  try {
    const body = readBody(req);
    const user = authorize(body.initData);
    const by = String(user.id), h = host(req);
    const action = String(body.action || 'list');
    if (body.id != null && !POST_ID.test(String(body.id))) throw new ReviewError('Неверный ID поста');

    if (action === 'list') {
      const r = await withPipe(s => ({ posts: s.posts.slice(-150) }));
      const dups = findDuplicates(r.posts);
      const KIND = { manual: '👤 сделал сам', auto: '🤖 ИИ-редактор', news: '📰 из новостей', bot: '💬 тема из бота', app: '📱 из Instagram Manager', studio: '🎨 конструктор', own: '📷 свой контент', own_text: '✍️ свой текст' };
      const posts = [...r.posts].reverse().map(p => {
        const thumbPath = p.media?.images?.[0] || p.bgs?.[0] || p.bg?.path || null;
        return { ...summary(p), created_at_utc: p.created_at_utc || null, kind_label: KIND[p.source?.kind] || '', slides: (p.draft?.slides || []).length,
          thumb: thumbPath ? mediaUrl(h, thumbPath, 6 * 3600) : null, dup_of: dups[p.id] || null };
      });
      return reply(res, 200, { ok: true, posts });
    }
    if (action === 'factcheck') {
      const check = await factcheckPost(body.id,{actor:by});
      const message = factcheckMessage(body.id,check);
      // Read-only notification, never a publish, and no Groq calls.
      try { await tgCall('sendMessage',{chat_id:Number(by),text:message,
        disable_web_page_preview:true}); } catch(e) { console.error('factcheck-telegram',e?.message); }
      return reply(res,200,{ok:true,kind:check.kind,report:check.report,
        sources:check.sources,checked_at_utc:check.checked_at_utc});
    }
    if (action === 'journal') {
      // Вкладка «История»: что происходило с постами (создан, согласован, собран, опубликован, отклонён)
      const r = await withPipe(s => ({ posts: s.posts }));
      const counts = {};
      for (const p of r.posts) counts[p.status] = (counts[p.status] || 0) + 1;
      const events = r.posts.flatMap(p => (p.history || []).map(h => ({ at: h.at, id: p.id, event: h.event, by: h.by === 'auto-editor' ? 'ИИ-редактор' : h.by ? 'ты' : '', note: String(h.note || '').slice(0, 140),
        title: p.draft?.slides?.[0]?.title || '', status: p.status, permalink: p.ig?.permalink || null })))
        .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 120);
      return reply(res, 200, { ok: true, counts, events });
    }
    if (action === 'get') {
      const r = await withPipe(s => ({ post: findPost(s, body.id) }));
      const bgs = { ...(r.post.bg?.path ? { 0: r.post.bg.path } : {}), ...(r.post.bgs || {}) };
      const bg_urls = Object.fromEntries(Object.entries(bgs).filter(([, p]) => p).map(([i, p]) => [i, mediaUrl(h, p, 3600)]));
      return reply(res, 200, { ok: true, post: r.post, bg_urls });
    }
    if (action === 'mark_archived' || action === 'mark_restored') {
      const archived = action === 'mark_archived';
      const r = await withPipe(s => {
        const post = findPost(s, body.id);
        const wasArchived = Boolean(post.ig_archived_at_utc);
        setArchiveMarker(post, archived, by);
        return { post, message: wasArchived === archived ? undefined :
          `pipeline: ${archived ? 'archive' : 'unarchive'} ${post.id}` };
      });
      return reply(res, 200, { ok: true, post: summary(r.post) });
    }
    if (action === 'copy_post') {
      const r = await withPipe(s => {
        const original = findPost(s, body.id);
        const post = copyToDraft(s, original, by);
        return { post, message: `pipeline: copy ${original.id} to ${post.id}` };
      });
      // No AI generation and no auto-approval. User edits the new draft.
      return reply(res, 200, { ok: true, post: summary(r.post) });
    }
    if (action === 'set_bg') {
      if (body.rights !== true) throw new ReviewError('Отметь, что права на изображение проверены');
      const image = await fetchImage(String(body.url || ''));
      const r = await attachImageBackground(body.id, Number(body.slide) || 1, image, { source: body.source, title: body.title, url: body.url }, by);
      if (r.rerender) await tgCall('sendMessage', { chat_id: Number(by), text: `🎬 ${body.id}: кадр на слайд ${r.slide}. Пересобираю финал — пришлю через ~2 минуты.` });
      return reply(res, 200, { ok: true, slide: r.slide, total: r.total, rerender: r.rerender, post: summary(r.post) });
    }
    if (action === 'set_bg_data') {
      if (body.rights !== true) throw new ReviewError('Подтверди права на изображение');
      const r = await attachStudioBackground(body.id, Number(body.slide), body.data, by);
      return reply(res, 200, { ok: true, slide: r.slide, total: r.total, rerender: r.rerender, post: summary(r.post) });
    }
    if (action === 'clear_bg') {
      const r = await clearBackground(body.id, Number(body.slide) || 1, by);
      return reply(res, 200, { ok: true, post: summary(r.post) });
    }
    if (action === 'create') {
      const topic = String(body.topic || '').trim().slice(0, 220);
      const sched = cleanSchedule(body.scheduled_at); // проверяем до генерации, чтобы не тратить ИИ зря
      const presetId = body.presetId || presetFor(['carousel', 'reel'].includes(body.kind) ? body.kind : 'post', topic);
      body.presetId = presetId;
      const draft = await generateDraft({ presetId, styleId: body.styleId, topic, facts: body.facts, voice: body.voice });
      const r = await withPipe(s => {
        const post = createPost(s, { draft, source: { kind: body.link ? 'news' : 'app', topic: body.topic, facts: body.facts, preset_id: body.presetId, style_id: body.styleId, voice: body.voice, link: body.link } }, by);
        if (sched) post.scheduled_at = sched;
        if (['post', 'carousel', 'reel'].includes(body.recommended)) post.source.recommended = body.recommended;
        return { post, message: `pipeline: new ${post.id}` };
      });
      if (['post', 'carousel', 'reel'].includes(body.recommended)) await safeLearn({ type: 'format_choice', post: r.post.id, recommended: body.recommended, chosen: ['carousel', 'reel'].includes(body.kind) ? body.kind : 'post' });
      await sendTextCard(r.post, h);
      return reply(res, 200, { ok: true, post: summary(r.post) });
    }
    if (action === 'submit') {
      let before = null;
      const r = await withPipe(s => {
        if (body.id) before = JSON.parse(JSON.stringify(findPost(s, body.id).draft));
        const post = body.id ? replaceDraft(findPost(s, body.id), { draft: body.draft, pages: body.pages ?? null }, by, 'конструктор')
          : createPost(s, { draft: body.draft, pages: body.pages ?? null, source: { kind: body.origin === 'manual' ? 'manual' : 'studio', topic: body.draft?.topic } }, by);
        if (body.defer_notify === true) post.studio_sync = 1; // new preview-preserving image sync
        return { post, message: `pipeline: text from studio ${post.id}` };
      });
      // пост, собранный владельцем вручную: эталон стиля для ИИ
      if (!body.id && body.origin === 'manual') await safeLearn({ type: 'owner_post', post: r.post.id, after: draftDigest(r.post.draft), format: r.post.draft.format });
      if (before && textChanged(before, r.post.draft)) await safeLearn({ type: 'text_edit', post: r.post.id, before: draftDigest(before), after: draftDigest(r.post.draft) });
      const vd = cleanVisual(body.visual_diff);
      if (vd) await safeLearn({ type: 'visual_edit', post: r.post.id, format: r.post.draft.format, diff: vd });
      if (body.approve === true) {
        const a = await withPipe(s => ({ post: act(findPost(s, r.post.id), 'approve_text', by), message: `pipeline: approve_text ${r.post.id}` }));
        if (a.post.learn_stat) await safeLearn({ type: 'stat', key: a.post.learn_stat, post: a.post.id });
        await tgCall('sendMessage', { chat_id: Number(by), text: `🎨 Пост ${a.post.id}: текст из конструктора согласован, собираю. Финал пришлю через ~2 минуты.` });
        return reply(res, 200, { ok: true, post: summary(a.post) });
      }
      if (body.defer_notify !== true) await sendTextCard(r.post, h);
      return reply(res, 200, { ok: true, post: summary(r.post) });
    }
    if (action === 'notify_text') {
      const r = await withPipe(s => ({ post: findPost(s, body.id) }));
      if (r.post.status !== 'text_review') throw new ReviewError('Пост уже не ожидает согласования текста', 409);
      await sendTextCard(r.post, h);
      return reply(res, 200, { ok: true, post: summary(r.post) });
    }
    if (action === 'regen') {
      const current = await withPipe(s => ({ post: findPost(s, body.id) }));
      const draft = await regenerate(current.post, String(body.feedback || '').slice(0, 600));
      const r = await withPipe(s => ({ post: replaceDraft(findPost(s, body.id), { draft, pages: null }, by, body.feedback || 'другой вариант'), message: `pipeline: regen ${body.id}` }));
      if (body.feedback) await safeLearn({ type: 'text_feedback', post: body.id, feedback: String(body.feedback).slice(0, 600), before: draftDigest(current.post.draft) });
      await sendTextCard(r.post, h);
      return reply(res, 200, { ok: true, post: summary(r.post) });
    }
    if (action === 'apply_images') {
      const r = await applySuggestedImages(body.id, by);
      if (r.rerender) await tgCall('sendMessage', { chat_id: Number(by), text: `🎬 ${body.id}: кадры поставлены, пересобираю финал` });
      return reply(res, 200, { ok: true, ...r });
    }
    if (action === 'schedule') {
      const r = await withPipe(s => ({ post: setSchedule(findPost(s, body.id), body.at ?? null, by), message: `pipeline: schedule ${body.id}` }));
      return reply(res, 200, { ok: true, post: summary(r.post) });
    }
    if (action === 'handoff') {
      const r = await withPipe(s => ({ post: act(findPost(s, body.id), 'handoff', by), message: `pipeline: handoff ${body.id}` }));
      const files = r.post.draft?.format === 'reel' && r.post.media?.video ? [r.post.media.video] : (r.post.media?.images || []);
      await tgCall('sendMessage', { chat_id: Number(by), text: `📥 ${r.post.id}: файлы в полном качестве и подпись. Выложи сам из Instagram (можно с музыкой или в черновик)` });
      for (const f of files) await tgCall('sendDocument', { chat_id: Number(by), document: mediaUrl(h, f, 7 * 24 * 3600) });
      if (r.post.draft?.caption) await tgCall('sendMessage', { chat_id: Number(by), text: r.post.draft.caption });
      return reply(res, 200, { ok: true, post: summary(r.post) });
    }
    if (['approve_text', 'approve_final', 'redo', 'retry', 'reject', 'publish_now'].includes(action)) {
      const r = await withPipe(s => ({ post: act(findPost(s, body.id), action, by), message: `pipeline: ${action} ${body.id}` }));
      if (r.post.learn_stat && ['approve_text', 'approve_final'].includes(action)) await safeLearn({ type: 'stat', key: r.post.learn_stat, post: r.post.id });
      if (r.post.status === 'text_review') await sendTextCard(r.post, h);
      if (action === 'approve_text') await tgCall('sendMessage', { chat_id: Number(by), text: `🎨 Пост ${r.post.id}: текст согласован, собираю в конструкторе. Финал пришлю через ~2 минуты.` });
      if (action === 'approve_final' || action === 'publish_now') await tgCall('sendMessage', { chat_id: Number(by), text: r.post.status === 'scheduled' ? `🕒 Пост ${r.post.id}: опубликую ${almatyTime(r.post.scheduled_at)} по Алматы. Ссылку пришлю` : `📤 Пост ${r.post.id}: публикую в Instagram. Ссылку пришлю, когда выйдет.` });
      return reply(res, 200, { ok: true, post: summary(r.post) });
    }
    throw new ReviewError('Неизвестное действие');
  } catch (err) { fail(res, err); }
}
