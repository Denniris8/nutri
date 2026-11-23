const { createHash, createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { openCodeRequest, readFoodSessionConfig } = require('./opencode-food.js');
const { parseTrainingSavedTime } = require('./training-entries.js');
const { extractPlanDisclosure, validatePlanSemantics, recordedPlanFacts } = require('./training-plans.js');
const { createAnalysisProgressRecorder } = require('./analysis-progress.js');

const permissions = [{ permission: '*', pattern: '*', action: 'deny' }];
// El ID vive solo en memoria del servidor; el cliente nunca elige ni recibe una sesión reutilizable.
const sessions = new Map();
const pendingPlanSessions = new Map();
const locks = new Map();
const planLocks = new Map();
const progress = new Map();
const trainingPromptPath = path.resolve(__dirname, '../../comportamiento-sesion-entrenamientos.md');
const trainingPlanPromptPath = path.resolve(__dirname, '../../comportamiento-sesion-plan.md');
const bodyWeightQuestion = 'Indica tu peso actual aproximado en kg; el peso registrado no está disponible o tiene más de 60 días.';

function issueTrainingPlanDraft(userId, pending, secret) {
  if (!secret) return undefined;
  const { runId, goals, context, plan, macros, expiresAt } = pending;
  const payload = Buffer.from(JSON.stringify({ userId: String(userId), runId, goals, context, plan, macros, expiresAt })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`training-plan-draft-v1:${payload}`).digest('base64url');
  return `${payload}.${signature}`;
}

function readTrainingPlanDraft(userId, token, secret) {
  const invalid = () => Object.assign(new Error('El borrador venció o no pertenece a esta cuenta. Genera un plan nuevo.'), { status: 409 });
  if (!secret || typeof token !== 'string' || token.length > 500000) throw invalid();
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw invalid();
  const expected = createHmac('sha256', secret).update(`training-plan-draft-v1:${payload}`).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
  let draft;
  try { draft = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (draft.userId !== String(userId) || !Number.isFinite(draft.expiresAt) || draft.expiresAt <= Date.now()) throw invalid();
  return draft;
}

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
    plan_question: 'Hace falta una aclaración antes de completar el plan.',
    analysis_failed: 'El análisis del entrenamiento se detuvo.', plan_failed: 'La generación del plan se detuvo.',
    analysis_retry: 'Respuesta incompleta; reintentando el análisis…', plan_retry: 'Plan incompleto; reintentando la generación…',
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

function withUserLock(userId, run, store = locks) {
  const previous = store.get(userId) || Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  store.set(userId, current);
  return current.finally(() => { if (store.get(userId) === current) store.delete(userId); });
}

function parseTrainingPlanReply(parts, systemPrompt, context = {}, fixedMacros) {
  const raw = parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let reply;
  try { reply = JSON.parse(raw); }
  catch { throw new Error('El plan generado no cumple el formato esperado.'); }
  const macros = reply?.macros_objetivo;
  if (reply?.estado === 'requiere_aclaracion') {
    const question = typeof reply.pregunta === 'string' && reply.pregunta.trim();
    if (Object.keys(reply).length !== 2 || !question || question.length > 500 || /[\r\n]/.test(question)
      || !/^¿[^¿?]+\?$/.test(question)) throw new Error('Devuelve únicamente una pregunta concreta entre ¿ y ?.');
    return { state: 'requiere_aclaracion', question };
  }
  const keys = ['proteinas_g', 'carbohidratos_g', 'grasas_g', 'calorias_kcal'];
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)
    || reply.estado !== 'plan_listo' || Object.keys(reply).length !== 3 || !Object.hasOwn(reply, 'plan_markdown') || !Object.hasOwn(reply, 'macros_objetivo')
    || typeof reply.plan_markdown !== 'string' || !reply.plan_markdown.trim() || reply.plan_markdown.length > 30000
    || !macros || typeof macros !== 'object' || Array.isArray(macros)
    || Object.keys(macros).length !== keys.length || keys.some((key) => !Object.hasOwn(macros, key))) {
    throw new Error('El plan generado tiene campos incompletos.');
  }
  const limits = { proteinas_g: 10000, carbohidratos_g: 10000, grasas_g: 10000, calorias_kcal: 100000 };
  for (const key of keys) {
    const value = macros[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > limits[key]) throw new Error('El plan generado contiene metas de macros no válidas.');
    macros[key] = Number(value.toFixed(key === 'calorias_kcal' ? 1 : 2));
    if (!macros[key]) throw new Error('La meta redondeada debe ser positiva.');
  }
  if (fixedMacros && keys.some(key => macros[key] !== fixedMacros[key])) throw new Error('Conserva los macros de reposo del borrador sin cambios.');
  const body = reply.plan_markdown.trim();
  if (!body.startsWith('[Estimaciones Calculadas]') || body.includes('[Datos Registrados]') || body.split('[Supuestos Adoptados]').length !== 2) throw new Error('Devuelve solo estimaciones, supuestos y recomendaciones.');
  const disclosure = extractPlanDisclosure(systemPrompt);
  const table = `| Nutriente | Meta diaria de reposo |\n|---|---:|\n| Proteínas | ${macros.proteinas_g} g |\n| Carbohidratos | ${macros.carbohidratos_g} g |\n| Grasas | ${macros.grasas_g} g |\n| Calorías | ${macros.calorias_kcal} kcal |\n${disclosure}`;
  const plan = `[Datos Registrados]\n${recordedPlanFacts(context)}\n\n${body}\n\n${table}`;
  if (plan.length > 30000) throw new Error('Reduce la extensión del plan.');
  validatePlanSemantics(plan, macros, disclosure, context);
  return { state: 'plan_listo', plan, macros };
}

