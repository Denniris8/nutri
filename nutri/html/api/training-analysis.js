const { createHash, randomUUID } = require('node:crypto');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { openCodeRequest, readFoodSessionConfig } = require('./opencode-food.js');
const { parseTrainingSavedTime } = require('./training-entries.js');
const { extractPlanDisclosure, validatePlanSemantics } = require('./training-plans.js');
const { createAnalysisProgressRecorder } = require('./analysis-progress.js');

const permissions = [{ permission: '*', pattern: '*', action: 'deny' }];
// El ID vive solo en memoria del servidor; el cliente nunca elige ni recibe una sesión reutilizable.
const sessions = new Map();
const pendingPlanSessions = new Map();
const locks = new Map();
const progress = new Map();
const trainingPromptPath = path.resolve(__dirname, '../../comportamiento-sesion-entrenamientos.md');
const trainingPlanPromptPath = path.resolve(__dirname, '../../comportamiento-sesion-plan.md');

function reportTrainingProgress(userId, progressId, event, recordEvent) {
  recordEvent?.(event);
  if (!progressId) return;
  const labels = {
    analysis_context_started: 'Consultando peso y estatura registrados…',
    analysis_context_ready: 'Datos biométricos listos; preparando el análisis…',
    analysis_config: 'Leyendo las reglas de análisis…',
    analysis_session: 'Preparando el análisis…',
    analysis_sent: 'Enviando entrenamiento para análisis…',
    analysis_received: 'Respuesta recibida; validando actividad e intensidad…',
    analysis_steps_saved: 'Pasos diarios guardados por separado.',
    analysis_complete: 'Análisis completo; calculando el guardado…',
    plan_context_started: 'Consultando perfil, preferencias y mediciones…',
    plan_context_ready: 'Contexto reunido; preparando la generación del plan…',
    plan_config: 'Leyendo las reglas del plan…',
    plan_session: 'Preparando el plan…',
    plan_sent: 'Enviando objetivos y contexto para generar el plan…',
    plan_received: 'Plan recibido; validando contenido y metas…',
    plan_complete: 'Plan generado; listo para revisar y guardar.',
    analysis_failed: 'El análisis del entrenamiento se detuvo.', plan_failed: 'La generación del plan se detuvo.',
  };
  const label = labels[event];
  if (!label) return;
  const key = `${userId}:${progressId}`;
  progress.set(key, { label, updatedAt: Date.now() });
  if (progress.size > 500) progress.delete(progress.keys().next().value);
}

function getTrainingProgress(userId, progressId) {
  const key = `${userId}:${progressId}`;
  const current = progress.get(key);
  if (current && Date.now() - current.updatedAt > 15 * 60 * 1000) progress.delete(key);
  return progress.get(key) || null;
}

async function readTrainingPrompt() {
  let document;
  try { document = await readFile(trainingPromptPath, 'utf8'); }
  catch { throw new Error('No se pudo leer comportamiento-sesion-entrenamientos.md.'); }
  const prompt = document.match(/<!-- TRAINING_OPENCODE_PROMPT_START -->([\s\S]*?)<!-- TRAINING_OPENCODE_PROMPT_END -->/);
  if (!prompt) throw new Error('No se encontró el prompt canónico de registro de entrenamientos.');
  return prompt[1].trim();
}

async function readTrainingPlanPrompt() {
  let document;
  try { document = await readFile(trainingPlanPromptPath, 'utf8'); }
  catch { throw new Error('No se pudo leer comportamiento-sesion-plan.md.'); }
  const prompt = document.match(/<!-- TRAINING_PLAN_OPENCODE_PROMPT_START -->([\s\S]*?)<!-- TRAINING_PLAN_OPENCODE_PROMPT_END -->/);
  if (!prompt) throw new Error('No se encontró el prompt canónico del plan de entrenamiento.');
  return prompt[1].trim();
}

function withUserLock(userId, run) {
  const previous = locks.get(userId) || Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  locks.set(userId, current);
  return current.finally(() => { if (locks.get(userId) === current) locks.delete(userId); });
}

