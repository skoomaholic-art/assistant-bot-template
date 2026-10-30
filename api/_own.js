// Свой контент владельца: фото/видео/альбом/текст в чат бота → пост в конвейере (без генерации картинок).
import { createHash } from 'node:crypto';
import { botToken, ghPutBinary, ReviewError, utcNow } from './_lib.js';
import { act, cleanTags, createPost, findPost, generateDraft, ownButtons, ownCard, POST_ID, presetFor, tgCall, withPipe } from './_pipeline.js';
import { capHashtags } from './_hashtags.js';

const MAX_BYTES = 20 * 1024 * 1024; // предел скачивания файлов Bot API

export function extractMedia(m) {
  if (!m) return null;
  if (Array.isArray(m.photo) && m.photo.length) {
    const p = [...m.photo].sort((a, b) => (b.file_size || b.width * b.height) - (a.file_size || a.width * a.height))[0];
    return { kind: 'photo', file_id: p.file_id, uid: p.file_unique_id, ext: 'jpg', size: p.file_size || 0 };
  }
  if (m.video) return { kind: 'video', file_id: m.video.file_id, uid: m.video.file_unique_id, ext: 'mp4', size: m.video.file_size || 0 };
  const d = m.document;
  if (d && /^image\/(jpeg|png|webp|heic)$/.test(d.mime_type || '')) return { kind: 'photo', file_id: d.file_id, uid: d.file_unique_id, ext: (d.mime_type.split('/')[1] || 'jpg').replace('jpeg', 'jpg'), size: d.file_size || 0 };
  if (d && /^video\/(mp4|quicktime)$/.test(d.mime_type || '')) return { kind: 'video', file_id: d.file_id, uid: d.file_unique_id, ext: d.mime_type.endsWith('mp4') ? 'mp4' : 'mov', size: d.file_size || 0 };
  return null;
}

export async function downloadFile(fileId, fetchImpl = fetch) {
  const info = await tgCall('getFile', { file_id: fileId });
  if (!info?.ok) throw new ReviewError('Telegram не отдал файл. Если он больше 20 МБ — сожми или пришли короче', 413);
  const r = await fetchImpl(`https://api.telegram.org/file/bot${botToken()}/${info.result.file_path}`);
  if (!r.ok) throw new ReviewError('Не удалось скачать файл из Telegram', 502);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new ReviewError('Файл больше 20 МБ', 413);
  return buf;
}

// Фото/видео: создать пост (или добавить в альбом) и загрузить файл в IGM
export async function addOwnMedia(message, owner, deps = {}) {
  const media = extractMedia(message);
  if (!media) return null;
  if (media.size > MAX_BYTES) throw new ReviewError('Файл больше 20 МБ: Telegram не даёт боту скачать его. Сожми видео или пришли короче', 413);
  const pipe = deps.pipe || withPipe;
  const group = message.media_group_id ? String(message.media_group_id) : null;
  const caption = String(message.caption || '').trim().slice(0, 2200);
  // «создан» берём из результата замыкания: при конфликте записи withPipe выполняет его заново на свежем
  // состоянии, и второе фото альбома уже найдёт пост, созданный первым (иначе каждое фото было бы «новым»)
  const first = await pipe(st => {
    let post = group ? st.posts.find(p => p.own?.media_group_id === group && p.status === 'text_review') : null;
    if (post) {
      if (media.kind === 'video' || post.draft.format === 'reel') throw new ReviewError('В альбоме для карусели могут быть только фото');
      if ((post.own.files || []).length >= 10) throw new ReviewError('В карусели максимум 10 фото');
      if (caption && !post.draft.caption) post.draft.caption = capHashtags(caption);
      return { post, created: false, message: caption ? `pipeline: own caption ${post.id}` : undefined };
    }
    post = createPost(st, { draft: { format: media.kind === 'video' ? 'reel' : 'portrait', slides: [{ title: 'Свой пост', subtitle: '' }], caption, tags: {} }, source: { kind: 'own', topic: caption.slice(0, 200) } }, owner);
    post.own = { media_group_id: group, files: [], kind: media.kind };
    return { post, created: true, message: `pipeline: own post ${post.id}` };
  });
  const created = first.created === true;
  const id = first.post.id;
  const buf = await (deps.download || downloadFile)(media.file_id);
  const path = `media/posts/${id}/src-${String(media.uid).replace(/[^A-Za-z0-9_-]/g, '')}.${media.ext}`;
  await (deps.putBinary || ghPutBinary)(path, buf, `pipeline: own file ${id}`);
  const r = await pipe(st => {
    const post = findPost(st, id);
    post.own ||= { files: [] };
    if (!post.own.files.includes(path)) post.own.files.push(path);
    post.own.order = { ...(post.own.order || {}), [path]: message.message_id || 0 };
    post.own.files.sort((a, b) => (post.own.order[a] || 0) - (post.own.order[b] || 0));
    post.updated_at_utc = utcNow();
    return { post, message: `pipeline: own file added ${id}` };
  });
  return { post: r.post, created };
}

