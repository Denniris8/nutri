const http = require('node:http');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { readFile } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash, createHmac, randomBytes, randomUUID, scrypt: scryptCallback, timingSafeEqual } = require('node:crypto');
const { preferencesSql, readGarminEmail, readPreferences, savePreferences } = require('./api/preferences.js');
const { accountProfileSql, readAccountProfile, saveAccountProfile } = require('./api/account-profile.js');
const { verifyGarminAccount } = require('./api/garmin-verification.js');
const { syncGarminTraining } = require('./api/garmin-training-sync.js');
const { readBiometrics, saveBiometric } = require('./api/biometrics.js');
const { readPlicometrics, savePlicometric } = require('./api/plicometrics.js');
const { clearFoodChatHistory, deleteFoodEntry, getFoodEntryProgress, readFoodEntries, readPendingFoodDraft, saveFoodEntry } = require('./api/food-entries.js');
const { calendarDayRange, readCalendarTimezone } = require('./api/calendar-day.js');
const { deleteFoodOpenCodeSession, openCodeRequest: defaultOpenCodeRequest, recordFoodError } = require('./api/opencode-food.js');
const { buildChefNutritionContext, deleteChefSession, sendChefMessage } = require('./api/chef-chat.js');
const { recordApplicationError } = require('./api/application-errors.js');
const { sendVerificationEmail: defaultSendVerificationEmail } = require('./api/email.js');
const { analyzeTraining, deleteTrainingPlanSession, deleteTrainingSession, generateTrainingPlan, getTrainingProgress, readTrainingPlanPrompt, reportTrainingProgress } = require('./api/training-analysis.js');
const { createAnalysisProgressRecorder } = require('./api/analysis-progress.js');
const { calculateTrainingEnergy, deleteTrainingEntry, localCalendarDate, readDailySteps, readTrainingEntries, recordTrainingError, saveDailySteps, saveTrainingEntry, visibleTrainingEntries } = require('./api/training-entries.js');
const { activateTrainingPlan, deleteTrainingPlan, extractPlanDisclosure, readTrainingPlanForDate, readTrainingPlans, saveTrainingPlan, summarizeTrainingPlan } = require('./api/training-plans.js');
const { addNotification, markNotificationRead, notificationInsertSql, readNotifications, resolveNotificationsSql } = require('./api/notifications.js');