function parseTrainingPlanReply(parts, systemPrompt, context) {
  const raw = parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n').trim();
  let reply;
  try { reply = JSON.parse(raw); }
  catch { throw new Error('El plan generado no cumple el formato esperado.'); }
  const macros = reply?.macros_objetivo;
  const keys = ['proteinas_g', 'carbohidratos_g', 'grasas_g', 'calorias_kcal'];
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)
    || Object.keys(reply).length !== 2 || !Object.hasOwn(reply, 'plan_markdown') || !Object.hasOwn(reply, 'macros_objetivo')
    || typeof reply.plan_markdown !== 'string' || !reply.plan_markdown.trim() || reply.plan_markdown.length > 30000
    || !macros || typeof macros !== 'object' || Array.isArray(macros)
    || Object.keys(macros).length !== keys.length || keys.some((key) => !Object.hasOwn(macros, key))) {
    throw new Error('El plan generado tiene campos incompletos.');
  }
  const limits = { proteinas_g: 10000, carbohidratos_g: 10000, grasas_g: 10000, calorias_kcal: 100000 };
  for (const key of keys) {
    const value = macros[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > limits[key])) throw new Error('El plan generado contiene metas de macros no válidas.');
  }
  validatePlanSemantics(reply.plan_markdown, macros, extractPlanDisclosure(systemPrompt), context);
  return { plan: reply.plan_markdown.trim(), macros: Object.fromEntries(keys.map((key) => [key, macros[key]])) };
}

async function openTrainingSession(userId, config, request) {
  const fingerprint = createHash('sha256').update(JSON.stringify({ userId, scope: 'training-analysis', model: config.model, agent: config.agent, variant: config.variant })).digest('hex');
  const cached = sessions.get(userId);
  if (cached?.fingerprint === fingerprint) {
    const current = await request('GET', `/session/${encodeURIComponent(cached.id)}`, undefined, config.requestTimeoutMs);
    if (current.status >= 200 && current.status < 300 && current.data?.metadata?.trainingUserId === userId && current.data?.metadata?.trainingConfigSha256 === fingerprint) {
      return cached.id;
    }
    sessions.delete(userId);
  }
  const model = config.model ? { id: config.model.modelID, providerID: config.model.providerID, ...(config.variant ? { variant: config.variant } : {}) } : undefined;
  const created = await request('POST', '/session', {
    title: 'Análisis de entrenamiento',
    ...(config.agent ? { agent: config.agent } : {}),
    ...(model ? { model } : {}),
    permission: permissions,
    metadata: { trainingUserId: userId, trainingConfigSha256: fingerprint },
  }, config.requestTimeoutMs);
  const id = created.data?.id;
  if (created.status < 200 || created.status >= 300 || !/^ses_[A-Za-z0-9_-]{4,120}$/.test(id || '')) throw new Error('No se pudo preparar el análisis del entrenamiento.');
  sessions.set(userId, { id, fingerprint });
  return id;
}

