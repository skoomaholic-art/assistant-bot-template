import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, mergeNews, cleanSources, fetchSource, decode } from '../api/_news.js';
import { callScript } from '../api/mail.js';

const RSS = `<?xml version="1.0"?><rss><channel><title>X</title>
<item><title><![CDATA[«Дюна 3»: первые кадры &amp; дата]]></title><link>https://example.com/a</link>
<pubDate>Tue, 27 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Текст &lt;b&gt;анонса&lt;/b&gt;&lt;/p&gt;</description></item>
<item><title>Без ссылки</title><link>javascript:alert(1)</link></item>
<item><title>Сериал продлён - Кинопоиск</title><link>https://news.google.com/x</link><pubDate>Wed, 28 Oct 2026 01:00:00 GMT</pubDate></item>
</channel></rss>`;
const ATOM = `<feed><entry><title>Atom news</title><link rel="alternate" href="https://ex.org/b"/><updated>2026-10-26T00:00:00Z</updated><summary>s</summary></entry></feed>`;

test('RSS and Atom parsed, HTML stripped, unsafe links dropped', () => {
  const r = parseFeed(RSS);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, '«Дюна 3»: первые кадры & дата');
  assert.equal(r[0].summary, 'Текст анонса');
  assert.equal(r[0].date, '2026-10-27T10:00:00.000Z');
  const a = parseFeed(ATOM);
  assert.equal(a[0].link, 'https://ex.org/b');
  assert.equal(decode('&#1044;&#x430;'), 'Да');
});

test('merge: newest first, dedupe, Google News publisher split', () => {
  const sources = [{ id: 'gn-kino', title: 'GN', lang: 'ru' }, { id: 'v', title: 'V', lang: 'en' }];
  const items = parseFeed(RSS);
  const m = mergeNews([{ id: 'gn-kino', items }, { id: 'v', items: [items[0]] }], sources);
  assert.equal(m.length, 2);
  assert.equal(m[0].title, 'Сериал продлён');
  assert.equal(m[0].source_title, 'Кинопоиск');
});

test('sources: only https, fallback to defaults', () => {
  assert.equal(cleanSources([{ id: 'ok', url: 'https://a.b/rss' }, { id: 'bad', url: 'http://a.b' }]).length, 1);
  assert.ok(cleanSources(null).length >= 5);
  assert.ok(cleanSources([{ id: 'x', url: 'https://a/b', enabled: false }]).length >= 5);
});

test('broken source reports error instead of throwing', async () => {
  const r = await fetchSource({ id: 'x', url: 'https://a/b' }, async () => ({ ok: false, status: 404 }));
  assert.deepEqual([r.ok, r.error], [false, 'HTTP 404']);
  const t = await fetchSource({ id: 'x', url: 'https://a/b' }, async () => { throw Object.assign(new Error(), { name: 'AbortError' }); });
  assert.equal(t.error, 'таймаут');
});

test('mail: requires config, valid script URL, passes key, maps forbidden', async () => {
  const save = { ...process.env };
  try {
    delete process.env.MAIL_SCRIPT_URL; delete process.env.MAIL_SCRIPT_KEY;
    await assert.rejects(callScript({ action: 'list' }), e => e.code === 503);
    process.env.MAIL_SCRIPT_URL = 'https://evil.example/exec'; process.env.MAIL_SCRIPT_KEY = 'k'.repeat(32);
    await assert.rejects(callScript({ action: 'list' }), e => e.code === 503);
    process.env.MAIL_SCRIPT_URL = 'https://script.google.com/macros/s/AKfy_abc-123/exec';
    let sent;
    const ok = await callScript({ action: 'list' }, async (url, opts) => { sent = JSON.parse(opts.body); return { status: 200, text: async () => JSON.stringify({ ok: true, items: [] }) }; });
    assert.equal(sent.key, 'k'.repeat(32)); assert.deepEqual(ok.items, []);
    await assert.rejects(callScript({ action: 'list' }, async () => ({ status: 200, text: async () => JSON.stringify({ ok: false, error: 'forbidden' }) })), /Ключ не совпадает/);
    await assert.rejects(callScript({ action: 'list' }, async () => ({ status: 200, text: async () => '<html>accounts.google.com ServiceLogin</html>' })), /Anyone/);
    await assert.rejects(callScript({ action: 'list' }, async () => ({ status: 200, text: async () => '<html>Script function not found: doPost</html>' })), /doPost/);
  } finally { process.env = save; }
});

