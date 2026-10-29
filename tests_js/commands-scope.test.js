import test from 'node:test';
import assert from 'node:assert/strict';
import { syncCommands } from '../api/bot.js';

test('guests get only start/guide, owner gets full list in own chat', async () => {
  const calls = [];
  const r = await syncCommands('12345', async (m, b) => { calls.push(b); return { ok: true }; });
  assert.equal(r.ok, true);
  const def = calls.find(b => !b.scope), own = calls.find(b => b.scope);
  assert.deepEqual(def.commands.map(c => c.command), ['start', 'guide']);
  assert.deepEqual(own.scope, { type: 'chat', chat_id: 12345 });
  assert.ok(own.commands.some(c => c.command === 'post'));
});
