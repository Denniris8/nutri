const { createHash } = require('node:crypto');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const { openCodeRequest, readFoodSessionConfig } = require('./opencode-food.js');

const promptPath = path.resolve(__dirname, '../../comportamiento-sesion-chef.md');
const permissions = [{ permission: '*', pattern: '*', action: 'deny' }];
const sessions = new Map();
const locks = new Map();
const nutrientFields = [
  ['caloriesKcal', 'energyKcal', 'calorias_kcal'],
  ['proteinG', 'proteinG', 'proteinas_g'],
  ['carbohydrateG', 'carbohydrateG', 'carbohidratos_g'],
  ['fatG', 'fatG', 'grasas_g'],
];

function buildChefNutritionContext({ date, foodRecords, trainingRecords, exercise, activePlan }) {
  const completed = foodRecords.filter((record) => record.state === 'completado');
  const items = completed.flatMap((record) => record.items || []);
  const hasTraining = trainingRecords.length > 0;
  const base = activePlan?.macros || {};
  const adjustment = exercise?.adjustmentKcal != null && Number.isFinite(Number(exercise.adjustmentKcal))
    ? Number(exercise.adjustmentKcal) : null;
  const consumptionComplete = items.length > 0;
  const macroSources = { estimated: 0, declared: 0, sourced: 0 };
  for (const item of items) {
    if (item.macroStatus === 'estimado') macroSources.estimated += 1;
    if (item.macroSource === 'declarado_usuario') macroSources.declared += 1;
    if (!['estimado', 'declarado_usuario'].includes(item.macroSource)) macroSources.sourced += 1;
  }
  const nutrients = Object.fromEntries(nutrientFields.map(([key, itemKey, targetKey]) => {
    const rawTarget = base[targetKey];
    const baseTarget = rawTarget == null ? null : Number(rawTarget);
    const exerciseAware = hasTraining && (key === 'caloriesKcal' || key === 'carbohydrateG');
    const extra = key === 'carbohydrateG' && adjustment != null ? adjustment / 4 : adjustment;
    const target = baseTarget == null || !Number.isFinite(baseTarget) || baseTarget < 0 || exerciseAware && extra == null
      ? null : baseTarget + (exerciseAware ? extra : 0);
    const available = consumptionComplete && items.every((item) => item.basis === 'per_portion'
      && item[itemKey] != null && Number.isFinite(Number(item[itemKey])) && Number(item[itemKey]) >= 0);
    const consumed = available ? items.reduce((sum, item) => sum + Number(item[itemKey]), 0) : null;
    return [key, { target, consumed, remaining: target != null && consumed != null ? Math.round((target - consumed) * 10) / 10 : null }];
  }));
  return {
    date,
    targetSource: activePlan ? 'plan_activo' : 'sin_plan_activo',
    consumptionStatus: items.length
      ? nutrientFields.every(([, itemKey]) => items.every((item) => item.basis === 'per_portion' && item[itemKey] != null && Number.isFinite(Number(item[itemKey])) && Number(item[itemKey]) >= 0)) ? 'completo' : 'incompleto'
      : completed.length ? 'incompleto' : 'sin_registros_completos',
    completedMealCount: completed.length,
    pendingMealCount: foodRecords.filter((record) => record.state !== 'completado').length,
    trainingSessionCount: trainingRecords.length,
    exerciseAdjustmentKcal: hasTraining ? adjustment : null,
    macroSources,
    nutrients,
  };
}

async function readChefPrompt() {
  let document;
  try { document = await readFile(promptPath, 'utf8'); }
  catch { throw Object.assign(new Error('No se pudo leer el comportamiento de Chef.'), { code: 'CHEF_PROMPT_READ_FAILED' }); }
  const prompt = document.match(/<!-- CHEF_OPENCODE_PROMPT_START -->([\s\S]*?)<!-- CHEF_OPENCODE_PROMPT_END -->/);
  if (!prompt) throw Object.assign(new Error('No se encontró el prompt canónico de Chef.'), { code: 'CHEF_PROMPT_INVALID' });
  return prompt[1].trim();
}

