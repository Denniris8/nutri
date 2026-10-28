const assert = require('node:assert/strict');
const test = require('node:test');
const { buildChefNutritionContext, deleteChefSession, sendChefMessage } = require('./chef-chat.js');

test('Chef loads its canonical prompt, answers in a user-owned tool-free session, and closes it', async () => {
  const calls = [];
  let metadata;
  const requestOpenCode = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (method === 'POST' && endpoint === '/session') { metadata = body.metadata; return { status: 201, data: { id: 'ses_chef123' } }; }
    if (method === 'GET') return { status: 200, data: { metadata } };
    if (method === 'POST') return { status: 200, data: { parts: [{ type: 'text', text: 'Prueba una sopa de lentejas.' }] } };
    return { status: 204, data: null };
  };
  const answer = await sendChefMessage({
    userId: '987654', message: '¿Qué puedo cocinar con lentejas?',
    nutritionContext: { date: '2026-10-28' },
    readConfig: async () => ({ model: null, agent: 'build', variant: null, requestTimeoutMs: 10000 }),
    requestOpenCode,
  });

  assert.equal(answer, 'Prueba una sopa de lentejas.');
  const followUp = await sendChefMessage({ userId: '987654', message: '¿Y cómo la preparo?', nutritionContext: { date: '2026-10-28' }, readConfig: async () => ({ model: null, agent: 'build', variant: null, requestTimeoutMs: 10000 }), requestOpenCode });
  assert.equal(followUp, 'Prueba una sopa de lentejas.');
  assert.equal(calls[0].body.metadata.chefUserId, '987654');
  assert.equal(calls[0].body.permission[0].action, 'deny');
  assert.match(calls[1].body.system, /Eres Chef/);
  assert.deepEqual(calls[1].body.tools, {});
  assert.deepEqual(JSON.parse(calls[1].body.parts[0].text), { message: '¿Qué puedo cocinar con lentejas?', nutritionContext: { date: '2026-10-28' } });
  assert.match(calls[3].body.system, /Eres Chef/);
  assert.equal(JSON.parse(calls[3].body.parts[0].text).message, '¿Y cómo la preparo?');
  assert.equal(await deleteChefSession({ userId: '987654', requestOpenCode }), true);
  assert.equal(calls.at(-1).endpoint, '/session/ses_chef123');
});

test('Chef rejects an empty message before opening an OpenCode session', async () => {
  let called = false;
  await assert.rejects(sendChefMessage({ userId: '987654', message: ' ', requestOpenCode: async () => { called = true; } }), { status: 400 });
  assert.equal(called, false);
});

test('Chef context calculates remaining targets with registered training adjustment', () => {
  const context = buildChefNutritionContext({
    date: '2026-10-28',
    foodRecords: [{ state: 'completado', items: [{ basis: 'per_portion', energyKcal: 500, proteinG: 30, carbohydrateG: 50, fatG: 20, macroStatus: 'verificado', macroSource: 'usda_fdc' }] }],
    trainingRecords: [{ origin: 'manual' }], exercise: { adjustmentKcal: 300 },
    activePlan: { macros: { calorias_kcal: 2000, proteinas_g: 120, carbohidratos_g: 200, grasas_g: 60 } },
  });

  assert.deepEqual(context.nutrients, {
    caloriesKcal: { target: 2300, consumed: 500, remaining: 1800 },
    proteinG: { target: 120, consumed: 30, remaining: 90 },
    carbohydrateG: { target: 275, consumed: 50, remaining: 225 },
    fatG: { target: 60, consumed: 20, remaining: 40 },
  });
});

test('Chef context does not treat days without completed meals as zero consumption', () => {
  const context = buildChefNutritionContext({
    date: '2026-10-28', foodRecords: [], trainingRecords: [], exercise: { adjustmentKcal: 0 },
    activePlan: { macros: { calorias_kcal: 2000, proteinas_g: 120, carbohidratos_g: 200, grasas_g: 60 } },
  });
  assert.equal(context.consumptionStatus, 'sin_registros_completos');
  assert.equal(context.nutrients.caloriesKcal.consumed, null);
  assert.equal(context.nutrients.caloriesKcal.remaining, null);
});

test('Chef context withholds remaining macros when a completed meal has incomplete nutrition', () => {
  const context = buildChefNutritionContext({
    date: '2026-10-28',
    foodRecords: [{ state: 'completado', items: [{ basis: 'per_portion', energyKcal: 500, proteinG: 30, carbohydrateG: null, fatG: 20 }] }],
    trainingRecords: [], exercise: { adjustmentKcal: 0 },
    activePlan: { macros: { calorias_kcal: 2000, proteinas_g: 120, carbohidratos_g: 200, grasas_g: 60 } },
  });
  assert.equal(context.nutrients.caloriesKcal.remaining, 1500);
  assert.equal(context.nutrients.proteinG.remaining, 90);
  assert.equal(context.nutrients.carbohydrateG.remaining, null);
  assert.equal(context.consumptionStatus, 'incompleto');
});
