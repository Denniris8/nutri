const http = require('node:http');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHmac, randomBytes, randomUUID, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { readGarminEmail, readPreferences, savePreferences } = require('./api/preferences.js');
const { readAccountProfile, saveAccountProfile } = require('./api/account-profile.js');
const { verifyGarminAccount } = require('./api/garmin-verification.js');
const { syncGarminTraining } = require('./api/garmin-training-sync.js');
const { readBiometrics, saveBiometric } = require('./api/biometrics.js');
const { readPlicometrics, savePlicometric } = require('./api/plicometrics.js');
const { deleteFoodEntry, readFoodEntries, readPendingFoodDraft, saveFoodEntry } = require('./api/food-entries.js');
const { deleteFoodOpenCodeSession, ensureFoodOpenCodeSession, openCodeRequest: defaultOpenCodeRequest, recordFoodError, safeOpenCodeErrorCode, traceFoodSession } = require('./api/opencode-food.js');
const { analyzeTraining, deleteTrainingSession, generateTrainingPlan, prepareTrainingSession } = require('./api/training-analysis.js');
const { calculateTrainingEnergy, deleteTrainingEntry, localCalendarDate, readDailySteps, readTrainingEntries, saveDailySteps, saveTrainingEntry, visibleTrainingEntries } = require('./api/training-entries.js');
const { deleteTrainingPlan, readTrainingPlans, saveTrainingPlan } = require('./api/training-plans.js');

const scrypt = promisify(scryptCallback);
const sessionCookie = 'nutri_session';
const sessionSeconds = 8 * 60 * 60;
const termsVersion = 1;
const bodyLimit = 32768;
const loginLimit = 10;
const limitWindow = 15 * 60 * 1000;
const dummySalt = randomBytes(16);
let dummyHashPromise;
const countryDialCodes = {
  AR: '+54', AU: '+61', BO: '+591', BR: '+55', CA: '+1', CL: '+56', CN: '+86', CO: '+57',
  CR: '+506', CU: '+53', EC: '+593', SV: '+503', ES: '+34', US: '+1', PH: '+63', FR: '+33',
  DE: '+49', GT: '+502', HN: '+504', IN: '+91', IT: '+39', JP: '+81', MX: '+52', NI: '+505',
  PA: '+507', PY: '+595', PE: '+51', PT: '+351', PR: '+1', GB: '+44', DO: '+1', UY: '+598', VE: '+58',
};
const files = new Map([
  ['/', 'login.html'], ['/dashboard_nutricional.html', 'dashboard_nutricional.html'],
  ['/login.html', 'login.html'], ['/preferencias.html', 'preferencias.html'],
  ['/terminos.html', 'terminos.html'],
  ['/dashboard_nutricional.css', 'dashboard_nutricional.css'],
  ['/help-popups.css', 'help-popups.css'], ['/notifications.css', 'notifications.css'], ['/onboarding-flow.js', 'onboarding-flow.js'],
]);
const contentTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
};

function loadDatabaseEnvironment() {
  let lines;
  try {
    lines = readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/);
  } catch {
    return;
  }
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^("|')(.*)\1$/, '$2');
    if (['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DASHBOARD_JWT_SECRET', 'USDA', 'OPENCODE_SERVICE_FILE', 'OPENCODE_BASE_URL', 'OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_PORT', 'OPENCODE_AUTO_START', 'OPENCODE_PROJECT_DIR'].includes(match[1])) {
      process.env[match[1]] = value;
    }
  }
}

loadDatabaseEnvironment();

function mysql(sql) {
  const { DB_HOST: host, DB_PORT: port, DB_USER: user, DB_PASSWORD: password, DB_NAME: database } = process.env;
  if (![host, port, user, password, database].every(Boolean)) throw new Error('database_config');
  return new Promise((resolve, reject) => {
    const child = spawn('mysql', [
      `--host=${host}`, `--port=${port}`, `--user=${user}`, `--database=${database}`,
      '--batch', '--raw', '--skip-column-names', '--default-character-set=utf8mb4', '--connect-timeout=5',
    ], { env: { ...process.env, MYSQL_PWD: password }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code) reject(Object.assign(new Error(stderr), { code }));
      else resolve(stdout.trim());
    });
    child.stdin.end(sql);
  });
}

function textSql(value) {
  return `CONVERT(0x${Buffer.from(value, 'utf8').toString('hex')} USING utf8mb4)`;
}

function signJwt(userId, sessionId, secret, now = Math.floor(Date.now() / 1000)) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ sub: String(userId), sid: sessionId, iat: now, exp: now + sessionSeconds, iss: 'nutri-app', aud: 'nutri-app' });
  const content = `${header}.${payload}`;
  return `${content}.${createHmac('sha256', secret).update(content).digest('base64url')}`;
}

