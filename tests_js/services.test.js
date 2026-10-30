import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchService, withBridge } from '../api/_services.js';

test('bridge injected before </body>', () => {
  const h = withBridge('<html><body><a href="?days=7">7</a></body></html>');
  assert.match(h, /svcParams[\s\S]*<\/body>/);
});

test('no password → clear hint, no fetch', async () => {
  delete process.env.OYYNKHANA_STATS_PASSWORD;
  let called = false;
  const r = await fetchService('oyynkhana', {}, { fetchImpl: async () => { called = true; } });
  assert.equal(r.html, null); assert.match(r.error, /OYYNKHANA_STATS_PASSWORD/); assert.equal(called, false);
});

test('fetches with basic auth and whitelisted params only', async () => {
  process.env.OYYNKHANA_STATS_PASSWORD = 'pw';
  let seen;
  const r = await fetchService('oyynkhana', { days: '7', evil: 'x' }, { fetchImpl: async (u, o) => { seen = { u, o }; return { ok: true, status: 200, text: async () => '<body>ok</body>' }; } });
  assert.equal(seen.u, 'https://oyynkhana.vercel.app/stats?days=7');
  assert.equal(seen.o.headers.Authorization, 'Basic ' + Buffer.from('owner:pw').toString('base64'));
  assert.match(r.html, /ok/);
  const bad = await fetchService('oyynkhana', {}, { fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' }) });
  assert.match(bad.error, /не подошёл/);
  assert.equal((await fetchService('nope')).status, 404);
});
