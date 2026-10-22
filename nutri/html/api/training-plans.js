const macroFields = ['proteinas_g', 'carbohidratos_g', 'grasas_g', 'calorias_kcal'];

function extractPlanDisclosure(prompt) {
  const disclosure = String(prompt).match(/añade literalmente esta frase:\s*[“"]([^”"]+)[”"]/i)?.[1];
  if (!disclosure) throw new Error('El prompt del plan no define la nota canónica de ajuste diario.');
  return disclosure;
}

function validatePlanSemantics(content, macros, disclosure, context) {
  if (!['[Datos Registrados]', '[Estimaciones Calculadas]', '[Supuestos Adoptados]'].every((label) => content.toLowerCase().includes(label.toLowerCase()))
    || typeof disclosure !== 'string' || !content.includes(disclosure)) throw new Error('El plan debe distinguir datos, estimaciones y supuestos e incluir la nota canónica de ajuste diario.');
  if (context) {
    const section = content.match(/\[Datos Registrados\]([\s\S]*?)\[Estimaciones Calculadas\]/i)?.[1] || '';
    const missingAge = context.profile?.age == null && /\b(?:edad(?!\s+corporal)|age)\b.{0,20}\b\d{1,3}\b|\b\d{1,3}\s+años\b/i.test(section);
    const missingSex = context.profile?.sex == null && /\b(?:sexo|sex)\b.{0,12}\b(?:masculino|femenino|male|female)\b/i.test(section);
    const missingHeight = context.profile?.heightCm == null && /\b(?:estatura|altura|height)\b.{0,16}\b\d{2,3}(?:[.,]\d+)?\s*(?:cm)?/i.test(section);
    const hasWeight = context.hasWeight ?? context.biometricRecords?.some((record) => Number.isFinite(Number(record.weightKg)) && Number(record.weightKg) >= 20);
    const missingWeight = !hasWeight && /\bpeso(?: corporal)?\b.{0,18}\b\d{2,3}(?:[.,]\d+)?\s*(?:kg|kilos?)?/i.test(section);
    const hasMetric = (key) => context.biometricRecords?.some((record) => record[key] != null) ?? context.bodyFacts?.[key] === true;
    const missingBodyData = [
      [/\b(?:IMC|BMI)\b.{0,24}\b\d+(?:[.,]\d+)?/i, 'bmi'],
      [/\b(?:grasa corporal|porcentaje de grasa)\b.{0,24}\b\d+(?:[.,]\d+)?/i, 'bodyFatPct'],
      [/\bmasa muscular\b.{0,24}\b\d+(?:[.,]\d+)?/i, 'musclePct'],
      [/\bgrasa visceral\b.{0,24}\b\d+(?:[.,]\d+)?/i, 'visceralFat'],
      [/\bedad corporal\b.{0,24}\b\d+(?:[.,]\d+)?/i, 'bodyAge'],
      [/\b(?:TMB|metabolismo basal)\b.{0,24}\b\d+(?:[.,]\d+)?/i, 'restingMetabolismKcal'],
    ].some(([pattern, key]) => !(hasMetric(key) || key === 'restingMetabolismKcal' && context.profile?.restingMetabolismKcal != null) && pattern.test(section));
    const plicometryFields = [
      [/\btríceps\b.{0,24}\b\d+(?:[.,]\d+)?\s*mm\b/i, 'tricepsMm'],
      [/\bbíceps\b.{0,24}\b\d+(?:[.,]\d+)?\s*mm\b/i, 'bicepsMm'],
      [/\bsubescapular\b.{0,24}\b\d+(?:[.,]\d+)?\s*mm\b/i, 'subescapularMm'],
      [/\bsuprailiaco\b.{0,24}\b\d+(?:[.,]\d+)?\s*mm\b/i, 'suprailiacoMm'],
      [/\babdominal\b.{0,24}\b\d+(?:[.,]\d+)?\s*mm\b/i, 'abdominalMm'],
      [/\bmuslo anterior\b.{0,24}\b\d+(?:[.,]\d+)?\s*mm\b/i, 'musloAnteriorMm'],
      [/\bpantorrilla\b.{0,24}\b\d+(?:[.,]\d+)?\s*mm\b/i, 'pantorrillaMm'],
    ];
    const missingPlicometry = plicometryFields.some(([pattern, key]) => {
      const exists = context.plicometricRecords?.some((record) => record[key] != null) ?? context.plicometryFacts?.[key] === true;
      return !exists && pattern.test(section);
    });
    if (missingAge || missingSex || missingHeight || missingWeight || missingBodyData || missingPlicometry) {
      throw new Error('El plan presenta como registrados datos que no están en el perfil.');
    }
  }
  const values = macroFields.map((key) => macros[key]);
  if (values.every((value) => value !== null)) {
    const [protein, carbohydrate, fat, calories] = values;
    const energy449 = 4 * protein + 4 * carbohydrate + 9 * fat;
    if (Math.abs(energy449 - calories) > Math.max(100, calories * 0.1)) throw new Error('Las metas del plan no son coherentes con la comprobación energética 4/4/9.');
  }
}

function summarizeTrainingPlan(plan) {
  if (!plan) return null;
  const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
  const labels = { proteinas_g: 'proteína', carbohidratos_g: 'carbohidratos', grasas_g: 'grasas', calorias_kcal: 'calorías kcal' };
  const summary = [
    plan.createdAt && `Fecha: ${clean(plan.createdAt)}`,
    plan.goals && `Objetivos: ${clean(plan.goals)}`,
    `Macros de reposo: ${macroFields.map((key) => `${labels[key]}=${plan.macros?.[key] ?? 'no disponible'}`).join(', ')}`,
  ].filter(Boolean);
  const points = String(plan.content ?? '').split(/\r?\n/)
    .filter((line) => /^\s*(?:#{1,4}\s+|[-*]\s+|\d+[.)]\s+)/.test(line))
    .map((line) => clean(line.replace(/^\s*(?:#{1,4}\s+|[-*]\s+|\d+[.)]\s+)/, '').replace(/[`*_>#]/g, '')))
    .filter(Boolean).slice(0, 8);
  if (points.length) summary.push(`Puntos principales: ${points.join(' | ')}`);
  return summary;
}

function validateTrainingPlan({ userId, requestId, goals, plan, macros, disclosure, context }) {
  const id = String(userId);
  const objectives = typeof goals === 'string' ? goals.trim() : '';
  const content = typeof plan === 'string' ? plan.trim() : '';
  const limits = { proteinas_g: 10000, carbohidratos_g: 10000, grasas_g: 10000, calorias_kcal: 100000 };
  if (!/^\d+$/.test(id) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId || '')
    || !objectives || objectives.length > 2000 || /[\u0000-\u0008\u000b\u000e-\u001f]/.test(objectives)
    || !content || content.length > 30000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)
    || !macros || typeof macros !== 'object' || Array.isArray(macros)
    || Object.keys(macros).length !== macroFields.length || macroFields.some((key) => !Object.hasOwn(macros, key)
      || macros[key] !== null && (typeof macros[key] !== 'number' || !Number.isFinite(macros[key]) || macros[key] < 0 || macros[key] > limits[key]))) {
    throw Object.assign(new Error('El objetivo, el plan o sus macros no son válidos.'), { status: 400 });
  }
  const safeMacros = Object.fromEntries(macroFields.map((key) => [key, macros[key]]));
  validatePlanSemantics(content, safeMacros, disclosure, context);
  return { id, requestId, objectives, content, macros: safeMacros };
}

async function saveTrainingPlan({ userId, requestId, goals, plan, macros, disclosure, context, dbQuery, textSql }) {
  const entry = validateTrainingPlan({ userId, requestId, goals, plan, macros, disclosure, context });
  const macroSql = (key, decimals) => entry.macros[key] === null ? 'NULL' : entry.macros[key].toFixed(decimals);
  const saved = await dbQuery(`INSERT INTO planes_entrenamiento(usuario_id,request_id,objetivos,contenido,objetivo_proteinas_g,objetivo_carbohidratos_g,objetivo_grasas_g,objetivo_calorias_kcal,creado_en) VALUES (${entry.id},${textSql(entry.requestId)},${textSql(entry.objectives)},${textSql(entry.content)},${macroSql('proteinas_g', 2)},${macroSql('carbohidratos_g', 2)},${macroSql('grasas_g', 2)},${macroSql('calorias_kcal', 1)},UTC_TIMESTAMP(3)) AS incoming ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id);
SELECT JSON_OBJECT('id',id,'requestId',request_id,'createdAt',DATE_FORMAT(creado_en,'%Y-%m-%dT%H:%i:%sZ'),'goals',objetivos,'plan',contenido,'macros',JSON_OBJECT('proteinas_g',objetivo_proteinas_g,'carbohidratos_g',objetivo_carbohidratos_g,'grasas_g',objetivo_grasas_g,'calorias_kcal',objetivo_calorias_kcal),'inserted',ROW_COUNT()=1) FROM planes_entrenamiento WHERE id=LAST_INSERT_ID() AND usuario_id=${entry.id} LIMIT 1;`);
  if (!saved) throw new Error('No se pudo recuperar el plan guardado.');
  const persisted = JSON.parse(saved);
  if (persisted.requestId !== entry.requestId || persisted.goals !== entry.objectives || persisted.plan !== entry.content
    || macroFields.some((key) => (persisted.macros[key] == null ? null : Number(persisted.macros[key])) !== entry.macros[key])) {
    throw Object.assign(new Error('La clave de guardado ya corresponde a otro plan.'), { status: 409 });
  }
  return { id: persisted.id, requestId: persisted.requestId, createdAt: persisted.createdAt, inserted: persisted.inserted === true };
}

async function readTrainingPlans({ userId, dbQuery }) {
  const id = String(userId);
  if (!/^\d+$/.test(id)) throw Object.assign(new Error('Cuenta no válida.'), { status: 400 });
  const rows = await dbQuery(`SELECT JSON_OBJECT('id',id,'goals',objetivos,'plan',contenido,'macros',JSON_OBJECT('proteinas_g',objetivo_proteinas_g,'carbohidratos_g',objetivo_carbohidratos_g,'grasas_g',objetivo_grasas_g,'calorias_kcal',objetivo_calorias_kcal),'createdAt',DATE_FORMAT(creado_en,'%Y-%m-%dT%H:%i:%sZ')) FROM planes_entrenamiento WHERE usuario_id=${id} ORDER BY creado_en DESC,id DESC LIMIT 3;`);
  return rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row)) : [];
}

async function deleteTrainingPlan({ userId, planId, dbQuery }) {
  const user = String(userId);
  const id = String(planId);
  if (!/^\d+$/.test(user) || !/^[1-9]\d{0,19}$/.test(id)) throw Object.assign(new Error('Plan no válido.'), { status: 400 });
  const result = await dbQuery(`DELETE FROM planes_entrenamiento WHERE id=${id} AND usuario_id=${user}; SELECT ROW_COUNT();`);
  return result.split(/\s+/).at(-1) === '1';
}

module.exports = { deleteTrainingPlan, extractPlanDisclosure, readTrainingPlans, saveTrainingPlan, summarizeTrainingPlan, validatePlanSemantics, validateTrainingPlan };
