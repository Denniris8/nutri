const assert = require('node:assert/strict');
const test = require('node:test');
const { activateTrainingPlan, deleteTrainingPlan, readTrainingPlanForDate, readTrainingPlans, saveTrainingPlan, summarizeTrainingPlan, validatePlanSemantics, validateTrainingPlan } = require('./training-plans.js');
const requestId = '123e4567-e89b-42d3-a456-426614174000';
const disclosure = 'Las metas de calorías y carbohidratos se ajustan según los entrenamientos registrados para el día seleccionado.';
const planFor = (macros) => `[Datos Registrados]\nEdad registrada.\n[Estimaciones Calculadas]\nMacros estimados.\n| Macro | Meta diaria |\n| --- | --- |\n| Proteínas | ${macros.proteinas_g} g |\n| Carbohidratos | ${macros.carbohidratos_g} g |\n| Grasas | ${macros.grasas_g} g |\n| Calorías | ${macros.calorias_kcal} kcal |\n${disclosure}\n[Supuestos Adoptados]\nDisponibilidad asumida.`;
const plan = planFor({ proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 });

test('previous training plan is summarized as a bounded list', () => {
  const summary = summarizeTrainingPlan({
    createdAt: '2026-10-15', goals: 'Ganar fuerza',
    macros: { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 },
    content: '# Rutina\n- Sentadilla 3x8\n- Press 3x8',
  });
  assert.deepEqual(summary, [
    'Fecha: 2026-10-15',
    'Objetivos: Ganar fuerza',
    'Macros de reposo: proteína=140, carbohidratos=220, grasas=65, calorías kcal=2000',
    'Puntos principales: Rutina | Sentadilla 3x8 | Press 3x8',
  ]);
  assert.equal(summarizeTrainingPlan(null), null);
});

test('saved training plan is owned by the authenticated user and records its UTC creation date', async () => {
  let sql;
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  const result = await saveTrainingPlan({
    userId: '27', requestId, goals: 'Ganar fuerza', plan, macros, disclosure,
    textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`,
    dbQuery: async (query) => { sql = query; return JSON.stringify({ id: 5, requestId, createdAt: '2026-10-15T12:00:00Z', goals: 'Ganar fuerza', plan, macros, inserted: true }); },
  });
  assert.match(sql, /INSERT INTO planes_entrenamiento\(usuario_id,request_id,objetivos,contenido,/);
  assert.match(sql, /ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID\(id\)/);
  assert.doesNotMatch(sql, /objetivo_entrenamiento_/);
  assert.match(sql, /,140\.00,220\.00,65\.00,2000\.0,UTC_TIMESTAMP/);
  assert.match(sql, /UTC_TIMESTAMP\(3\)/);
  assert.match(sql, /WHERE id=LAST_INSERT_ID\(\) AND usuario_id=27/);
  assert.deepEqual(result, { id: 5, requestId, createdAt: '2026-10-15T12:00:00Z', inserted: true });
});

test('reusing an idempotency key with a different plan is rejected', async () => {
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  await assert.rejects(saveTrainingPlan({
    userId: '27', requestId, goals: 'Ganar fuerza', plan, macros, disclosure,
    textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`,
    dbQuery: async () => JSON.stringify({ id: 5, requestId, createdAt: '2026-10-15T12:00:00Z', goals: 'Otro objetivo', plan, macros, inserted: false }),
  }), { status: 409 });
});

test('training plan persistence rejects oversized or empty input', () => {
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  assert.throws(() => validateTrainingPlan({ userId: '27', requestId, goals: '', plan, macros, disclosure }), { status: 400 });
  assert.throws(() => validateTrainingPlan({ userId: '27', requestId, goals: 'Objetivo', plan: 'x'.repeat(30001), macros, disclosure }), { status: 400 });
  assert.throws(() => validateTrainingPlan({ userId: '27', requestId, goals: 'Objetivo', plan, macros: { ...macros, proteinas_g: '140 g' }, disclosure }), { status: 400 });
  assert.throws(() => validateTrainingPlan({ userId: '27', requestId, goals: 'Objetivo', plan: '# Plan', macros, disclosure }), /distinguir datos/);
  assert.throws(() => validateTrainingPlan({ userId: '27', requestId, goals: 'Objetivo', plan: planFor({ ...macros, calorias_kcal: 2800 }), macros: { ...macros, calorias_kcal: 2800 }, disclosure }), /4\/4\/9/);
});

