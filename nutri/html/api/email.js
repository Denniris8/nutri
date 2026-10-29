function verificationUrl(token, env = process.env) {
  let base;
  try { base = new URL(env.APP_BASE_URL); } catch { throw Object.assign(new Error('email_url_not_configured'), { code: 'EMAIL_NOT_CONFIGURED' }); }
  if (base.username || base.password || (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname))) {
    throw Object.assign(new Error('email_url_invalid'), { code: 'EMAIL_NOT_CONFIGURED' });
  }
  return new URL(`/login.html?verify=${encodeURIComponent(token)}`, base).href;
}

function emailJsErrorCode(status, message) {
  if (/private key|access.?token/i.test(message)) return 'EMAILJS_PRIVATE_KEY_REJECTED';
  if (/service.?id/i.test(message)) return 'EMAILJS_SERVICE_ID_REJECTED';
  if (/template.?id/i.test(message)) return 'EMAILJS_TEMPLATE_ID_REJECTED';
  if (/public key|user.?id/i.test(message)) return 'EMAILJS_PUBLIC_KEY_REJECTED';
  if (/recipient|to.?email|email address/i.test(message)) return 'EMAILJS_RECIPIENT_REJECTED';
  return Number.isInteger(status) ? `EMAILJS_HTTP_${status}` : 'EMAILJS_REJECTED';
}

async function sendVerificationEmail(email, token, env = process.env, fetchImpl = fetch) {
  if (![env.EMAILJS_SERVICE_ID, env.EMAILJS_TEMPLATE_ID, env.EMAILJS_PUBLIC_KEY, env.EMAILJS_PRIVATE_KEY].every(Boolean)) {
    throw Object.assign(new Error('email_not_configured'), { code: 'EMAIL_NOT_CONFIGURED' });
  }
  const url = verificationUrl(token, env);
  const response = await fetchImpl('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      service_id: env.EMAILJS_SERVICE_ID,
      template_id: env.EMAILJS_TEMPLATE_ID,
      user_id: env.EMAILJS_PUBLIC_KEY,
      accessToken: env.EMAILJS_PRIVATE_KEY,
      template_params: { to_email: email, verification_url: url },
    }),
  });
  if (!response.ok) {
    const providerMessage = await response.text().catch(() => '');
    throw Object.assign(new Error('email_provider_rejected'), {
      code: emailJsErrorCode(response.status, providerMessage),
      upstreamHttpStatus: Number.isInteger(response.status) ? response.status : undefined,
    });
  }
}

module.exports = { sendVerificationEmail };