function verifyJwt(token, secret, now = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (header.alg !== 'HS256' || header.typ !== 'JWT' || claims.iss !== 'nutri-app' || claims.aud !== 'nutri-app') return null;
    if (!/^\d+$/.test(claims.sub) || !/^[0-9a-f-]{36}$/.test(claims.sid) || !Number.isInteger(claims.exp) || claims.exp <= now) return null;
    return claims;
  } catch {
    return null;
  }
}

function cookieValue(request) {
  const item = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookie}=`));
  return item?.slice(sessionCookie.length + 1) || '';
}

function setCookie(response, token, maxAge = sessionSeconds) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function bodyJson(request, maxBytes = bodyLimit) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw Object.assign(new Error(), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error(), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw Object.assign(new Error(), { status: 400 });
  }
}

function sameOrigin(request) {
  try {
    const origin = new URL(request.headers.origin);
    return !!request.headers.host && origin.host.toLowerCase() === request.headers.host.toLowerCase() && ['http:', 'https:'].includes(origin.protocol);
  } catch {
    return false;
  }
}

const derivePassword = (password, salt) => scrypt(password, salt, 64, { maxmem: 64 * 1024 * 1024 });

async function passwordMatches(password, saltHex, hashHex) {
  const validHash = /^[a-f\d]{32}$/i.test(saltHex || '') && /^[a-f\d]{128}$/i.test(hashHex || '');
  const salt = validHash ? Buffer.from(saltHex, 'hex') : dummySalt;
  const expected = validHash ? Buffer.from(hashHex, 'hex') : await (dummyHashPromise ||= derivePassword('invalid-user-password', dummySalt));
  const actual = await derivePassword(password, salt);
  return validHash && timingSafeEqual(actual, expected);
}

function validateRegistration(data) {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const password = typeof data.password === 'string' ? data.password : '';
  const country = typeof data.countryIso === 'string' ? data.countryIso : '';
  const sex = typeof data.sex === 'string' ? data.sex : '';
  const heightRaw = data.heightCm;
  const heightValue = heightRaw == null || heightRaw === '' ? null
    : typeof heightRaw === 'string' && /^\d{2,3}(?:\.\d{1,2})?$/.test(heightRaw) ? Number(heightRaw) : NaN;
  const age = Number(data.age);
  const rawPhone = typeof data.phone === 'string' ? data.phone : '';
  const phone = rawPhone.replace(/[\s()-]/g, '');
  const dialCode = countryDialCodes[country];
  const e164 = dialCode && /^\d{6,15}$/.test(phone) ? `${dialCode}${phone}` : '';
  if (!name || name.length > 150 || /[\u0000-\u001f]/.test(name)) throw Object.assign(new Error(), { status: 400 });
  if (!Number.isInteger(age) || age < 13 || age > 120) throw Object.assign(new Error(), { status: 400 });
  if (heightValue === null || !Number.isFinite(heightValue) || heightValue < 80 || heightValue > 250) throw Object.assign(new Error(), { status: 400 });
  if (!['masculino', 'femenino'].includes(sex) || !dialCode || !/^\+[1-9]\d{6,14}$/.test(e164)) throw Object.assign(new Error(), { status: 400 });
  if (Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 128) throw Object.assign(new Error(), { status: 400 });
  return { name, age, sex, height: heightValue.toFixed(2), country, phone, e164, password, isTest: data.isTestAccount === true };
}

function authError(response, status, message) {
  json(response, status, { error: message });
}

function createServer({ dbQuery = mysql, jwtSecret = process.env.DASHBOARD_JWT_SECRET, now = () => Math.floor(Date.now() / 1000), openCodeRequest = defaultOpenCodeRequest } = {}) {
  const attempts = new Map();

  async function authenticated(request) {
    const token = cookieValue(request);
    const claims = verifyJwt(token, jwtSecret, now());
    if (!claims) return null;
    const sql = `SELECT s.usuario_id FROM dashboard_sessions s JOIN usuarios u ON u.id=s.usuario_id WHERE s.session_id=${textSql(claims.sid)} AND s.usuario_id=${claims.sub} AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP() AND u.activo=1 LIMIT 1;`;
    const userId = await dbQuery(sql);
    return userId === claims.sub ? claims : null;
  }

  async function onboardingPath(userId) {
    const id = String(userId);
    if (!/^\d+$/.test(id)) throw new Error('invalid_user_id');
    const result = await dbQuery(`SELECT EXISTS(SELECT 1 FROM preferencias_usuario p JOIN perfil_salud_usuario h ON h.usuario_id=p.usuario_id WHERE p.usuario_id=${id}),EXISTS(SELECT 1 FROM dashboard_terms_decisions WHERE usuario_id=${id} AND terms_version=${termsVersion} AND decision='accepted');`);
    const [preferencesSaved, termsAccepted] = result.split('\t');
    return preferencesSaved !== '1' ? '/preferencias.html' : termsAccepted !== '1' ? '/terminos.html' : '/dashboard_nutricional.html';
  }

  function allowAttempt(request, response, type) {
    const key = `${type}:${request.socket.remoteAddress || 'unknown'}`;
    const time = Date.now();
    for (const [entry, state] of attempts) if (state.until <= time) attempts.delete(entry);
    const state = attempts.get(key) || { count: 0, until: time + limitWindow };
    if (state.count >= loginLimit) {
      response.setHeader('Retry-After', Math.ceil((state.until - time) / 1000));
      authError(response, 429, 'Demasiados intentos. Intenta más tarde.');
      return false;
    }
    state.count += 1;
    attempts.set(key, state);
    return true;
  }

  async function startSession(userId, response) {
    const sessionId = randomUUID();
    const sql = `INSERT INTO dashboard_sessions(session_id,usuario_id,expires_at) VALUES (${textSql(sessionId)},${userId},UTC_TIMESTAMP()+INTERVAL ${sessionSeconds} SECOND);`;
    await dbQuery(sql);
    setCookie(response, signJwt(userId, sessionId, jwtSecret, now()));
  }

  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (process.env.NODE_ENV === 'production') response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    let pathname;
    let editMode = false;
    try {
      const url = new URL(request.url, 'http://localhost');
      pathname = url.pathname;
      editMode = url.searchParams.get('edit') === '1';
    }
    catch { response.writeHead(400).end(); return; }

    if (pathname.startsWith('/api/auth/')) {
      if (!['POST'].includes(request.method)) { response.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!jwtSecret || Buffer.byteLength(jwtSecret) < 32) { authError(response, 503, 'Autenticación no configurada.'); return; }
      const route = pathname.slice('/api/auth/'.length);
      if (route === 'register' || route === 'login') {
        if (!allowAttempt(request, response, route)) return;
        let data;
        try { data = await bodyJson(request); }
        catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
        try {
          if (route === 'register') {
            const input = validateRegistration(data);
            const salt = randomBytes(16);
            const passwordHash = await derivePassword(input.password, salt);
            const sessionId = randomUUID();
            const testRows = input.isTest ? `INSERT INTO registros_biometricos(usuario_id,fuente,peso_kg,notas) VALUES (@new_user_id,'manual',75,${textSql('Datos ficticios de demostración; reemplázalos por datos personales reales.')});
