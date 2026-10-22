// =============================================================================
// Puente Telegram ⇄ OpenCode (nutricion_app)
// -----------------------------------------------------------------------------
// Cuando escribes por Telegram, el mensaje llega directamente a una sesión del
// modelo en el servicio OpenCode de la Raspberry (proyecto /home/pcp/Desktop/app),
// el modelo ejecuta sus herramientas (mysql, Garmin, archivos, etc.) en tiempo
// real y su respuesta regresa a Telegram.
//
// Flujo:
//   1. Mensaje de texto -> POST /api/session/{id}/prompt
//   2. Espera con POST /api/experimental/session/{id}/wait
//      - Si el modelo pide permisos  -> botones en Telegram (una vez/siempre/rechazar)
//      - Si el modelo hace preguntas -> formulario en Telegram, tu respuesta vuelve al modelo
//   3. GET /api/session/{id}/message -> se extrae el texto del asistente y se envia a Telegram
// =============================================================================
import { Bot, InlineKeyboard } from 'grammy';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isAllowedChat, parseAllowedChatIds } from './access-control.js';
import { apiHelp, apiRequest } from './nutrition-api.js';

// ------------------------------ Configuracion -------------------------------
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const ALLOWED_CHAT_IDS = parseAllowedChatIds(process.env.ALLOWED_CHAT_IDS);

const SERVICE_FILE = process.env.OPENCODE_SERVICE_FILE || '/opencode-state/service.json';
const PROJECT_DIR = process.env.OPENCODE_PROJECT_DIR || '/home/pcp/Desktop/app';
// ask: te pregunta con botones | once | always | reject: auto-responde permisos
const PERMISSION_MODE = (process.env.OPENCODE_PERMISSION_MODE || 'ask').toLowerCase();
const TURN_TIMEOUT_MS = Number.parseInt(process.env.OPENCODE_TURN_TIMEOUT_MS || '900000', 10);
const PERMISSION_TIMEOUT_MS = Number.parseInt(process.env.OPENCODE_PERMISSION_TIMEOUT_MS || '180000', 10);
const FORM_TIMEOUT_MS = Number.parseInt(process.env.OPENCODE_FORM_TIMEOUT_MS || '300000', 10);
const SSH_CONTROL_URL = process.env.SSH_CONTROL_URL || 'http://127.0.0.1:8765/ssh';
const SSH_CONTROL_TOKEN = process.env.SSH_CONTROL_TOKEN || '';

const DATA_DIR = process.env.BOT_DATA_DIR || '/app/data';
const SESSIONS_FILE = `${DATA_DIR}/sessions.json`;
const TG_LIMIT = 4096;

if (!BOT_TOKEN || BOT_TOKEN.startsWith('PON_AQUI')) {
  console.error('[grammy] BOT_TOKEN no configurado en app/grammy/.env (token de @BotFather).');
  process.exit(1);
}
if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(BOT_TOKEN)) {
  console.error(
    '[grammy] El BOT_TOKEN no parece completo/valido. BotFather entrega tokens con formato\n' +
    '         "1234567890:AAEhh..." (numero + dos puntos + hash). Copia el token COMPLETO.'
  );
  process.exit(1);
}
if (!['ask', 'once', 'always', 'reject'].includes(PERMISSION_MODE)) {
  console.error(`[grammy] OPENCODE_PERMISSION_MODE invalido: "${PERMISSION_MODE}" (usa ask|once|always|reject)`);
  process.exit(1);
}
if (ALLOWED_CHAT_IDS.size === 0) {
  console.error('[grammy] ALLOWED_CHAT_IDS vacio o invalido; el bot no iniciara sin una lista de chats autorizados.');
  process.exit(1);
}

