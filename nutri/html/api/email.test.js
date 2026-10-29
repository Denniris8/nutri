const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sendPasswordRecoveryEmail, sendVerificationEmail } = require('./email.js');

const env = {
  EMAILJS_SERVICE_ID: 'service_test',
  EMAILJS_TEMPLATE_ID: 'template_test',
  EMAILJS_PUBLIC_KEY: 'public_test',
  EMAILJS_PRIVATE_KEY: 'private_test',
  APP_BASE_URL: 'https://nutri.example.test',
};

test('verification email is sent through EmailJS with recipient and link template params', async () => {
  let request;
  await sendVerificationEmail('person@example.test', 'token_123', env, async (...args) => {
    request = args;
    return { ok: true };
  });
  assert.equal(request[0], 'https://api.emailjs.com/api/v1.0/email/send');
  const payload = JSON.parse(request[1].body);
  assert.equal(payload.service_id, env.EMAILJS_SERVICE_ID);
  assert.equal(payload.template_id, env.EMAILJS_TEMPLATE_ID);
  assert.equal(payload.user_id, env.EMAILJS_PUBLIC_KEY);
  assert.equal(payload.accessToken, env.EMAILJS_PRIVATE_KEY);
  assert.deepEqual(payload.template_params, {
    to_email: 'person@example.test',
    verification_url: 'https://nutri.example.test/login.html?verify=token_123',
    action_label: 'Verificar correo',
    action_message: 'Verifica tu correo para activar tu cuenta.',
  });
});

test('password recovery email reuses the configured template with recovery copy and reset link', async () => {
  let request;
  await sendPasswordRecoveryEmail('person@example.test', 'token_123', env, async (...args) => { request = args; return { ok: true }; });
  const payload = JSON.parse(request[1].body);
  assert.equal(payload.template_id, env.EMAILJS_TEMPLATE_ID);
  assert.deepEqual(payload.template_params, {
    to_email: 'person@example.test',
    verification_url: 'https://nutri.example.test/login.html?reset=token_123',
    action_label: 'Restablecer contraseña',
    action_message: 'Usa este enlace para elegir una nueva contraseña. Vence en una hora.',
  });
});

test('EmailJS rejection returns a sanitized error code', async () => {
  await assert.rejects(
    sendVerificationEmail('person@example.test', 'token_123', env, async () => ({ ok: false })),
    { code: 'EMAILJS_REJECTED' },
  );
});

test('EmailJS service validation errors are classified without retaining provider text', async () => {
  await assert.rejects(
    sendVerificationEmail('person@example.test', 'token_123', env, async () => ({
      ok: false, status: 400, text: async () => 'The service ID is invalid',
    })),
    { code: 'EMAILJS_SERVICE_ID_REJECTED', upstreamHttpStatus: 400 },
  );
});
