const { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } = require('node:crypto');

function credentialKey(secret) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.from('nutri-app'), Buffer.from('garmin-credentials-v1'), 32));
}

function credentialDigest(email, password, secret) {
  return createHmac('sha256', secret).update(`${email}\0${password}`).digest('base64url');
}

function issueGarminProof({ email, password, userId, secret }) {
  const payload = Buffer.from(JSON.stringify({ userId: String(userId), digest: credentialDigest(email, password, secret), expires: Date.now() + 10 * 60_000 })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function verifyGarminProof({ proof, email, password, userId, secret }) {
  if (typeof proof !== 'string' || typeof secret !== 'string') return false;
  const [payload, signature, extra] = proof.split('.');
  if (!payload || !signature || extra) return false;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const digest = Buffer.from(claims.digest || '');
    const expectedDigest = Buffer.from(credentialDigest(email, password, secret));
    return claims.userId === String(userId) && claims.expires > Date.now()
      && digest.length === expectedDigest.length && timingSafeEqual(digest, expectedDigest);
  } catch { return false; }
}

function encryptGarminCredentials(email, password, secret) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', credentialKey(secret), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ email, password }), 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('hex'), nonce: nonce.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };
}

function decryptGarminCredentials({ ciphertext, nonce, authTag }, secret) {
  const decipher = createDecipheriv('aes-256-gcm', credentialKey(secret), Buffer.from(nonce, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]).toString('utf8'));
}

module.exports = { decryptGarminCredentials, encryptGarminCredentials, issueGarminProof, verifyGarminProof };