export async function setCaption(id, text, owner, deps = {}) {
  const pipe = deps.pipe || withPipe;
  return pipe(st => {
    const post = findPost(st, id);
    if (!['text_review', 'final_review', 'failed'].includes(post.status)) throw new ReviewError('Подпись уже не изменить', 409);
    post.draft.caption = capHashtags(String(text).trim().slice(0, 2200));
    (post.history ||= []).push({ at: utcNow(), event: 'caption_updated', by: String(owner) });
    if (post.source?.kind !== 'own' && post.status === 'text_review') (post.history).push({ at: utcNow(), event: 'text_updated', by: String(owner) });
    return { post, message: `pipeline: caption ${id}` };
  });
}

// Подпись от ИИ для своего фото/видео: по описанию владельца (картинку модель не видит)
export async function aiCaption(about, gen) {
  const d = await (gen || generateDraft)({ presetId: presetFor('post', about), topic: about.slice(0, 220), owner_text: about });
  return { caption: d.caption, tags: cleanTags(d.tags) };
}

export { act, POST_ID, ownCard, ownButtons };


// Картинка от владельца на обложку поста ИИ (ответом на карточку текста или на промпт)
export async function attachBackground(id, message, owner, deps = {}) {
  const media = extractMedia(message);
  if (!media || media.kind !== 'photo') throw new ReviewError('Для обложки нужна картинка (фото), не видео');
  if (media.size > MAX_BYTES) throw new ReviewError('Картинка больше 20 МБ', 413);
  const asked = Number((String(message.caption || '').match(/\d{1,2}/) || [])[0]);
  return storeBackground(id, {
    asked, owner, deps,
    load: () => (deps.download || downloadFile)(media.file_id),
    path: `media/posts/${id}/bg-${String(media.uid).replace(/[^A-Za-z0-9_-]/g, '')}.${media.ext === 'png' ? 'png' : 'jpg'}`,
  });
}

// Кадр или постер из TMDB / fanart.tv на слайд (из конструктора). image = {buf, type}, meta = {source, title, url}
export async function attachImageBackground(id, slide, image, meta, owner, deps = {}) {
  const ext = /png/.test(image.type) ? 'png' : 'jpg';
  const hash = createHash('sha1').update(image.buf).digest('hex').slice(0, 12);
  return storeBackground(id, {
    asked: Number(slide), owner, deps, load: async () => image.buf,
    path: `media/posts/${id}/bg-db-${hash}.${ext}`,
    imageSource: { source: String(meta.source || 'TMDB').slice(0, 30), title: String(meta.title || '').slice(0, 120), url: String(meta.url || '').slice(0, 300) },
  });
}

// Local Cover Studio PNG/JPG/WebP preview data is compressed to JPG in the
// browser and uploaded through the authenticated Mini App API. Do not trust the
// claimed content type: check size and JPEG signature before writing to IGM.
export async function attachStudioBackground(id, slide, data, owner, deps = {}) {
  if (!Number.isInteger(Number(slide)) || Number(slide) < 1 || Number(slide) > 10) throw new ReviewError('Неверный номер слайда', 400);
  const uri = String(data || '');
  if (uri.length > 2_800_000) throw new ReviewError('Картинка слишком большая для отправки', 413);
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(uri);
  if (!m) throw new ReviewError('Ожидалась фотография JPG из конструктора', 400);
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 128 || buf.length > 2_100_000 ||
      buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
    throw new ReviewError('Неподдерживаемое или слишком большое изображение', 413);
  }
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 16);
  return storeBackground(id, {
    asked: Number(slide), owner, deps, load: async () => buf,
    path: `media/posts/${id}/bg-studio-${hash}.jpg`,
  });
}