function extractExplicitSteps(description, stepContext = {}) {
  const text = String(description || '');
  const matches = [...text.matchAll(/\b(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(mil)?\s*pasos\b/gi)];
  if (matches.length !== 1) return { stepsCount: null, stepsDate: null };
  const [, raw, thousands] = matches[0];
  const amount = raw.includes('.') || raw.includes(',')
    ? raw.replace(/[.,](?=\d{3}(?:\D|$))/g, '').replace(',', '.')
    : raw;
  const stepsCount = Number(amount) * (thousands ? 1000 : 1);
  const localDate = stepContext.localDate;
  const parsedLocalDate = typeof localDate === 'string' ? new Date(`${localDate}T00:00:00Z`) : null;
  if (!Number.isSafeInteger(stepsCount) || stepsCount < 0 || stepsCount > 250000
    || !/^\d{4}-\d{2}-\d{2}$/.test(localDate || '') || Number.isNaN(parsedLocalDate?.getTime())
    || parsedLocalDate.toISOString().slice(0, 10) !== localDate) return { stepsCount: null, stepsDate: null };
  const dateMentions = [...text.matchAll(/\b(anteayer|ayer|hoy|mañana|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b/gi)];
  if (dateMentions.length > 1) return { stepsCount: null, stepsDate: null };
  let day = new Date(`${localDate}T00:00:00Z`);
  const dateMention = dateMentions[0]?.[1]?.toLowerCase();
  if (dateMention === 'mañana') return { stepsCount: null, stepsDate: null };
  if (dateMention === 'ayer') day.setUTCDate(day.getUTCDate() - 1);
  else if (dateMention === 'anteayer') day.setUTCDate(day.getUTCDate() - 2);
  else if (dateMention && dateMention !== 'hoy') {
    const date = dateMention.includes('/') ? dateMention.split('/').reverse().map((part, index) => index === 0 ? (part.length === 2 ? `20${part}` : part) : part.padStart(2, '0')).join('-') : dateMention;
    day = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== date) return { stepsCount: null, stepsDate: null };
  }
  const stepsDate = day.toISOString().slice(0, 10);
  return stepsDate > localDate ? { stepsCount: null, stepsDate: null } : { stepsCount, stepsDate };
}

function parseReply(parts, biometricContext, explicitWeightKg, description = '', stepContext = {}) {
  const raw = parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n').trim();
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let reply;
  try { reply = JSON.parse(text); }
  catch { throw new Error('El análisis del entrenamiento devolvió una respuesta no válida.'); }
  const fields = ['trainingSession', 'question', 'activity', 'durationMinutes', 'met'];
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)
    || Object.keys(reply).length !== fields.length || fields.some((key) => !Object.hasOwn(reply, key))
    || typeof reply.trainingSession !== 'boolean'
    || !(reply.question === null || typeof reply.question === 'string' && reply.question.trim() && reply.question.length <= 1000)) {
    throw new Error('El análisis devolvió datos de entrenamiento no válidos.');
  }
  const steps = extractExplicitSteps(description, stepContext);
  const fieldsAreNull = ['activity', 'durationMinutes', 'met'].every((key) => reply[key] === null);
  if (reply.trainingSession === false && (reply.question !== null || !fieldsAreNull)) {
    throw new Error('La respuesta mezcló pasos diarios con una sesión de entrenamiento.');
  }
  if (!reply.trainingSession) return { ...reply, ...steps, caloriesKcal: null, weightKg: null, formula: null };
  const activity = typeof reply.activity === 'string' && reply.activity.trim() && reply.activity.length <= 120
    && !/[\u0000-\u001f]/.test(reply.activity) ? reply.activity.trim() : null;
  const durationMinutes = Number.isFinite(reply.durationMinutes) && reply.durationMinutes > 0 && reply.durationMinutes <= 1440 ? reply.durationMinutes : null;
  const met = Number.isFinite(reply.met) && reply.met > 0 && reply.met <= 30 ? reply.met : null;
  const weightKg = explicitWeightKg ?? (!biometricContext.latestWeightStale ? biometricContext.latestWeightKg : null);
  const missingDetails = [!activity && 'la actividad', durationMinutes == null && 'la duración', met == null && 'la intensidad'].filter(Boolean);
  const question = [reply.question || (missingDetails.length ? `Indica ${missingDetails.join(' y ')} del entrenamiento.` : null),
    weightKg == null ? 'Indica tu peso actual aproximado en kg; el peso registrado no está disponible o tiene más de 60 días.' : null]
    .filter(Boolean).join(' ') || null;
  const missing = missingDetails.length > 0 || weightKg == null;
  const caloriesKcal = missing || question ? null : Math.round(met * 3.5 * weightKg / 200 * durationMinutes * 10) / 10;
  return {
    trainingSession: true, question: caloriesKcal == null ? question : null,
    activity, durationMinutes, met, weightKg, ...steps, caloriesKcal,
    formula: caloriesKcal == null ? null : `${met} MET × 3.5 × ${weightKg} kg / 200 × ${durationMinutes} min`,
  };
}

