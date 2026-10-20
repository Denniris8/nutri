const macroFields = ['proteinas_g', 'carbohidratos_g', 'grasas_g', 'calorias_kcal'];

function validateTrainingPlan({ userId, goals, plan, macros }) {
  const id = String(userId);
  const objectives = typeof goals === 'string' ? goals.trim() : '';
  const content = typeof plan === 'string' ? plan.trim() : '';
  const limits = { proteinas_g: 10000, carbohidratos_g: 10000, grasas_g: 10000, calorias_kcal: 100000 };
  if (!/^\d+$/.test(id) || !objectives || objectives.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(objectives)
    || !content || content.length > 30000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)
    || !macros || typeof macros !== 'object' || Array.isArray(macros)
    || Object.keys(macros).length !== macroFields.length || macroFields.some((key) => !Object.hasOwn(macros, key)
      || macros[key] !== null && (typeof macros[key] !== 'number' || !Number.isFinite(macros[key]) || macros[key] < 0 || macros[key] > limits[key]))) {
    throw Object.assign(new Error('El objetivo, el plan o sus macros no son válidos.'), { status: 400 });
  }
  return { id, objectives, content, macros: Object.fromEntries(macroFields.map((key) => [key, macros[key]])) };
}

async function saveTrainingPlan({ userId, goals, plan, macros, dbQuery, textSql }) {
  const entry = validateTrainingPlan({ userId, goals, plan, macros });
  const macroSql = (key, decimals) => entry.macros[key] === null ? 'NULL' : entry.macros[key].toFixed(decimals);
  const saved = await dbQuery(`INSERT INTO planes_entrenamiento(usuario_id,objetivos,contenido,objetivo_proteinas_g,objetivo_carbohidratos_g,objetivo_grasas_g,objetivo_calorias_kcal,creado_en) VALUES (${entry.id},${textSql(entry.objectives)},${textSql(entry.content)},${macroSql('proteinas_g', 2)},${macroSql('carbohidratos_g', 2)},${macroSql('grasas_g', 2)},${macroSql('calorias_kcal', 1)},UTC_TIMESTAMP(3)); SELECT JSON_OBJECT('id',LAST_INSERT_ID(),'createdAt',DATE_FORMAT(creado_en,'%Y-%m-%dT%H:%i:%sZ')) FROM planes_entrenamiento WHERE id=LAST_INSERT_ID() AND usuario_id=${entry.id} LIMIT 1;`);
  if (!saved) throw new Error('No se pudo recuperar el plan guardado.');
  return JSON.parse(saved);
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

module.exports = { deleteTrainingPlan, readTrainingPlans, saveTrainingPlan, validateTrainingPlan };
