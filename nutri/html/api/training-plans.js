const macroFields = ['proteinas_g', 'carbohidratos_g', 'grasas_g', 'calorias_kcal'];

function extractPlanDisclosure(prompt) {
  const disclosure = String(prompt).match(/añade literalmente esta frase:\s*[“"]([^”"]+)[”"]/i)?.[1];
  if (!disclosure) throw new Error('El prompt del plan no define la nota canónica de ajuste diario.');
  return disclosure;
}

function validateMacroPresentation(content, macros, disclosure) {
  const lines = content.split(/\r?\n/);
  const labels = { proteinas_g: /prote[ií]nas/i, carbohidratos_g: /carbohidratos/i, grasas_g: /grasas/i, calorias_kcal: /calor[ií]as/i };
  const rows = Object.entries(labels).map(([key, label]) => {
    const matches = lines.flatMap((line, index) => {
      const cells = line.split('|').map((cell) => cell.trim());
      if (cells.length < 3 || !label.test(cells[1] || '')) return [];
      return [{ index, value: cells[2] }];
    });
    if (matches.length !== 1) throw new Error('El plan debe presentar una sola tabla con los cuatro macros de reposo.');
    const expected = macros[key] === null ? null : macros[key];
    const valueText = matches[0].value;
    const isNumeric = /^(?:\d+(?:[.,]\d+)?)\s*(?:g|kcal)?$/i.test(valueText);
    const numericValue = isNumeric ? Number(valueText.replace(/\s*(?:g|kcal)\s*$/i, '').replace(',', '.')) : NaN;
    if (expected === null ? !/^(?:no disponible|n\/a|null)$/i.test(valueText)
      : !Number.isFinite(numericValue) || numericValue !== expected) {
      throw new Error('Los macros del informe no coinciden con macros_objetivo.');
    }
    return matches[0].index;
  });
  const tableEnd = Math.max(...rows);
  if (content.split(disclosure).length !== 2 || lines.slice(tableEnd + 1).find((line) => line.trim()) !== disclosure) {
    throw new Error('La frase canónica debe aparecer inmediatamente después de la tabla de macros.');
  }
}

function validatePlanSemantics(content, macros, disclosure, context) {
  const sections = ['[Datos Registrados]', '[Estimaciones Calculadas]', '[Supuestos Adoptados]'];
  const positions = sections.map((label) => content.indexOf(label));
  if (positions.some((position) => position < 0) || positions.some((position, index) => index > 0 && position <= positions[index - 1])
    || typeof disclosure !== 'string' || !content.includes(disclosure)) throw new Error('El plan debe distinguir datos, estimaciones y supuestos e incluir la nota canónica de ajuste diario.');
  validateMacroPresentation(content, macros, disclosure);
  if (context) {
    const section = content.match(/\[Datos Registrados\]([\s\S]*?)\[Estimaciones Calculadas\]/i)?.[1] || '';
    const missingAge = context.profile?.age == null && /\b(?:edad(?!\s+corporal)|age)\b.{0,20}\b\d{1,3}\b|\b\d{1,3}\s+años\b/i.test(section);
    const missingSex = context.profile?.sex == null && /\b(?:sexo|sex)\b.{0,12}\b(?:masculino|femenino|male|female)\b/i.test(section);
    const missingHeight = context.profile?.heightCm == null && /\b(?:estatura|altura|height)\b.{0,16}\b\d{2,3}(?:[.,]\d+)?\s*(?:cm)?/i.test(section);
    const hasWeight = context.hasWeight ?? context.biometricRecords?.some((record) => Number.isFinite(Number(record.weightKg)) && Number(record.weightKg) >= 20);
    const missingWeight = !hasWeight && /\bpeso(?: corporal)?\b.{0,18}\b\d{2,3}(?:[.,]\d+)?\s*(?:kg|kilos?)?/i.test(section);
    const hasMetric = (key) => context.biometricRecords?.some((record) => record[key] != null) ?? context.bodyFacts?.[key] === true;
    // El valor debe seguir directamente a la etiqueta (con un conector corto); así "ganar masa muscular y entrenar 5 días" no cuenta como dato medido.
    const reported = (label) => new RegExp(`\\b(?:${label})\\b\\s*(?:registrad[oa]s?|medid[oa]s?)?\\s*(?:[:=]|es|fue|de|del)?\\s*\\d+(?:[.,]\\d+)?`, 'i');
    const missingBodyData = [
      [reported('IMC|BMI'), 'bmi'],
      [reported('grasa corporal|porcentaje de grasa'), 'bodyFatPct'],
      [reported('masa muscular'), 'musclePct'],
      [reported('grasa visceral'), 'visceralFat'],
      [reported('edad corporal'), 'bodyAge'],
      [reported('TMB|metabolismo basal'), 'restingMetabolismKcal'],
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
  const rows = await dbQuery(`SELECT JSON_OBJECT('id',p.id,'goals',p.objetivos,'plan',p.contenido,'macros',JSON_OBJECT('proteinas_g',p.objetivo_proteinas_g,'carbohidratos_g',p.objetivo_carbohidratos_g,'grasas_g',p.objetivo_grasas_g,'calorias_kcal',p.objetivo_calorias_kcal),'createdAt',DATE_FORMAT(p.creado_en,'%Y-%m-%dT%H:%i:%sZ'),'hasAssociatedDays',EXISTS(SELECT 1 FROM vigencias_planes_entrenamiento v WHERE v.usuario_id=p.usuario_id AND v.plan_id=p.id),'activePeriod',(SELECT JSON_OBJECT('id',v.id,'startDate',DATE_FORMAT(v.fecha_inicio,'%Y-%m-%d')) FROM vigencias_planes_entrenamiento v WHERE v.usuario_id=p.usuario_id AND v.plan_id=p.id AND v.fecha_fin IS NULL LIMIT 1)) FROM planes_entrenamiento p WHERE p.usuario_id=${id} ORDER BY EXISTS(SELECT 1 FROM vigencias_planes_entrenamiento v WHERE v.usuario_id=p.usuario_id AND v.plan_id=p.id AND v.fecha_fin IS NULL) DESC,p.creado_en DESC,p.id DESC LIMIT 3;`);
  return rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row)) : [];
}

async function readTrainingPlanForDate({ userId, date, dbQuery, textSql }) {
  const id = String(userId);
  const parsed = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : null;
  if (!/^\d+$/.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error('La fecha del plan no es válida.'), { status: 400 });
  }
  const row = await dbQuery(`SELECT JSON_OBJECT('id',p.id,'goals',p.objetivos,'plan',p.contenido,'macros',JSON_OBJECT('proteinas_g',p.objetivo_proteinas_g,'carbohidratos_g',p.objetivo_carbohidratos_g,'grasas_g',p.objetivo_grasas_g,'calorias_kcal',p.objetivo_calorias_kcal),'vigencyId',v.id,'startDate',DATE_FORMAT(v.fecha_inicio,'%Y-%m-%d'),'endDate',DATE_FORMAT(v.fecha_fin,'%Y-%m-%d')) FROM vigencias_planes_entrenamiento v JOIN planes_entrenamiento p ON p.id=v.plan_id AND p.usuario_id=v.usuario_id WHERE v.usuario_id=${id} AND v.fecha_inicio<=${textSql(date)} AND (v.fecha_fin IS NULL OR v.fecha_fin>=${textSql(date)}) ORDER BY v.fecha_inicio DESC,v.id DESC LIMIT 1;`);
  return row ? JSON.parse(row) : null;
}

