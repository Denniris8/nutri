const path = require('node:path');
const { homedir } = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { readFile } = require('node:fs/promises');

let localServer;
let localServerStart;
const sessionLocks = new Map();
const verifiedFoodSessions = new Map();
const foodConfigPath = path.resolve(__dirname, '../../configuracion-sesion.json');
const foodBehaviorPath = path.resolve(__dirname, '../../comportamiento-sesion-comidas.md');

function getFoodSessionDefaults() {
  return { model: null, agent: null, variant: null, requestTimeoutMs: 600000, usdaTimeoutMs: 10000, maxFoodItems: 12, usdaCandidateLimit: 10 };
}

async function readFoodSessionConfig(filePath = foodConfigPath) {
  let config;
  try { config = JSON.parse(await readFile(filePath, 'utf8')); }
  catch { throw new Error('No se pudo leer configuracion-sesion.json.'); }
  const allowed = new Set(['model', 'agent', 'variant', 'requestTimeoutMs', 'usdaTimeoutMs', 'maxFoodItems', 'usdaCandidateLimit']);
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some((key) => !allowed.has(key))) throw new Error('La configuración de sesión contiene campos no permitidos.');
  let model = null;
  if (config.model != null) {
    const { providerID, modelID } = config.model;
    if (typeof providerID !== 'string' || typeof modelID !== 'string' || !/^[\w.-]{1,100}$/.test(providerID) || !/^[\w.:/-]{1,150}$/.test(modelID)) throw new Error('El proveedor o modelo configurado no es válido.');
    model = { providerID, modelID };
  }
  const text = (value, name) => {
    if (value == null) return null;
    if (typeof value !== 'string' || !/^[\w.-]{1,80}$/.test(value)) throw new Error(`La opción ${name} no es válida.`);
    return value;
  };
  const integer = (value, fallback, min, max, name) => {
    const number = value == null ? fallback : value;
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(`La opción ${name} debe estar entre ${min} y ${max}.`);
    return number;
  };
  return {
    model, agent: text(config.agent, 'agent'), variant: text(config.variant, 'variant'),
    requestTimeoutMs: integer(config.requestTimeoutMs, 600000, 10000, 600000, 'requestTimeoutMs'),
    usdaTimeoutMs: integer(config.usdaTimeoutMs, 10000, 3000, 30000, 'usdaTimeoutMs'),
    maxFoodItems: integer(config.maxFoodItems, 12, 1, 12, 'maxFoodItems'),
    usdaCandidateLimit: integer(config.usdaCandidateLimit, 10, 1, 10, 'usdaCandidateLimit'),
  };
}

async function readFoodSystemPrompt(maxFoodItems) {
  const document = await readFile(foodBehaviorPath, 'utf8');
  const prompt = document.match(/<!-- FOOD_OPENCODE_PROMPT_START -->([\s\S]*?)<!-- FOOD_OPENCODE_PROMPT_END -->/);
  if (!prompt) throw new Error('No se encontró el prompt canónico de registro de comidas.');
  return prompt[1].trim().replace(/\{\{MAX_FOOD_ITEMS\}\}/g, String(maxFoodItems));
}
const foodSessionPermissions = [
  { permission: '*', pattern: '*', action: 'deny' },
  { permission: 'webfetch', pattern: '*', action: 'allow' },
  { permission: 'websearch', pattern: '*', action: 'allow' },
];
const openCodeErrorCodes = new Set([
  'ABORT_ERR', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  'SERVICE_CONFIG', 'SERVICE_UNAVAILABLE', 'SERVICE_START_FAILED', 'TIMEOUT', 'OPEN_CODE_ERROR', 'OPENCODE_HTTP_ERROR',
  'FOOD_RESPONSE_NO_ITEMS', 'FOOD_RESPONSE_INVALID_ITEMS', 'FOOD_RESPONSE_INVALID_CLARIFICATION', 'FOOD_RESPONSE_INVALID_STRUCTURE',
  'FOOD_PERSISTENCE_VERIFY_FAILED',
]);