import { mailCallback, checkMinutes, minutesToTomorrow9, sendDue, cleanItem, reminderButtons, humanDelay } from '../api/mail.js';
import { handleUpdate } from '../api/bot.js';

test('mail: remind minutes validated, tomorrow 9:00 Almaty', () => {
  assert.equal(checkMinutes(90), 90);
  assert.throws(() => checkMinutes(0));
  assert.throws(() => checkMinutes(60 * 24 * 91));
  assert.throws(() => checkMinutes('abc'));
  // 29 окт 23:38 по Алматы (18:38 UTC) → 30 окт 9:00 = 562 мин
  assert.equal(minutesToTomorrow9(Date.UTC(2026, 9, 29, 18, 38)), 562);
  // 01:00 по Алматы → 9:00 следующего календарного дня, а не того же
  assert.equal(minutesToTomorrow9(Date.UTC(2026, 9, 29, 20, 0)), 24 * 60 + 8 * 60);
  assert.equal(humanDelay(90), '1 ч 30 мин');
  assert.equal(humanDelay(4320), '3 дн');
});

test('mail: items cleaned, bad links and statuses dropped', () => {
  const c = cleanItem({ id: 'abc12345', status: 'hack', link: 'javascript:alert(1)', remindAt: 'nope', subject: 'x'.repeat(500) });
  assert.equal(c.status, 'new'); assert.equal(c.link, null); assert.equal(c.remindAt, null); assert.equal(c.subject.length, 200);
  const btns = reminderButtons({ id: 'abc12345', status: 'work', link: 'https://mail.google.com/mail/u/0/#all/abc12345' }).flat();
  assert.ok(btns.every(b => !b.callback_data || Buffer.byteLength(b.callback_data) <= 64));
  assert.ok(btns.some(b => b.callback_data === 'mt:abc12345:new'));
});

test('mail: reminder buttons call the script', async () => {
  const calls = [];
  const call = async p => { calls.push(p); return { ok: true }; };
  assert.equal((await mailCallback('mt:abc12345:done', call)).ack, '✅ Готово');
  assert.deepEqual(calls.pop(), { action: 'status', id: 'abc12345', status: 'done' });
  assert.match((await mailCallback('mt:abc12345:r60', call)).ack, /через 1 ч/);
  assert.deepEqual(calls.pop(), { action: 'remind', id: 'abc12345', minutes: 60 });
  await mailCallback('mt:abc12345:tmr', call, Date.UTC(2026, 9, 29, 18, 38));
  assert.equal(calls.pop().minutes, 562);
  assert.equal(await mailCallback('mt:../../x:done', call), null);
});

test('bot: mt: button only for owner, edits message', async () => {
  const update = from => ({ callback_query: { id: '1', data: 'mt:abc12345:work', from: { id: from }, message: { message_id: 5, text: '⏰ Напоминание\n«Тема»\nот Х\nСтатус: новая', chat: { id: from, type: 'private' } } } });
  const deps = { mailCall: async () => ({ ok: true }) };
  assert.deepEqual(await handleUpdate(update(999), { owner: '111', host: 'x', deps }), []);
  const out = await handleUpdate(update(111), { owner: '111', host: 'x', deps });
  assert.equal(out[0].type, 'ack'); assert.equal(out[1].type, 'edit');
  assert.match(out[1].text, /Взял в работу/); assert.doesNotMatch(out[1].text, /Статус: новая/);
});

test('mail: due reminders need the script key and report sent ids', async () => {
  const save = { ...process.env };
  try {
    process.env.MAIL_SCRIPT_KEY = 'k'.repeat(32); process.env.TG_BOT_TOKEN = '1:x'; process.env.TG_OWNER_CHAT_ID = '111';
    await assert.rejects(sendDue({ key: 'wrong', items: [] }), e => e.code === 403);
    const sent = [];
    const ids = await sendDue({ key: 'k'.repeat(32), items: [{ id: 'abc12345', subject: 'S' }, { id: 'bad id' }, { id: 'def67890' }] },
      async (url, o) => { const b = JSON.parse(o.body); sent.push(b); return { json: async () => ({ ok: b.text.includes('S') }) }; });
    assert.equal(sent.length, 2); assert.equal(sent[0].chat_id, 111);
    assert.deepEqual(ids, ['abc12345']);
  } finally { process.env = save; }
});