async function activateTrainingPlan({ userId, planId, startDate, today, dayStart, dayEnd, dbQuery, textSql }) {
  const user = String(userId);
  const plan = String(planId);
  const dateValue = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
  };
  if (!/^\d+$/.test(user) || !/^[1-9]\d{0,19}$/.test(plan) || !dateValue(startDate) || !dateValue(today)
    || !dayStart || !dayEnd || startDate < today) throw Object.assign(new Error('La fecha de inicio del plan no es válida.'), { status: 400 });
  const result = await dbQuery(`SET @locked_user=NULL,@plan_exists=NULL,@active_id=NULL,@active_plan=NULL,@active_start=NULL;
START TRANSACTION;
SELECT id INTO @locked_user FROM usuarios WHERE id=${user} FOR UPDATE;
SET @plan_exists=(SELECT id FROM planes_entrenamiento WHERE id=${plan} AND usuario_id=${user} LIMIT 1);
SELECT id,plan_id,fecha_inicio INTO @active_id,@active_plan,@active_start FROM vigencias_planes_entrenamiento WHERE usuario_id=${user} AND fecha_fin IS NULL LIMIT 1 FOR UPDATE;
SET @already_active=COALESCE(@active_plan=${plan} AND @active_start=${textSql(startDate)},FALSE);
SET @overlap=EXISTS(SELECT 1 FROM vigencias_planes_entrenamiento WHERE usuario_id=${user} AND id<>COALESCE(@active_id,0) AND (fecha_fin IS NULL OR fecha_fin>=${textSql(startDate)}));
SET @has_training=EXISTS(SELECT 1 FROM registros_entrenamientos WHERE usuario_id=${user} AND creado_en>=${textSql(dayStart)} AND creado_en<${textSql(dayEnd)});
SET @can_activate=@locked_user IS NOT NULL AND @plan_exists IS NOT NULL AND ${textSql(startDate)}>=${textSql(today)} AND NOT @overlap AND (@active_id IS NULL OR @active_start<${textSql(startDate)} OR @already_active) AND (@already_active OR NOT @has_training);
UPDATE vigencias_planes_entrenamiento SET fecha_fin=DATE_SUB(${textSql(startDate)},INTERVAL 1 DAY) WHERE id=@active_id AND @can_activate AND NOT @already_active;
INSERT INTO vigencias_planes_entrenamiento(usuario_id,plan_id,fecha_inicio,fecha_fin,creado_en) SELECT ${user},${plan},${textSql(startDate)},NULL,UTC_TIMESTAMP(3) WHERE @can_activate AND NOT @already_active;
SET @new_id=LAST_INSERT_ID();
SELECT JSON_OBJECT('ok',@can_activate,'planExists',@plan_exists IS NOT NULL,'alreadyActive',@already_active,'hasTraining',@has_training,'vigencyId',IF(@already_active,@active_id,@new_id));
COMMIT;`);
  let outcome;
  try { outcome = JSON.parse(result.trim().split(/\r?\n/).at(-1)); } catch { throw new Error('No se pudo verificar la activación del plan.'); }
  if (!outcome.planExists) throw Object.assign(new Error('El plan no existe.'), { status: 404 });
  if (!outcome.ok) throw Object.assign(new Error(outcome.hasTraining
    ? 'Ya hay entrenamientos guardados en esa fecha; activa el plan desde otro día para conservar la trazabilidad.'
    : 'La fecha se cruza con otra vigencia o no avanza respecto al plan actual.'), { status: 409 });
  return { vigencyId: String(outcome.vigencyId), alreadyActive: outcome.alreadyActive };
}