test('saved plan listing is scoped to the authenticated user and limited to the latest three', async () => {
  let sql;
  const plans = await readTrainingPlans({
    userId: '27',
    dbQuery: async (query) => {
      sql = query;
       return '{"id":5,"goals":"Ganar fuerza","plan":"# Plan","macros":{"proteinas_g":140,"carbohidratos_g":220,"grasas_g":65,"calorias_kcal":2000},"createdAt":"2026-10-15T12:00:00Z"}';
    },
  });
  assert.match(sql, /WHERE p\.usuario_id=27 ORDER BY EXISTS\(SELECT 1 FROM vigencias_planes_entrenamiento/);
  assert.match(sql, /LIMIT 3/);
  assert.equal(plans[0].id, 5);
});

test('activation uses authenticated ownership, serializes changes, and rejects ambiguous history', async () => {
  let sql;
  const activated = await activateTrainingPlan({
    userId: '27', planId: '5', startDate: '2026-10-24', today: '2026-10-23',
    dayStart: '2026-10-24 00:00:00', dayEnd: '2026-10-25 00:00:00',
    textSql: (value) => `'${value}'`,
    dbQuery: async (query) => { sql = query; return '{"ok":true,"planExists":true,"alreadyActive":false,"hasTraining":false,"vigencyId":9}'; },
  });
  assert.match(sql, /START TRANSACTION/);
  assert.match(sql, /SELECT id INTO @locked_user FROM usuarios WHERE id=27 FOR UPDATE/);
  assert.match(sql, /UPDATE vigencias_planes_entrenamiento SET fecha_fin/);
  assert.match(sql, /INSERT INTO vigencias_planes_entrenamiento/);
  assert.match(sql, /@has_training/);
  assert.deepEqual(activated, { vigencyId: '9', alreadyActive: false });
});

test('active plan lookup is scoped to user and calendar date', async () => {
  let sql;
  const active = { id: 5, vigencyId: 9, goals: 'Ganar fuerza' };
  const result = await readTrainingPlanForDate({
    userId: '27', date: '2026-10-24', textSql: (value) => `'${value}'`,
    dbQuery: async (query) => { sql = query; return JSON.stringify(active); },
  });
  assert.match(sql, /v\.usuario_id=27/);
  assert.match(sql, /v\.fecha_inicio<=\'2026-10-24\'/);
  assert.deepEqual(result, active);
});

test('plan deletion is scoped to the authenticated user and refuses plans with vigencies', async () => {
  let sql;
  const deleted = await deleteTrainingPlan({ userId: '27', planId: '5', dbQuery: async (query) => {
    sql = query;
    return '{"planExists":true,"hasVigencies":false,"deleted":true}';
  } });
  assert.match(sql, /SELECT id INTO @locked_user FROM usuarios WHERE id=27 FOR UPDATE/);
  assert.match(sql, /EXISTS\(SELECT 1 FROM vigencias_planes_entrenamiento WHERE usuario_id=27 AND plan_id=5\)/);
  assert.match(sql, /DELETE FROM planes_entrenamiento WHERE id=5 AND usuario_id=27 AND @locked_user IS NOT NULL AND NOT @has_vigencies/);
  assert.equal(deleted, true);
});

test('plan deletion returns conflict whenever any vigency exists', async () => {
  await assert.rejects(deleteTrainingPlan({
    userId: '27', planId: '5',
    dbQuery: async () => '{"planExists":true,"hasVigencies":true,"deleted":false}',
  }), { status: 409, message: /días asociados/ });
});

test('body-data claims are rejected only when a missing measurement is presented as registered', () => {
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  const context = { profile: { age: 32, sex: 'masculino', heightCm: 175 }, biometricRecords: [{ weightKg: 78.5 }], plicometricRecords: [] };
  const withLine = (line) => plan.replace('Edad registrada.', line);
  const check = (line) => validatePlanSemantics(withLine(line), macros, disclosure, context);
  assert.doesNotThrow(() => check('Objetivo declarado: ganar masa muscular y entrenar 5 días.'));
  assert.doesNotThrow(() => check('Objetivo: reducir grasa corporal a 15 % en 12 semanas.'));
  assert.doesNotThrow(() => check('Metabolismo en reposo: no disponible. Plicometrías: 0 registros.'));
  assert.throws(() => check('Masa muscular: 38 %.'), /no están en el perfil/);
  assert.throws(() => check('IMC 25,6 registrado.'), /no están en el perfil/);
  assert.throws(() => check('Grasa corporal registrada 22 %.'), /no están en el perfil/);
  assert.throws(() => check('TMB de 1700 kcal.'), /no están en el perfil/);
});