async function analyzeTraining({ userId, description, userWeightContext = description, biometricData, stepContext, progressId, progressRecorder, requestOpenCode = openCodeRequest, readConfig = readFoodSessionConfig }) {
  const id = String(userId);
  const text = typeof description === 'string' ? description.trim() : '';
  if (!/^\d+$/.test(id)) throw Object.assign(new Error('Cuenta autenticada no válida.'), { status: 400 });
  if (!text || text.length > 1200) throw Object.assign(new Error('Describe el entrenamiento (máximo 1200 caracteres).'), { status: 400 });
  const numeric = (value, min, max) => {
    const number = value == null ? null : Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? number : null;
  };
  const biometricContext = {
    latestWeightKg: numeric(biometricData?.latestWeightKg, 20, 400),
    latestWeightStale: biometricData?.latestWeightStale === true,
    weightMeasuredAt: typeof biometricData?.weightMeasuredAt === 'string' ? biometricData.weightMeasuredAt.slice(0, 19) : null,
    weightSource: ['manual', 'bia'].includes(biometricData?.weightSource) ? biometricData.weightSource : null,
    registeredHeightCm: numeric(biometricData?.registeredHeightCm, 80, 250),
  };
  const savedTime = parseTrainingSavedTime(text);
  return withUserLock(id, async () => {
    reportTrainingProgress(id, progressId, 'analysis_config', progressRecorder?.record);
    const config = await readConfig();
    const systemPrompt = await readTrainingPrompt();
    reportTrainingProgress(id, progressId, 'analysis_session', progressRecorder?.record);
    const sessionId = await openTrainingSession(id, config, requestOpenCode);
    const model = config.model ? { providerID: config.model.providerID, modelID: config.model.modelID } : undefined;
    reportTrainingProgress(id, progressId, 'analysis_sent', progressRecorder?.record);
    const result = await requestOpenCode('POST', `/session/${encodeURIComponent(sessionId)}/message`, {
      system: systemPrompt,
      tools: {},
      ...(model ? { model } : {}),
      ...(config.agent ? { agent: config.agent } : {}),
      ...(config.variant ? { variant: config.variant } : {}),
      parts: [{ type: 'text', text: JSON.stringify({ description: text, biometricContext, stepContext }) }],
    }, config.requestTimeoutMs);
    if (result.status < 200 || result.status >= 300) throw new Error('No se pudo analizar el entrenamiento.');
    reportTrainingProgress(id, progressId, 'analysis_received', progressRecorder?.record);
    const weightMatches = [...String(userWeightContext || text).matchAll(/(?:peso(?:\s+actual|\s+corporal)?\s*(?:es|de|:|=)?\s*)(\d+(?:[.,]\d+)?)\s*(?:kg|kilos?)\b|^\s*(\d+(?:[.,]\d+)?)\s*(?:kg|kilos?)\s*$/gim)];
    const weightMatch = weightMatches.at(-1);
    const explicitWeightKg = weightMatch ? numeric(Number((weightMatch[1] || weightMatch[2]).replace(',', '.')), 20, 400) : null;
    return { ...parseReply(result.data?.parts || [], biometricContext, explicitWeightKg, text, stepContext), biometricContext, requestedSaveTime: savedTime.value, saveTimeStatus: savedTime.status };
  });
}

async function deleteTrainingSession({ userId, requestOpenCode = openCodeRequest, alreadyLocked = false }) {
  const id = String(userId);
  const remove = async () => {
    const cached = sessions.get(id);
    if (!cached) return;
    const deleted = await requestOpenCode('DELETE', `/session/${encodeURIComponent(cached.id)}`);
    if ((deleted.status < 200 || deleted.status >= 300) && deleted.status !== 404) throw new Error('No se pudo cerrar la sesión de análisis del entrenamiento.');
    sessions.delete(id);
  };
  return alreadyLocked ? remove() : withUserLock(id, remove);
}

async function closePendingPlanSession(userId, requestOpenCode, runId) {
  const pending = pendingPlanSessions.get(userId);
  if (!pending || runId && pending.runId !== runId) return false;
  const deleted = await requestOpenCode('DELETE', `/session/${encodeURIComponent(pending.sessionId)}`);
  if ((deleted.status < 200 || deleted.status >= 300) && deleted.status !== 404) {
    throw Object.assign(new Error('No se pudo cerrar la sesión del plan.'), { code: 'TRAINING_PLAN_SESSION_CLEANUP' });
  }
  pendingPlanSessions.delete(userId);
  return true;
}