async function storeBackground(id, { asked, owner, deps, load, path, imageSource = null }) {
  const pipe = deps.pipe || withPipe;
  const cur = await pipe(st => ({ post: findPost(st, id) }));
  if (cur.post.source?.kind === 'own') throw new ReviewError('Это твой пост с фото — картинку не нужно, просто собери финал');
  if (!['text_review', 'final_review', 'failed'].includes(cur.post.status)) throw new ReviewError('Пост уже публикуется — картинку не поменять', 409);
  const n = Math.max(1, (cur.post.draft.slides || []).length);
  if (asked && (asked < 1 || asked > n)) throw new ReviewError(`В посте ${n} слайд(ов): номер от 1 до ${n}`);
  const buf = await load();
  await (deps.putBinary || ghPutBinary)(path, buf, `pipeline: background ${id}`);
  return pipe(st => {
    const post = findPost(st, id);
    const bgs = { ...(post.bg?.path ? { 0: post.bg.path } : {}), ...(post.bgs || {}) };
    let index = asked ? asked - 1 : 0;
    if (!asked && n > 1) { index = 0; while (index < n - 1 && bgs[index] && bgs[index] !== path) index++; }
    if (!imageSource && Object.values(bgs).includes(path)) index = Number(Object.keys(bgs).find(k => bgs[k] === path));
    bgs[index] = path;
    post.bgs = bgs;
    post.bg = bgs[0] ? { path: bgs[0], at: utcNow() } : null;
    // источник картинки по слайдам: подпись «© правообладатели» и метка для лаборатории
    const sources = (post.image_sources || []).filter(x => x.slide !== index + 1);
    if (imageSource) sources.push({ slide: index + 1, ...imageSource, at: utcNow() });
    post.image_sources = sources.length ? sources : undefined;
    if (!sources.length) delete post.image_sources;
    let rerender = false;
    if (post.status === 'final_review' && post.approvals?.text?.by) { post.status = 'rendering'; post.approvals = { text: post.approvals.text }; rerender = true; }
    (post.history ||= []).push({ at: utcNow(), event: 'background_added', by: String(owner), note: `слайд ${index + 1}${imageSource ? ' · ' + imageSource.source : ''}` });
    return { post, rerender, slide: index + 1, total: n, filled: Object.keys(bgs).length, message: `pipeline: background ${id} slide ${index + 1}` };
  });
}

// Убрать картинку со слайда (вернуть строгий фон)
export async function clearBackground(id, slide, owner, deps = {}) {
  const pipe = deps.pipe || withPipe;
  return pipe(st => {
    const post = findPost(st, id);
    if (!['text_review', 'final_review', 'failed'].includes(post.status)) throw new ReviewError('Пост уже публикуется', 409);
    const index = Number(slide) - 1;
    const bgs = { ...(post.bg?.path ? { 0: post.bg.path } : {}), ...(post.bgs || {}) };
    delete bgs[index];
    post.bgs = bgs;
    post.bg = bgs[0] ? { path: bgs[0], at: utcNow() } : null;
    const sources = (post.image_sources || []).filter(x => x.slide !== index + 1);
    if (sources.length) post.image_sources = sources; else delete post.image_sources;
    (post.history ||= []).push({ at: utcNow(), event: 'background_removed', by: String(owner), note: `слайд ${index + 1}` });
    return { post, message: `pipeline: clear background ${id} slide ${index + 1}` };
  });
}