// --------------------------- Cliente API OpenCode ---------------------------
// El registro del servicio (URL + password) se relee en cada reconexion, asi el
// bot sobrevive a reinicios del servicio aunque cambie de puerto.
let service = null;
function loadService() {
  try {
    const parsed = JSON.parse(readFileSync(SERVICE_FILE, 'utf8'));
    if (!parsed?.url || !parsed?.password) throw new Error('registro incompleto');
    service = { url: parsed.url, password: parsed.password };
  } catch (error) {
    service = null;
    throw new Error(
      `No pude leer el registro del servicio OpenCode (${SERVICE_FILE}): ${error.message}. ` +
      '¿Esta corriendo "opencode serve --service" en la Raspberry?'
    );
  }
}
function authHeader() {
  return 'Basic ' + Buffer.from(`opencode:${service.password}`).toString('base64');
}
async function api(method, apiPath, body, { retry = true } = {}) {
  if (!service) loadService();
  let res;
  try {
    res = await fetch(`${service.url}${apiPath}`, {
      method,
      headers: {
        authorization: authHeader(),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    if (retry && method === 'GET') {
      loadService(); // el servicio pudo haber reiniciado en otro puerto
      return api(method, apiPath, body, { retry: false });
    }
    throw new Error(`Sin conexion con el servicio OpenCode: ${error.message}`);
  }
  const text = await res.text();
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { json = null; }
  }
  return { status: res.status, json };
}

// ------------------------- Sesiones por chat (persistencia) ------------------
let chatSessions = {};
try { chatSessions = JSON.parse(await readFile(SESSIONS_FILE, 'utf8')); } catch { /* primera vez */ }
async function persistSessions() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(SESSIONS_FILE, JSON.stringify(chatSessions, null, 2));
  } catch (error) {
    console.error('[grammy] No pude persistir sessions.json:', error.message);
  }
}

async function ensureSession(chatId, label) {
  const existing = chatSessions[chatId];
  if (existing) {
    const res = await api('GET', `/api/session/${existing}`);
    if (res.status === 200) return existing;
    console.warn(`[grammy] Sesion ${existing} ya no existe; creo una nueva.`);
  }
  const res = await api('POST', '/api/session', {
    title: `Telegram ${label}`,
    location: { directory: PROJECT_DIR },
  });
  if (res.status !== 200) {
    throw new Error(`No pude crear sesion de OpenCode (HTTP ${res.status}: ${res.json?.message ?? ''})`);
  }
  const id = res.json.data.id;
  chatSessions[chatId] = id;
  await persistSessions();
  console.log(`[grammy] Sesion ${id} creada para chat ${chatId}.`);
  return id;
}

// ------------------------------ Estado por chat ------------------------------
// busy / queue / stop / pendingForm / pendingPermission (resolvers de espera)
const chats = new Map();
function state(chatId) {
  if (!chats.has(chatId)) {
    chats.set(chatId, { busy: false, currentMessage: '', lastMessage: '', queue: [], stop: false, pendingAsk: null });
  }
  return chats.get(chatId);
}

// --------------------------------- Bot base ----------------------------------
const bot = new Bot(BOT_TOKEN);

bot.use(async (ctx, next) => {
    if (isAllowedChat(ctx.chat?.id, ALLOWED_CHAT_IDS)) {
    return next();
  }
  console.warn(`[grammy] Chat no autorizado ignorado: ${ctx.chat?.id}`);
  return undefined;
});

// ------------------------------- Utilidades TG -------------------------------
async function sendMd(chatId, text) {
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  } catch {
    await bot.api.sendMessage(chatId, text); // sin formato si Markdown rompe
  }
}
async function sendLong(chatId, text, replaceMessageId = null) {
  let rest = (text || '').trim();
  if (!rest) rest = '(sin contenido en la respuesta)';
  let first = true;
  while (rest.length > 0) {
    const chunk = rest.slice(0, TG_LIMIT);
    rest = rest.slice(TG_LIMIT);
    if (first && replaceMessageId) {
      try { await bot.api.editMessageText(chatId, replaceMessageId, chunk); }
      catch { await bot.api.sendMessage(chatId, chunk); }
    } else await bot.api.sendMessage(chatId, chunk);
    first = false;
  }
}

// ------------------------- Extraccion de la respuesta -----------------------
async function extractAnswer(sessionID, userMsgId, sentAtMs) {
  // Los mensajes mas recientes (order=desc) y en orden cronologico
  const res = await api('GET', `/api/session/${sessionID}/message?limit=100&order=desc`);
  const messages = (res.json?.data ?? []).slice().reverse();
  let after;
  const idx = messages.findIndex((m) => m.id === userMsgId);
  if (idx >= 0) {
    after = messages.slice(idx + 1);
  } else {
    after = messages.filter((m) => {
      const t = m.time?.created ?? 0;
      const ms = t > 1e12 ? t : t * 1000; // segundos o milisegundos
      return ms >= sentAtMs - 1000;
    });
  }
  const texts = [];
  for (const m of after) {
    if (m.type !== 'assistant') continue;
    for (const part of m.content ?? []) {
      if (part.type === 'text' && part.text) texts.push(part.text);
    }
  }
  return texts.join('\n\n').trim();
}

