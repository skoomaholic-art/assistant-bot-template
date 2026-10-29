// GET /api/media?p=media/posts/P0001/1.jpg&e=<unix>&s=<sig> — временная публичная ссылка на готовую картинку/видео поста.
// Нужна Instagram (забирает медиа по HTTPS) и Telegram (превью финала). Без верной подписи — 403.
import { igmRepo } from './_lib.js';
import { verifyMedia } from './_pipeline.js';

export default async function handler(req, res) {
  const q = new URL(req.url, 'https://x').searchParams;
  const path = q.get('p') || '', exp = q.get('e') || '', sig = q.get('s') || '';
  if (!verifyMedia(path, exp, sig)) { res.statusCode = 403; return res.end('forbidden'); }
  const token = String(process.env.IGM_BRIDGE_TOKEN || '').trim();
  const r = await fetch(`https://api.github.com/repos/${igmRepo()}/contents/${path}`, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'mybrand-media' },
  }).catch(() => null);
  if (!r || !r.ok) { res.statusCode = 404; return res.end('not found'); }
  const buf = Buffer.from(await r.arrayBuffer());
  res.statusCode = 200;
  res.setHeader('Content-Type', path.endsWith('.mp4') ? 'video/mp4' : path.endsWith('.png') ? 'image/png' : 'image/jpeg');
  res.setHeader('Content-Length', String(buf.length));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.end(buf);
}
