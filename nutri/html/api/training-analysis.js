const { createHash } = require('node:crypto');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { openCodeRequest, readFoodSessionConfig } = require('./opencode-food.js');
const { parseTrainingSavedTime } = require('./training-entries.js');

const permissions = [{ permission: '*', pattern: '*', action: 'deny' }];
// El ID vive solo en memoria del servidor; el cliente nunca elige ni recibe una sesión reutilizable.
const sessions = new Map();
const locks = new Map();
const trainingPromptPath = path.resolve(__dirname, '../../comportamiento-sesion-entrenamientos.md');
const trainingPlanPromptPath = path.resolve(__dirname, '../../comportamiento-sesion-plan.md');

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

function parseTrainingPlanReply(parts) {
  const raw = parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n').trim();
  let reply;
  try { reply = JSON.parse(raw); }
  catch { throw new Error('OpenCode devolvió un plan que no cumple el formato JSON.'); }
  const macros = reply?.macros_objetivo;
  const keys = ['proteinas_g', 'carbohidratos_g', 'grasas_g', 'calorias_kcal'];
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)
    || Object.keys(reply).length !== 2 || !Object.hasOwn(reply, 'plan_markdown') || !Object.hasOwn(reply, 'macros_objetivo')
    || typeof reply.plan_markdown !== 'string' || !reply.plan_markdown.trim() || reply.plan_markdown.length > 30000
    || !macros || typeof macros !== 'object' || Array.isArray(macros)
    || Object.keys(macros).length !== keys.length || keys.some((key) => !Object.hasOwn(macros, key))) {
    throw new Error('OpenCode devolvió un plan con campos incompletos.');
  }
  const limits = { proteinas_g: 10000, carbohidratos_g: 10000, grasas_g: 10000, calorias_kcal: 100000 };
  for (const key of keys) {
    const value = macros[key];
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > limits[key])) {
      throw new Error('OpenCode devolvió metas de macros no válidas.');
    }
  }
  return { plan: reply.plan_markdown.trim(), macros: Object.fromEntries(keys.map((key) => [key, macros[key]])) };
}

async function openTrainingSession(userId, config, request) {
  const fingerprint = createHash('sha256').update(JSON.stringify({ userId, scope: 'training-analysis', model: config.model, agent: config.agent, variant: config.variant })).digest('hex');
  const cached = sessions.get(userId);
  if (cached?.fingerprint === fingerprint) {
    const current = await request('GET', `/session/${encodeURIComponent(cached.id)}`, undefined, config.requestTimeoutMs);
    if (current.status >= 200 && current.status < 300 && current.data?.metadata?.trainingUserId === userId && current.data?.metadata?.trainingConfigSha256 === fingerprint) return cached.id;
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
  if (created.status < 200 || created.status >= 300 || !/^ses_[A-Za-z0-9_-]{4,120}$/.test(id || '')) throw new Error('No se pudo iniciar la sesión OpenCode de entrenamiento.');
  sessions.set(userId, { id, fingerprint });
  return id;
}

function parseReply(parts, biometricContext) {
  const raw = parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n').trim();
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let reply;
  try { reply = JSON.parse(text); }
  catch { throw new Error('OpenCode devolvió una respuesta de entrenamiento no válida.'); }
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)
    || typeof reply.trainingSession !== 'boolean'
    || !(reply.question === null || typeof reply.question === 'string' && reply.question.length <= 1000)
    || !(reply.caloriesKcal === null || Number.isFinite(reply.caloriesKcal) && reply.caloriesKcal >= 0 && reply.caloriesKcal <= 100000)) {
    throw new Error('OpenCode devolvió datos de entrenamiento no válidos.');
  }
  const stepsCount = reply.stepsCount ?? null;
  const stepsDate = reply.stepsDate ?? null;
  const parsedStepsDate = stepsDate === null ? null : new Date(`${stepsDate}T00:00:00Z`);
  if (!(stepsCount === null || Number.isSafeInteger(stepsCount) && stepsCount >= 0 && stepsCount <= 250000)
    || !(stepsDate === null || typeof stepsDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stepsDate)
      && !Number.isNaN(parsedStepsDate.getTime()) && parsedStepsDate.toISOString().slice(0, 10) === stepsDate)
    || stepsCount === null && stepsDate !== null) throw new Error('OpenCode devolvió un total de pasos no válido.');
  if (reply.trainingSession === false && (reply.question !== null || reply.caloriesKcal !== null
    || ['activity', 'durationMinutes', 'weightKg', 'met', 'formula'].some((key) => reply[key] != null))) {
    throw new Error('OpenCode mezcló pasos diarios con una sesión de entrenamiento.');
  }
  if (reply.trainingSession && reply.caloriesKcal === null && !reply.question?.trim()) throw new Error('OpenCode no calculó calorías ni pidió una aclaración.');
  reply.stepsCount = stepsCount;
  reply.stepsDate = stepsDate;
  if (reply.caloriesKcal !== null) {
    if (biometricContext.latestWeightKg != null) reply.weightKg = biometricContext.latestWeightKg;
    if (typeof reply.activity !== 'string' || !reply.activity.trim() || reply.activity.length > 120
      || !Number.isFinite(reply.durationMinutes) || reply.durationMinutes <= 0 || reply.durationMinutes > 1440
      || !Number.isFinite(reply.weightKg) || reply.weightKg <= 0 || reply.weightKg > 350
      || !Number.isFinite(reply.met) || reply.met <= 0 || reply.met > 30) throw new Error('OpenCode devolvió una estimación incompleta.');
    reply.caloriesKcal = Math.round(reply.met * 3.5 * reply.weightKg / 200 * reply.durationMinutes * 10) / 10;
    reply.formula = `${reply.met} MET × 3.5 × ${reply.weightKg} kg / 200 × ${reply.durationMinutes} min`;
  }
  return reply;
}