// «🎬 Взять кадры»: ставим предложенные кадры TMDB на слайды, где ещё нет картинки.
// Статус проверяем один раз, все файлы грузим, потом одна запись в posts.json и одна пересборка
export async function applySuggestedImages(id, owner, deps = {}) {
  const { pendingSuggestions } = await import('./_pipeline.js');
  const { fetchImage } = await import('./_images.js');
  const pipe = deps.pipe || withPipe;
  const cur = await pipe(st => ({ post: findPost(st, id) }));
  if (cur.post.source?.kind === 'own') throw new ReviewError('Это твой пост с фото: картинка не нужна, просто собери финал');
  if (!['text_review', 'final_review', 'failed'].includes(cur.post.status)) throw new ReviewError('Пост уже публикуется, картинку не поменять', 409);
  const n = Math.max(1, (cur.post.draft.slides || []).length);
  const list = pendingSuggestions(cur.post).filter(x => x.slide >= 1 && x.slide <= n);
  if (!list.length) throw new ReviewError('Кадры уже стоят или их нет');
  const put = deps.putBinary || ghPutBinary;
  const ready = [];
  for (const x of list) {
    try {
      const image = await (deps.fetchImage || fetchImage)(x.url);
      const ext = /png/.test(image.type) ? 'png' : 'jpg';
      const hash = createHash('sha1').update(image.buf).digest('hex').slice(0, 12);
      const path = `media/posts/${id}/bg-db-${hash}.${ext}`;
      await put(path, image.buf, `pipeline: background ${id}`);
      ready.push({ slide: x.slide, path, source: { source: String(x.source || 'TMDB').slice(0, 30), title: String(x.title || '').slice(0, 120), url: String(x.url || '').slice(0, 300) } });
    } catch (err) { console.error('suggested image', x.slide, err?.message); }
  }
  if (!ready.length) throw new ReviewError('Не удалось скачать кадры, попробуй позже', 502);
  const r = await pipe(st => {
    const post = findPost(st, id);
    if (!['text_review', 'final_review', 'failed'].includes(post.status)) throw new ReviewError('Пост уже публикуется, картинку не поменять', 409);
    const bgs = { ...(post.bg?.path ? { 0: post.bg.path } : {}), ...(post.bgs || {}) };
    let sources = post.image_sources || [];
    for (const x of ready) {
      bgs[x.slide - 1] = x.path;
      sources = [...sources.filter(y => y.slide !== x.slide), { slide: x.slide, ...x.source, at: utcNow() }];
    }
    post.bgs = bgs;
    post.bg = bgs[0] ? { path: bgs[0], at: utcNow() } : null;
    if (sources.length) post.image_sources = sources; else delete post.image_sources;
    let rerender = false;
    if (post.status === 'final_review' && post.approvals?.text?.by) { post.status = 'rendering'; post.approvals = { text: post.approvals.text }; rerender = true; }
    (post.history ||= []).push({ at: utcNow(), event: 'background_added', by: String(owner), note: `кадры на слайды ${ready.map(x => x.slide).join(', ')}` });
    return { post, rerender, message: `pipeline: suggested images ${id} slides ${ready.map(x => x.slide).join(',')}` };
  });
  return { slides: ready.map(x => x.slide), total: list.length, rerender: r.rerender, post: r.post };
}

// ---------- Музыка для Reels: трек в бот ----------
const MOODS = [['tense', /напряж|трев|тревож|tense|триллер/i], ['calm', /спок|тих|calm|мягк/i], ['epic', /эпич|мощн|epic|героич/i],
  ['sad', /груст|печал|sad|драм/i], ['upbeat', /весел|бодр|upbeat|драйв|лёгк|легк/i], ['mystery', /загад|мистик|mystery|тайн/i]];
