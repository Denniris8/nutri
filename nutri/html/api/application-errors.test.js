const assert = require('node:assert/strict');
const { test } = require('node:test');
const { recordApplicationError } = require('./application-errors.js');

const textSql = (value) => `CONVERT(0x${Buffer.from(value, 'utf8').toString('hex')} USING utf8mb4)`;

test('application error rows use SQL NULL when no user is associated', async () => {
  let query = '';
  await recordApplicationError({
    dbQuery: async (sql) => { query = sql; }, textSql,
    traceId: '123e4567-e89b-42d3-a456-426614174000', area: 'auth', event: 'verification_email_failed',
    stage: 'resend', action: 'POST /api/auth/resend-verification', method: 'POST',
    route: '/api/auth/resend-verification', httpStatus: 503, error: new Error(), description: 'No se pudo enviar el correo.',
  });
  assert.ok(query.includes(`${textSql('/api/auth/resend-verification')},NULL,${textSql('HTTP_503')}`));
});

test('application error rows preserve upstream HTTP status separately', async () => {
  let query = '';
  await recordApplicationError({
    dbQuery: async (sql) => { query = sql; }, textSql,
    traceId: '123e4567-e89b-42d3-a456-426614174000', area: 'auth', event: 'verification_email_failed',
    stage: 'resend', action: 'POST /api/auth/resend-verification', method: 'POST',
    route: '/api/auth/resend-verification', httpStatus: 503, upstreamHttpStatus: 401,
    error: Object.assign(new Error(), { code: 'EMAILJS_HTTP_401' }), description: 'No se pudo enviar el correo.',
  });
  assert.match(query, /EMAILJS_HTTP_401/);
  assert.match(query, /HTTP_503,401,/);
});