async function analyzeTraining({ userId, description, biometricData, stepContext, requestOpenCode = openCodeRequest, readConfig = readFoodSessionConfig }) {
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
    weightMeasuredAt: typeof biometricData?.weightMeasuredAt === 'string' ? biometricData.weightMeasuredAt.slice(0, 19) : null,
    weightSource: ['manual', 'bia'].includes(biometricData?.weightSource) ? biometricData.weightSource : null,
    registeredHeightCm: numeric(biometricData?.registeredHeightCm, 80, 250),
  };
  const savedTime = parseTrainingSavedTime(text);
  return withUserLock(id, async () => {
    const config = await readConfig();
    const systemPrompt = await readTrainingPrompt();
    const sessionId = await openTrainingSession(id, config, requestOpenCode);
    const model = config.model ? { providerID: config.model.providerID, modelID: config.model.modelID } : undefined;
    const result = await requestOpenCode('POST', `/session/${encodeURIComponent(sessionId)}/message`, {
      system: systemPrompt,
      tools: {},
      ...(model ? { model } : {}),
      ...(config.agent ? { agent: config.agent } : {}),
      ...(config.variant ? { variant: config.variant } : {}),
      parts: [{ type: 'text', text: JSON.stringify({ description: text, biometricContext, stepContext }) }],
    }, config.requestTimeoutMs);
    if (result.status < 200 || result.status >= 300) throw new Error('OpenCode no pudo analizar el entrenamiento.');
    return { ...parseReply(result.data?.parts || [], biometricContext), biometricContext, requestedSaveTime: savedTime.value, saveTimeStatus: savedTime.status };
  });
}

async function prepareTrainingSession({ userId, requestOpenCode = openCodeRequest, readConfig = readFoodSessionConfig }) {
  const id = String(userId);
  if (!/^\d+$/.test(id)) throw Object.assign(new Error('Cuenta autenticada no válida.'), { status: 400 });
  return withUserLock(id, async () => {
    await deleteTrainingSession({ userId: id, requestOpenCode });
    return openTrainingSession(id, await readConfig(), requestOpenCode);
  });
}

async function deleteTrainingSession({ userId, requestOpenCode = openCodeRequest }) {
  const id = String(userId);
  const cached = sessions.get(id);
  if (!cached) return;
  const deleted = await requestOpenCode('DELETE', `/session/${encodeURIComponent(cached.id)}`);
  if ((deleted.status < 200 || deleted.status >= 300) && deleted.status !== 404) throw new Error('No se pudo eliminar la sesión OpenCode de entrenamiento.');
  sessions.delete(id);
}

async function generateTrainingPlan({ userId, goals, context, requestOpenCode = openCodeRequest, readConfig = readFoodSessionConfig }) {
  const id = String(userId);
  const text = typeof goals === 'string' ? goals.trim() : '';
  if (!/^\d+$/.test(id)) throw Object.assign(new Error('Cuenta autenticada no válida.'), { status: 400 });
  if (!text || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw Object.assign(new Error('Describe tus objetivos (máximo 2000 caracteres).'), { status: 400 });
  }
  const config = await readConfig();
  const systemPrompt = await readTrainingPlanPrompt();
  const model = config.model ? { providerID: config.model.providerID, modelID: config.model.modelID } : undefined;
  const fingerprint = createHash('sha256').update(JSON.stringify({ userId: id, scope: 'training-plan', model: config.model, agent: config.agent, variant: config.variant })).digest('hex');
  let created;
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
  try {
    const result = await requestOpenCode('POST', `/session/${encodeURIComponent(sessionId)}/message`, {
      system: systemPrompt,
      tools: {},
      ...(model ? { model } : {}),
      ...(config.agent ? { agent: config.agent } : {}),
      ...(config.variant ? { variant: config.variant } : {}),
      parts: [{ type: 'text', text: JSON.stringify({ goals: text, context }) }],
    }, config.requestTimeoutMs);
    if (result.status < 200 || result.status >= 300) throw new Error('OpenCode no pudo generar el plan.');
    return parseTrainingPlanReply(result.data?.parts || []);
  } finally {
    try {
      const deleted = await requestOpenCode('DELETE', `/session/${encodeURIComponent(sessionId)}`, undefined, config.requestTimeoutMs);
      if ((deleted.status < 200 || deleted.status >= 300) && deleted.status !== 404) throw new Error();
    } catch { throw Object.assign(new Error('No se pudo cerrar la sesión temporal del plan.'), { code: 'TRAINING_PLAN_SESSION_CLEANUP' }); }
  }
}

module.exports = { analyzeTraining, deleteTrainingSession, generateTrainingPlan, parseTrainingPlanReply, prepareTrainingSession };