async function openTrainingSession(userId, config, request) {
  const fingerprint = createHash('sha256').update(JSON.stringify({ userId, scope: 'training-analysis', model: config.model, agent: config.agent, variant: config.variant })).digest('hex');
  const cached = sessions.get(userId);
  if (cached?.fingerprint === fingerprint && Date.now() - cached.verifiedAt < 30000) return cached.id;
  if (cached?.fingerprint === fingerprint) {
    const current = await request('GET', `/session/${encodeURIComponent(cached.id)}`, undefined, config.requestTimeoutMs);
    if (current.status >= 200 && current.status < 300 && current.data?.metadata?.trainingUserId === userId && current.data?.metadata?.trainingConfigSha256 === fingerprint) {
      cached.verifiedAt = Date.now();
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
  sessions.set(userId, { ...(cached?.fingerprint === fingerprint ? cached : {}), id, fingerprint, verifiedAt: Date.now() });
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
  const dateMention = dateMentions[0]?.[1]?.toLowerCase();
  let day = new Date(`${dateMention ? localDate : stepContext.selectedDate || localDate}T00:00:00Z`);
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
    weightKg == null ? bodyWeightQuestion : null]
    .filter(Boolean).join(' ') || null;
  const missing = missingDetails.length > 0 || weightKg == null;
  const caloriesKcal = missing || question ? null : Math.round(met * 3.5 * weightKg / 200 * durationMinutes * 10) / 10;
  return {
    trainingSession: true, question: weightKg == null && !missingDetails.length && (!reply.question || /(?:tu peso|peso (?:actual|corporal))/i.test(reply.question) && !/carga|levant|barra|mancuerna/i.test(reply.question)) ? bodyWeightQuestion : caloriesKcal == null ? question : null,
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
  const explicitSteps = extractExplicitSteps(text, stepContext);
  if (stepContext?.selectedDate) {
    const mentions = text.replace(/\b(?:por|de) la mañana\b/gi, '').match(/\b(?:anteayer|ayer|hoy|mañana|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b/gi) || [];
    if (mentions.some((mention) => extractExplicitSteps(`${mention}: 0 pasos`, stepContext).stepsDate !== stepContext.selectedDate)) {
      throw Object.assign(new Error(`Está seleccionado ${stepContext.selectedDate}, pero la fecha del mensaje no coincide. Elige el día correcto o corrige la descripción antes de guardar.`), { status: 400 });
    }
  }
  if (explicitSteps.stepsCount !== null && /^(?:(?:hoy|ayer|anteayer)[:,]?\s+)?(?:(?:hice|caminé|registré|di)\s+)?\d[\d.,]*\s*(?:mil\s*)?pasos[.!]?$/i.test(text)) {
    return { trainingSession: false, activity: null, durationMinutes: null, met: null, question: null, ...explicitSteps, caloriesKcal: null, weightKg: null, formula: null, biometricContext, saveTimeStatus: 'none', requestedSaveTime: null };
  }
  return withUserLock(id, async () => {
    reportTrainingProgress(id, progressId, 'analysis_config', progressRecorder?.record);
    const config = await readConfig();
    const systemPrompt = await readTrainingPrompt();
    reportTrainingProgress(id, progressId, 'analysis_session', progressRecorder?.record);
    let sessionId = await openTrainingSession(id, config, requestOpenCode);
    const model = config.model ? { providerID: config.model.providerID, modelID: config.model.modelID } : undefined;
    reportTrainingProgress(id, progressId, 'analysis_sent', progressRecorder?.record);
    const context = sessions.get(id);
    const declaration = [...text.matchAll(/\b(?:mi peso(?:\s+actual|\s+corporal)?(?:\s+es)?|peso (?:actual|corporal)|yo peso)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(?:kg|kilos?)\b/gi)].at(-1);
    const bare = context.awaitingWeight && text.match(/^(\d+(?:[.,]\d+)?)\s*(?:kg|kilos?)\.?$/i);
    const rawWeight = declaration?.[1] || bare?.[1];
    const explicitWeightKg = rawWeight ? numeric(Number(rawWeight.replace(',', '.')), 20, 400) : context.weightKg ?? null;
    let recovered = false;
    const analyze = async (correccionFormato) => {
      const send = () => requestOpenCode('POST', `/session/${encodeURIComponent(sessionId)}/message`, {
        system: systemPrompt,
        tools: {},
        ...(model ? { model } : {}),
        ...(config.agent ? { agent: config.agent } : {}),
        ...(config.variant ? { variant: config.variant } : {}),
        parts: [{ type: 'text', text: JSON.stringify({ description: text, historialUsuario: userWeightContext, preguntaAnterior: context.question, biometricContext, stepContext, ...(correccionFormato ? { correccionFormato } : {}) }) }],
      }, config.requestTimeoutMs);
      let result;
      try { result = await send(); }
      catch (error) { if (error.status !== 404) throw error; result = { status: 404 }; }
      if (result.status === 404 && !recovered) {
        recovered = true;
        sessions.delete(id);
        sessionId = await openTrainingSession(id, config, requestOpenCode);
        result = await send();
      }
      if (result.status < 200 || result.status >= 300) throw new Error('No se pudo analizar el entrenamiento.');
      reportTrainingProgress(id, progressId, 'analysis_received', progressRecorder?.record);
      try { return parseReply(result.data?.parts || [], biometricContext, explicitWeightKg, text, stepContext); }
      catch (error) { throw Object.assign(error, { code: 'TRAINING_REPLY_FORMAT' }); }
    };
    let reply;
    try { reply = await analyze(); }
    catch (error) {
      if (error.code !== 'TRAINING_REPLY_FORMAT') throw error;
      reportTrainingProgress(id, progressId, 'analysis_retry', progressRecorder?.record);
      reply = await analyze('Devuelve únicamente el JSON con todos los campos requeridos y con los tipos indicados.');
    }
    if (!reply.trainingSession && /\bentren/i.test(text)) {
      reportTrainingProgress(id, progressId, 'analysis_no_session_retry', progressRecorder?.record);
      reply = await analyze('El usuario mencionó un entrenamiento. Si afirma haberlo realizado, clasifícalo con trainingSession:true y pregunta solo el dato que falte. Si solo menciona pasos o niega haber entrenado, mantén trainingSession:false.');
    }
    Object.assign(sessions.get(id), { weightKg: explicitWeightKg, question: reply.question, awaitingWeight: reply.question === bodyWeightQuestion });
    return { ...reply, biometricContext, requestedSaveTime: savedTime.value, saveTimeStatus: savedTime.status };
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
  const deleted = pending.sessionId ? await requestOpenCode('DELETE', `/session/${encodeURIComponent(pending.sessionId)}`, undefined, 5000) : { status: 204 };
  if ((deleted.status < 200 || deleted.status >= 300) && deleted.status !== 404) {
    throw Object.assign(new Error('No se pudo cerrar la sesión del plan.'), { code: 'TRAINING_PLAN_SESSION_CLEANUP' });
  }
  pendingPlanSessions.delete(userId);
  return true;
}

async function deleteTrainingPlanSession({ userId, runId, requestOpenCode = openCodeRequest }) {
  const id = String(userId);
  if (!/^\d+$/.test(id) || runId != null && typeof runId !== 'string') return false;
  return withUserLock(id, () => closePendingPlanSession(id, requestOpenCode, runId), planLocks);
}

async function refineTrainingPlan({ userId, runId, changes, snapshot, progressId, progressRecorder, requestOpenCode = openCodeRequest, readConfig = readFoodSessionConfig }) {
  const id = String(userId);
  const text = typeof changes === 'string' ? changes.trim() : '';
  if (!/^\d+$/.test(id) || typeof runId !== 'string' || !text || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw Object.assign(new Error('Describe los cambios que quieres hacer (máximo 2000 caracteres).'), { status: 400 });
  }
  return withUserLock(id, async () => {
    if (!snapshot || snapshot.runId !== runId) throw Object.assign(new Error('El borrador ya no está disponible. Genera un plan nuevo.'), { status: 409 });
    const cached = pendingPlanSessions.get(id);
    if (cached && cached.runId !== runId) await closePendingPlanSession(id, requestOpenCode);
    const pending = { ...snapshot, sessionId: cached?.runId === runId ? cached.sessionId : null };
    const prior = pending.baseline || (pending.plan ? { plan_markdown: pending.plan, macros_objetivo: pending.macros } : null);
    const requestText = [pending.pendingChange, text].filter(Boolean).join('\n');
    // Una mención («no cambies las calorías») no autoriza recalcular las metas.
    const changeNutrition = requestText.split(/[.;!?\n]/).some(clause =>
      !/\b(?:no|sin|conserva|mant[eé]n)\b/i.test(clause) &&
      /\b(?:ajust\w*|cambi\w*|recalcul\w*|aument\w*|reduc\w*|sub[ei]\w*|baj\w*|fij\w*|modific\w*|quiero)\b.{0,60}\b(?:macros?|calor[ií]as|kcal|prote[ií]nas?|grasas?|carbohidratos?|d[eé]ficit|super[aá]vit|objetivo energ[eé]tico)\b/i.test(clause));
    const fixedMacros = prior && !changeNutrition ? prior.macros_objetivo : null;
    if (pending.expiresAt <= Date.now()) throw Object.assign(new Error('El borrador venció. Genera un plan nuevo.'), { status: 409 });
    const config = await readConfig();
    const systemPrompt = await readTrainingPlanPrompt();
    const model = config.model ? { providerID: config.model.providerID, modelID: config.model.modelID } : undefined;
    const openSession = async () => {
      const created = await requestOpenCode('POST', '/session', {
        title: 'Plan de entrenamiento recuperado', permission: permissions,
        metadata: { trainingPlanUserId: id },
      }, config.requestTimeoutMs);
      if (created.status < 200 || created.status >= 300 || !/^ses_[A-Za-z0-9_-]{4,120}$/.test(created.data?.id || '')) throw Object.assign(new Error('No se pudo recuperar la sesión del plan.'), { upstream: true });
      pending.sessionId = created.data.id;
      pendingPlanSessions.set(id, { runId, sessionId: pending.sessionId });
    };
    if (!pending.sessionId) await openSession();
    reportTrainingProgress(id, progressId, 'plan_sent', progressRecorder?.record);
    let recovered = false;
    const send = async (correccionFormato) => {
      const body = {
        system: systemPrompt, tools: {}, ...(model ? { model } : {}),
        ...(config.agent ? { agent: config.agent } : {}), ...(config.variant ? { variant: config.variant } : {}),
        parts: [{ type: 'text', text: JSON.stringify({ goals: pending.goals, context: pending.context, borradorActual: prior, aclaraciones: pending.answers || [], preguntaPendiente: pending.question, cambioPendiente: pending.pendingChange, cambiosSolicitados: text, macrosFijos: fixedMacros, ...(correccionFormato ? { correccionFormato } : {}) }) }],
      };
      const post = () => requestOpenCode('POST', `/session/${encodeURIComponent(pending.sessionId)}/message`, body, config.requestTimeoutMs);
      let result;
      try { result = await post(); } catch (error) { if (error.status !== 404) throw error; result = { status: 404 }; }
      if (result.status === 404 && !recovered) {
        recovered = true;
        await openSession();
        result = await post();
      }
      if (result.status < 200 || result.status >= 300) throw Object.assign(new Error('No se pudo actualizar el plan.'), { upstream: true });
      reportTrainingProgress(id, progressId, 'plan_received', progressRecorder?.record);
      try { return parseTrainingPlanReply(result.data?.parts || [], systemPrompt, pending.context, fixedMacros); }
      catch (error) { throw Object.assign(error, { code: 'PLAN_FORMAT' }); }
    };
    let refined;
    try { refined = await send(); }
    catch (error) {
      if (error.code !== 'PLAN_FORMAT') throw error;
      refined = await send(`Aplica los cambios solicitados al borrador y devuelve únicamente el objeto JSON completo requerido. Error de validación previo: ${String(error.message).slice(0, 250)}`);
    }
    return { ...refined, runId, expiresAt: pending.expiresAt };
  }, planLocks);
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
    let failure;
    try {
      reportTrainingProgress(id, progressId, 'plan_sent', progressRecorder?.record);
      const generate = async (correccionFormato) => {
        const result = await requestOpenCode('POST', `/session/${encodeURIComponent(sessionId)}/message`, {
          system: systemPrompt,
          tools: {},
          ...(model ? { model } : {}),
          ...(config.agent ? { agent: config.agent } : {}),
          ...(config.variant ? { variant: config.variant } : {}),
          parts: [{ type: 'text', text: JSON.stringify({ goals: text, context, ...(correccionFormato ? { correccionFormato } : {}) }) }],
        }, config.requestTimeoutMs);
        if (result.status < 200 || result.status >= 300) throw Object.assign(new Error('No se pudo generar el plan.'), { upstream: true });
        reportTrainingProgress(id, progressId, 'plan_received', progressRecorder?.record);
        try { return parseTrainingPlanReply(result.data?.parts || [], systemPrompt, context); }
        catch (error) { throw Object.assign(error, { code: 'PLAN_FORMAT' }); }
      };
      let plan;
      try { plan = await generate(); }
      catch (error) {
        if (error.code !== 'PLAN_FORMAT') throw error;
        reportTrainingProgress(id, progressId, 'plan_retry', progressRecorder?.record);
        plan = await generate(`Corrige la respuesta anterior: ${String(error.message).slice(0, 300)} Devuelve únicamente el JSON completo requerido.`);
      }
      const runId = progressId || randomUUID();
      pendingPlanSessions.set(id, { sessionId, runId });
      retained = true;
      return { ...plan, runId, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (!retained) {
        try {
          const deleted = await requestOpenCode('DELETE', `/session/${encodeURIComponent(sessionId)}`, undefined, 5000);
          if ((deleted.status < 200 || deleted.status >= 300) && deleted.status !== 404) throw new Error();
        } catch { throw Object.assign(new Error('No se pudo cerrar la sesión temporal del plan.'), { code: 'TRAINING_PLAN_SESSION_CLEANUP', cause: failure }); }
      }
    }
  }, planLocks);
}

module.exports = { analyzeTraining, deleteTrainingPlanSession, deleteTrainingSession, extractExplicitSteps, generateTrainingPlan, getTrainingProgress, issueTrainingPlanDraft, readTrainingPlanDraft, parseReply, parseTrainingPlanReply, readTrainingPlanPrompt, refineTrainingPlan, reportTrainingProgress };
