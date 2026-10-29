import test from 'node:test';
import assert from 'node:assert/strict';
import { groqJSON, parseJsonLoose } from '../api/_groq.js';

test('json-mode 400 falls back to plain mode and parses fenced JSON', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body); calls.push(body);
    if (calls.length === 1) return { ok: false, status: 400, json: async () => ({ error: { code: 'json_validate_failed' } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Вот:\n```json\n{"a":1}\n```' } }] }) };
  };
  assert.deepEqual(await groqJSON([{ role: 'user', content: 'x' }], { key: 'k', fetchImpl }), { a: 1 });
  assert.ok(calls[0].response_format); assert.equal(calls[1].response_format, undefined);
});

test('rate limit and bad key are reported clearly; third attempt uses backup model', async () => {
  await assert.rejects(groqJSON([], { key: 'k', fetchImpl: async () => ({ ok: false, status: 429 }) }), e => e.code === 429);
  await assert.rejects(groqJSON([], { key: 'k', fetchImpl: async () => ({ ok: false, status: 401 }) }), /ключ/);
  const models = [];
  await assert.rejects(groqJSON([], { key: 'k', fetchImpl: async (u, o) => { models.push(JSON.parse(o.body).model); return { ok: false, status: 400, json: async () => ({}) }; } }), /HTTP 400/);
  assert.equal(models[2], 'llama-3.3-70b-versatile');
  assert.equal(parseJsonLoose('nope'), null);
});