INSERT INTO registros_plicometro(usuario_id,fecha,triceps_mm,biceps_mm,subescapular_mm,suprailiaco_mm,abdominal_mm,muslo_anterior_mm,pantorrilla_mm) VALUES (@new_user_id,UTC_DATE(),10,5,12,9,14,15,8);
INSERT INTO registros_comidas(usuario_id,request_id,fecha_consumo,descripcion_original,estado,creado_en) VALUES (@new_user_id,UUID(),UTC_DATE(),${textSql('DATO SINTÉTICO DE PRUEBA: desayuno de ejemplo; alimentos y cantidades no son consumo real.')},'pendiente',UTC_TIMESTAMP(3));
INSERT INTO planes_entrenamiento(usuario_id,objetivos,contenido,creado_en) VALUES (@new_user_id,${textSql('DATO SINTÉTICO DE PRUEBA: objetivo de demostración; no es una recomendación personal.')},${textSql('DATO SINTÉTICO DE PRUEBA: plan de demostración; no es una recomendación personalizada.')},UTC_TIMESTAMP(3));
` : '';
            const sql = `START TRANSACTION;
INSERT INTO usuarios(nombre,edad,sexo,estatura_cm,pais_iso,celular_e164,password_salt,password_hash,es_prueba) VALUES (${textSql(input.name)},${input.age},${textSql(input.sex)},${input.height ?? 'NULL'},${textSql(input.country)},${textSql(input.e164)},UNHEX('${salt.toString('hex')}'),UNHEX('${passwordHash.toString('hex')}'),${input.isTest ? 1 : 0});
SET @new_user_id=LAST_INSERT_ID();
${testRows}
INSERT INTO dashboard_sessions(session_id,usuario_id,expires_at) VALUES (${textSql(sessionId)},@new_user_id,UTC_TIMESTAMP()+INTERVAL ${sessionSeconds} SECOND);
COMMIT;
SELECT @new_user_id;`;
            const output = await dbQuery(sql);
            const userId = output.split(/\s+/).at(-1);
            if (!/^\d+$/.test(userId || '')) throw new Error('registration_result');
            setCookie(response, signJwt(userId, sessionId, jwtSecret, now()));
            json(response, 201, { ok: true });
            return;
          }

          const phone = typeof data.phone === 'string' ? data.phone.replace(/[\s()-]/g, '') : '';
          const password = typeof data.password === 'string' ? data.password : '';
          if (!/^\+[1-9]\d{6,14}$/.test(phone) || Buffer.byteLength(password) > 128 || !password) {
            authError(response, 400, 'Datos no válidos.'); return;
          }
          const result = await dbQuery(`SELECT id,HEX(password_salt),HEX(password_hash),activo FROM usuarios WHERE celular_e164=${textSql(phone)} LIMIT 1;`);
          const [id, saltHex, hashHex, active] = result.split('\t');
          if (!id || active !== '1' || !await passwordMatches(password, saltHex, hashHex)) { authError(response, 401, 'Celular o contraseña incorrectos.'); return; }
          await startSession(id, response);
          json(response, 200, { ok: true });
          return;
        } catch (error) {
          if (error.status) { authError(response, error.status, 'Datos no válidos.'); return; }
          if (/Duplicate entry|ER_DUP_ENTRY/.test(error.message)) { authError(response, 409, 'Ya existe una cuenta con ese celular.'); return; }
          authError(response, 503, 'No se pudo completar la solicitud.');
          return;
        }
      }

      if (route === 'logout') {
        try {
          const claims = await authenticated(request);
          if (claims) await dbQuery(`UPDATE dashboard_sessions SET revoked_at=UTC_TIMESTAMP() WHERE session_id=${textSql(claims.sid)} AND revoked_at IS NULL;`);
          setCookie(response, '', 0);
          json(response, 200, { ok: true });
        } catch { authError(response, 503, 'No se pudo completar la solicitud.'); }
        return;
      }
      if (route === 'delete') {
        if (!allowAttempt(request, response, route)) return;
        let claims;
        let data;
        try { claims = await authenticated(request); }
        catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
        if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
        try { data = await bodyJson(request); }
        catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
        const password = typeof data.password === 'string' ? data.password : '';
        if (Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 128) { authError(response, 400, 'Confirma tu contraseña.'); return; }
        try {
          const row = await dbQuery(`SELECT HEX(password_salt),HEX(password_hash),activo FROM usuarios WHERE id=${claims.sub} LIMIT 1;`);
          const [saltHex, hashHex, active] = row.split('\t');
          if (active !== '1' || !await passwordMatches(password, saltHex, hashHex)) { authError(response, 401, 'Contraseña incorrecta.'); return; }
          await deleteTrainingSession({ userId: claims.sub, requestOpenCode: openCodeRequest });
          await deleteFoodOpenCodeSession({ userId: claims.sub, dbQuery, requestOpenCode: openCodeRequest });
          const deleted = await dbQuery(`DELETE FROM usuarios WHERE id=${claims.sub}; SELECT ROW_COUNT();`);
          if (deleted.split(/\s+/).at(-1) !== '1') { authError(response, 404, 'La cuenta ya no existe.'); return; }
          setCookie(response, '', 0);
          json(response, 200, { ok: true });
        } catch { authError(response, 503, 'No se pudo eliminar la cuenta.'); }
        return;
      }
      authError(response, 404, 'Ruta no encontrada.');
      return;
    }

    if (pathname === '/api/terms/decision') {
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      let claims;
      let data;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      if (!['accepted', 'rejected'].includes(data.decision)) { authError(response, 400, 'Decisión no válida.'); return; }
      const decision = data.decision;
      const sessionUpdate = decision === 'rejected'
        ? `UPDATE dashboard_sessions SET revoked_at=UTC_TIMESTAMP() WHERE session_id=${textSql(claims.sid)} AND revoked_at IS NULL;`
        : '';
      try {
        await dbQuery(`START TRANSACTION;
