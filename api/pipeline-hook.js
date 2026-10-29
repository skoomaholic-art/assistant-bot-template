// POST от workflow IGM pipeline.yml: { id, event: final_ready|published|failed, ts } + X-Pipeline-Signature.
// Присылает владельцу финал на согласование, ссылку на опубликованный пост или ошибку.
import crypto from 'node:crypto';
import { ghGetJson, ownerId, readBody } from './_lib.js';
import { runEditor } from './_editor.js';
import { planVisuals } from './_visual.js';
import { hookSignature, PIPE_PATH, pipelineSecret, POST_ID, promptMessage, sendFinal, sendPrompts, withPipe, sendStatus, tgCall } from './_pipeline.js';

const out = (res, code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(body); };

export function validHook({ id, event, ts }, sig, secret = pipelineSecret(), now = Date.now()) {
  if (!secret || !POST_ID.test(String(id)) || !['final_ready', 'published', 'failed', 'ping', 'prompts', 'editor', 'replan'].includes(event)) return false;
  if (!Number.isInteger(ts) || Math.abs(now / 1000 - ts) > 600) return false;
  const a = Buffer.from(hookSignature(id, event, ts, secret)), b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return out(res, 405, 'POST only');
  const body = readBody(req);
  if (!validHook(body, req.headers['x-pipeline-signature'])) return out(res, 401, 'bad signature');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (body.event === 'ping') {
    // Проверка связки IGM ↔ Vercel: раз подпись верна, PIPELINE_SECRET совпадает. Заодно проверяем остальное.
    const key = String(process.env.GROQ_API_KEY || '').trim();
    let groq = key ? 'invalid' : 'missing';
    if (key) {
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + key } }).catch(() => null);
      if (r?.ok) groq = 'ok'; else if (r && r.status !== 401 && r.status !== 403) groq = 'http_' + r.status;
    }
    const sent = await tgCall('sendMessage', { chat_id: Number(ownerId()), text: '🔗 Проверка: робот IGM достучался до бота — связка работает.' });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, secret_match: true, groq, cron_secret: Boolean(String(process.env.CRON_SECRET || '').trim()), telegram: Boolean(sent?.ok), owner: Boolean(ownerId()), bridge: Boolean(process.env.IGM_BRIDGE_TOKEN) }));
  }
  if (body.event === 'editor') {
    // Запуск ИИ-редактора по расписанию IGM (editor.yml): один пост за вызов
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    try {
      const r = await runEditor({ host: String(process.env.WEBAPP_HOST || host), limit: 1 });
      res.statusCode = 200; return res.end(JSON.stringify({ ok: true, ...r }));
    } catch (err) {
      console.error('editor hook', err?.message);
      res.statusCode = 200; return res.end(JSON.stringify({ ok: false, error: String(err?.message || 'error').slice(0, 300) }));
    }
  }
  try {
    const { data } = await ghGetJson(PIPE_PATH);
    const post = (data?.posts || []).find(p => p.id === body.id);
    if (!post) return out(res, 404, 'no post');
    if (body.event === 'replan') {
      // Пересобрать промпты поста по разбору новости и прислать владельцу
      const r = await withPipe(async st => {
        const p = st.posts.find(x => x.id === body.id);
        if (!p || p.status !== 'text_review') throw new Error('post not in text review');
        return { post: p };
      });
      const d = { ...r.post.draft };
      await planVisuals(d, { source: r.post.source?.facts || '', avoid: [d.image_prompt, ...(d.image_prompts || [])].filter(Boolean) });
      const u = await withPipe(st => { const p = st.posts.find(x => x.id === body.id); p.draft.image_prompt = d.image_prompt; p.draft.image_prompts = d.image_prompts; p.draft.visual_brief = d.visual_brief; return { post: p, message: `pipeline: replan prompts ${body.id}` }; });
      const pm = promptMessage(u.post);
      if (pm) await sendPrompts('🔄 Новые промпты по разбору новости\n\n' + pm, u.post.id);
      return out(res, 200, 'ok');
    }
    if (body.event === 'prompts') {
      const pm = promptMessage(post);
      if (pm) await sendPrompts(pm, post.id);
      return out(res, 200, 'ok');
    }
    if (body.event === 'final_ready' && post.status === 'final_review') await sendFinal(post, host);
    else await sendStatus(post);
    return out(res, 200, 'ok');
  } catch (err) {
    console.error('pipeline hook', err?.message);
    return out(res, 502, 'error');
  }
}
