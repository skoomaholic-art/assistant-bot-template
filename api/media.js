// GET /api/media?p=media/posts/P0001/1.jpg&e=<unix>&s=<sig> — временная публичная ссылка на готовую картинку/видео поста.
// Нужна Instagram (забирает медиа по HTTPS) и Telegram (превью финала). Без верной подписи — 403.
// Vercel отдаёт из функции не больше 4,5 МБ, поэтому видео и большие файлы не проксируем, а отвечаем
// 302 на временную ссылку GitHub (download_url приватного репозитория живёт несколько минут, с токеном внутри).
import { igmRepo } from './_lib.js';
import { verifyMedia } from './_pipeline.js';

export const INLINE_MAX = 4 * 1024 * 1024;
const typeOf = path => (path.endsWith('.mp4') ? 'video/mp4' : path.endsWith('.png') ? 'image/png' : 'image/jpeg');
const headers = accept => ({
  Authorization: 'Bearer ' + String(process.env.IGM_BRIDGE_TOKEN || '').trim(), Accept: accept,
  'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mybrand-media',
});
const ALLOWED_REDIRECT = /^https:\/\/(raw\.githubusercontent\.com|media\.githubusercontent\.com|objects\.githubusercontent\.com)\//;

// Что ответить на проверенный путь: { redirect } | { body, type } | null (нет файла)
export async function resolveMedia(path, fetchImpl = fetch) {
  const api = `https://api.github.com/repos/${igmRepo()}/contents/${path}`;
  const r = await fetchImpl(api, { headers: headers('application/vnd.github+json') }).catch(() => null);
  if (!r || !r.ok) return null;
  const meta = await r.json().catch(() => null);
  if (!meta || Array.isArray(meta) || meta.type !== 'file') return null;
  const size = Number(meta.size) || 0;
  const big = path.endsWith('.mp4') || size > INLINE_MAX;
  if (big) return typeof meta.download_url === 'string' && ALLOWED_REDIRECT.test(meta.download_url) ? { redirect: meta.download_url } : null;
  // до 1 МБ GitHub кладёт файл прямо в ответ (base64); 1–4 МБ — забираем сырой файл
  if (meta.encoding === 'base64' && meta.content) return { body: Buffer.from(meta.content, 'base64'), type: typeOf(path) };
  const raw = await fetchImpl(api, { headers: headers('application/vnd.github.raw') }).catch(() => null);
  if (!raw || !raw.ok) return null;
  const body = Buffer.from(await raw.arrayBuffer());
  if (body.length > INLINE_MAX) return typeof meta.download_url === 'string' && ALLOWED_REDIRECT.test(meta.download_url) ? { redirect: meta.download_url } : null;
  return { body, type: typeOf(path) };
}

export default async function handler(req, res) {
  const q = new URL(req.url, 'https://x').searchParams;
  const path = q.get('p') || '', exp = q.get('e') || '', sig = q.get('s') || '';
  if (!verifyMedia(path, exp, sig)) { res.statusCode = 403; return res.end('forbidden'); }
  const out = await resolveMedia(path);
  if (!out) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('X-Robots-Tag', 'noindex');
  if (out.redirect) {
    // ссылка с токеном короткоживущая: не кэшировать
    res.statusCode = 302;
    res.setHeader('Location', out.redirect);
    res.setHeader('Cache-Control', 'no-store');
    return res.end();
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', out.type);
  res.setHeader('Content-Length', String(out.body.length));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(out.body);
}