function safeOpenCodeErrorCode(error) {
  for (const code of [error?.code, error?.cause?.code]) if (openCodeErrorCodes.has(code)) return code;
  return error?.name === 'TimeoutError' ? 'TIMEOUT' : 'OPEN_CODE_ERROR';
}

function traceFoodSession(trace, event, details = {}) {
  if (!trace) return;
  const entry = { at: new Date().toISOString(), event, ...details };
  trace.events.push(entry);
  console.info(JSON.stringify({ area: 'food-opencode', trace_id: trace.id, ...entry }));
}

function openCodeHttpError(status, operation, message) {
  return Object.assign(new Error(message), { code: 'OPENCODE_HTTP_ERROR', status, operation });
}

async function requestOpenCodePrompt(service, sessionId, body, timeoutMs) {
  const messagePath = `/api/session/${sessionId}/message`;
  const promptPath = `/api/session/${sessionId}/prompt`;
  const waitPath = `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`;
  const text = [body.system, ...(body.parts || []).filter((part) => part.type === 'text').map((part) => part.text)]
    .filter(Boolean).join('\n\n');
  const submitted = await request(service, 'POST', promptPath, { text }, timeoutMs);
  if (submitted.status < 200 || submitted.status >= 300) throw openCodeHttpError(submitted.status, `POST ${promptPath}`, 'OpenCode no pudo aceptar el mensaje.');
  const userMessageId = submitted.data?.id;
  if (typeof userMessageId !== 'string') throw new Error('OpenCode no devolvió el identificador del mensaje.');
  const waited = await request(service, 'POST', waitPath, undefined, timeoutMs);
  if (waited.status < 200 || waited.status >= 300) throw openCodeHttpError(waited.status, `POST ${waitPath}`, 'OpenCode no terminó el mensaje.');
  const history = await request(service, 'GET', `${messagePath}?order=desc&limit=20`, undefined, timeoutMs);
  if (history.status < 200 || history.status >= 300) throw openCodeHttpError(history.status, `GET ${messagePath}`, 'OpenCode no devolvió el historial del mensaje.');
  const messages = Array.isArray(history.data?.data) ? history.data.data : Array.isArray(history.data) ? history.data : [];
  const userIndex = messages.findIndex((message) => message.id === userMessageId);
  const reply = userIndex > 0 ? messages.slice(0, userIndex).find((message) => message.type === 'assistant') : null;
  if (!reply || reply.time?.completed == null) throw Object.assign(new Error('OpenCode no devolvió una respuesta completa.'), { code: 'OPEN_CODE_ERROR' });
  if (reply.error) throw Object.assign(new Error('OpenCode no pudo completar el mensaje.'), { code: 'OPEN_CODE_ERROR' });
  return { status: 200, data: { info: { id: reply.id }, parts: reply.content || [] } };
}

async function recordFoodError({ dbQuery, textSql, userId, trace, stage, error, httpStatus = null, action = 'POST /api/food-entries', route = '/api/food-entries', method = 'POST' }) {
  const failure = trace?.events.slice().reverse().find((item) => item.event.endsWith('_failed'));
  const event = failure?.event || 'save_failed';
  const errorText = typeof error?.message === 'string' ? error.message : '';
  const mysqlError = errorText.match(/\bERROR\s+(\d+)\s+\(([A-Z0-9]{5})\)/);
  const rawCode = error?.code ?? error?.cause?.code;
  const errorCode = mysqlError ? `MYSQL_${mysqlError[1]}_${mysqlError[2]}`
    : typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,55}$/.test(rawCode) ? rawCode
      : Number.isInteger(error?.status) ? `HTTP_${error.status}` : safeOpenCodeErrorCode(error);
  const errorName = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : null;
  const description = {
    session_resolution_failed: 'No se pudo resolver o crear la sesión OpenCode de comidas.',
    session_open_failed: 'No se pudo abrir la sesión OpenCode de comidas.',
    message_failed: 'OpenCode no completó el análisis del registro de comida.',
    reply_parse_failed: 'La respuesta del análisis no pudo convertirse en datos válidos.',
    reply_validation_failed: 'La respuesta del análisis no pasó la validación de alimentos.',
    draft_candidate_persistence_failed: 'No se pudo guardar un candidato de alimento en el borrador; la aclaración se conservó.',
    session_cleanup_failed: 'No se pudo limpiar la sesión OpenCode de comidas.',
  }[event] || (stage === 'persistence' ? 'No se pudieron guardar los alimentos analizados.' : 'Falló el registro de comida.');
  const upstreamStatus = [failure?.upstreamHttpStatus, failure?.httpStatus]
    .find((status) => Number.isInteger(status) && status >= 100 && status <= 599);
  const values = [
    'food-opencode', trace?.id || null, event, failure?.stage || stage || null,
    failure?.operation || action, method, route, String(userId), errorCode,
    errorName, httpStatus, upstreamStatus ?? null, description,
  ].map((value) => value == null ? 'NULL' : textSql(String(value)));
  await dbQuery(`INSERT INTO errores_aplicacion(ocurrido_en,area,trace_id,evento,etapa,accion_realizada,metodo_http,ruta,usuario_id,codigo_error,nombre_error,http_status,upstream_http_status,descripcion_error) VALUES (UTC_TIMESTAMP(3),${values.join(',')});`);
}