const scrypt = promisify(scryptCallback);
const sessionCookie = 'nutri_session';
const sessionSeconds = 7 * 24 * 60 * 60;
const termsVersion = 1;
const appVersion = readFileSync(path.join(__dirname, '..', 'VERSION'), 'utf8').trim();
const bodyLimit = 32768;
const loginLimit = 10;
const registrationLimit = 5;
const registrationWindowMinutes = 60;
const limitWindow = 15 * 60 * 1000;
const foodEntryWindow = 5 * 60 * 1000;
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
  ['/manifest.webmanifest', 'manifest.webmanifest'], ['/pwa-icon.svg', 'pwa-icon.svg'],
  ['/pwa-icon-192.png', 'pwa-icon-192.png'], ['/pwa-icon-512.png', 'pwa-icon-512.png'],
  ['/service-worker.js', 'service-worker.js'], ['/pwa-register.js', 'pwa-register.js'],
]);
const contentTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
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
    if (['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'DASHBOARD_JWT_SECRET', 'USDA', 'OPENCODE_SERVICE_FILE', 'OPENCODE_BASE_URL', 'OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_PORT', 'OPENCODE_AUTO_START', 'OPENCODE_PROJECT_DIR', 'EMAILJS_SERVICE_ID', 'EMAILJS_TEMPLATE_ID', 'EMAILJS_PUBLIC_KEY', 'EMAILJS_PRIVATE_KEY', 'APP_BASE_URL'].includes(match[1])) {
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

function setCookie(response, token, maxAge = sessionSeconds, request) {
  const secure = process.env.NODE_ENV === 'production' || request?.socket?.encrypted ? '; Secure' : '';
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
  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  const heightRaw = data.heightCm;
  const heightValue = heightRaw == null || heightRaw === '' ? null
    : typeof heightRaw === 'string' && /^\d{2,3}(?:\.\d{1,2})?$/.test(heightRaw) ? Number(heightRaw) : NaN;
  const age = Number(data.age);
  const rawPhone = typeof data.phone === 'string' ? data.phone : '';
  const phone = rawPhone.replace(/[\s()-]/g, '');
  const dialCode = countryDialCodes[country];
  const e164 = phone ? dialCode && /^\d{6,15}$/.test(phone) ? `${dialCode}${phone}` : '' : null;
  if (!name || name.length > 150 || /[\u0000-\u001f]/.test(name)) throw Object.assign(new Error(), { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || Buffer.byteLength(email, 'utf8') > 254 || /[^\x00-\x7f]/.test(email)) throw Object.assign(new Error(), { status: 400 });
  if (!Number.isInteger(age) || age < 13 || age > 120) throw Object.assign(new Error(), { status: 400 });
  if (heightValue === null || !Number.isFinite(heightValue) || heightValue < 80 || heightValue > 250) throw Object.assign(new Error(), { status: 400 });
  if (!['masculino', 'femenino'].includes(sex) || !dialCode || (phone && !/^\+[1-9]\d{6,14}$/.test(e164 || ''))) throw Object.assign(new Error(), { status: 400 });
  if (Buffer.byteLength(password, 'utf8') < 12 || Buffer.byteLength(password, 'utf8') > 128) throw Object.assign(new Error(), { status: 400 });
  return { name, age, sex, height: heightValue.toFixed(2), country, email, phone, e164, password };
}

function authError(response, status, message) {
  json(response, status, { error: message });
}

function createServer({ dbQuery = mysql, jwtSecret = process.env.DASHBOARD_JWT_SECRET, now = () => Math.floor(Date.now() / 1000), openCodeRequest = defaultOpenCodeRequest, sendVerificationEmail = defaultSendVerificationEmail, testAccountPhone = process.env.DASHBOARD_TEST_ACCOUNT_PHONE || '+520000000000', allowTestAccountSeeding = process.env.ALLOW_TEST_ACCOUNT_SEEDING === 'true' && process.env.NODE_ENV !== 'production' } = {}) {
  const attempts = new Map();

  async function authenticated(request) {
    const token = cookieValue(request);
    const claims = verifyJwt(token, jwtSecret, now());
    if (!claims) return null;
    const sql = `SELECT s.usuario_id FROM dashboard_sessions s JOIN usuarios u ON u.id=s.usuario_id WHERE s.session_id=${textSql(claims.sid)} AND s.usuario_id=${claims.sub} AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP() AND u.activo=1 LIMIT 1;`;
    const userId = await dbQuery(sql);
    return userId === claims.sub ? claims : null;
  }

  const progressAuth = new Map();
  async function authenticatedForProgress(request) {
    const token = cookieValue(request);
    const hit = token && progressAuth.get(token);
    if (hit && hit.until > Date.now()) return hit.claims;
    const claims = await authenticated(request);
    if (claims && token) {
      progressAuth.set(token, { claims, until: Date.now() + 5000 });
      if (progressAuth.size > 200) progressAuth.delete(progressAuth.keys().next().value);
    }
    return claims;
  }

  async function reserveLoginAttempt(request, email) {
    const ip = request.socket.remoteAddress || 'unknown';
    const keys = [
      { kind: 'ip', hash: createHmac('sha256', jwtSecret).update(`login-rate:ip:${ip}`).digest('hex') },
      ...(email ? [{ kind: 'email', hash: createHmac('sha256', jwtSecret).update(`login-rate:email:${email}`).digest('hex') }] : []),
    ];
    const values = keys.map(({ kind, hash }) => `(${textSql(kind)},UNHEX('${hash}'),UTC_TIMESTAMP(3),1)`).join(',');
    const scope = keys.map(({ kind, hash }) => `(kind=${textSql(kind)} AND key_hash=UNHEX('${hash}'))`).join(' OR ');
    const result = await dbQuery(`DELETE FROM auth_login_rate_limits WHERE window_started_at < UTC_TIMESTAMP(3)-INTERVAL 1 DAY ORDER BY window_started_at LIMIT 500;
INSERT INTO auth_login_rate_limits(kind,key_hash,window_started_at,attempts) VALUES ${values} ON DUPLICATE KEY UPDATE attempts=IF(window_started_at < UTC_TIMESTAMP(3)-INTERVAL 15 MINUTE,1,attempts+1),window_started_at=IF(window_started_at < UTC_TIMESTAMP(3)-INTERVAL 15 MINUTE,UTC_TIMESTAMP(3),window_started_at);
SELECT COALESCE(MAX(attempts),0),GREATEST(1,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(3),DATE_ADD(MAX(window_started_at),INTERVAL 15 MINUTE))) FROM auth_login_rate_limits WHERE ${scope};`);
    const [attempts, retryAfter] = result.split(/\r?\n/).at(-1).split('\t').map(Number);
    return { keys, allowed: Number.isFinite(attempts) && attempts <= loginLimit, retryAfter: Number.isFinite(retryAfter) ? retryAfter : 900 };
  }

  async function releaseLoginAttempt(keys) {
    const scope = keys.map(({ kind, hash }) => `(kind=${textSql(kind)} AND key_hash=UNHEX('${hash}'))`).join(' OR ');
    await dbQuery(`UPDATE auth_login_rate_limits SET attempts=attempts-1 WHERE (${scope}) AND attempts>0;
DELETE FROM auth_login_rate_limits WHERE (${scope}) AND attempts=0;`);
  }

  async function reserveRegistrationAttempt(request) {
    const hash = createHmac('sha256', jwtSecret).update(`registration-rate:ip:${request.socket.remoteAddress || 'unknown'}`).digest('hex');
    const result = await dbQuery(`/* registration-rate-limit */
DELETE FROM auth_login_rate_limits WHERE window_started_at < UTC_TIMESTAMP(3)-INTERVAL 1 DAY ORDER BY window_started_at LIMIT 500;
INSERT INTO auth_login_rate_limits(kind,key_hash,window_started_at,attempts) VALUES ('ip',UNHEX('${hash}'),UTC_TIMESTAMP(3),1) ON DUPLICATE KEY UPDATE attempts=IF(window_started_at < UTC_TIMESTAMP(3)-INTERVAL ${registrationWindowMinutes} MINUTE,1,LEAST(attempts+1,${registrationLimit + 1})),window_started_at=IF(window_started_at < UTC_TIMESTAMP(3)-INTERVAL ${registrationWindowMinutes} MINUTE,UTC_TIMESTAMP(3),window_started_at);
SELECT attempts,GREATEST(1,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(3),DATE_ADD(window_started_at,INTERVAL ${registrationWindowMinutes} MINUTE))) FROM auth_login_rate_limits WHERE kind='ip' AND key_hash=UNHEX('${hash}') LIMIT 1;`);
    const [attempts, retryAfter] = result.split(/\r?\n/).at(-1).split('\t').map(Number);
    return { allowed: Number.isFinite(attempts) && attempts <= registrationLimit, retryAfter: Number.isFinite(retryAfter) ? retryAfter : registrationWindowMinutes * 60 };
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
    const maxAttempts = type === 'chef-chat' ? 20 : loginLimit;
    const messageType = ['food-entry', 'training-analysis', 'training-plan', 'chef-chat'].includes(type);
    const windowMs = type === 'chef-chat' ? 2 * 60 * 1000 : messageType ? foodEntryWindow : limitWindow;
    for (const [entry, state] of attempts) if (state.until <= time) attempts.delete(entry);
    const state = attempts.get(key) || { count: 0, until: time + windowMs };
    if (state.count >= maxAttempts) {
      const retryAfter = Math.max(1, Math.ceil((state.until - time) / 1000));
      response.setHeader('Retry-After', retryAfter);
      const retryMinutes = Math.max(1, Math.ceil(retryAfter / 60));
      const message = messageType
        ? `Límite de ${maxAttempts} mensajes alcanzado. Podrás enviar más en ${retryMinutes} minuto${retryMinutes === 1 ? '' : 's'}.`
        : 'Demasiados intentos. Intenta más tarde.';
      authError(response, 429, message);
      return false;
    }
    state.count += 1;
    attempts.set(key, state);
    return true;
  }

  async function startSession(userId, response, request) {
    const sessionId = randomUUID();
    const sql = `INSERT INTO dashboard_sessions(session_id,usuario_id,expires_at) VALUES (${textSql(sessionId)},${userId},UTC_TIMESTAMP()+INTERVAL ${sessionSeconds} SECOND);`;
    await dbQuery(sql);
    setCookie(response, signJwt(userId, sessionId, jwtSecret, now()), sessionSeconds, request);
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

    if (pathname === '/healthz') {
      response.writeHead(request.method === 'GET' ? 200 : 405).end();
      return;
    }

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
            const registrationAttempt = await reserveRegistrationAttempt(request);
            if (!registrationAttempt.allowed) {
              response.setHeader('Retry-After', registrationAttempt.retryAfter);
              authError(response, 429, 'Demasiados intentos de registro. Intenta más tarde.');
              return;
            }
            const isTestAccount = allowTestAccountSeeding && input.e164 === testAccountPhone;
            const salt = randomBytes(16);
            const passwordHash = await derivePassword(input.password, salt);
            const verificationToken = randomBytes(32).toString('base64url');
            const verificationHash = createHash('sha256').update(verificationToken).digest('hex');
            const testRows = isTestAccount ? `INSERT INTO registros_biometricos(usuario_id,fuente,peso_kg,notas) VALUES (@new_user_id,'manual',75,${textSql('Datos ficticios de demostración; reemplázalos por datos personales reales.')});
INSERT INTO registros_plicometro(usuario_id,fecha,triceps_mm,biceps_mm,subescapular_mm,suprailiaco_mm,abdominal_mm,muslo_anterior_mm,pantorrilla_mm) VALUES (@new_user_id,UTC_DATE(),10,5,12,9,14,15,8);
INSERT INTO registros_comidas(usuario_id,request_id,fecha_consumo,descripcion_original,estado,creado_en) VALUES (@new_user_id,UUID(),UTC_DATE(),${textSql('DATO SINTÉTICO DE PRUEBA: desayuno de ejemplo; alimentos y cantidades no son consumo real.')},'pendiente',UTC_TIMESTAMP(3));
INSERT INTO planes_entrenamiento(usuario_id,objetivos,contenido,creado_en) VALUES (@new_user_id,${textSql('DATO SINTÉTICO DE PRUEBA: objetivo de demostración; no es una recomendación personal.')},${textSql('DATO SINTÉTICO DE PRUEBA: plan de demostración; no es una recomendación personalizada.')},UTC_TIMESTAMP(3));
INSERT INTO vigencias_planes_entrenamiento(usuario_id,plan_id,fecha_inicio,creado_en) SELECT usuario_id,id,UTC_DATE(),UTC_TIMESTAMP(3) FROM planes_entrenamiento WHERE usuario_id=@new_user_id ORDER BY id DESC LIMIT 1;
` : '';
            const sql = `START TRANSACTION;
INSERT INTO usuarios(nombre,edad,sexo,estatura_cm,pais_iso,celular_e164,correo_electronico,password_salt,password_hash,es_prueba) VALUES (${textSql(input.name)},${input.age},${textSql(input.sex)},${input.height ?? 'NULL'},${textSql(input.country)},${input.e164 ? textSql(input.e164) : 'NULL'},${textSql(input.email)},UNHEX('${salt.toString('hex')}'),UNHEX('${passwordHash.toString('hex')}'),${isTestAccount ? 1 : 0});
SET @new_user_id=LAST_INSERT_ID();
${testRows}
INSERT INTO tokens_cuenta_email(usuario_id,proposito,token_hash,vence_en) VALUES (@new_user_id,'verificacion',UNHEX('${verificationHash}'),UTC_TIMESTAMP(3)+INTERVAL 24 HOUR);
COMMIT;
SELECT @new_user_id;`;
            const output = await dbQuery(sql);
            const userId = output.split(/\s+/).at(-1);
            if (!/^\d+$/.test(userId || '')) throw new Error('registration_result');
            try {
              await sendVerificationEmail(input.email, verificationToken);
            } catch (error) {
              const traceId = randomUUID();
              try { await recordApplicationError({ dbQuery, textSql, traceId, area: 'auth', event: 'verification_email_failed', stage: 'send', action: 'POST /api/auth/register', method: 'POST', route: '/api/auth/register', httpStatus: 503, upstreamHttpStatus: error.upstreamHttpStatus, error, description: 'No se pudo enviar el correo de verificación.' }); }
              catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
              json(response, 202, { ok: true, pendingVerification: true, message: 'La cuenta quedó pendiente de verificación. No se pudo enviar el correo; contacta soporte para solicitar otro enlace.' });
              return;
            }
            json(response, 202, { ok: true, pendingVerification: true, message: 'La cuenta quedó pendiente de verificación. Revisa tu correo para activar el acceso.' });
            return;
          }

          const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
          const password = typeof data.password === 'string' ? data.password : '';
          const reservation = await reserveLoginAttempt(request, /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && Buffer.byteLength(email, 'utf8') <= 254 ? email : null);
          if (!reservation.allowed) {
            await releaseLoginAttempt(reservation.keys);
            response.setHeader('Retry-After', reservation.retryAfter);
            authError(response, 429, 'Demasiados intentos. Intenta más tarde.');
            return;
          }
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || Buffer.byteLength(email, 'utf8') > 254 || /[^\x00-\x7f]/.test(email) || Buffer.byteLength(password) > 128 || !password) {
            await releaseLoginAttempt(reservation.keys);
            authError(response, 400, 'Datos no válidos.'); return;
          }
          let result;
          let passwordValid;
          try {
            result = await dbQuery(`SELECT id,HEX(password_salt),HEX(password_hash),activo,correo_verificado_en IS NOT NULL FROM usuarios WHERE correo_electronico=${textSql(email)} AND correo_verificado_en IS NOT NULL LIMIT 1;`);
            const [, saltHex, hashHex] = result.split('\t');
            passwordValid = await passwordMatches(password, saltHex, hashHex);
          } catch (error) {
            await releaseLoginAttempt(reservation.keys);
            throw error;
          }
          const [id, , , active, emailVerified] = result.split('\t');
          if (!id || active !== '1' || emailVerified !== '1' || !passwordValid) {
            const traceId = randomUUID();
            try {
              await dbQuery(`INSERT INTO errores_aplicacion(ocurrido_en,area,trace_id,evento,etapa,accion_realizada,metodo_http,ruta,codigo_error,nombre_error,http_status,descripcion_error) VALUES (UTC_TIMESTAMP(3),${textSql('auth')},${textSql(traceId)},${textSql('login_failed')},${textSql('credentials')},${textSql('POST /api/auth/login')},${textSql('POST')},${textSql('/api/auth/login')},${textSql('AUTH_INVALID_CREDENTIALS')},${textSql('AuthenticationError')},401,${textSql('Inicio de sesión rechazado.')});`);
            } catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
            authError(response, 401, 'Correo o contraseña incorrectos.'); return;
          }
          await releaseLoginAttempt(reservation.keys);
          await startSession(id, response, request);
          json(response, 200, { ok: true });
          return;
        } catch (error) {
          if (error.status) { authError(response, error.status, 'Datos no válidos.'); return; }
          if (/Duplicate entry|ER_DUP_ENTRY/.test(error.message || '')) { authError(response, 400, 'Datos no válidos.'); return; }
          authError(response, 503, 'No se pudo completar la solicitud.');
          return;
        }
      }

      if (route === 'logout') {
        try {
          const claims = await authenticated(request);
          if (claims) await dbQuery(`UPDATE dashboard_sessions SET revoked_at=UTC_TIMESTAMP() WHERE session_id=${textSql(claims.sid)} AND revoked_at IS NULL;`);
          setCookie(response, '', 0, request);
          json(response, 200, { ok: true });
        } catch { authError(response, 503, 'No se pudo completar la solicitud.'); }
        return;
      }
      if (route === 'verify-email') {
        if (!allowAttempt(request, response, 'verify-email')) return;
        let data;
        try { data = await bodyJson(request); }
        catch (error) { authError(response, error.status || 400, 'Enlace de verificación no válido o vencido.'); return; }
        const token = typeof data.token === 'string' ? data.token : '';
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { authError(response, 400, 'Enlace de verificación no válido o vencido.'); return; }
        const tokenHash = createHash('sha256').update(token).digest('hex');
        try {
          const result = await dbQuery(`START TRANSACTION;
UPDATE tokens_cuenta_email t JOIN usuarios u ON u.id=t.usuario_id SET t.consumido_en=UTC_TIMESTAMP(3),u.correo_verificado_en=UTC_TIMESTAMP(3) WHERE t.proposito='verificacion' AND t.token_hash=UNHEX('${tokenHash}') AND t.consumido_en IS NULL AND t.vence_en>UTC_TIMESTAMP(3) AND u.correo_verificado_en IS NULL;
SELECT ROW_COUNT(),(SELECT u.correo_electronico FROM tokens_cuenta_email t JOIN usuarios u ON u.id=t.usuario_id WHERE t.proposito='verificacion' AND t.token_hash=UNHEX('${tokenHash}') AND t.consumido_en IS NOT NULL LIMIT 1);
COMMIT;`);
          const [updatedRows, email] = result.trim().split('\t');
          if (Number(updatedRows) < 1 || !email) { authError(response, 400, 'Enlace de verificación no válido o vencido.'); return; }
          json(response, 200, { ok: true, email });
        } catch { authError(response, 503, 'No se pudo verificar el correo.'); }
        return;
      }
      if (route === 'resend-verification') {
        if (!allowAttempt(request, response, 'resend-verification')) return;
        let data;
        try { data = await bodyJson(request); }
        catch (error) { authError(response, error.status || 400, 'Solicitud no válida.'); return; }
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        const genericResponse = () => json(response, 202, { ok: true, message: 'Si la cuenta necesita verificación, enviaremos un enlace al correo registrado.' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || Buffer.byteLength(email, 'utf8') > 254 || /[^\x00-\x7f]/.test(email)) { genericResponse(); return; }
        try {
          const [userId, verified] = (await dbQuery(`SELECT id,correo_verificado_en IS NOT NULL FROM usuarios WHERE correo_electronico=${textSql(email)} LIMIT 1;`)).split('\t');
          if (!/^\d+$/.test(userId || '') || verified !== '0') { genericResponse(); return; }
          const token = randomBytes(32).toString('base64url');
          const tokenHash = createHash('sha256').update(token).digest('hex');
          await dbQuery(`START TRANSACTION;
UPDATE tokens_cuenta_email SET consumido_en=UTC_TIMESTAMP(3) WHERE usuario_id=${userId} AND proposito='verificacion' AND consumido_en IS NULL;
INSERT INTO tokens_cuenta_email(usuario_id,proposito,token_hash,vence_en) VALUES (${userId},'verificacion',UNHEX('${tokenHash}'),UTC_TIMESTAMP(3)+INTERVAL 24 HOUR);
COMMIT;`);
          try { await sendVerificationEmail(email, token); }
          catch (error) {
            const traceId = randomUUID();
            try { await recordApplicationError({ dbQuery, textSql, traceId, area: 'auth', event: 'verification_email_failed', stage: 'resend', action: 'POST /api/auth/resend-verification', method: 'POST', route: '/api/auth/resend-verification', httpStatus: 503, upstreamHttpStatus: error.upstreamHttpStatus, error, description: 'No se pudo reenviar el correo de verificación.' }); }
            catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
          }
          genericResponse();
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
          setCookie(response, '', 0, request);
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
        if (decision === 'rejected') setCookie(response, '', 0, request);
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
      try {
        const result = await syncGarminTraining({ userId: claims.sub, date, timezone, dbQuery, textSql, secret: jwtSecret });
        if (result.saved || result.updated) await addNotification({ userId: claims.sub, category: 'entrenamiento', state: 'guardado', title: 'Actividades Garmin sincronizadas', message: `Garmin: ${result.saved} nueva${result.saved === 1 ? '' : 's'} y ${result.updated} actualizada${result.updated === 1 ? '' : 's'}.`, dbQuery, textSql });
        json(response, 200, result);
      } catch (error) { authError(response, error.status || 502, error.status ? error.message : 'No se pudieron sincronizar las actividades Garmin.'); }
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

    if (pathname === '/api/notifications') {
      if (!['GET', 'POST'].includes(request.method)) { response.writeHead(405, { Allow: 'GET, POST' }).end(); return; }
      if (request.method === 'POST' && !sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudieron cargar las alertas.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      if (request.method === 'POST') {
        if (!allowAttempt(request, response, 'notification-create')) return;
        try {
          const data = await bodyJson(request);
          const validState = data.category === 'comida' && ['requiere_respuesta', 'guardado', 'error'].includes(data.state)
            || data.category === 'plan' && ['generado', 'guardado', 'error'].includes(data.state)
            || data.category === 'entrenamiento' && ['requiere_respuesta', 'generado', 'guardado', 'error'].includes(data.state);
          if (!validState
            || typeof data.title !== 'string' || !data.title.trim() || data.title.length > 120
            || typeof data.message !== 'string' || !data.message.trim() || data.message.length > 2000
            || data.referenceId != null && !/^[1-9]\d{0,19}$/.test(String(data.referenceId))) {
            authError(response, 400, 'Datos de alerta no válidos.'); return;
          }
          await dbQuery(`${notificationInsertSql({ ...data, userId: claims.sub, textSql })};`);
          json(response, 201, { ok: true });
        } catch (error) { authError(response, error.status || 400, error.status ? error.message : 'No se pudo guardar la alerta.'); }
        return;
      }
      try { json(response, 200, await readNotifications({ userId: claims.sub, dbQuery })); }
      catch { authError(response, 503, 'No se pudieron cargar las alertas.'); }
      return;
    }

    const notificationRead = pathname.match(/^\/api\/notifications\/([1-9]\d{0,19})\/read$/);
    if (notificationRead) {
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo actualizar la alerta.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try {
        const updated = await markNotificationRead({ userId: claims.sub, notificationId: notificationRead[1], dbQuery });
        json(response, updated ? 200 : 404, { ok: updated });
      } catch { authError(response, 503, 'No se pudo actualizar la alerta.'); }
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

    if (pathname === '/api/food-entries/progress') {
      if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(); return; }
      let claims;
      try { claims = await authenticatedForProgress(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      const requestId = new URL(request.url, 'http://localhost').searchParams.get('requestId') || '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        authError(response, 400, 'Solicitud de progreso no válida.'); return;
      }
      json(response, 200, { progress: getFoodEntryProgress(claims.sub, requestId) });
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

    if (pathname === '/api/progress/nutrition') {
      if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      const url = new URL(request.url, 'http://localhost');
      const days = Number(url.searchParams.get('dias'));
      const end = url.searchParams.get('hasta');
      if (![7, 14, 30].includes(days) || !/^\d{4}-\d{2}-\d{2}$/.test(end || '') || Number.isNaN(Date.parse(`${end}T00:00:00Z`)) || new Date(`${end}T00:00:00Z`).toISOString().slice(0, 10) !== end) {
        authError(response, 400, 'Periodo no válido.'); return;
      }
      const startOffset = days - 1;
      const periodOffset = days * 2 - 1;
      const currentStart = `DATE_SUB(${textSql(end)},INTERVAL ${startOffset} DAY)`;
      const previousStart = `DATE_SUB(${textSql(end)},INTERVAL ${periodOffset} DAY)`;
      const currentDates = (column) => column.startsWith('DATE(')
        ? `${column.slice(5, -1)}>=CONCAT(${currentStart},' 00:00:00') AND ${column.slice(5, -1)}<DATE_ADD(${textSql(end)},INTERVAL 1 DAY)`
        : `${column} BETWEEN ${currentStart} AND ${textSql(end)}`;
      const previousDates = (column) => column.startsWith('DATE(')
        ? `${column.slice(5, -1)}>=CONCAT(${previousStart},' 00:00:00') AND ${column.slice(5, -1)}<CONCAT(${currentStart},' 00:00:00')`
        : `${column} BETWEEN ${previousStart} AND DATE_SUB(${textSql(end)},INTERVAL ${days} DAY)`;
      try {
        const [result, body, activity, plicometric] = (await dbQuery(`WITH daily AS (
  SELECT fecha_consumo,COUNT(*) AS meals,
    COUNT(*)=COUNT(energia_kcal) AND COUNT(*)=COUNT(proteina_g) AND COUNT(*)=COUNT(carbohidratos_g) AND COUNT(*)=COUNT(grasa_g) AS complete,
    SUM(energia_kcal) AS kcal,SUM(proteina_g) AS protein,SUM(carbohidratos_g) AS carbs,SUM(grasa_g) AS fat
  FROM registros_comidas WHERE usuario_id=${claims.sub} AND estado='completado'
    AND fecha_consumo BETWEEN DATE_SUB(${textSql(end)},INTERVAL ${periodOffset} DAY) AND ${textSql(end)}
  GROUP BY fecha_consumo
)
SELECT JSON_OBJECT('days',${days},'current',JSON_OBJECT(
  'loggedDays',(SELECT COUNT(DISTINCT fecha_consumo) FROM registros_comidas WHERE usuario_id=${claims.sub} AND ${currentDates('fecha_consumo')}),
  'completeDays',COUNT(CASE WHEN fecha_consumo>=${currentStart} AND complete THEN 1 END),
  'incompleteDays',COUNT(CASE WHEN fecha_consumo>=${currentStart} AND NOT complete THEN 1 END),
  'kcal',AVG(CASE WHEN fecha_consumo>=${currentStart} AND complete THEN kcal END),
  'protein',AVG(CASE WHEN fecha_consumo>=${currentStart} AND complete THEN protein END),
  'carbs',AVG(CASE WHEN fecha_consumo>=${currentStart} AND complete THEN carbs END),
  'fat',AVG(CASE WHEN fecha_consumo>=${currentStart} AND complete THEN fat END)),
  'previous',JSON_OBJECT('loggedDays',(SELECT COUNT(DISTINCT fecha_consumo) FROM registros_comidas WHERE usuario_id=${claims.sub} AND ${previousDates('fecha_consumo')}),'completeDays',COUNT(CASE WHEN fecha_consumo<${currentStart} AND complete THEN 1 END),
  'incompleteDays',COUNT(CASE WHEN fecha_consumo<${currentStart} AND NOT complete THEN 1 END),
  'kcal',AVG(CASE WHEN fecha_consumo<${currentStart} AND complete THEN kcal END),
  'protein',AVG(CASE WHEN fecha_consumo<${currentStart} AND complete THEN protein END),
  'carbs',AVG(CASE WHEN fecha_consumo<${currentStart} AND complete THEN carbs END),
  'fat',AVG(CASE WHEN fecha_consumo<${currentStart} AND complete THEN fat END)),
  'quality',JSON_OBJECT('currentPending',(SELECT COUNT(*) FROM registros_comidas WHERE usuario_id=${claims.sub} AND estado<>'completado' AND ${currentDates('fecha_consumo')}),'previousPending',(SELECT COUNT(*) FROM registros_comidas WHERE usuario_id=${claims.sub} AND estado<>'completado' AND ${previousDates('fecha_consumo')}),'macroSources',JSON_OBJECT('usda',(SELECT COUNT(*) FROM registros_comidas e JOIN registros_comida_items i ON i.registro_comida_id=e.id WHERE e.usuario_id=${claims.sub} AND e.estado='completado' AND ${currentDates('e.fecha_consumo')} AND i.fuente_macros='usda_fdc'),'declared',(SELECT COUNT(*) FROM registros_comidas e JOIN registros_comida_items i ON i.registro_comida_id=e.id WHERE e.usuario_id=${claims.sub} AND e.estado='completado' AND ${currentDates('e.fecha_consumo')} AND i.fuente_macros='declarado_usuario'),'web',(SELECT COUNT(*) FROM registros_comidas e JOIN registros_comida_items i ON i.registro_comida_id=e.id WHERE e.usuario_id=${claims.sub} AND e.estado='completado' AND ${currentDates('e.fecha_consumo')} AND i.fuente_macros='webfetch'),'opencode',(SELECT COUNT(*) FROM registros_comidas e JOIN registros_comida_items i ON i.registro_comida_id=e.id WHERE e.usuario_id=${claims.sub} AND e.estado='completado' AND ${currentDates('e.fecha_consumo')} AND i.fuente_macros='opencode_estimado'),'estimated',(SELECT COUNT(*) FROM registros_comidas e JOIN registros_comida_items i ON i.registro_comida_id=e.id WHERE e.usuario_id=${claims.sub} AND e.estado='completado' AND ${currentDates('e.fecha_consumo')} AND i.estado_macros='estimado'))),
   'goals',(SELECT JSON_OBJECT('kcal',p.objetivo_calorias_kcal,'protein',p.objetivo_proteinas_g,'carbs',p.objetivo_carbohidratos_g,'fat',p.objetivo_grasas_g) FROM vigencias_planes_entrenamiento v JOIN planes_entrenamiento p ON p.id=v.plan_id AND p.usuario_id=v.usuario_id WHERE v.usuario_id=${claims.sub} AND v.fecha_inicio<=${currentStart} AND (v.fecha_fin IS NULL OR v.fecha_fin>=${textSql(end)}) ORDER BY v.fecha_inicio DESC,v.id DESC LIMIT 1)) FROM daily;
SELECT JSON_OBJECT('current',JSON_OBJECT('measurements',(SELECT COUNT(*) FROM registros_biometricos WHERE usuario_id=${claims.sub} AND ${currentDates('DATE(medido_en)')}),'firstKg',(SELECT peso_kg FROM registros_biometricos WHERE usuario_id=${claims.sub} AND ${currentDates('DATE(medido_en)')} ORDER BY medido_en,id LIMIT 1),'lastKg',(SELECT peso_kg FROM registros_biometricos WHERE usuario_id=${claims.sub} AND ${currentDates('DATE(medido_en)')} ORDER BY medido_en DESC,id DESC LIMIT 1),'firstDate',(SELECT DATE_FORMAT(medido_en,'%Y-%m-%d') FROM registros_biometricos WHERE usuario_id=${claims.sub} AND ${currentDates('DATE(medido_en)')} ORDER BY medido_en,id LIMIT 1),'lastDate',(SELECT DATE_FORMAT(medido_en,'%Y-%m-%d') FROM registros_biometricos WHERE usuario_id=${claims.sub} AND ${currentDates('DATE(medido_en)')} ORDER BY medido_en DESC,id DESC LIMIT 1)), 'previous',JSON_OBJECT('measurements',(SELECT COUNT(*) FROM registros_biometricos WHERE usuario_id=${claims.sub} AND ${previousDates('DATE(medido_en)')}),'firstKg',(SELECT peso_kg FROM registros_biometricos WHERE usuario_id=${claims.sub} AND ${previousDates('DATE(medido_en)')} ORDER BY medido_en,id LIMIT 1),'lastKg',(SELECT peso_kg FROM registros_biometricos WHERE usuario_id=${claims.sub} AND ${previousDates('DATE(medido_en)')} ORDER BY medido_en DESC,id DESC LIMIT 1),'firstDate',(SELECT DATE_FORMAT(medido_en,'%Y-%m-%d') FROM registros_biometricos WHERE usuario_id=${claims.sub} AND ${previousDates('DATE(medido_en)')} ORDER BY medido_en,id LIMIT 1),'lastDate',(SELECT DATE_FORMAT(medido_en,'%Y-%m-%d') FROM registros_biometricos WHERE usuario_id=${claims.sub} AND ${previousDates('DATE(medido_en)')} ORDER BY medido_en DESC,id DESC LIMIT 1)));
SELECT JSON_OBJECT('current',JSON_OBJECT('stepDays',(SELECT COUNT(*) FROM registros_pasos_diarios WHERE usuario_id=${claims.sub} AND ${currentDates('fecha')}),'avgSteps',(SELECT AVG(pasos) FROM registros_pasos_diarios WHERE usuario_id=${claims.sub} AND ${currentDates('fecha')}),'trainingSessions',(SELECT COUNT(*) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND ${currentDates('DATE(creado_en)')}),'manualSessions',(SELECT COUNT(*) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND origen='manual' AND ${currentDates('DATE(creado_en)')}),'deviceSessions',(SELECT COUNT(*) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND origen<>'manual' AND ${currentDates('DATE(creado_en)')}),'manualMinutes',(SELECT SUM(duracion_minutos) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND origen='manual' AND ${currentDates('DATE(creado_en)')}),'deviceMinutes',(SELECT SUM(duracion_minutos) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND origen<>'manual' AND ${currentDates('DATE(creado_en)')}),'manualKcal',(SELECT SUM(energia_kcal) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND origen='manual' AND ${currentDates('DATE(creado_en)')}),'deviceKcal',(SELECT SUM(energia_kcal) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND origen<>'manual' AND ${currentDates('DATE(creado_en)')})), 'previous',JSON_OBJECT('stepDays',(SELECT COUNT(*) FROM registros_pasos_diarios WHERE usuario_id=${claims.sub} AND ${previousDates('fecha')}),'avgSteps',(SELECT AVG(pasos) FROM registros_pasos_diarios WHERE usuario_id=${claims.sub} AND ${previousDates('fecha')}),'trainingSessions',(SELECT COUNT(*) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND ${previousDates('DATE(creado_en)')}),'manualSessions',(SELECT COUNT(*) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND origen='manual' AND ${previousDates('DATE(creado_en)')}),'deviceSessions',(SELECT COUNT(*) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND origen<>'manual' AND ${previousDates('DATE(creado_en)')}),'manualMinutes',(SELECT SUM(duracion_minutos) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND origen='manual' AND ${previousDates('DATE(creado_en)')}),'deviceMinutes',(SELECT SUM(duracion_minutos) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND origen<>'manual' AND ${previousDates('DATE(creado_en)')}),'manualKcal',(SELECT SUM(energia_kcal) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND origen='manual' AND ${previousDates('DATE(creado_en)')}),'deviceKcal',(SELECT SUM(energia_kcal) FROM registros_entrenamientos WHERE usuario_id=${claims.sub} AND origen<>'manual' AND ${previousDates('DATE(creado_en)')})));
SELECT JSON_OBJECT('current',(SELECT COUNT(*) FROM registros_plicometro WHERE usuario_id=${claims.sub} AND ${currentDates('fecha')}),'previous',(SELECT COUNT(*) FROM registros_plicometro WHERE usuario_id=${claims.sub} AND ${previousDates('fecha')}));`)).split('\n');
        json(response, 200, { nutrition: JSON.parse(result), body: JSON.parse(body), activity: JSON.parse(activity), plicometric: JSON.parse(plicometric) });
      } catch {
        const traceId = randomUUID();
        try { await dbQuery(`INSERT INTO errores_aplicacion(ocurrido_en,area,trace_id,evento,etapa,accion_realizada,metodo_http,ruta,codigo_error,nombre_error,http_status,descripcion_error) VALUES (UTC_TIMESTAMP(3),${textSql('dashboard-progress')},${textSql(traceId)},${textSql('progress_data_load_failed')},${textSql('read')},${textSql('GET /api/progress/nutrition')},${textSql('GET')},${textSql('/api/progress/nutrition')},${textSql('PROGRESS_DATA_READ_FAILED')},${textSql('Error')},503,${textSql('No se pudieron consultar los datos de progreso.')});`); }
        catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
        authError(response, 503, 'No se pudo cargar el resumen nutricional.');
      }
      return;
    }

    if (pathname === '/api/food/session') {
      if (!['POST', 'DELETE'].includes(request.method)) { response.writeHead(405, { Allow: 'POST, DELETE' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (request.method === 'POST' && !allowAttempt(request, response, 'food-session')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      if (request.method === 'DELETE') {
        let closeContext = {};
        if (request.headers['content-type']) {
          try { closeContext = await bodyJson(request); }
          catch (error) { authError(response, error.status || 400, 'No se pudo leer el contexto de cierre.'); return; }
        }
        const trace = { id: randomUUID(), events: [] };
        try {
          await deleteFoodOpenCodeSession({ userId: claims.sub, dbQuery, requestOpenCode: openCodeRequest });
          await clearFoodChatHistory({ userId: claims.sub, requestId: closeContext.requestId, targetEntryId: closeContext.targetEntryId, dbQuery, textSql });
          json(response, 200, { ok: true });
        } catch (error) {
          try { await recordFoodError({ dbQuery, textSql, userId: claims.sub, trace, stage: 'cancel_session', error, httpStatus: 503, action: 'DELETE /api/food/session', route: '/api/food/session', method: 'DELETE' }); }
          catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: trace.id })); }
          authError(response, 503, 'No se pudo eliminar la sesión de comida.');
        }
        return;
      }
      json(response, 200, { ok: true });
      return;
    }

    if (pathname === '/api/training/session') {
      if (request.method !== 'DELETE') { response.writeHead(405, { Allow: 'DELETE' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try {
        await deleteTrainingSession({ userId: claims.sub, requestOpenCode: openCodeRequest });
        json(response, 200, { ok: true });
      } catch {
        const traceId = randomUUID();
        try {
          await dbQuery(`INSERT INTO errores_aplicacion(ocurrido_en,area,trace_id,evento,etapa,accion_realizada,metodo_http,ruta,usuario_id,codigo_error,nombre_error,http_status,descripcion_error) VALUES (UTC_TIMESTAMP(3),${textSql('training-opencode')},${textSql(traceId)},${textSql('session_cleanup_failed')},${textSql('cancel_session')},${textSql('DELETE /api/training/session')},${textSql('DELETE')},${textSql('/api/training/session')},${claims.sub},${textSql('TRAINING_SESSION_CANCEL_CLEANUP')},${textSql('Error')},503,${textSql('No se pudo eliminar la sesión OpenCode de entrenamiento al cancelar.')});`);
        } catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
        authError(response, 503, 'No se pudo eliminar la sesión de entrenamiento.');
      }
      return;
    }

    if (pathname === '/api/chef-chat') {
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'chef-chat')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      let data;
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Mensaje no válido.'); return; }
      if (typeof data.message !== 'string' || !data.message.trim() || data.message.length > 2000) {
        authError(response, 400, 'Escribe un mensaje de hasta 2000 caracteres.'); return;
      }
      const timezone = request.headers['x-client-timezone'] || 'UTC';
      let date = data.date;
      if (!date) {
        try { date = localCalendarDate(timezone); }
        catch { authError(response, 400, 'No se pudo determinar la fecha local.'); return; }
      }
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
        || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
        authError(response, 400, 'La fecha seleccionada no es válida.'); return;
      }
      let stage = 'nutrition_context';
      try {
        const [foodRecords, allTrainingRecords, preferences, activePlan] = await Promise.all([
          readFoodEntries({ userId: claims.sub, fecha: date, dbQuery, textSql }),
          readTrainingEntries({ userId: claims.sub, dbQuery, date, timezone }),
          readPreferences({ userId: claims.sub, dbQuery }),
          readTrainingPlanForDate({ userId: claims.sub, date, dbQuery, textSql }),
        ]);
        const trainingRecords = visibleTrainingEntries(allTrainingRecords, preferences);
        const nutritionContext = buildChefNutritionContext({ date, foodRecords, trainingRecords, exercise: calculateTrainingEnergy(trainingRecords), activePlan });
        stage = 'open_code_response';
        const answer = await sendChefMessage({ userId: claims.sub, message: data.message, nutritionContext, requestOpenCode: openCodeRequest });
        json(response, 200, { answer });
      } catch (error) {
        const traceId = randomUUID();
        const status = error.status || 502;
        if (status >= 500) {
          try { await recordApplicationError({ dbQuery, textSql, userId: claims.sub, traceId, area: 'chef-opencode', event: 'chef_reply_failed', stage, action: 'POST /api/chef-chat', method: 'POST', route: '/api/chef-chat', httpStatus: status, error, description: 'No se pudo generar una respuesta de Chef.' }); }
          catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
          json(response, status, { error: 'No se pudo generar una respuesta de Chef.', traceId });
        } else authError(response, status, error.message || 'Mensaje no válido.');
      }
      return;
    }

    if (pathname === '/api/chef-chat/session') {
      if (request.method !== 'DELETE') { response.writeHead(405, { Allow: 'DELETE' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'chef-chat-session')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try { json(response, 200, { ok: true, deleted: await deleteChefSession({ userId: claims.sub, requestOpenCode: openCodeRequest }) }); }
      catch (error) {
        const traceId = randomUUID();
        try { await recordApplicationError({ dbQuery, textSql, userId: claims.sub, traceId, area: 'chef-opencode', event: 'chef_session_cleanup_failed', stage: 'cleanup', action: 'DELETE /api/chef-chat/session', method: 'DELETE', route: '/api/chef-chat/session', httpStatus: 503, error, description: 'No se pudo cerrar la sesión temporal de Chef.' }); }
        catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
        json(response, 503, { error: 'No se pudo cerrar la sesión de Chef.', traceId });
      }
      return;
    }

    if (pathname === '/api/training-progress') {
      if (request.method !== 'GET') { response.writeHead(405, { Allow: 'GET' }).end(); return; }
      let claims;
      try { claims = await authenticatedForProgress(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      const progressId = new URL(request.url, 'http://localhost').searchParams.get('progressId') || '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(progressId)) {
        authError(response, 400, 'Solicitud de progreso no válida.'); return;
      }
      json(response, 200, { progress: getTrainingProgress(claims.sub, progressId) });
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
      if (data.progressId != null && (typeof data.progressId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.progressId))) {
        authError(response, 400, 'Solicitud de progreso no válida.'); return;
      }
      if (data.userMessages != null && (!Array.isArray(data.userMessages) || data.userMessages.length > 20 || data.userMessages.some((message) => typeof message !== 'string' || message.length > 1200))) {
        authError(response, 400, 'El historial del entrenamiento no es válido.'); return;
      }
      const traceId = randomUUID();
      const progressRecorder = createAnalysisProgressRecorder({ dbQuery, textSql, userId: claims.sub, flow: 'entrenamiento', operationId: data.progressId || traceId });
      let stage = 'analysis';
      try {
        reportTrainingProgress(claims.sub, data.progressId, 'analysis_context_started', progressRecorder.record);
        const timezone = request.headers['x-client-timezone'] || 'UTC';
        const localDate = localCalendarDate(timezone);
        const biometricData = JSON.parse(await dbQuery(`SELECT JSON_OBJECT('latestBiometric',(SELECT JSON_OBJECT('weightKg',peso_kg,'measuredAt',DATE_FORMAT(medido_en,'%Y-%m-%d %H:%i:%s'),'source',fuente) FROM registros_biometricos WHERE usuario_id=${claims.sub} ORDER BY medido_en DESC,id DESC LIMIT 1),'registeredHeightCm',(SELECT estatura_cm FROM usuarios WHERE id=${claims.sub} LIMIT 1));`));
        const latest = biometricData.latestBiometric;
        reportTrainingProgress(claims.sub, data.progressId, 'analysis_context_ready', progressRecorder.record);
        const measuredDate = typeof latest?.measuredAt === 'string' ? latest.measuredAt.slice(0, 10) : '';
        const ageDays = (Date.parse(`${localDate}T00:00:00Z`) - Date.parse(`${measuredDate}T00:00:00Z`)) / 86400000;
        const latestWeightStale = latest?.weightKg != null && (!Number.isFinite(ageDays) || ageDays < 0 || ageDays > 60);
        const analysis = await analyzeTraining({ userId: claims.sub, description: data.description, userWeightContext: (data.userMessages || [data.description]).join('\n'), stepContext: { localDate, timezone }, biometricData: {
          latestWeightKg: latestWeightStale ? null : latest?.weightKg,
          latestWeightStale,
          weightMeasuredAt: latest?.measuredAt,
          weightSource: latest?.source,
          registeredHeightCm: biometricData.registeredHeightCm,
        }, progressId: data.progressId, progressRecorder, requestOpenCode: openCodeRequest });
        if (analysis.stepsCount !== null) {
          stage = 'steps';
          analysis.stepsSaved = await saveDailySteps({
            userId: claims.sub, date: analysis.stepsDate || localDate, localDate,
            stepsCount: analysis.stepsCount, source: 'manual', dbQuery, textSql,
          });
          reportTrainingProgress(claims.sub, data.progressId, 'analysis_steps_saved', progressRecorder.record);
        }
        if (analysis.trainingSession && analysis.caloriesKcal == null && analysis.question) {
          await dbQuery(`${resolveNotificationsSql({ userId: claims.sub, category: 'entrenamiento', textSql })};`);
          if (data.suppressNotification !== true) await addNotification({ userId: claims.sub, category: 'entrenamiento', state: 'requiere_respuesta', title: 'Entrenamiento: falta una aclaración', message: analysis.question, dbQuery, textSql });
        }
        reportTrainingProgress(claims.sub, data.progressId, 'analysis_complete', progressRecorder.record);
        await progressRecorder.flush();
        json(response, 200, { analysis });
      }
      catch (error) {
        reportTrainingProgress(claims.sub, data.progressId, 'analysis_failed', progressRecorder.record);
        await progressRecorder.flush();
        try { await recordTrainingError({ dbQuery, textSql, userId: claims.sub, traceId, stage, error, httpStatus: error.status || 502, action: 'POST /api/training-analysis' }); }
        catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
        if (data.suppressNotification !== true) try { await addNotification({ userId: claims.sub, category: 'entrenamiento', state: 'error', title: 'No se pudo analizar el entrenamiento', message: 'Revisa el modal de entrenamiento e inténtalo de nuevo.', dbQuery, textSql }); } catch {}
        authError(response, error.status || 502, error.status ? error.message : 'No se pudo analizar el entrenamiento.');
      }
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
      if (data.progressId != null && (typeof data.progressId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.progressId))) {
        authError(response, 400, 'Solicitud de progreso no válida.'); return;
      }
      const traceId = randomUUID();
      const progressRecorder = createAnalysisProgressRecorder({ dbQuery, textSql, userId: claims.sub, flow: 'plan', operationId: data.progressId || traceId });
      try {
        reportTrainingProgress(claims.sub, data.progressId, 'plan_context_started', progressRecorder.record);
        const labels = new Set(['profile', 'preferences', 'biometrics', 'plicometrics', 'age', 'previousPlan']);
        const contextRows = await dbQuery(`SELECT 'profile'; ${accountProfileSql(claims.sub)}
SELECT 'preferences'; ${preferencesSql(claims.sub)}
SELECT 'biometrics'; SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('measuredAt',DATE_FORMAT(medido_en,'%Y-%m-%d %H:%i:%s'),'source',fuente,'weightKg',peso_kg,'bodyAge',edad_corporal,'bodyFatPct',grasa_pct,'restingMetabolismKcal',metabolismo_basal_kcal,'visceralFat',grasa_visceral,'bmi',imc,'musclePct',musculo_pct)),JSON_ARRAY()) FROM (SELECT medido_en,fuente,peso_kg,edad_corporal,grasa_pct,metabolismo_basal_kcal,grasa_visceral,imc,musculo_pct FROM registros_biometricos WHERE usuario_id=${claims.sub} ORDER BY medido_en DESC,id DESC LIMIT 24) AS biometric_records;
SELECT 'plicometrics'; SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('fecha',fecha,'tricepsMm',triceps_mm,'bicepsMm',biceps_mm,'subescapularMm',subescapular_mm,'suprailiacoMm',suprailiaco_mm,'abdominalMm',abdominal_mm,'musloAnteriorMm',muslo_anterior_mm,'pantorrillaMm',pantorrilla_mm)),JSON_ARRAY()) FROM (SELECT id,fecha,triceps_mm,biceps_mm,subescapular_mm,suprailiaco_mm,abdominal_mm,muslo_anterior_mm,pantorrilla_mm FROM registros_plicometro WHERE usuario_id=${claims.sub} ORDER BY fecha DESC,id DESC LIMIT 24) AS plicometric_records;
SELECT 'age'; SELECT JSON_OBJECT('age',edad) FROM usuarios WHERE id=${claims.sub} LIMIT 1;
SELECT 'previousPlan'; SELECT JSON_OBJECT('createdAt',DATE_FORMAT(creado_en,'%Y-%m-%dT%H:%i:%sZ'),'goals',objetivos,'content',contenido,'macros',JSON_OBJECT('proteinas_g',objetivo_proteinas_g,'carbohidratos_g',objetivo_carbohidratos_g,'grasas_g',objetivo_grasas_g,'calorias_kcal',objetivo_calorias_kcal)) FROM planes_entrenamiento WHERE usuario_id=${claims.sub} ORDER BY creado_en DESC,id DESC LIMIT 1;`);
        const contextData = new Map();
        let currentLabel = '';
        for (const row of contextRows.split(/\r?\n/).filter(Boolean)) {
          if (labels.has(row)) currentLabel = row;
          else if (currentLabel) { contextData.set(currentLabel, row); currentLabel = ''; }
        }
        const profile = contextData.has('profile') ? JSON.parse(contextData.get('profile')) : null;
        const preferences = contextData.has('preferences') ? JSON.parse(contextData.get('preferences')) : null;
        const ageRow = contextData.get('age');
        const age = ageRow ? JSON.parse(ageRow).age : null;
        const biometrics = JSON.parse(contextData.get('biometrics') || '[]');
        const plicometrics = JSON.parse(contextData.get('plicometrics') || '[]');
        const previousPlanRow = contextData.get('previousPlan');
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
          previousTrainingPlanSummary: summarizeTrainingPlan(previousPlanRow ? JSON.parse(previousPlanRow) : null),
        };
        reportTrainingProgress(claims.sub, data.progressId, 'plan_context_ready', progressRecorder.record);
        const generated = await generateTrainingPlan({ userId: claims.sub, goals: data && typeof data === 'object' ? data.goals : undefined, context, progressId: data.progressId, progressRecorder, requestOpenCode: openCodeRequest });
        reportTrainingProgress(claims.sub, data.progressId, 'plan_complete', progressRecorder.record);
        await progressRecorder.flush();
        if (data.suppressNotification !== true) try { await addNotification({ userId: claims.sub, category: 'plan', state: 'generado', title: 'Plan generado, aún sin guardar', message: 'Tu plan está listo para revisar y guardar.', dbQuery, textSql }); } catch {}
        json(response, 200, generated);
      } catch (error) {
        reportTrainingProgress(claims.sub, data.progressId, 'plan_failed', progressRecorder.record);
        await progressRecorder.flush();
        if (data.suppressNotification !== true) try { await addNotification({ userId: claims.sub, category: 'plan', state: 'error', title: 'No se pudo generar el plan', message: 'Revisa el modal de plan e inténtalo de nuevo.', dbQuery, textSql }); } catch {}
        const status = error.status || 502;
        if (status >= 500) {
          const source = error.code === 'TRAINING_PLAN_SESSION_CLEANUP' && error.cause ? error.cause : error;
          const code = typeof source.code === 'string' && /^[A-Z][A-Z0-9_]{0,55}$/.test(source.code) ? source.code : 'TRAINING_PLAN_GENERATION_FAILED';
          const name = typeof source.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(source.name) ? source.name : 'Error';
          try {
            await dbQuery(`INSERT INTO errores_aplicacion(ocurrido_en,area,trace_id,evento,etapa,accion_realizada,metodo_http,ruta,usuario_id,codigo_error,nombre_error,http_status,descripcion_error) VALUES (UTC_TIMESTAMP(3),${textSql('training-opencode')},${textSql(traceId)},${textSql('plan_generation_failed')},${textSql('generation')},${textSql('POST /api/training-plan')},${textSql('POST')},${textSql('/api/training-plan')},${claims.sub},${textSql(code)},${textSql(name)},${status},${textSql('No se pudo generar el plan de entrenamiento.')});`);
          } catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
        }
        const cleanupFailed = error.code === 'TRAINING_PLAN_SESSION_CLEANUP';
        const sessionOpenFailed = error.code === 'TRAINING_PLAN_SESSION_OPEN';
        const message = cleanupFailed ? 'No se pudo cerrar la sesión temporal; el plan no se guardó en la aplicación.' : sessionOpenFailed ? 'No se pudo preparar el análisis del plan.' : error.status ? error.message : 'No se pudo generar el plan de entrenamiento.';
        if (status >= 500) json(response, status, { error: message, traceId });
        else authError(response, status, message);
      }
      return;
    }

    if (pathname === '/api/training-plan/session') {
      if (request.method !== 'DELETE') { response.writeHead(405, { Allow: 'DELETE' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'training-plan-session-cancel')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      try {
        const deleted = await deleteTrainingPlanSession({ userId: claims.sub, requestOpenCode: openCodeRequest });
        json(response, 200, { ok: true, deleted });
      } catch {
        const traceId = randomUUID();
        try {
          await dbQuery(`INSERT INTO errores_aplicacion(ocurrido_en,area,trace_id,evento,etapa,accion_realizada,metodo_http,ruta,usuario_id,codigo_error,nombre_error,http_status,descripcion_error) VALUES (UTC_TIMESTAMP(3),${textSql('training-opencode')},${textSql(traceId)},${textSql('session_cleanup_failed')},${textSql('cancel_plan_session')},${textSql('DELETE /api/training-plan/session')},${textSql('DELETE')},${textSql('/api/training-plan/session')},${claims.sub},${textSql('TRAINING_PLAN_SESSION_CANCEL_CLEANUP')},${textSql('Error')},503,${textSql('No se pudo eliminar la sesión OpenCode del plan al cancelar.')});`);
        } catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
        authError(response, 503, 'No se pudo eliminar la sesión del plan de entrenamiento.');
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

    const trainingPlanActivate = pathname.match(/^\/api\/training-plans\/([1-9]\d{0,19})\/activate$/);
    if (trainingPlanActivate) {
      if (request.method !== 'POST') { response.writeHead(405, { Allow: 'POST' }).end(); return; }
      if (!sameOrigin(request)) { authError(response, 403, 'Solicitud no permitida.'); return; }
      if (!allowAttempt(request, response, 'training-plan-activate')) return;
      let claims;
      try { claims = await authenticated(request); }
      catch { authError(response, 503, 'No se pudo validar la sesión.'); return; }
      if (!claims) { authError(response, 401, 'La sesión expiró. Inicia sesión de nuevo.'); return; }
      let data;
      try { data = await bodyJson(request, 4096); }
      catch (error) { authError(response, error.status || 400, 'La fecha de inicio no es válida.'); return; }
      const parsedStartDate = typeof data.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.startDate) ? Date.parse(`${data.startDate}T00:00:00Z`) : NaN;
      if (!Number.isFinite(parsedStartDate) || new Date(parsedStartDate).toISOString().slice(0, 10) !== data.startDate) { authError(response, 400, 'La fecha de inicio no es válida.'); return; }
      const traceId = randomUUID();
      try {
        const timezone = await readCalendarTimezone(claims.sub, dbQuery, request.headers['x-client-timezone']);
        const today = localCalendarDate(timezone);
        const { start, end } = calendarDayRange(data.startDate, timezone);
        const activated = await activateTrainingPlan({ userId: claims.sub, planId: trainingPlanActivate[1], startDate: data.startDate, today, dayStart: start, dayEnd: end, dbQuery, textSql });
        json(response, 200, { ok: true, ...activated });
      } catch (error) {
        const status = Number.isInteger(error.status) ? error.status : 503;
        if (status === 503) try { await recordTrainingError({ dbQuery, textSql, userId: claims.sub, traceId, stage: 'activation', error, httpStatus: status, action: `POST /api/training-plans/${trainingPlanActivate[1]}/activate` }); } catch {}
        authError(response, status, status === 503 ? 'No se pudo activar el plan.' : error.message);
      }
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
        const disclosure = extractPlanDisclosure(await readTrainingPlanPrompt());
        const [profile, factsRow] = await Promise.all([
          readAccountProfile({ userId: claims.sub, dbQuery }),
          dbQuery(`SELECT JSON_OBJECT('age',(SELECT edad FROM usuarios WHERE id=${claims.sub} LIMIT 1),'hasWeight',EXISTS(SELECT 1 FROM registros_biometricos WHERE usuario_id=${claims.sub} AND peso_kg IS NOT NULL),'bodyFacts',JSON_OBJECT('bmi',EXISTS(SELECT 1 FROM registros_biometricos WHERE usuario_id=${claims.sub} AND imc IS NOT NULL),'bodyFatPct',EXISTS(SELECT 1 FROM registros_biometricos WHERE usuario_id=${claims.sub} AND grasa_pct IS NOT NULL),'musclePct',EXISTS(SELECT 1 FROM registros_biometricos WHERE usuario_id=${claims.sub} AND musculo_pct IS NOT NULL),'visceralFat',EXISTS(SELECT 1 FROM registros_biometricos WHERE usuario_id=${claims.sub} AND grasa_visceral IS NOT NULL),'bodyAge',EXISTS(SELECT 1 FROM registros_biometricos WHERE usuario_id=${claims.sub} AND edad_corporal IS NOT NULL),'restingMetabolismKcal',EXISTS(SELECT 1 FROM registros_biometricos WHERE usuario_id=${claims.sub} AND metabolismo_basal_kcal IS NOT NULL)),'plicometryFacts',JSON_OBJECT('tricepsMm',EXISTS(SELECT 1 FROM registros_plicometro WHERE usuario_id=${claims.sub} AND triceps_mm IS NOT NULL),'bicepsMm',EXISTS(SELECT 1 FROM registros_plicometro WHERE usuario_id=${claims.sub} AND biceps_mm IS NOT NULL),'subescapularMm',EXISTS(SELECT 1 FROM registros_plicometro WHERE usuario_id=${claims.sub} AND subescapular_mm IS NOT NULL),'suprailiacoMm',EXISTS(SELECT 1 FROM registros_plicometro WHERE usuario_id=${claims.sub} AND suprailiaco_mm IS NOT NULL),'abdominalMm',EXISTS(SELECT 1 FROM registros_plicometro WHERE usuario_id=${claims.sub} AND abdominal_mm IS NOT NULL),'musloAnteriorMm',EXISTS(SELECT 1 FROM registros_plicometro WHERE usuario_id=${claims.sub} AND muslo_anterior_mm IS NOT NULL),'pantorrillaMm',EXISTS(SELECT 1 FROM registros_plicometro WHERE usuario_id=${claims.sub} AND pantorrilla_mm IS NOT NULL)));`),
        ]);
        const facts = JSON.parse(factsRow);
        const context = { profile: { age: facts.age, sex: profile?.sex ?? null, heightCm: profile?.heightCm ?? null, restingMetabolismKcal: profile?.restingMetabolismKcal ?? null }, hasWeight: facts.hasWeight, bodyFacts: facts.bodyFacts, plicometryFacts: facts.plicometryFacts };
        const saved = await saveTrainingPlan({ userId: claims.sub, requestId: data.runId, goals: data.goals, plan: data.plan, macros: data.macros, disclosure, context, dbQuery, textSql });
        if (typeof data.runId === 'string') try {
          await deleteTrainingPlanSession({ userId: claims.sub, runId: data.runId, requestOpenCode: openCodeRequest });
        } catch {
          const traceId = randomUUID();
          try {
            await dbQuery(`INSERT INTO errores_aplicacion(ocurrido_en,area,trace_id,evento,etapa,accion_realizada,metodo_http,ruta,usuario_id,codigo_error,nombre_error,http_status,descripcion_error) VALUES (UTC_TIMESTAMP(3),${textSql('training-opencode')},${textSql(traceId)},${textSql('session_cleanup_failed')},${textSql('after_plan_saved')},${textSql('POST /api/training-plans')},${textSql('POST')},${textSql('/api/training-plans')},${claims.sub},${textSql('TRAINING_PLAN_SESSION_CLEANUP')},${textSql('Error')},201,${textSql('No se pudo eliminar la sesión OpenCode después de guardar el plan.')});`);
          } catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
        }
        if (saved.inserted) {
          try { await dbQuery(`${resolveNotificationsSql({ userId: claims.sub, category: 'plan', state: 'generado', textSql })};`); } catch {}
          if (data.suppressNotification !== true) try { await addNotification({ userId: claims.sub, category: 'plan', state: 'guardado', title: 'Plan guardado', message: 'Tu plan de entrenamiento quedó guardado.', referenceId: saved.id, dbQuery, textSql }); } catch {}
        }
        json(response, 201, { ok: true, ...saved });
      } catch (error) {
        if (data.suppressNotification !== true) try { await addNotification({ userId: claims.sub, category: 'plan', state: 'error', title: 'No se pudo guardar el plan', message: 'Intenta guardar el plan nuevamente.', dbQuery, textSql }); } catch {}
        const traceId = randomUUID();
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 503;
        const mysqlError = String(error.message || '').match(/\bERROR\s+(\d+)\s+\(([A-Z0-9]{5})\)/);
        const code = mysqlError ? `MYSQL_${mysqlError[1]}_${mysqlError[2]}`
          : typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,55}$/.test(error.code) ? error.code : 'TRAINING_PLAN_SAVE_FAILED';
        const name = typeof error.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error';
        try {
          await dbQuery(`INSERT INTO errores_aplicacion(ocurrido_en,area,trace_id,evento,etapa,accion_realizada,metodo_http,ruta,usuario_id,codigo_error,nombre_error,http_status,descripcion_error) VALUES (UTC_TIMESTAMP(3),${textSql('training-plan-save')},${textSql(traceId)},${textSql('plan_save_failed')},${textSql('persistence')},${textSql('POST /api/training-plans')},${textSql('POST')},${textSql('/api/training-plans')},${claims.sub},${textSql(code)},${textSql(name)},${status},${textSql('No se pudo guardar el plan de entrenamiento.')});`);
        } catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
        json(response, status, { error: error.status ? error.message : 'No se pudo guardar el plan.', traceId });
      }
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
          json(response, 200, { records: visibleRecords, garminEnabled, ...(date ? { exercise: calculateTrainingEnergy(visibleRecords), activePlan: await readTrainingPlanForDate({ userId: claims.sub, date, dbQuery, textSql }) } : {}) });
        }
        catch (error) { authError(response, error.status || 503, error.status ? error.message : 'No se pudieron cargar los entrenamientos.'); }
        return;
      }
      if (!allowAttempt(request, response, 'training-entry')) return;
      let data;
      try { data = await bodyJson(request); }
      catch (error) { authError(response, error.status || 400, 'Datos no válidos.'); return; }
      await saveTrainingEntry({ response, data, userId: claims.sub, dbQuery, textSql, json, timezone: request.headers['x-client-timezone'] });
      if (response.statusCode === 201) {
        try { await deleteTrainingSession({ userId: claims.sub, requestOpenCode: openCodeRequest }); }
        catch {
          const traceId = randomUUID();
          try {
            await dbQuery(`INSERT INTO errores_aplicacion(ocurrido_en,area,trace_id,evento,etapa,accion_realizada,metodo_http,ruta,usuario_id,codigo_error,nombre_error,http_status,descripcion_error) VALUES (UTC_TIMESTAMP(3),${textSql('training-opencode')},${textSql(traceId)},${textSql('session_cleanup_failed')},${textSql('after_training_saved')},${textSql('POST /api/training-entries')},${textSql('POST')},${textSql('/api/training-entries')},${claims.sub},${textSql('TRAINING_SESSION_CLEANUP')},${textSql('Error')},201,${textSql('No se pudo eliminar la sesión OpenCode después de guardar el entrenamiento.')});`);
          } catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
        }
      }
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
      let body = await readFile(path.join(__dirname, files.get(pathname)));
      if (pathname === '/dashboard_nutricional.html') body = Buffer.from(body.toString().replace('__APP_VERSION__', appVersion));
      const versionedAsset = /\.(?:css|js)$/.test(pathname) && /[?&]v=[^&]+/.test(request.url);
      response.writeHead(200, { 'Content-Type': contentTypes[path.extname(files.get(pathname))], 'Content-Length': body.length, 'Cache-Control': versionedAsset ? 'public, max-age=31536000, immutable' : 'no-store' });
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
