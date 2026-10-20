const { createRequire } = require('node:module');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { issueGarminProof } = require('./integration-credentials.js');

async function verifyGarminAccount({ response, data, json, userId, secret }) {
  const email = typeof data.email === 'string' ? data.email.trim() : '';
  const password = typeof data.password === 'string' ? data.password : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !password || password.length > 256) {
    json(response, 400, { error: 'Introduce un correo y contraseña válidos.' });
    return;
  }

  const garminRoot = path.resolve(__dirname, '../../garmin-connect-mcp');
  let tokenRoot;
  let client;
  let timeout;
  try {
    tokenRoot = await mkdtemp(path.join(os.tmpdir(), 'nutri-garmin-check-'));
    const fromGarmin = createRequire(path.join(garminRoot, 'package.json'));
    const { Client } = fromGarmin('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = fromGarmin('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(garminRoot, 'build/index.js')],
      cwd: garminRoot,
      stderr: 'ignore',
      env: {
        PATH: process.env.PATH || '',
        HOME: os.homedir(),
        GARMIN_EMAIL: email,
        GARMIN_PASSWORD: password,
        GARMIN_FORCE_LOGIN: '1',
        GARMIN_TOKEN_DIR: tokenRoot,
      },
    });
    client = new Client({ name: 'nutri-garmin-account-check', version: '1.0.0' }, { capabilities: {} });
    const request = async () => {
      await client.connect(transport);
      const result = await client.callTool({ name: 'get_user_profile', arguments: {} }, undefined, { timeout: 35000 });
      if (result.isError) {
        const message = (result.content || []).filter((part) => part.type === 'text').map((part) => part.text).join(' ');
        if (/MFA is required/i.test(message)) throw Object.assign(new Error(), { code: 'mfa_required' });
        if (/invalid credentials/i.test(message)) throw Object.assign(new Error(), { code: 'garmin_rejected' });
        throw Object.assign(new Error(), { code: 'garmin_unavailable' });
      }
    };
    await Promise.race([
      request(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error(), { code: 'timeout' })), 40000); }),
    ]);
    json(response, 200, { ok: true, proof: issueGarminProof({ email, password, userId, secret }) });
  } catch (error) {
    const code = error.code;
    if (code === 'mfa_required') json(response, 422, { error: 'La cuenta requiere MFA; esta prueba aún no admite códigos de verificación.' });
    else if (code === 'garmin_rejected') json(response, 401, { error: 'Garmin no aceptó las credenciales ingresadas.' });
    else json(response, 502, { error: 'No se pudo contactar Garmin para validar la cuenta.' });
  } finally {
    clearTimeout(timeout);
    try { await client?.close(); } catch {}
    if (tokenRoot) await rm(tokenRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { verifyGarminAccount };
