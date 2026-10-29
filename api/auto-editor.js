// Ежедневный запуск ИИ-редактора (Vercel Cron). Защищён CRON_SECRET: Vercel сам шлёт Authorization: Bearer <CRON_SECRET>.
import crypto from 'node:crypto';
import { runEditor } from './_editor.js';

const same = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };

export default async function handler(req, res) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!secret || !same(req.headers.authorization, 'Bearer ' + secret)) { res.statusCode = 401; return res.end('{"ok":false}'); }
  const host = String(process.env.WEBAPP_HOST || req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  try {
    const r = await runEditor({ host, limit: 1 }); // по одному посту за вызов: укладываемся в 60 с; остальные — по расписанию IGM
    res.statusCode = 200; res.end(JSON.stringify({ ok: true, ...r }));
  } catch (err) {
    console.error('auto-editor', err?.message);
    res.statusCode = 200; res.end(JSON.stringify({ ok: false, error: err?.message || 'error' }));
  }
}
