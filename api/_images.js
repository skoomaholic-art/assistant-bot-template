// Поиск изображений по названию тайтла или имени актёра: TMDB (+ fanart.tv для фильмов/сериалов).
// Ключи на Vercel: TMDB_API_KEY (v3 key или v4 Read Access Token), FANART_API_KEY (необязателен).
// Права на кадры и постеры у правообладателей: в посте нужна отметка о проверке прав и указание источника.
import { ReviewError } from './_lib.js';

const env = n => String(process.env[n] || '').trim();
export const IMG_HOSTS = /^https:\/\/(image\.tmdb\.org|assets\.fanart\.tv)\//;
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';

async function tmdb(path, params = {}, fetchImpl = fetch) {
  const key = env('TMDB_API_KEY');
  if (!key) throw new ReviewError('На Vercel не задан TMDB_API_KEY — поиск кадров недоступен', 503);
  const bearer = key.length > 60; // v4 Read Access Token
  const qs = new URLSearchParams({ ...params, ...(bearer ? {} : { api_key: key }) });
  const r = await fetchImpl(`${TMDB}${path}?${qs}`, { headers: { Accept: 'application/json', ...(bearer ? { Authorization: 'Bearer ' + key } : {}) } }).catch(() => null);
  if (!r) throw new ReviewError('TMDB недоступен', 502);
  if (r.status === 401) throw new ReviewError('TMDB отклонил ключ — проверь TMDB_API_KEY', 502);
  if (!r.ok) throw new ReviewError('TMDB ответил ошибкой ' + r.status, 502);
  return r.json();
}

// Найти тайтлы и людей по строке
export async function searchTitles(q, fetchImpl = fetch) {
  const query = String(q || '').trim().slice(0, 100);
  if (query.length < 2) throw new ReviewError('Введи название или имя');
  const data = await tmdb('/search/multi', { query, language: 'ru-RU', include_adult: 'false' }, fetchImpl);
  return (data.results || []).filter(x => ['movie', 'tv', 'person'].includes(x.media_type)).slice(0, 12).map(x => ({
    type: x.media_type, id: x.id,
    title: x.title || x.name || '', original: x.original_title || x.original_name || '',
    year: String(x.release_date || x.first_air_date || '').slice(0, 4) || null,
    thumb: x.poster_path ? IMG + 'w185' + x.poster_path : x.profile_path ? IMG + 'w185' + x.profile_path : null,
    known_for: x.media_type === 'person' ? (x.known_for || []).map(k => k.title || k.name).filter(Boolean).slice(0, 3).join(', ') : null,
  }));
}

const pic = (p, kind, source, w, h) => ({ kind, source, thumb: IMG + 'w342' + p, url: IMG + (kind === 'poster' || kind === 'profile' ? 'w780' : 'w1280') + p, width: w || null, height: h || null });

// Все изображения одного тайтла или человека
export async function listImages(type, id, fetchImpl = fetch) {
  if (!['movie', 'tv', 'person'].includes(type) || !/^\d{1,9}$/.test(String(id))) throw new ReviewError('Неверный тайтл');
  const out = [];
  if (type === 'person') {
    const d = await tmdb(`/person/${id}/images`, {}, fetchImpl);
    for (const x of (d.profiles || []).slice(0, 30)) out.push(pic(x.file_path, 'profile', 'TMDB', x.width, x.height));
  } else {
    const d = await tmdb(`/${type}/${id}/images`, { include_image_language: 'null,ru,en' }, fetchImpl);
    for (const x of (d.backdrops || []).slice(0, 40)) out.push(pic(x.file_path, 'backdrop', 'TMDB', x.width, x.height));
    for (const x of (d.posters || []).slice(0, 20)) out.push(pic(x.file_path, 'poster', 'TMDB', x.width, x.height));
    const fanartKey = env('FANART_API_KEY');
    if (fanartKey) {
      let fid = id;
      if (type === 'tv') fid = (await tmdb(`/tv/${id}/external_ids`, {}, fetchImpl).catch(() => ({}))).tvdb_id;
      if (fid) {
        const r = await fetchImpl(`https://webservice.fanart.tv/v3/${type === 'tv' ? 'tv' : 'movies'}/${fid}?api_key=${encodeURIComponent(fanartKey)}`).catch(() => null);
        if (r?.ok) {
          const f = await r.json().catch(() => ({}));
          const add = (arr, kind) => (arr || []).slice(0, 12).forEach(x => x?.url && IMG_HOSTS.test(x.url) && out.push({ kind, source: 'fanart.tv', thumb: x.url.replace('/fanart/', '/preview/'), url: x.url }));
          add(f.moviebackground || f.showbackground, 'backdrop');
          add(f.moviethumb || f.tvthumb, 'backdrop');
          add(f.movieposter || f.tvposter, 'poster');
        }
      }
    }
  }
  return out;
}

export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
export async function fetchImage(url, fetchImpl = fetch) {
  if (!IMG_HOSTS.test(String(url))) throw new ReviewError('Изображение не с разрешённого источника', 400);
  // redirect:'error' — разрешённый хост не может увести на чужой адрес; размер проверяем до чтения тела
  const r = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!r?.ok) throw new ReviewError('Не удалось скачать изображение', 502);
  const type = r.headers?.get?.('content-type') || 'image/jpeg';
  if (!/^image\/(jpeg|png)/.test(type)) throw new ReviewError('Это не картинка', 400);
  const declared = Number(r.headers?.get?.('content-length') || 0);
  if (declared > MAX_IMAGE_BYTES) throw new ReviewError('Картинка слишком большая', 413);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new ReviewError('Картинка слишком большая', 413);
  return { buf, type };
}
