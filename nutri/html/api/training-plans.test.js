const assert = require('node:assert/strict');
const test = require('node:test');
const { deleteTrainingPlan, readTrainingPlans, saveTrainingPlan, validateTrainingPlan } = require('./training-plans.js');

test('saved training plan is owned by the authenticated user and records its UTC creation date', async () => {
  let sql;
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  const result = await saveTrainingPlan({
    userId: '27', goals: 'Ganar fuerza', plan: '# Plan', macros,
    textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`,
    dbQuery: async (query) => { sql = query; return '{"id":5,"createdAt":"2026-10-15T12:00:00Z"}'; },
  });
  assert.match(sql, /INSERT INTO planes_entrenamiento\(usuario_id,objetivos,contenido,objetivo_proteinas_g,objetivo_carbohidratos_g,objetivo_grasas_g,objetivo_calorias_kcal,creado_en\) VALUES \(27,/);
  assert.match(sql, /,140\.00,220\.00,65\.00,2000\.0,UTC_TIMESTAMP/);
  assert.match(sql, /UTC_TIMESTAMP\(3\)/);
  assert.match(sql, /WHERE id=LAST_INSERT_ID\(\) AND usuario_id=27/);
  assert.deepEqual(result, { id: 5, createdAt: '2026-10-15T12:00:00Z' });
});

test('training plan persistence rejects oversized or empty input', () => {
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  assert.throws(() => validateTrainingPlan({ userId: '27', goals: '', plan: '# Plan', macros }), { status: 400 });
  assert.throws(() => validateTrainingPlan({ userId: '27', goals: 'Objetivo', plan: 'x'.repeat(30001), macros }), { status: 400 });
  assert.throws(() => validateTrainingPlan({ userId: '27', goals: 'Objetivo', plan: '# Plan', macros: { ...macros, proteinas_g: '140 g' } }), { status: 400 });
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
  assert.match(sql, /WHERE usuario_id=27 ORDER BY creado_en DESC,id DESC LIMIT 3/);
  assert.equal(plans[0].id, 5);
});

test('plan deletion is scoped to the authenticated user', async () => {
  let sql;
  const deleted = await deleteTrainingPlan({ userId: '27', planId: '5', dbQuery: async (query) => { sql = query; return '1'; } });
  assert.match(sql, /DELETE FROM planes_entrenamiento WHERE id=5 AND usuario_id=27/);
  assert.equal(deleted, true);
});