const shortSessionId = (sessionId) => `…${String(sessionId).slice(-8)}`;

// ponytail: in-process per-user serialization; use a MySQL advisory lock if the dashboard runs multiple instances.
function validateServiceUrl(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1', 'host.docker.internal', 'opencode'].includes(host) || url.username || url.password) {
    throw Object.assign(new Error('OpenCode debe estar disponible en loopback.'), { code: 'SERVICE_CONFIG' });
  }
  return url.origin;
}

async function loadService() {
  const serviceFile = process.env.OPENCODE_SERVICE_FILE || path.join(homedir(), '.local', 'state', 'opencode', 'service.json');
  try {
    const service = JSON.parse(await readFile(serviceFile, 'utf8'));
    if (!service.url) throw new Error('missing_url');
    return { url: validateServiceUrl(process.env.OPENCODE_SERVICE_PROXY_URL || service.url), password: String(service.password || ''), autoStart: false };
  } catch (error) {
    if (process.env.OPENCODE_SERVICE_FILE) throw Object.assign(new Error('No se pudo cargar el registro local de OpenCode.'), { code: 'SERVICE_CONFIG' });
    const port = Number(process.env.OPENCODE_PORT || 4096);
    const url = validateServiceUrl(process.env.OPENCODE_BASE_URL || `http://127.0.0.1:${port}`);
    return { url, port: Number(new URL(url).port || 80), password: process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || '', autoStart: process.env.OPENCODE_AUTO_START !== 'false' };
  }
}

async function request(service, method, endpoint, body, timeoutMs = 120000) {
  const url = new URL(endpoint, service.url);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method,
      headers: {
        ...(service.password ? { authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString('base64')}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      signal: AbortSignal.timeout(timeoutMs),
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('aborted', () => { clearTimeout(timeout); reject(Object.assign(new Error('OpenCode response was interrupted.'), { code: 'ECONNRESET' })); });
      response.on('error', (error) => { clearTimeout(timeout); reject(error); });
      response.on('end', () => {
        clearTimeout(timeout);
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch {} }
        resolve({ status: response.statusCode || 0, data: data?.data ?? data });
      });
    });
    const timeout = setTimeout(() => request.destroy(Object.assign(new Error('OpenCode request timed out.'), { code: 'TIMEOUT' })), timeoutMs);
    request.on('error', (error) => { clearTimeout(timeout); reject(error); });
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function ensureService(service) {
  try {
    if ((await request(service, 'GET', '/global/health', undefined, 3000)).status === 200) return;
  } catch {}
  if (!service.autoStart) throw Object.assign(new Error('El servicio no está disponible.'), { code: 'SERVICE_UNAVAILABLE' });
  if (!localServer || localServer.exitCode != null) {
    if (!localServerStart) {
      localServerStart = Promise.resolve().then(() => {
        localServer = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(service.port)], {
          cwd: process.env.OPENCODE_PROJECT_DIR || path.resolve(__dirname, '../..'),
          env: { ...process.env, ...(service.password ? { OPENCODE_SERVER_PASSWORD: service.password } : {}) },
          stdio: 'ignore',
        });
        localServer.once('error', () => { localServer = null; });
        localServer.once('exit', () => { localServer = null; });
        localServer.unref();
      }).finally(() => { localServerStart = null; });
    }
    await localServerStart;
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try { if ((await request(service, 'GET', '/global/health', undefined, 3000)).status === 200) return; }
    catch {}
    if (!localServer || localServer.exitCode != null) break;
  }
  throw Object.assign(new Error('No se pudo iniciar OpenCode local.'), { code: 'SERVICE_START_FAILED' });
}