INSERT INTO dashboard_terms_decisions(usuario_id,terms_version,decision,decided_at) VALUES (${claims.sub},${termsVersion},${textSql(decision)},UTC_TIMESTAMP()) AS incoming ON DUPLICATE KEY UPDATE decision=incoming.decision,decided_at=incoming.decided_at;
${sessionUpdate}
COMMIT;`);
        if (decision === 'rejected') setCookie(response, '', 0);
        json(response, 200, { ok: true, decision });
      } catch { authError(response, 503, 'No se pudo guardar la decisión.'); }
      return;
    }

    if (pathname === '/api/garmin/verify') {
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'garmin-verification')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      let data;
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      await verifyGarminAccount({ response, data, json, userId: claims.sub, secret: jwtSecret });
      return;
    }

    if (pathname === '/api/integrations/garmin/sync') {
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'garmin-training-sync')) return;
      let claims;
      let data;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      const timezone = request.headers['x-client-timezone'];
      const date = typeof data.date === 'string' ? data.date : '';
      const dateValue = new Date(`${date}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== date
          || typeof timezone !== 'string' || timezone.length > 64) { authError(response, 400, 'La fecha o zona horaria no es válida.'); return; }
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
      catch { authError(response, 400, 'La zona horaria no es válida.'); return; }
      try { json(response, 200, await syncGarminTraining({ userId: claims.sub, date, timezone, dbQuery, textSql, secret: jwtSecret })); }
      catch (error) { authError(response, error.status || 502, error.status ? error.message : 'No se pudieron sincronizar las actividades Garmin.'); }
      return;
    }

    if (pathname === '/api/integrations/garmin') {
      if (request.method !== 'DELETE') { response.writeHead(405, { Allow: 'DELETE' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try {
        await dbQuery(`START TRANSACTION; DELETE FROM credenciales_integracion_usuario WHERE usuario_id=${claims.sub} AND proveedor='garmin'; UPDATE preferencias_usuario SET modo_dispositivo='ninguno' WHERE usuario_id=${claims.sub}; COMMIT;`);
        json(response, 200, { ok: true });
      } catch { authError(response, 503, 'No se pudo desvincular Garmin.'); }
      return;
    }

    if (pathname === '/api/dashboard/profile') {
      if (!['GET', 'POST'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, POST' }).end(); return; }
      if (request.method === 'POST' && !sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (request.method === 'POST' && !allowAttempt(request, response, 'account-profile')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      if (request.method === 'GET') {
        try { json(response, 200, { profile: await readAccountProfile({ userId: claims.sub, dbQuery }) }); }
        catch { authError(response, 503, 'No se pudo cargar el perfil.'); }
        return;
      }
      let data;
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      await saveAccountProfile({ response, data, userId: claims.sub, dbQuery, textSql, json });
      return;
    }

    if (pathname === '/api/biometrics') {
      if (!['GET', 'POST'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, POST' }).end(); return; }
      if (request.method === 'POST' && !sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      if (request.method === 'GET') {
        try { json(response, 200, { records: await readBiometrics({ userId: claims.sub, dbQuery }) }); }
        catch { authError(response, 503, 'No se pudieron cargar los registros.'); }
        return;
      }
      let data;
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      await saveBiometric({ response, data, userId: claims.sub, dbQuery, textSql, json });
      return;
    }

    if (pathname === '/api/plicometrics') {
      if (!['GET', 'POST'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, POST' }).end(); return; }
      if (request.method === 'POST' && !sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      if (request.method === 'GET') {
        try { json(response, 200, { records: await readPlicometrics({ userId: claims.sub, dbQuery }) }); }
        catch { authError(response, 503, 'No se pudieron cargar los registros de plicómetro.'); }
        return;
      }
      let data;
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      await savePlicometric({ response, data, userId: claims.sub, dbQuery, textSql, json });
      return;
    }

    const foodEntryDelete = pathname.match(/^\/api\/food-entries\/([1-9]\d*)$/);
    if (foodEntryDelete) {
      if (request.method !== 'DELETE') { response.writeHead(405, { Allow: 'DELETE' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'food-entry-delete')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try {
        if (!await deleteFoodEntry({ userId: claims.sub, entryId: foodEntryDelete[1], dbQuery })) { authError(response, 404, 'La comida ya no existe.'); return; }
        json(response, 200, { ok: true });
      } catch (error) { authError(response, error.status || 503, error.status ? error.message : 'No se pudo eliminar la comida.'); }
      return;
    }

    if (pathname === '/api/food-entries/pending') {
      if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try { json(response, 200, { draft: await readPendingFoodDraft({ userId: claims.sub, dbQuery }) }); }
      catch { authError(response, 503, 'No se pudo recuperar el borrador de comida.'); }
      return;
    }

    if (pathname === '/api/food-entries') {
      if (!['GET', 'POST'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, POST' }).end(); return; }
      if (request.method === 'POST' && !sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      if (request.method === 'GET') {
        const date = new URL(request.url, 'http://localhost').searchParams.get('fecha');
        try { json(response, 200, { records: await readFoodEntries({ userId: claims.sub, fecha: date, dbQuery, textSql }) }); }
        catch (error) { authError(response, error.status || 503, error.status ? error.message : 'No se pudieron cargar las comidas.'); }
        return;
      }
      if (!allowAttempt(request, response, 'food-entry')) return;
      let data;
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      await saveFoodEntry({ response, data, userId: claims.sub, dbQuery, textSql, json, requestOpenCode: openCodeRequest });
      return;
    }

    if (pathname === '/api/food/session') {
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'food-session')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      const trace = { id: randomUUID(), events: [] };
      try {
        await ensureFoodOpenCodeSession({ userId: claims.sub, dbQuery, textSql, requestOpenCode: openCodeRequest, trace });
        json(response, 200, { ok: true });
      } catch (error) {
        if (!trace.events.some((event) => event.event.endsWith('_failed'))) {
          traceFoodSession(trace, 'session_open_failed', {
            stage: 'session_resolution', errorCode: safeOpenCodeErrorCode(error),
            ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { upstreamHttpStatus: error.status } : {}),
            ...(typeof error.operation === 'string' ? { operation: error.operation } : {}),
          });
        }
        try {
          await recordFoodError({
            dbQuery, textSql, userId: claims.sub, trace, stage: 'session_resolution', error, httpStatus: 503,
            action: 'POST /api/food/session', route: '/api/food/session',
          });
        } catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed' })); }
        authError(response, 503, 'No se pudo abrir la sesión de comidas.');
      }
      return;
    }

    if (pathname === '/api/training/session') {
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'training-session')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try {
        await prepareTrainingSession({ userId: claims.sub, requestOpenCode: openCodeRequest });
        json(response, 200, { ok: true });
      } catch { authError(response, 503, 'No se pudo preparar la sesión de entrenamiento.'); }
      return;
    }

    if (pathname === '/api/training-analysis') {
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'training-analysis')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      let data;
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      try {
        const timezone = request.headers['x-client-timezone'] || 'UTC';
        const localDate = localCalendarDate(timezone);
        const biometricData = JSON.parse(await dbQuery(`SELECT JSON_OBJECT('latestBiometric',(SELECT JSON_OBJECT('weightKg',peso_kg,'measuredAt',DATE_FORMAT(medido_en,'%Y-%m-%d %H:%i:%s'),'source',fuente) FROM registros_biometricos WHERE usuario_id=${claims.sub} ORDER BY medido_en DESC,id DESC LIMIT 1),'registeredHeightCm',(SELECT estatura_cm FROM usuarios WHERE id=${claims.sub} LIMIT 1));`));
        const analysis = await analyzeTraining({ userId: claims.sub, description: data.description, stepContext: { localDate, timezone }, biometricData: {
          latestWeightKg: biometricData.latestBiometric?.weightKg,
          weightMeasuredAt: biometricData.latestBiometric?.measuredAt,
          weightSource: biometricData.latestBiometric?.source,
          registeredHeightCm: biometricData.registeredHeightCm,
        }, requestOpenCode: openCodeRequest });
        if (analysis.stepsCount !== null) {
          analysis.stepsSaved = await saveDailySteps({
            userId: claims.sub, date: analysis.stepsDate || localDate, localDate,
            stepsCount: analysis.stepsCount, source: 'manual', dbQuery, textSql,
          });
        }
        json(response, 200, { analysis });
      }
      catch (error) { authError(response, error.status || 502, error.status ? error.message : 'No se pudo analizar el entrenamiento.'); }
      return;
    }

    if (pathname === '/api/training-plan') {
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'training-plan')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      let data;
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      try {
        const [profile, preferences, biometricRows, plicometricRows, ageRow] = await Promise.all([
          readAccountProfile({ userId: claims.sub, dbQuery }),
          readPreferences({ userId: claims.sub, dbQuery }),
          dbQuery(`SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('measuredAt',DATE_FORMAT(medido_en,'%Y-%m-%d %H:%i:%s'),'source',fuente,'weightKg',peso_kg,'bodyAge',edad_corporal,'bodyFatPct',grasa_pct,'restingMetabolismKcal',metabolismo_basal_kcal,'visceralFat',grasa_visceral,'bmi',imc,'musclePct',musculo_pct,'notes',notas)),JSON_ARRAY()) FROM (SELECT medido_en,fuente,peso_kg,edad_corporal,grasa_pct,metabolismo_basal_kcal,grasa_visceral,imc,musculo_pct,notas FROM registros_biometricos WHERE usuario_id=${claims.sub} ORDER BY medido_en DESC,id DESC) AS biometric_records;`),
          dbQuery(`SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('fecha',fecha,'tricepsMm',triceps_mm,'bicepsMm',biceps_mm,'subescapularMm',subescapular_mm,'suprailiacoMm',suprailiaco_mm,'abdominalMm',abdominal_mm,'musloAnteriorMm',muslo_anterior_mm,'pantorrillaMm',pantorrilla_mm)),JSON_ARRAY()) FROM (SELECT id,fecha,triceps_mm,biceps_mm,subescapular_mm,suprailiaco_mm,abdominal_mm,muslo_anterior_mm,pantorrilla_mm FROM registros_plicometro WHERE usuario_id=${claims.sub} ORDER BY fecha DESC,id DESC) AS plicometric_records;`),
          dbQuery(`SELECT JSON_OBJECT('age',edad) FROM usuarios WHERE id=${claims.sub} LIMIT 1;`),
        ]);
        const age = ageRow ? JSON.parse(ageRow).age : null;
        const biometrics = JSON.parse(biometricRows || '[]');
        const plicometrics = JSON.parse(plicometricRows || '[]');
        const context = {
          profile: { age, sex: profile?.sex ?? null, heightCm: profile?.heightCm ?? null, restingMetabolismKcal: profile?.restingMetabolismKcal ?? null, restingMetabolismSource: profile?.restingMetabolismSource ?? null },
          preferences: preferences ? {
            dietaryPattern: preferences.patronAlimentario,
            preferredFoods: preferences.preferredFoods,
            avoidedFoods: preferences.avoidedFoods,
            allergiesStatus: preferences.allergiesStatus,
            allergiesDetails: preferences.allergiesDetails,
            medicationsStatus: preferences.medicationsStatus,
            medicationsDetails: preferences.medicationsDetails,
          } : null,
          biometricRecords: biometrics,
          plicometricRecords: plicometrics,
        };
        const generated = await generateTrainingPlan({ userId: claims.sub, goals: data && typeof data === 'object' ? data.goals : undefined, context, requestOpenCode: openCodeRequest });
        json(response, 200, generated);
      } catch (error) {
        const cleanupFailed = error.code === 'TRAINING_PLAN_SESSION_CLEANUP';
        const sessionOpenFailed = error.code === 'TRAINING_PLAN_SESSION_OPEN';
        authError(response, error.status || 502, cleanupFailed ? 'No se pudo eliminar la sesión temporal de OpenCode; el plan no se guardó en la aplicación.' : sessionOpenFailed ? error.message : error.status ? error.message : 'No se pudo generar el plan de entrenamiento.');
      }
      return;
    }

    const trainingPlanDelete = pathname.match(/^\/api\/training-plans\/([1-9]\d{0,19})$/);
    if (trainingPlanDelete) {
      if (request.method !== 'DELETE') { response.writeHead(405, { Allow: 'DELETE' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'training-plan-delete')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try {
        if (!await deleteTrainingPlan({ userId: claims.sub, planId: trainingPlanDelete[1], dbQuery })) { authError(response, 404, 'El plan ya no existe.'); return; }
        json(response, 200, { ok: true });
      } catch (error) { authError(response, error.status || 503, error.status ? error.message : 'No se pudo eliminar el plan.'); }
      return;
    }

    if (pathname === '/api/training-plans') {
      if (!['GET', 'POST'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, POST' }).end(); return; }
      if (request.method === 'POST' && !sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      if (request.method === 'GET') {
        try { json(response, 200, { plans: await readTrainingPlans({ userId: claims.sub, dbQuery }) }); }
        catch { authError(response, 503, 'No se pudieron cargar los planes guardados.'); }
        return;
      }
      if (!allowAttempt(request, response, 'training-plan-save')) return;
      let data;
      try { data = await bodyJson(request, 131072); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      try {
        const saved = await saveTrainingPlan({ userId: claims.sub, goals: data.goals, plan: data.plan, macros: data.macros, dbQuery, textSql });
        json(response, 201, { ok: true, ...saved });
      } catch (error) { authError(response, error.status || 503, error.status ? error.message : 'No se pudo guardar el plan.'); }
      return;
    }

    const trainingEntryDelete = pathname.match(/^\/api\/training-entries\/([1-9]\d*)$/);
    if (trainingEntryDelete) {
      if (request.method !== 'DELETE') { response.writeHead(405, { Allow: 'DELETE' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'training-entry-delete')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try {
        if (!await deleteTrainingEntry({ userId: claims.sub, entryId: trainingEntryDelete[1], dbQuery })) { authError(response, 404, 'El entrenamiento ya no existe.'); return; }
        json(response, 200, { ok: true });
      } catch (error) { authError(response, error.status || 503, error.status ? error.message : 'No se pudo eliminar el entrenamiento.'); }
      return;
    }

    if (pathname === '/api/daily-steps') {
      if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try {
        const date = new URL(request.url, 'http://localhost').searchParams.get('fecha');
        json(response, 200, { date, stepsCount: await readDailySteps({ userId: claims.sub, date, dbQuery, textSql }) });
      } catch (error) { authError(response, error.status || 503, error.status ? error.message : 'No se pudieron cargar los pasos.'); }
      return;
    }

    if (pathname === '/api/training-entries') {
      if (!['GET', 'POST'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, POST' }).end(); return; }
      if (request.method === 'POST' && !sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      if (request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost');
        const date = url.searchParams.get('fecha');
        try {
          const records = await readTrainingEntries({ userId: claims.sub, dbQuery, ...(date ? { date, timezone: request.headers['x-client-timezone'] } : {}) });
          let preferences = null;
          try { preferences = await readPreferences({ userId: claims.sub, dbQuery }); } catch {}
          const garminEnabled = preferences?.deviceMode === 'garmin' && preferences.garminConnected === true;
          const visibleRecords = visibleTrainingEntries(records, preferences);
          json(response, 200, { records: visibleRecords, garminEnabled, ...(date ? { exercise: calculateTrainingEnergy(visibleRecords) } : {}) });
        }
        catch (error) { authError(response, error.status || 503, error.status ? error.message : 'No se pudieron cargar los entrenamientos.'); }
        return;
      }
      if (!allowAttempt(request, response, 'training-entry')) return;
      let data;
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      await saveTrainingEntry({ response, data, userId: claims.sub, dbQuery, textSql, json, timezone: request.headers['x-client-timezone'] });
      return;
    }

    if (pathname === '/api/onboarding/preferences') {
      if (request.method !== 'GET' && request.method !== 'POST') { response.writeHead(405, { Allow: 'GET, POST' }).end(); return; }
      if (request.method === 'POST' && !sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      if (request.method === 'GET') {
        try {
          const result = await readPreferences({ userId: claims.sub, dbQuery });
          if (!result) { authError(response, 404, 'No hay preferencias guardadas.'); return; }
          const includeGarminEmail = new URL(request.url, 'http://localhost').searchParams.get('includeGarminEmail') === '1';
          const garminEmail = includeGarminEmail && result.garminConnected
            ? await readGarminEmail({ userId: claims.sub, dbQuery, secret: jwtSecret }) : null;
          json(response, 200, { preferences: { ...result, ...(includeGarminEmail ? { garminEmail } : {}) } });
        } catch { authError(response, 503, 'No se pudieron cargar los datos.'); }
        return;
      }
      let data;
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      await savePreferences({ request, response, data, userId: claims.sub, dbQuery, textSql, json, secret: jwtSecret });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    if (!files.has(pathname)) { response.writeHead(404).end('Not found'); return; }
    if (['/', '/login.html', '/dashboard_nutricional.html', '/preferencias.html', '/terminos.html'].includes(pathname)) {
      let claims;
      try { claims = await authenticated(request); }
      catch { response.writeHead(503).end('Servicio temporalmente no disponible'); return; }
      if (!claims) {
        if (pathname === '/') {
          response.writeHead(302, { Location: '/login.html' }).end();
          return;
        }
        if (pathname !== '/login.html') {
          response.writeHead(302, { Location: '/login.html' }).end();
          return;
        }
      } else {
        let destination;
        try { destination = await onboardingPath(claims.sub); }
        catch { response.writeHead(503).end('Servicio temporalmente no disponible'); return; }
          const editing = editMode && pathname === '/preferencias.html' && destination === '/dashboard_nutricional.html';
        if (!editing && pathname !== destination) { response.writeHead(302, { Location: destination }).end(); return; }
      }
    }
    try {
      const body = await readFile(path.join(__dirname, files.get(pathname)));
      response.writeHead(200, { 'Content-Type': contentTypes[path.extname(files.get(pathname))], 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(500).end('Internal server error'); }
  });
}

if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT debe ser un entero entre 1 y 65535');
  if (!process.env.DASHBOARD_JWT_SECRET || Buffer.byteLength(process.env.DASHBOARD_JWT_SECRET) < 32) throw new Error('DASHBOARD_JWT_SECRET debe tener al menos 32 bytes');
  createServer().listen(port, host, () => console.log(`Vistas disponibles en http://${host}:${port}`));
}

module.exports = { createServer, signJwt, verifyJwt, validateRegistration };
