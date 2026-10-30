import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMail } from '../api/mail.js';

test('forwarded jira mail shows real sender and clean text', () => {
  const r = cleanMail('Owner Name', 'Отправитель: jira@example.com There is 1 update, 1 comment. FM Marketing<https://jira.example.com/browse/MARK> / [cid:jira-generated-image-avatar-ada4] MARK-738<https://jira.example.com/browse/MARK-738> В очереди');
  assert.equal(r.from, 'jira@example.com');
  assert.equal(r.snippet, 'There is 1 update, 1 comment. FM Marketing / MARK-738 В очереди');
});

test('outlook warnings removed', () => {
  const r = cleanMail('A', 'Отправитель: noreply@docs.example.com Вы не часто получаете электронную почту от noreply@docs.example.com. Узнайте, почему это важно<https://aka.ms/x> EXTERNAL EMAIL: This email originated from outside of the organisation. Do not click links or open attachments unless you recognise the sender and know the content is safe. ВНЕШНЯЯ ПОЧТА: Это письмо отправлено из внешней организации. Не переходите по ссылкам и не открывайте вложения если вы не узнаете отправителя и не знаете что содержимое безопасно. Добрый день! Заявка на согласование');
  assert.equal(r.from, 'noreply@docs.example.com');
  assert.equal(r.snippet, 'Добрый день! Заявка на согласование');
});

test('plain mail untouched', () => {
  assert.deepEqual(cleanMail('Иван', 'Привет, как дела'), { from: 'Иван', snippet: 'Привет, как дела' });
});