async function openCodeRequest(method, endpoint, body, timeoutMs = 120000) {
  try {
    const service = await loadService();
    await ensureService(service);
    const messagePath = method === 'POST' && endpoint.match(/^\/session\/([^/]+)\/message$/);
    if (messagePath) return await requestOpenCodePrompt(service, messagePath[1], body || {}, timeoutMs);
    if (body && typeof body === 'object' && body.permission) {
      const { permission, ...rest } = body;
      body = {
        ...rest,
        permissions: permission.map(({ permission: action, pattern: resource, action: effect }) => ({ action, resource, effect })),
      };
    }
    const apiEndpoint = endpoint === '/session' || endpoint.startsWith('/session/') ? `/api${endpoint}` : endpoint;
    return await request(service, method, apiEndpoint, body, timeoutMs);
  } catch (error) {
    throw Object.assign(new Error('El servicio no respondió a la solicitud.'), {
      code: safeOpenCodeErrorCode(error),
      ...(Number.isInteger(error.status) ? { status: error.status } : {}),
      ...(typeof error.operation === 'string' ? { operation: error.operation } : {}),
    });
  }
}

function withUserLock(userId, run) {
  const previous = sessionLocks.get(userId) || Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  sessionLocks.set(userId, current);
  return current.finally(() => { if (sessionLocks.get(userId) === current) sessionLocks.delete(userId); });
}

function withFoodSessionLock(userId, run) { return withUserLock(String(userId), run); }