function withUserLock(userId, run) {
  const previous = locks.get(userId) || Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  locks.set(userId, current);
  return current.finally(() => { if (locks.get(userId) === current) locks.delete(userId); });
}

async function openChefSession(userId, config, request) {
  const fingerprint = createHash('sha256').update(JSON.stringify({ userId, scope: 'chef-chat', model: config.model, agent: config.agent, variant: config.variant })).digest('hex');
  const cached = sessions.get(userId);
  if (cached?.fingerprint === fingerprint) {
    const current = await request('GET', `/session/${encodeURIComponent(cached.id)}`, undefined, config.requestTimeoutMs);
    if (current.status >= 200 && current.status < 300 && current.data?.metadata?.chefUserId === userId && current.data?.metadata?.chefConfigSha256 === fingerprint) return cached.id;
    sessions.delete(userId);
  }
  const model = config.model ? { id: config.model.modelID, providerID: config.model.providerID, ...(config.variant ? { variant: config.variant } : {}) } : undefined;
  const created = await request('POST', '/session', {
    title: 'Chat Chef',
    ...(config.agent ? { agent: config.agent } : {}),
    ...(model ? { model } : {}),
    permission: permissions,
    metadata: { chefUserId: userId, chefConfigSha256: fingerprint },
  }, config.requestTimeoutMs);
  const sessionId = created.data?.id;
  if (created.status < 200 || created.status >= 300 || !/^ses_[A-Za-z0-9_-]{4,120}$/.test(sessionId || '')) {
    throw Object.assign(new Error('No se pudo iniciar el chat Chef.'), { code: 'CHEF_SESSION_OPEN_FAILED' });
  }
  sessions.set(userId, { id: sessionId, fingerprint });
  return sessionId;
}

async function sendChefMessage({ userId, message, nutritionContext, requestOpenCode = openCodeRequest, readConfig = readFoodSessionConfig }) {
  const id = String(userId);
  const text = typeof message === 'string' ? message.trim() : '';
  if (!/^\d+$/.test(id)) throw Object.assign(new Error('Cuenta autenticada no válida.'), { status: 400 });
  if (!text || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw Object.assign(new Error('Escribe un mensaje de hasta 2000 caracteres.'), { status: 400 });
  }
  return withUserLock(id, async () => {
    const [config, system] = await Promise.all([readConfig(), readChefPrompt()]);
    const sessionId = await openChefSession(id, config, requestOpenCode);
    const model = config.model ? { providerID: config.model.providerID, modelID: config.model.modelID } : undefined;
    const result = await requestOpenCode('POST', `/session/${encodeURIComponent(sessionId)}/message`, {
      system,
      tools: {},
      ...(model ? { model } : {}),
      ...(config.agent ? { agent: config.agent } : {}),
      ...(config.variant ? { variant: config.variant } : {}),
      parts: [{ type: 'text', text: JSON.stringify({ message: text, nutritionContext }) }],
    }, config.requestTimeoutMs);
    if (result.status < 200 || result.status >= 300) throw Object.assign(new Error('Chef no pudo completar la respuesta.'), { code: 'CHEF_REPLY_FAILED' });
    const answer = (result.data?.parts || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('\n').trim();
    if (!answer || answer.length > 12000) throw Object.assign(new Error('Chef no devolvió una respuesta válida.'), { code: 'CHEF_REPLY_INVALID' });
    return answer;
  });
}

async function deleteChefSession({ userId, requestOpenCode = openCodeRequest }) {
  const id = String(userId);
  if (!/^\d+$/.test(id)) throw Object.assign(new Error('Cuenta autenticada no válida.'), { status: 400 });
  return withUserLock(id, async () => {
    const cached = sessions.get(id);
    if (!cached) return false;
    const deleted = await requestOpenCode('DELETE', `/session/${encodeURIComponent(cached.id)}`);
    if ((deleted.status < 200 || deleted.status >= 300) && deleted.status !== 404) {
      throw Object.assign(new Error('No se pudo cerrar el chat Chef.'), { code: 'CHEF_SESSION_CLEANUP_FAILED' });
    }
    sessions.delete(id);
    return true;
  });
}

module.exports = { buildChefNutritionContext, deleteChefSession, readChefPrompt, sendChefMessage };
