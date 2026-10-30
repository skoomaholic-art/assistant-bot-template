// «🧩 Ещё»: страницы других проектов владельца внутри мини-приложения.
// Сервер сам входит на закрытую страницу (пароль хранится только в Vercel) и отдаёт HTML владельцу.
const SERVICES = {
  oyynkhana: {
    url: 'https://oyynkhana.vercel.app/stats', passEnv: 'OYYNKHANA_STATS_PASSWORD',
    // период, выбранная игра, фильтры ленты и вкладка, на которой открыть страницу
    params: {
      days: v => ([7, 30, 90].includes(Number(v)) ? String(Number(v)) : null),
      game: v => (/^[a-z0-9_-]{1,40}$/.test(String(v || '')) ? String(v) : null),
      fbg: v => (/^[a-z0-9_-]{1,40}$/.test(String(v || '')) ? String(v) : null),
      fbk: v => (/^[a-z]{1,12}$/.test(String(v || '')) ? String(v) : null),
      go: v => (/^[a-z]{1,12}$/.test(String(v || '')) ? String(v) : null),
    },
  },
};

// Ссылки «?days=N» и внешние ссылки внутри страницы передаём наверх, в мини-приложение
const BRIDGE = `<script>(function(){document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href')||'';
if(h.charAt(0)==='#')return;e.preventDefault();
if(h.charAt(0)==='?'){var p={};h.slice(1).split('&').forEach(function(kv){var i=kv.indexOf('=');if(i>0)p[decodeURIComponent(kv.slice(0,i))]=decodeURIComponent(kv.slice(i+1));});parent.postMessage({svcParams:p},'*');}
else parent.postMessage({svcOpen:a.href},'*');},true);})();</script>`;

export function withBridge(html) {
  const s = String(html || '');
  return /<\/body>/i.test(s) ? s.replace(/<\/body>/i, `${BRIDGE}</body>`) : s + BRIDGE;
}

export async function fetchService(id, params = {}, { fetchImpl = fetch } = {}) {
  const svc = SERVICES[id];
  if (!svc) return { status: 404, html: null, error: 'Нет такого проекта' };
  const pass = String(process.env[svc.passEnv] || '').trim();
  if (!pass) return { status: 503, html: null, error: `Добавь на Vercel (проект Instagram Manager) переменную ${svc.passEnv} — тот же пароль, что STATS_PASSWORD в Ойынхане, и сделай Redeploy.` };
  const u = new URL(svc.url);
  for (const [k, check] of Object.entries(svc.params || {})) { const v = check(params[k]); if (v) u.searchParams.set(k, v); }
  // redirect:'manual': пароль в Basic-заголовке не должен уйти на другой адрес вслед за редиректом
  let r, text;
  try {
    r = await fetchImpl(u.toString(), { redirect: 'manual', headers: { Authorization: 'Basic ' + Buffer.from(`owner:${pass}`).toString('base64') }, signal: AbortSignal.timeout(25000) });
    text = await r.text();
  } catch (err) {
    const slow = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { status: 504, html: null, error: slow ? 'Страница не ответила за 25 секунд. Попробуй ещё раз' : 'Страница не ответила: сеть недоступна. Попробуй ещё раз' };
  }
  if (r.status >= 300 && r.status < 400) return { status: r.status, html: null, error: 'Страница ответила переадресацией, открыть её здесь нельзя' };
  if (r.status === 401) return { status: 401, html: null, error: `Пароль не подошёл: ${svc.passEnv} должен совпадать со STATS_PASSWORD в Ойынхане.` };
  return { status: r.status, html: withBridge(text), error: r.ok ? null : `Страница ответила ${r.status}` };
}