async function ensureFoodOpenCodeSession({ userId, dbQuery, textSql, requestOpenCode = openCodeRequest, readConfig = readFoodSessionConfig, trace, returnMetadata = false }) {
  const id = String(userId);
  if (!/^\d+$/.test(id)) throw new Error('Cuenta autenticada no válida.');
  const config = await readConfig();
  const configFingerprint = createHash('sha256').update(JSON.stringify({ userId: id, sessionScope: 'food-conversation', model: config.model, agent: config.agent, variant: config.variant })).digest('hex');
  traceFoodSession(trace, 'session_resolution_started');
  const result = (sessionId, reused) => returnMetadata ? { sessionId, reused } : sessionId;
  return withUserLock(id, async () => {
    const cached = verifiedFoodSessions.get(id);
    if (cached?.fingerprint === configFingerprint) {
      const current = await requestOpenCode('GET', `/session/${encodeURIComponent(cached.sessionId)}`, undefined, config.requestTimeoutMs);
      if (current.status >= 200 && current.status < 300
        && current.data?.metadata?.foodUserId === id && current.data?.metadata?.foodConfigSha256 === configFingerprint) {
        traceFoodSession(trace, 'session_ready', { reused: true, session: shortSessionId(cached.sessionId) });
        return result(cached.sessionId, true);
      }
      if (current.status !== 404 && (current.status < 200 || current.status >= 300)) {
        throw openCodeHttpError(current.status, 'GET /api/session/{id}', 'No se pudo verificar la sesión OpenCode de comidas.');
      }
      verifiedFoodSessions.delete(id);
    }
    const stored = await dbQuery(`SELECT session_id FROM sesiones_comidas_opencode WHERE usuario_id=${id} LIMIT 1;`);
    if (/^ses_[A-Za-z0-9_-]{4,120}$/.test(stored || '')) {
      const current = await requestOpenCode('GET', `/session/${encodeURIComponent(stored)}`, undefined, config.requestTimeoutMs);
      if (current.status !== 404 && (current.status < 200 || current.status >= 300)) throw openCodeHttpError(current.status, 'GET /api/session/{id}', 'No se pudo verificar la sesión OpenCode de comidas.');
      if (current.status >= 200 && current.status < 300 && current.data?.metadata?.foodUserId === id
        && current.data?.metadata?.foodConfigSha256 === configFingerprint) {
        const updated = await requestOpenCode('PATCH', `/session/${encodeURIComponent(stored)}`, { permission: foodSessionPermissions }, config.requestTimeoutMs);
        if (updated.status < 200 || updated.status >= 300) throw openCodeHttpError(updated.status, 'PATCH /api/session/{id}', 'No se pudieron actualizar los permisos de la sesión de comidas.');
        verifiedFoodSessions.set(id, { sessionId: stored, fingerprint: configFingerprint });
        traceFoodSession(trace, 'session_ready', { reused: true, session: shortSessionId(stored) });
        return result(stored, true);
      }
      if (current.status >= 200 && current.status < 300 && current.data?.metadata?.foodUserId === id) {
        const deleted = await requestOpenCode('DELETE', `/session/${encodeURIComponent(stored)}`, undefined, config.requestTimeoutMs);
        if ((deleted.status < 200 || deleted.status >= 300) && deleted.status !== 404) throw openCodeHttpError(deleted.status, 'DELETE /api/session/{id}', 'No se pudo sustituir la sesión de comidas.');
      }
    }
    const model = config.model ? { id: config.model.modelID, providerID: config.model.providerID, ...(config.variant ? { variant: config.variant } : {}) } : undefined;
    const created = await requestOpenCode('POST', '/session', {
      title: 'Registro de comidas',
      ...(config.agent ? { agent: config.agent } : {}),
      ...(model ? { model } : {}),
      permission: foodSessionPermissions,
      metadata: { foodUserId: id, foodConfigSha256: configFingerprint },
    }, config.requestTimeoutMs);
    const sessionId = created.data?.id;
    if (created.status < 200 || created.status >= 300) {
      throw openCodeHttpError(created.status, 'POST /api/session', 'No se pudo iniciar la sesión OpenCode de comidas.');
    }
    if (!/^ses_[A-Za-z0-9_-]{4,120}$/.test(sessionId || '')) {
      throw new Error('No se pudo iniciar la sesión OpenCode de comidas.');
    }
    await dbQuery(`INSERT INTO sesiones_comidas_opencode(usuario_id,session_id) VALUES (${id},${textSql(sessionId)}) AS incoming ON DUPLICATE KEY UPDATE session_id=incoming.session_id,actualizado_en=CURRENT_TIMESTAMP;`);
    verifiedFoodSessions.set(id, { sessionId, fingerprint: configFingerprint });
    traceFoodSession(trace, 'session_ready', { reused: false, session: shortSessionId(sessionId) });
    return result(sessionId, false);
  }).catch((error) => {
    traceFoodSession(trace, 'session_resolution_failed', {
      stage: 'session_resolution', errorCode: safeOpenCodeErrorCode(error),
      ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { upstreamHttpStatus: error.status } : {}),
      ...(typeof error.operation === 'string' ? { operation: error.operation } : {}),
    });
    throw error;
  });
}

async function deleteFoodOpenCodeSession({ userId, dbQuery, requestOpenCode = openCodeRequest, forgetOnError = false }) {
  const id = String(userId);
  return withUserLock(id, async () => {
    const sessionId = await dbQuery(`SELECT session_id FROM sesiones_comidas_opencode WHERE usuario_id=${id} LIMIT 1;`);
    if (!sessionId) { verifiedFoodSessions.delete(id); return; }
    try {
      const deleted = await requestOpenCode('DELETE', `/session/${encodeURIComponent(sessionId)}`);
      if ((deleted.status < 200 || deleted.status >= 300) && deleted.status !== 404 && !forgetOnError) {
        throw openCodeHttpError(deleted.status, 'DELETE /api/session/{id}', 'No se pudo eliminar la sesión OpenCode de comidas.');
      }
    } catch (error) { if (!forgetOnError) throw error; }
    await dbQuery(`DELETE FROM sesiones_comidas_opencode WHERE usuario_id=${id};`);
    verifiedFoodSessions.delete(id);
  });
}