// --------------------------- Espera de la sesion -----------------------------
async function waitForIdle(sessionID, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    await fetch(`${service.url}/api/experimental/session/${sessionID}/wait`, {
      method: 'POST',
      headers: { authorization: authHeader() },
      signal: controller.signal,
    });
  } catch {
    // timeout del turno: lo maneja el bucle principal
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------- Permisos (botones) ----------------------------
const permissionWaiters = new Map(); // requestID -> { resolve, chatId }

function describePermission(req) {
  const lines = [`🔐 **El modelo pide permiso** para: \`${req.action}\``];
  if (req.message) lines.push(`> ${req.message}`);
  const resources = (req.resources ?? []).slice(0, 8).map((r) => `\`${r}\``).join('\n');
  if (resources) lines.push(`Recursos:\n${resources}`);
  lines.push('\n¿Aprobar?');
  return lines.join('\n');
}

async function askPermission(chatId, sessionID, req, stopSignal) {
  if (PERMISSION_MODE !== 'ask') {
    await api('POST', `/api/session/${sessionID}/permission/${req.id}/reply`, { decision: PERMISSION_MODE });
    console.log(`[grammy] Permiso ${req.id} auto-respondido: ${PERMISSION_MODE}`);
    return;
  }
  const keyboard = new InlineKeyboard()
    .text('✅ Una vez', `perm:${req.id}:once`)
    .text('♾️ Siempre', `perm:${req.id}:always`)
    .row()
    .text('❌ Rechazar', `perm:${req.id}:reject`);
  await sendMd(chatId, describePermission(req));
  await bot.api.sendMessage(chatId, '¿Aprobar?', { reply_markup: keyboard });
  await new Promise((resolve) => {
    let timer;
    const finish = () => { clearTimeout(timer); resolve(); };
    const waiter = { resolve: finish, chatId };
    permissionWaiters.set(req.id, waiter);
    if (stopSignal) stopSignal.resolve = finish;
    timer = setTimeout(async () => {
      if (permissionWaiters.get(req.id) !== waiter) return;
      permissionWaiters.delete(req.id);
      try { await api('POST', `/api/session/${sessionID}/permission/${req.id}/reply`, { decision: 'reject' }); }
      catch (error) { console.error('[grammy] No pude rechazar el permiso vencido:', error.message); }
      await bot.api.sendMessage(chatId, '⏱️ Permiso rechazado por tiempo de espera.').catch(() => {});
      finish();
    }, PERMISSION_TIMEOUT_MS);
  });
}

// ---------------------------- Formularios (preguntas) ------------------------
const formWaiters = new Map(); // chatId -> { form, sessionID, resolve }

function describeForm(form) {
  const lines = [`📋 **${form.title}**`];
  const visible = (form.fields ?? []).filter((f) => !f.hidden);
  visible.forEach((field, i) => {
    lines.push(`\n**${i + 1}. ${field.title || field.key}**`);
    if (field.description) lines.push(field.description);
    if (Array.isArray(field.options) && field.options.length) {
      field.options.forEach((opt, oi) => lines.push(`   ${oi + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`));
      lines.push(`   _(responde con el número${field.type === 'multiselect' ? 's, separados por coma' : ''})_`);
    }
  });
  lines.push('\nResponde en una sola mensaje, una línea por pregunta, en orden.');
  return lines.join('\n');
}

function coerceAnswer(field, raw) {
  const value = (raw ?? '').trim();
  if (field.type === 'boolean') return /^(si|sí|true|1|ok)$/i.test(value);
  if (field.type === 'number' || field.type === 'integer') {
    const n = Number(value.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  if (Array.isArray(field.options) && field.options.length) {
    if (field.type === 'multiselect') {
      const picks = value.split(/[,;\s]+/).map((p) => Number.parseInt(p, 10)).filter(Number.isInteger);
      return field.options.filter((_, i) => picks.includes(i + 1)).map((o) => o.value);
    }
    const byIndex = Number.parseInt(value, 10);
    if (Number.isInteger(byIndex) && field.options[byIndex - 1]) return field.options[byIndex - 1].value;
    const match = field.options.find((o) => o.label.toLowerCase().includes(value.toLowerCase()) && value);
    return match ? match.value : value;
  }
  return value;
}

function parseFormAnswer(form, text) {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const visible = (form.fields ?? []).filter((f) => !f.hidden);
  const answer = {};
  visible.forEach((field, i) => {
    answer[field.key] = coerceAnswer(field, lines[i] ?? '');
  });
  return answer;
}

async function askForm(chatId, sessionID, form, stopSignal) {
  await sendMd(chatId, describeForm(form));
  await new Promise((resolve) => {
    let timer;
    const finish = () => { clearTimeout(timer); resolve(); };
    const waiter = { form, sessionID, resolve: finish };
    formWaiters.set(chatId, waiter);
    if (stopSignal) stopSignal.resolve = finish;
    timer = setTimeout(async () => {
      if (formWaiters.get(chatId) !== waiter) return;
      formWaiters.delete(chatId);
      try { await api('DELETE', `/api/session/${sessionID}/form/${form.id}`); }
      catch (error) { console.error('[grammy] No pude cerrar el formulario vencido:', error.message); }
      await bot.api.sendMessage(chatId, '⏱️ Se canceló la pregunta por tiempo de espera.').catch(() => {});
      finish();
    }, FORM_TIMEOUT_MS);
  });
}

// Resolver permisos y formularios pendientes; devuelve true si habia algo.
async function resolvePending(chatId, sessionID, stopSignal) {
  let handled = false;
  const [perms, forms] = await Promise.all([
    api('GET', `/api/session/${sessionID}/permission`),
    api('GET', `/api/session/${sessionID}/form`),
  ]);
  for (const req of perms.json?.data ?? []) {
    handled = true;
    await askPermission(chatId, sessionID, req, stopSignal);
  }
  const formDetails = await Promise.all((forms.json?.data ?? []).map(async (form) => ({
    form, detail: await api('GET', `/api/session/${sessionID}/form/${form.id}`),
  })));
  for (const { form, detail } of formDetails) {
    if (detail.json?.data?.state?.status !== 'pending') continue;
    handled = true;
    await askForm(chatId, sessionID, form, stopSignal);
  }
  return handled;
}

// ------------------------------- Turno principal -----------------------------
async function runTurn(chatId, text) {
  const st = state(chatId);
  st.busy = true;
  st.currentMessage = text;
  st.stop = false;
  const stopSignal = { resolve: null };
  st.pendingAsk = stopSignal;
  const typing = setInterval(() => bot.api.sendChatAction(chatId, 'typing').catch(() => {}), 4500);
  const progress = await bot.api.sendMessage(chatId, '⏳ Conectando con OpenCode…').catch(() => null);
  const updateProgress = async (message) => {
    if (!progress) return false;
    try { await bot.api.editMessageText(chatId, progress.message_id, message); return true; }
    catch { return false; }
  };
  let sessionID = null;
  try {
    sessionID = await ensureSession(chatId, String(chatId));
    await updateProgress('✍️ Enviando mensaje al modelo…');

    // 1) Enviar el mensaje como prompt
    let prompt;
    for (let attempt = 0; ; attempt++) {
      prompt = await api('POST', `/api/session/${sessionID}/prompt`, { text });
      if (prompt.status === 200) break;
      if (prompt.status === 409 && attempt === 0) {
        await waitForIdle(sessionID, 60000);
        continue;
      }
      throw new Error(`El prompt fue rechazado (HTTP ${prompt.status}: ${prompt.json?.message ?? ''})`);
    }
    const userMsgId = prompt.json?.data?.id ?? null;
    const sentAtMs = Date.now();

    // 2) Esperar a que el modelo termine, resolviendo permisos/preguntas en el camino
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    await updateProgress('⏳ Esperando la respuesta de OpenCode…');
    while (Date.now() < deadline && !st.stop) {
      await waitForIdle(sessionID, deadline - Date.now());
      const hadPending = await resolvePending(chatId, sessionID, stopSignal);
      if (!hadPending) break;
      await updateProgress('🔄 Continuando después de tu respuesta…');
    }

    // 3) Respuesta
    if (st.stop) {
      if (!await updateProgress('⛔ Turno detenido.')) await bot.api.sendMessage(chatId, '⛔ Detenido.').catch(() => {});
      st.stop = false;
    } else {
      const answer = await extractAnswer(sessionID, userMsgId, sentAtMs);
      await sendLong(chatId, answer || '✅ Listo (el modelo no devolvió texto).', progress?.message_id);
    }
  } catch (error) {
    console.error('[grammy] Error en el turno:', error.message);
    if (!await updateProgress(`❌ ${error.message}`)) await bot.api.sendMessage(chatId, `❌ ${error.message}`).catch(() => {});
  } finally {
    clearInterval(typing);
    st.busy = false;
    st.currentMessage = '';
    st.pendingAsk = null;
    if (st.queue.length > 0 && !st.stop) {
      const next = st.queue.shift();
      runTurn(chatId, next); // siguiente mensaje encolado
    }
  }
}

function queueOrRun(chatId, text, remember = true) {
  const st = state(chatId);
  if (st.busy) {
    if (st.queue.length >= 10) return -1;
    st.queue.push(text);
    if (remember) st.lastMessage = text;
    return st.queue.length;
  }
  if (remember) st.lastMessage = text;
  runTurn(chatId, text).catch((error) => console.error('[grammy] runTurn:', error));
  return 0;
}

async function submitTurn(ctx, text, remember = true) {
  const position = queueOrRun(ctx.chat.id, text, remember);
  if (position < 0) return ctx.reply('⚠️ Demasiados mensajes en espera; espera a que termine el actual.');
  if (position > 0) return ctx.reply(`📥 En cola (posición ${position}). Responderé en orden.`);
}

// ------------------------------- Handlers Telegram ---------------------------
bot.command('start', (ctx) =>
  ctx.reply(
    '¡Hola! Soy el puente directo con OpenCode 🧠.\n\n' +
      'Escríbeme cualquier mensaje y llegará al modelo en tiempo real ' +
      `(proyecto: ${PROJECT_DIR}). Puede consultar tu BD de nutrición, Garmin, archivos y más.\n\n` +
      'Comandos:\n' +
      '/nueva — sesión nueva desde cero\n' +
      '/stop — interrumpe lo que estoy haciendo\n' +
      '/sesion — info de la sesión actual\n' +
      '/hoy — resumen nutricional de hoy\n' +
      '/objetivos — recalcular objetivos\n' +
      '/comida — registrar comida\n' +
      '/dashboard — rutas de la API Nutri\n' +
      '/help — esta ayuda',
    {
      reply_markup: new InlineKeyboard()
        .text('📊 Hoy', 'cmd:hoy')
        .text('🎯 Objetivos', 'cmd:objetivos'),
    }
  )
);
bot.command('help', (ctx) => ctx.reply(
  'Comandos: /start, /nueva, /stop, /sesion, /ping, /hoy, /objetivos, /comida, /dashboard o /api (API Nutri), /ssh [on|off].'
));
bot.command('ping', (ctx) => ctx.reply('pong'));

const pendingApiActions = new Map();
async function openApiDashboard(ctx) {
  const input = (ctx.match || '').trim();
  if (!input) return ctx.reply(apiHelp());
  const match = input.match(/^(GET|POST|DELETE)\s+(\/api\/\S*)(?:\s+([\s\S]+))?$/i);
  if (!match) return ctx.reply('Uso: /api <GET|POST|DELETE> /api/ruta [JSON]. Envía /api para ver rutas.');
  const [, rawMethod, path, rawPayload] = match;
  const method = rawMethod.toUpperCase();
  if (method === 'GET' && rawPayload) return ctx.reply('GET no acepta cuerpo JSON.');
  let payload;
  if (rawPayload) {
    try { payload = JSON.parse(rawPayload); }
    catch { return ctx.reply('El cuerpo debe ser JSON válido.'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ctx.reply('El cuerpo JSON debe ser un objeto.');
  }
  const action = { method, path, payload };
  if (method !== 'GET') {
    pendingApiActions.set(ctx.chat.id, action);
    return ctx.reply(`Confirmar ${method} ${path}?`, {
      reply_markup: new InlineKeyboard().text('Confirmar', 'nutri-api:confirm').text('Cancelar', 'nutri-api:cancel'),
    });
  }
  try { await sendLong(ctx.chat.id, await apiRequest(method, path)); }
  catch (error) { await ctx.reply(`Error API Nutri: ${error.message}`); }
}
bot.command('api', openApiDashboard);
bot.command('dashboard', (ctx) => ctx.reply(apiHelp()));

bot.callbackQuery(/^nutri-api:(confirm|cancel)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const action = pendingApiActions.get(ctx.chat.id);
  pendingApiActions.delete(ctx.chat.id);
  if (ctx.match[1] === 'cancel' || !action) return ctx.editMessageText('Acción cancelada o vencida.');
  await ctx.editMessageText(`Ejecutando ${action.method} ${action.path}…`);
  try { await sendLong(ctx.chat.id, await apiRequest(action.method, action.path, action.payload), ctx.callbackQuery.message.message_id); }
  catch (error) { await ctx.reply(`Error API Nutri: ${error.message}`); }
});

async function sshControl(method, state) {
  if (!SSH_CONTROL_TOKEN) throw new Error('SSH_CONTROL_TOKEN no está configurado');
  const response = await fetch(state ? `${SSH_CONTROL_URL}/${state}` : SSH_CONTROL_URL, {
    method,
    headers: { authorization: `Bearer ${SSH_CONTROL_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result.state;
}

bot.command('ssh', async (ctx) => {
  const action = (ctx.match || '').trim().toLowerCase();
  if (!action) {
    try {
      await ctx.reply(`SSH está ${await sshControl('GET') === 'on' ? 'encendido' : 'apagado'}.`);
    } catch (error) {
      await ctx.reply(`No pude consultar SSH: ${error.message}`);
    }
    return;
  }
  if (action === 'off') {
    await ctx.reply('⚠️ Apagar SSH puede cortar tu conexión remota. ¿Confirmas?', {
      reply_markup: new InlineKeyboard().text('Apagar SSH', 'ssh:off').text('Cancelar', 'ssh:cancel'),
    });
    return;
  }
  if (action !== 'on') return ctx.reply('Uso: /ssh [on|off]');
  try {
    const state = await sshControl('POST', 'on');
    await ctx.reply(`SSH ${state === 'on' ? 'encendido' : 'apagado'}.`);
  } catch (error) {
    await ctx.reply(`No pude cambiar SSH: ${error.message}`);
  }
});

bot.callbackQuery(/^ssh:(off|cancel)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.match[1] === 'cancel') return ctx.editMessageText('Operación cancelada.');
  try {
    const state = await sshControl('POST', 'off');
    await ctx.editMessageText(`SSH ${state === 'on' ? 'encendido' : 'apagado'}.`);
  } catch (error) {
    await ctx.editMessageText(`No pude cambiar SSH: ${error.message}`);
  }
});

// Limpia esperas activas de un chat (permisos y formularios pendientes)
async function clearWaiters(chatId) {
  for (const [requestID, waiter] of permissionWaiters.entries()) {
    if (waiter.chatId !== chatId) continue;
    permissionWaiters.delete(requestID);
    const sessionID = chatSessions[chatId];
    if (sessionID) {
      await api('POST', `/api/session/${sessionID}/permission/${requestID}/reply`, { decision: 'reject' }).catch(() => {});
    }
    waiter.resolve();
  }
  const fw = formWaiters.get(chatId);
  if (fw) {
    formWaiters.delete(chatId);
    await api('DELETE', `/api/session/${fw.sessionID}/form/${fw.form.id}`).catch(() => {});
    fw.resolve();
  }
}

bot.command('stop', async (ctx) => {
  const st = state(ctx.chat.id);
  st.stop = true;
  await clearWaiters(ctx.chat.id);
  const sessionID = chatSessions[ctx.chat.id];
  if (sessionID) {
    await api('POST', `/api/session/${sessionID}/interrupt`, {}).catch(() => {});
  }
  await ctx.reply(st.busy ? '🛑 Interrumpiendo…' : 'No hay nada en curso.');
});

bot.command('nueva', async (ctx) => {
  const chatId = ctx.chat.id;
  const st = state(chatId);
  st.stop = true;
  st.queue = [];
  await clearWaiters(chatId);
  const old = chatSessions[chatId];
  if (old) await api('DELETE', `/api/session/${old}`).catch(() => {});
  delete chatSessions[chatId];
  await persistSessions();
  await ctx.reply('🔄 Listo: el próximo mensaje empezará una sesión nueva.');
});

bot.command('sesion', async (ctx) => {
  const chatId = ctx.chat.id;
  const st = state(chatId);
  const sid = chatSessions[chatId];
  await ctx.reply(
    `Sesión: ${sid ?? '(ninguna aún)'}\n` +
      `Ocupado: ${st.busy ? 'sí' : 'no'} | En cola: ${st.queue.length}\n` +
      `Permisos: ${PERMISSION_MODE} | Proyecto: ${PROJECT_DIR}`
  );
});

bot.command('hoy', async (ctx) => {
  const chatId = ctx.chat.id;
  const st = state(chatId);
  if (st.busy) {
    if (st.queue.length >= 10) {
      await ctx.reply('⚠️ Demasiados mensajes en espera; espera a que termine el actual.');
      return;
    }
    st.queue.push('Dame el resumen nutricional de hoy: kcal consumidas vs objetivo, macros y eventos del día.');
    await ctx.reply(`📥 En cola (posición ${st.queue.length}). Responderé en orden.`);
    return;
  }
  runTurn(chatId, 'Dame el resumen nutricional de hoy: kcal consumidas vs objetivo, macros y eventos del día.').catch((e) => console.error('[grammy] runTurn:', e));
});

bot.command('objetivos', async (ctx) => {
  const chatId = ctx.chat.id;
  const st = state(chatId);
  if (st.busy) {
    if (st.queue.length >= 10) {
      await ctx.reply('⚠️ Demasiados mensajes en espera; espera a que termine el actual.');
      return;
    }
    st.queue.push('recalcular objetivos');
    await ctx.reply(`📥 En cola (posición ${st.queue.length}). Responderé en orden.`);
    return;
  }
  runTurn(chatId, 'recalcular objetivos').catch((e) => console.error('[grammy] runTurn:', e));
});

bot.command('comida', async (ctx) => {
  const chatId = ctx.chat.id;
  const st = state(chatId);
  const prompt = 'Quiero registrar una comida: ' + (ctx.match?.trim() ?? '');
  if (st.busy) {
    if (st.queue.length >= 10) {
      await ctx.reply('⚠️ Demasiados mensajes en espera; espera a que termine el actual.');
      return;
    }
    st.queue.push(prompt);
    await ctx.reply(`📥 En cola (posición ${st.queue.length}). Responderé en orden.`);
    return;
  }
  runTurn(chatId, prompt).catch((e) => console.error('[grammy] runTurn:', e));
});

bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  if (!text || text.startsWith('/')) return;
  const waiter = formWaiters.get(chatId);
  if (waiter) {
    try {
      const reply = await api('POST', `/api/session/${waiter.sessionID}/form/${waiter.form.id}/reply`, { answer: parseFormAnswer(waiter.form, text) });
      if (reply.status < 200 || reply.status >= 300) throw new Error();
      formWaiters.delete(chatId);
      waiter.resolve();
      await ctx.reply('✅ Respuesta enviada.');
    } catch {
      await ctx.reply('No pude enviar la respuesta; intenta de nuevo.');
    }
    return;
  }
  const st = state(chatId);
  if (st.busy) {
    if (st.queue.length >= 10) return ctx.reply('⚠️ Demasiados mensajes en espera; espera a que termine el actual.');
    st.queue.push(text);
    return ctx.reply(`📥 En cola (posición ${st.queue.length}). Responderé en orden.`);
  }
  runTurn(chatId, text).catch((error) => console.error('[grammy] runTurn:', error));
});

// Botones de permisos
bot.callbackQuery(/^cmd:hoy$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat.id;
  const st = state(chatId);
  if (st.busy) {
    if (st.queue.length >= 10) {
      await ctx.reply('⚠️ Demasiados mensajes en espera; espera a que termine el actual.');
      return;
    }
    st.queue.push('Dame el resumen nutricional de hoy: kcal consumidas vs objetivo, macros y eventos del día.');
    await ctx.reply(`📥 En cola (posición ${st.queue.length}). Responderé en orden.`);
    return;
  }
  runTurn(chatId, 'Dame el resumen nutricional de hoy: kcal consumidas vs objetivo, macros y eventos del día.').catch((e) => console.error('[grammy] runTurn:', e));
});

bot.callbackQuery(/^cmd:objetivos$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const chatId = ctx.chat.id;
  const st = state(chatId);
  if (st.busy) {
    if (st.queue.length >= 10) {
      await ctx.reply('⚠️ Demasiados mensajes en espera; espera a que termine el actual.');
      return;
    }
    st.queue.push('recalcular objetivos');
    await ctx.reply(`📥 En cola (posición ${st.queue.length}). Responderé en orden.`);
    return;
  }
  runTurn(chatId, 'recalcular objetivos').catch((e) => console.error('[grammy] runTurn:', e));
});

bot.callbackQuery(/^perm:(per[^:]+):(once|always|reject)$/, async (ctx) => {
  const [, requestID, decision] = ctx.match;
  const waiter = permissionWaiters.get(requestID);
  if (!waiter) {
    await ctx.answerCallbackQuery({ text: 'Esta solicitud ya expiró.' });
    return;
  }
  const sessionID = chatSessions[waiter.chatId];
  const res = await api('POST', `/api/session/${sessionID}/permission/${requestID}/reply`, { decision });
  permissionWaiters.delete(requestID);
  const icon = decision === 'reject' ? '❌' : decision === 'always' ? '♾️' : '✅';
  await ctx.editMessageText(`${ctx.callbackQuery.message.text}\n\n→ ${icon} ${decision}`, { parse_mode: 'Markdown' }).catch(() => {});
  await ctx.answerCallbackQuery({ text: `Permiso ${decision === 'reject' ? 'rechazado' : 'aprobado'}.` });
  waiter.resolve();
});

// Los mensajes de texto libres continúan por la sesión del chat; los comandos usan sus handlers específicos.

bot.catch((err) => console.error('[grammy] Error del bot:', err.error ?? err));

console.log('[grammy] Iniciando puente Telegram ⇄ OpenCode (long polling)...');
bot.start({
  onStart: (me) => console.log(`[grammy] Bot @${me.username} escuchando. Proyecto: ${PROJECT_DIR}`),
});

// Resúmenes automáticos del día nutricional vigente a las 01:59 y a las 17:00
let lastResumenDiario = '';
let lastResumenTarde = '';
let lastReporteSemanal = '';
let lastAlertaSuenoGym = '';
setInterval(() => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const dayKey = now.toISOString().slice(0, 10);
  const targets = [];
  if (hh === '01' && mm === '59' && lastResumenDiario !== dayKey) {
    lastResumenDiario = dayKey;
    targets.push('01:59');
  }
  if (hh === '17' && mm === '00' && lastResumenTarde !== dayKey) {
    lastResumenTarde = dayKey;
    targets.push('17:00');
  }
  if (now.getDay() === 0 && hh === '20' && mm === '00' && lastReporteSemanal !== dayKey) {
    lastReporteSemanal = dayKey;
    targets.push('20:00-semanal');
  }
  if (hh === '10' && mm === '00' && lastAlertaSuenoGym !== dayKey) {
    lastAlertaSuenoGym = dayKey;
    targets.push('10:00-sueno-gym');
  }
  for (const slot of targets) {
    const isWeekly = slot === '20:00-semanal';
    const isSleepGym = slot === '10:00-sueno-gym';
    const prompt = isWeekly
      ? 'Genera el reporte semanal: promedio de kcal consumidas, adherencia a los objetivos, días de fuerza vs consumo, y cambio de peso semanal según mis registros biométricos.'
      : isSleepGym
        ? 'Revisa si ayer hice entrenamiento en Garmin y si mi sueño fue menor a 6 horas; si ambas cosas aplican, genérame una alerta corta de recuperación.'
        : 'Dame el resumen del día nutricional vigente: kcal consumidas vs objetivo, macros y eventos del día.';
    const chatIds = Object.keys(chatSessions);
    for (const chatId of chatIds) {
      const st = state(chatId);
      if (st.busy) {
        st.queue.push(prompt);
        bot.api.sendMessage(chatId, `⏰ Resumen de las ${slot} en cola (posición ` + st.queue.length + ').').catch(() => {});
      } else {
        runTurn(chatId, prompt).catch((e) => console.error('[grammy] resumen programado:', e));
      }
    }
  }
}, 30000);

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());
