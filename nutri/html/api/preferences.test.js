const assert = require('node:assert/strict');
const test = require('node:test');
const { encryptGarminCredentials } = require('./integration-credentials.js');
const { readGarminEmail } = require('./preferences.js');

test('reads only the authenticated user Garmin email from encrypted credentials', async () => {
  const secret = 'test-jwt-secret-must-be-at-least-32-bytes';
  const encrypted = encryptGarminCredentials('owner@example.com', 'private-password', secret);
  let sql;
  const email = await readGarminEmail({
    userId: '27', secret,
    dbQuery: async (query) => {
      sql = query;
      return `${encrypted.ciphertext}\t${encrypted.nonce}\t${encrypted.authTag}\t1`;
    },
  });
  assert.match(sql, /WHERE usuario_id=27 AND proveedor='garmin'/);
  assert.equal(email, 'owner@example.com');
  assert.doesNotMatch(JSON.stringify({ email }), /private-password/);
});

test('returns null when the user has no stored Garmin credentials', async () => {
  assert.equal(await readGarminEmail({ userId: '27', dbQuery: async () => '' }), null);
});