async function requestFoodDescription({ sessionId, description, initialDescription, conversation, comidasDisponibles = [], comidasReferencia = [], referenciaComidaSolicitada = false, alimentosPendientes = [], continuacionRegistro = false, diaNutricional, genericEstimateApproved = false, retryFeedback, config, trace, requestOpenCode = openCodeRequest }) {
  config ||= await readFoodSessionConfig();
  const system = await readFoodSystemPrompt(config.maxFoodItems);
  const model = config.model ? { providerID: config.model.providerID, modelID: config.model.modelID } : undefined;
  const startedAt = Date.now();
  const requestContext = { description, ...(initialDescription ? { initialDescription } : {}), ...(conversation ? { conversation } : {}), ...(diaNutricional ? { diaNutricional } : {}), ...(genericEstimateApproved ? { genericEstimateApproved: true } : {}), ...(referenciaComidaSolicitada ? { referenciaComidaSolicitada: true } : {}), ...(retryFeedback ? { correccionFormato: retryFeedback } : {}), ...(comidasDisponibles.length ? { comidasDisponibles } : {}), ...(comidasReferencia.length ? { comidasReferencia } : {}), ...(alimentosPendientes.length ? { alimentosPendientes } : {}), ...(continuacionRegistro ? { continuacionRegistro: true } : {}) };
  const tools = genericEstimateApproved || referenciaComidaSolicitada ? {} : { websearch: true, webfetch: true };
  traceFoodSession(trace, 'message_sent', { stage: 'separar_alimentos', session: shortSessionId(sessionId), enabledTools: Object.keys(tools) });
  let result;
  try {
    result = await requestOpenCode('POST', `/session/${encodeURIComponent(sessionId)}/message`, {
      system,
      tools,
      ...(model ? { model } : {}),
      ...(config.agent ? { agent: config.agent } : {}),
      ...(config.variant ? { variant: config.variant } : {}),
      parts: [{ type: 'text', text: JSON.stringify(requestContext) }],
    }, config.requestTimeoutMs);
  } catch (error) {
    traceFoodSession(trace, 'message_failed', {
      stage: 'separar_alimentos', session: shortSessionId(sessionId), durationMs: Date.now() - startedAt,
      errorCode: safeOpenCodeErrorCode(error), operation: 'POST /api/session/{id}/prompt',
      ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { httpStatus: error.status } : {}),
    });
    throw error;
  }
  if (result.status < 200 || result.status >= 300) {
    traceFoodSession(trace, 'message_failed', {
      stage: 'separar_alimentos', session: shortSessionId(sessionId), durationMs: Date.now() - startedAt,
      httpStatus: result.status, operation: 'POST /api/session/{id}/prompt',
    });
    throw openCodeHttpError(result.status, 'POST /api/session/{id}/prompt', 'OpenCode no pudo analizar la comida.');
  }
  const parts = result.data?.parts || [];
  traceFoodSession(trace, 'message_received', {
    stage: 'separar_alimentos', session: shortSessionId(sessionId), durationMs: Date.now() - startedAt,
    httpStatus: result.status, messageId: result.data?.info?.id || null, partTypes: parts.map((part) => part.type),
    toolTitles: parts.filter((part) => part.type === 'tool').map((part) => part.tool || part.state?.title || 'tool'),
  });
  return parts;
}

module.exports = {
  deleteFoodOpenCodeSession, ensureFoodOpenCodeSession, openCodeRequest, recordFoodError, requestFoodDescription,
  getFoodSessionDefaults, readFoodSessionConfig, safeOpenCodeErrorCode, traceFoodSession, withFoodSessionLock,
};
