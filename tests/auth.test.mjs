// Email-OTP-Login über Mailpit (ARCHITECTURE.md Kap. 2).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { setup, createUser, http, expectHttpError, MAILPIT_URL } from './helpers.mjs';

before(setup);

async function latestMailTo(email) {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent('to:' + email)}`);
    const data = await res.json();
    if (data.messages && data.messages.length) {
      const msg = await (await fetch(`${MAILPIT_URL}/api/v1/message/${data.messages[0].ID}`)).json();
      return msg;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Keine Mail an ' + email + ' eingegangen.');
}

test('OTP-Login: Code per deutscher Mail, Token 30 Tage gültig', async () => {
  const { email, user } = await createUser('OTP-Nutzer');
  const { otpId } = await http('POST', '/api/collections/users/request-otp', { json: { email } });
  assert.ok(otpId);

  const mail = await latestMailTo(email);
  assert.match(mail.Subject, /Ihr Anmeldecode/);
  const code = mail.Text.match(/Anmeldecode lautet:\s*(\d+)/)[1];

  await expectHttpError(http('POST', '/api/collections/users/auth-with-otp', { json: { otpId, password: '00000000' } }), 400);
  const auth = await http('POST', '/api/collections/users/auth-with-otp', { json: { otpId, password: code } });
  assert.equal(auth.record.id, user.id);

  const payload = JSON.parse(Buffer.from(auth.token.split('.')[1], 'base64url').toString());
  const days = (payload.exp - Math.floor(Date.now() / 1000)) / 86400;
  assert.ok(days > 29.9 && days <= 30, `Token-Dauer ${days} Tage`);
});

test('Passwort-Login ist deaktiviert', async () => {
  const { email } = await createUser();
  await expectHttpError(http('POST', '/api/collections/users/auth-with-password', {
    json: { identity: email, password: 'irrelevant-password-123' } }), 403);
});

test('unbekannte Adresse: keine Fehlermeldung, aber auch keine Mail', async () => {
  const email = `unbekannt${Date.now()}@example.com`;
  const r = await http('POST', '/api/collections/users/request-otp', { json: { email } });
  assert.ok(r.otpId, 'Antwort verrät nicht, ob das Konto existiert');
  await new Promise((res) => setTimeout(res, 500));
  const data = await (await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent('to:' + email)}`)).json();
  assert.equal(data.messages.length, 0);
});
