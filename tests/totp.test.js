'use strict';
process.env.SESSION_SECRET = 'test-secret-value-for-unit-tests-0123456789';
const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../server/shared/totp');

test('RFC 6238 test vectors (SHA1, secret "12345678901234567890")', () => {
  const secret = t.base32Encode(Buffer.from('12345678901234567890'));
  // 8-digit vectors from the RFC, last 6 digits are the 6-digit code
  const vectors = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']];
  for (const [secs, code] of vectors) assert.equal(t.hotp(secret, Math.floor(secs / 30)), code, `t=${secs}`);
});

test('verify accepts ±1 step, rejects far-off and replayed codes', () => {
  const secret = t.generateSecret();
  const now = 1_700_000_000_000;
  const code = t.hotp(secret, Math.floor(now / 30000));
  const step = t.verify(secret, code, { now });
  assert.equal(step, Math.floor(now / 30000));
  assert.ok(t.verify(secret, code, { now: now + 30_000 }) !== null, 'one step late is fine');
  assert.equal(t.verify(secret, code, { now: now + 120_000 }), null, 'two minutes later is not');
  assert.equal(t.verify(secret, code, { now, lastStep: step }), null, 'replay rejected');
  assert.equal(t.verify(secret, '12345', { now }), null);
  assert.equal(t.verify(secret, 'abcdef', { now }), null);
});

test('secret encryption round-trips and detects tampering', () => {
  const s = t.generateSecret();
  const enc = t.encryptSecret(s);
  assert.notEqual(enc, s);
  assert.equal(t.decryptSecret(enc), s);
  const bad = enc.slice(0, -4) + 'AAAA';
  assert.throws(() => t.decryptSecret(bad));
});

test('recovery codes are single use', () => {
  const { plain, hashed } = t.generateRecoveryCodes(3);
  const left = t.consumeRecoveryCode(hashed, plain[1]);
  assert.equal(left.length, 2);
  assert.equal(t.consumeRecoveryCode(left, plain[1]), null);
  assert.ok(t.consumeRecoveryCode(left, plain[0].replace('-', '').toUpperCase()), 'case/dash insensitive');
  assert.equal(t.consumeRecoveryCode(hashed, 'nope'), null);
});

test('login challenge signs, expires and resists tampering', () => {
  const c = t.signChallenge(42);
  assert.equal(t.verifyChallenge(c), 42);
  assert.equal(t.verifyChallenge(c.replace('42.', '43.')), null);
  assert.equal(t.verifyChallenge(t.signChallenge(42, -1)), null);
  assert.equal(t.verifyChallenge('garbage'), null);
});