async function deleteTrainingPlanSession({ userId, runId, requestOpenCode = openCodeRequest }) {
  const id = String(userId);
  if (!/^\d+$/.test(id) || runId != null && typeof runId !== 'string') return false;
  return withUserLock(id, () => closePendingPlanSession(id, requestOpenCode, runId));
}

async function generateTrainingPlan({ userId, goals, context, progressId, progressRecorder, requestOpenCode = openCodeRequest, readConfig = readFoodSessionConfig }) {
  const id = String(userId);
  const text = typeof goals === 'string' ? goals.trim() : '';
  if (!/^\d+$/.test(id)) throw Object.assign(new Error('Cuenta autenticada no válida.'), { status: 400 });
  if (!text || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw Object.assign(new Error('Describe tus objetivos (máximo 2000 caracteres).'), { status: 400 });
  }
  reportTrainingProgress(id, progressId, 'plan_config', progressRecorder?.record);
  const config = await readConfig();
  const systemPrompt = await readTrainingPlanPrompt();
  const model = config.model ? { providerID: config.model.providerID, modelID: config.model.modelID } : undefined;
  const fingerprint = createHash('sha256').update(JSON.stringify({ userId: id, scope: 'training-plan', model: config.model, agent: config.agent, variant: config.variant })).digest('hex');
  return withUserLock(id, async () => {
    await closePendingPlanSession(id, requestOpenCode);
    let created;
    reportTrainingProgress(id, progressId, 'plan_session', progressRecorder?.record);
    try {
      created = await requestOpenCode('POST', '/session', {
        title: 'Plan de entrenamiento',
        ...(config.agent ? { agent: config.agent } : {}),
        ...(model ? { model: { id: model.modelID, providerID: model.providerID, ...(config.variant ? { variant: config.variant } : {}) } } : {}),
        permission: permissions,
        metadata: { trainingPlanUserId: id, trainingPlanConfigSha256: fingerprint },
      }, config.requestTimeoutMs);
    } catch {
      throw Object.assign(new Error('No se pudo abrir la sesión para crear el plan.'), { code: 'TRAINING_PLAN_SESSION_OPEN' });
    }
    const sessionId = created.data?.id;
    if (created.status < 200 || created.status >= 300 || !/^ses_[A-Za-z0-9_-]{4,120}$/.test(sessionId || '')) {
      throw Object.assign(new Error('No se pudo abrir la sesión para crear el plan.'), { code: 'TRAINING_PLAN_SESSION_OPEN' });
    }
    let retained = false;
    try {
      reportTrainingProgress(id, progressId, 'plan_sent', progressRecorder?.record);
      const result = await requestOpenCode('POST', `/session/${encodeURIComponent(sessionId)}/message`, {
        system: systemPrompt,
        tools: {},
        ...(model ? { model } : {}),
        ...(config.agent ? { agent: config.agent } : {}),
        ...(config.variant ? { variant: config.variant } : {}),
        parts: [{ type: 'text', text: JSON.stringify({ goals: text, context }) }],
      }, config.requestTimeoutMs);
      if (result.status < 200 || result.status >= 300) throw new Error('No se pudo generar el plan.');
      reportTrainingProgress(id, progressId, 'plan_received', progressRecorder?.record);
      const plan = parseTrainingPlanReply(result.data?.parts || [], systemPrompt, context);
      const runId = randomUUID();
      pendingPlanSessions.set(id, { sessionId, runId });
      retained = true;
      return { ...plan, runId };
    } finally {
      if (!retained) {
        try {
          const deleted = await requestOpenCode('DELETE', `/session/${encodeURIComponent(sessionId)}`, undefined, config.requestTimeoutMs);
          if ((deleted.status < 200 || deleted.status >= 300) && deleted.status !== 404) throw new Error();
        } catch { throw Object.assign(new Error('No se pudo cerrar la sesión temporal del plan.'), { code: 'TRAINING_PLAN_SESSION_CLEANUP' }); }
      }
    }
  });
}

module.exports = { analyzeTraining, deleteTrainingPlanSession, deleteTrainingSession, extractExplicitSteps, generateTrainingPlan, getTrainingProgress, parseReply, parseTrainingPlanReply, readTrainingPlanPrompt, reportTrainingProgress };
