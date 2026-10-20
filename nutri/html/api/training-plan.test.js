const assert = require('node:assert/strict');
const test = require('node:test');
const { generateTrainingPlan, parseTrainingPlanReply } = require('./training-analysis.js');

test('training plan uses the authenticated user context and deletes its temporary session', async () => {
  const calls = [];
  const context = { profile: { age: 32 }, biometricRecords: [], plicometricRecords: [] };
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  const trainingMacros = { proteinas_g: 140, carbohidratos_g: 270, grasas_g: 65, calorias_kcal: 2200 };
  const generated = await generateTrainingPlan({
    userId: '27', goals: 'Ganar fuerza', context,
    readConfig: async () => ({ model: null, agent: 'build', variant: null, requestTimeoutMs: 10000 }),
    requestOpenCode: async (method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      if (method === 'POST' && endpoint === '/session') return { status: 201, data: { id: 'ses_plan123' } };
      if (method === 'POST') return { status: 200, data: { parts: [{ type: 'text', text: JSON.stringify({ macros_objetivo: macros, macros_entrenamiento: trainingMacros, plan_markdown: '# Plan' }) }] } };
      return { status: 204, data: null };
    },
  });

  assert.deepEqual(generated, { plan: '# Plan', macros, trainingMacros });
  assert.equal(calls[0].body.metadata.trainingPlanUserId, '27');
  assert.equal(calls[0].body.permission[0].action, 'deny');
  assert.deepEqual(JSON.parse(calls[1].body.parts[0].text), { goals: 'Ganar fuerza', context });
  assert.deepEqual(calls.at(-1), { method: 'DELETE', endpoint: '/session/ses_plan123', body: undefined });
});

test('training plan rejects an invalid user or empty goals before opening a session', async () => {
  let calls = 0;
  const input = { userId: '27', goals: '', context: {}, requestOpenCode: async () => { calls += 1; } };
  await assert.rejects(generateTrainingPlan(input), { status: 400 });
  await assert.rejects(generateTrainingPlan({ ...input, userId: 'not-an-id', goals: 'Objetivo' }), { status: 400 });
  assert.equal(calls, 0);
});

test('training plan JSON requires four finite macro values for rest and training or explicit nulls', () => {
  const valid = {
    macros_objetivo: { proteinas_g: null, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 },
    macros_entrenamiento: { proteinas_g: null, carbohidratos_g: 270, grasas_g: 65, calorias_kcal: 2200 },
    plan_markdown: '# Plan',
  };
  assert.deepEqual(parseTrainingPlanReply([{ type: 'text', text: JSON.stringify(valid) }]), {
    plan: '# Plan', macros: valid.macros_objetivo, trainingMacros: valid.macros_entrenamiento,
  });
  assert.throws(() => parseTrainingPlanReply([{ type: 'text', text: JSON.stringify({ macros_objetivo: valid.macros_objetivo, plan_markdown: '# Plan' }) }]));
  assert.throws(() => parseTrainingPlanReply([{ type: 'text', text: '{"macros_objetivo":{},"macros_entrenamiento":{},"plan_markdown":"# Plan"}' }]));
});