export const moodOf = text => (MOODS.find(([, re]) => re.test(String(text || ''))) || [null])[0];
export function extractAudio(m) {
  const a = m?.audio || (m?.document && /^audio\/(mpeg|mp3|mp4|x-m4a|aac|ogg|wav|x-wav)$/.test(m.document.mime_type || '') ? m.document : null);
  if (!a) return null;
  return { file_id: a.file_id, uid: a.file_unique_id, size: a.file_size || 0, title: [a.performer, a.title].filter(Boolean).join(' — ') || a.file_name || 'трек', duration: a.duration || null,
    ext: /mp4|m4a|aac/.test(a.mime_type || '') ? 'm4a' : /ogg/.test(a.mime_type || '') ? 'ogg' : /wav/.test(a.mime_type || '') ? 'wav' : 'mp3' };
}
// Трек в библиотеку (без ответа на пост) или конкретному Reels (ответом на его карточку)
export async function addMusic(message, owner, { postId = null, deps = {} } = {}) {
  const { ghGetJson, ghPutJson } = await import('./_lib.js');
  const a = extractAudio(message);
  if (!a) throw new ReviewError('Это не аудиофайл');
  if (a.size > MAX_BYTES) throw new ReviewError('Трек больше 20 МБ', 413);
  if (postId) {
    // формат и статус проверяем до скачивания (до 20 МБ), чтобы не грузить файл зря
    const cur = await (deps.pipe || withPipe)(st => ({ post: findPost(st, postId) }));
    if (cur.post.draft?.format !== 'reel') throw new ReviewError('Музыка ставится только в Reels');
    if (['published', 'publishing', 'publishing_in_progress'].includes(cur.post.status)) throw new ReviewError('Reels уже публикуется', 409);
  }
  const buf = await (deps.download || downloadFile)(a.file_id);
  const path = `media/music/own-${String(a.uid).replace(/[^A-Za-z0-9_-]/g, '')}.${a.ext}`;
  await (deps.putBinary || ghPutBinary)(path, buf, 'music: track from owner');
  const mood = moodOf(message.caption) || null;
  const credit = (String(message.caption || '').match(/(?:автор|credit)\s*[:：]\s*(.+)/i) || [])[1]?.trim().slice(0, 160) || null;
  const track = { file: path, title: a.title.slice(0, 120), mood, credit, license: credit ? 'указано владельцем' : 'свой трек', source: 'telegram', enabled: true };
  if (postId) {
    const pipe = deps.pipe || withPipe;
    return pipe(st => {
      const post = findPost(st, postId);
      if (post.draft?.format !== 'reel') throw new ReviewError('Музыка ставится только в Reels');
      if (['published', 'publishing', 'publishing_in_progress'].includes(post.status)) throw new ReviewError('Reels уже публикуется', 409);
      post.music = track;
      let rerender = false;
      if (post.status === 'final_review' && post.approvals?.text?.by) { post.status = 'rendering'; post.approvals = { text: post.approvals.text }; rerender = true; }
      (post.history ||= []).push({ at: utcNow(), event: 'music_set', by: String(owner), note: track.title });
      return { post, rerender, track, message: `pipeline: music ${postId}` };
    });
  }
  const get = deps.get || ghGetJson, put = deps.put || ghPutJson;
  for (let attempt = 0; ; attempt++) {
    const { data, sha } = await get('content/music.json').catch(() => ({ data: null, sha: null }));
    const lib = data && Array.isArray(data.tracks) ? data : { schema_version: 1, tracks: [] };
    lib.tracks = [...lib.tracks.filter(t => t.file !== path), { ...track, mood: mood || 'calm' }];
    try { await put('content/music.json', lib, sha || undefined, 'music: owner track'); return { track: { ...track, mood: mood || 'calm' }, total: lib.tracks.length }; }
    catch (err) { if (!(err instanceof ReviewError && err.code === 409) || attempt >= 2) throw err; }
  }
}

// Видео владельца ответом на карточку Reels → сцена ролика (номер сцены в подписи или первая без клипа)
export async function attachClip(id, message, owner, deps = {}) {
  const media = extractMedia(message);
  if (!media || media.kind !== 'video') throw new ReviewError('Нужно видео');
  if (media.size > MAX_BYTES) throw new ReviewError('Видео больше 20 МБ: сожми или обрежь', 413);
  const pipe = deps.pipe || withPipe;
  const cur = await pipe(st => ({ post: findPost(st, id) }));
  if (cur.post.draft?.format !== 'reel') throw new ReviewError('Видео-сцены есть только в Reels');
  if (!['text_review', 'final_review', 'failed'].includes(cur.post.status)) throw new ReviewError('Reels уже публикуется', 409);
  const n = Math.max(1, (cur.post.draft.slides || []).length);
  const asked = Number((String(message.caption || '').match(/\d{1,2}/) || [])[0]);
  if (asked && (asked < 1 || asked > n)) throw new ReviewError(`В ролике ${n} сцен: номер от 1 до ${n}`);
  const buf = await (deps.download || downloadFile)(media.file_id);
  const path = `media/posts/${id}/clip-${String(media.uid).replace(/[^A-Za-z0-9_-]/g, '')}.${media.ext === 'mov' ? 'mov' : 'mp4'}`;
  await (deps.putBinary || ghPutBinary)(path, buf, `pipeline: clip ${id}`);
  return pipe(st => {
    const post = findPost(st, id);
    const clips = { ...(post.clips || {}) };
    let index = asked ? asked - 1 : 0;
    if (!asked) while (index < n - 1 && clips[index]) index++;
    clips[index] = path;
    post.clips = clips;
    let rerender = false;
    if (post.status === 'final_review' && post.approvals?.text?.by) { post.status = 'rendering'; post.approvals = { text: post.approvals.text }; rerender = true; }
    (post.history ||= []).push({ at: utcNow(), event: 'clip_added', by: String(owner), note: `сцена ${index + 1}` });
    return { post, rerender, scene: index + 1, total: n, filled: Object.keys(clips).length, message: `pipeline: clip ${id} scene ${index + 1}` };
  });
}
