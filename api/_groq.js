// Надёжный вызов Groq с ответом в JSON: json-режим → без него → запасная модель.
// Groq отвечает 400 (json_validate_failed), если модель выдала невалидный JSON в json-режиме.
import { ReviewError } from './_lib.js';

export const MODELS = ['openai/gpt-oss-20b', 'llama-3.3-70b-versatile'];

export function parseJsonLoose(text) {
  const t = String(text || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

export async function groqJSON(messages, { key = String(process.env.GROQ_API_KEY || '').trim(), fetchImpl = fetch, maxTokens = 3000, temperature = 0.5, timeoutMs = 25000, models = null } = {}) {
  if (!key) throw new ReviewError('На Vercel не задан GROQ_API_KEY', 503);
  const attempts = models ? models.map(m => ({ model: m, json: true, extra: m.startsWith('openai/') ? { reasoning_effort: 'low' } : {} })) : [
    { model: MODELS[0], json: true, extra: { reasoning_effort: 'low' } },
    { model: MODELS[0], json: false, extra: { reasoning_effort: 'low' } },
    { model: MODELS[1], json: true, extra: {} },
  ];
  let lastErr = null;
  for (const a of attempts) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: a.model, temperature, max_completion_tokens: maxTokens, ...a.extra, ...(a.json ? { response_format: { type: 'json_object' } } : {}), messages }),
      });
    } catch { lastErr = new ReviewError('ИИ-сервис недоступен. Повтори позже.', 502); continue; }
    finally { clearTimeout(timer); }
    if (resp.status === 429) throw new ReviewError('Лимит бесплатного Groq исчерпан. Повтори через минуту, списаний нет.', 429);
    if (resp.status === 401 || resp.status === 403) throw new ReviewError('Groq отклонил ключ — проверь GROQ_API_KEY', 502);
    if (!resp.ok) {
      let detail = '';
      try { const e = await resp.json(); detail = e?.error?.code || e?.error?.message || ''; } catch {}
      console.error('groq', a.model, resp.status, detail);
      lastErr = new ReviewError(`ИИ не ответил (HTTP ${resp.status}${detail ? ', ' + String(detail).slice(0, 60) : ''}). Повтори.`, 502);
      continue;
    }
    let content = '';
    try { content = (await resp.json()).choices?.[0]?.message?.content || ''; } catch {}
    const out = parseJsonLoose(content);
    if (out && typeof out === 'object') return out;
    lastErr = new ReviewError('ИИ вернул некорректный ответ. Повтори.', 502);
  }
  throw lastErr || new ReviewError('ИИ не ответил', 502);
}