async function deleteTrainingPlan({ userId, planId, dbQuery }) {
  const user = String(userId);
  const id = String(planId);
  if (!/^\d+$/.test(user) || !/^[1-9]\d{0,19}$/.test(id)) throw Object.assign(new Error('Plan no válido.'), { status: 400 });
  const result = await dbQuery(`SET @locked_user=NULL,@plan_exists=NULL,@has_vigencies=FALSE;
START TRANSACTION;
SELECT id INTO @locked_user FROM usuarios WHERE id=${user} FOR UPDATE;
SET @plan_exists=(SELECT id FROM planes_entrenamiento WHERE id=${id} AND usuario_id=${user} LIMIT 1);
SET @has_vigencies=EXISTS(SELECT 1 FROM vigencias_planes_entrenamiento WHERE usuario_id=${user} AND plan_id=${id});
DELETE FROM planes_entrenamiento WHERE id=${id} AND usuario_id=${user} AND @locked_user IS NOT NULL AND NOT @has_vigencies;
SELECT JSON_OBJECT('planExists',@plan_exists IS NOT NULL,'hasVigencies',@has_vigencies,'deleted',ROW_COUNT()=1);
COMMIT;`);
  let outcome;
  try { outcome = JSON.parse(result.trim().split(/\r?\n/).at(-1)); } catch { throw new Error('No se pudo verificar la eliminación del plan.'); }
  if (!outcome.planExists) throw Object.assign(new Error('El plan ya no existe.'), { status: 404 });
  if (outcome.hasVigencies) throw Object.assign(new Error('Este plan no se puede eliminar porque tiene días asociados y debe conservarse para la trazabilidad.'), { status: 409 });
  return outcome.deleted === true;
}

module.exports = { activateTrainingPlan, deleteTrainingPlan, extractPlanDisclosure, readTrainingPlanForDate, readTrainingPlans, saveTrainingPlan, summarizeTrainingPlan, validateMacroPresentation, validatePlanSemantics, validateTrainingPlan };
