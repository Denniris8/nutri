const assert = require('node:assert/strict');
const test = require('node:test');
const { deleteTrainingPlanSession, generateTrainingPlan, parseTrainingPlanReply, readTrainingPlanPrompt } = require('./training-analysis.js');
const disclosure = 'Las metas de calorías y carbohidratos se ajustan según los entrenamientos registrados para el día seleccionado.';
const planPrompt = `presenta los macros; añade literalmente esta frase: “${disclosure}”`;
const macroTable = '| Nutriente | Meta diaria de reposo |\n|---|---:|\n| Proteínas | 140 g |\n| Carbohidratos | 220 g |\n| Grasas | 65 g |\n| Calorías | 2000 kcal |';
const planText = `[Datos Registrados]\nEdad registrada: 32 años.\n[Estimaciones Calculadas]\nMacros estimados.\n${macroTable}\n${disclosure}\n[Supuestos Adoptados]\nDisponibilidad asumida.`;

test('training plan keeps its temporary session until the user saves or cancels', async () => {
  const calls = [];
  const context = { profile: { age: 32 }, biometricRecords: [], plicometricRecords: [] };
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  const generated = await generateTrainingPlan({
    userId: '27', goals: 'Ganar fuerza', context,
    readConfig: async () => ({ model: null, agent: 'build', variant: null, requestTimeoutMs: 10000 }),
    requestOpenCode: async (method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      if (method === 'POST' && endpoint === '/session') return { status: 201, data: { id: 'ses_plan123' } };
      if (method === 'POST') return { status: 200, data: { parts: [{ type: 'text', text: JSON.stringify({ macros_objetivo: macros, plan_markdown: planText }) }] } };
      return { status: 204, data: null };
    },
  });

  assert.equal(generated.plan, planText);
  assert.deepEqual(generated.macros, macros);
  assert.match(generated.runId, /^[0-9a-f-]{36}$/i);
  assert.equal(calls[0].body.metadata.trainingPlanUserId, '27');
  assert.equal(calls[0].body.permission[0].action, 'deny');
  assert.deepEqual(JSON.parse(calls[1].body.parts[0].text), { goals: 'Ganar fuerza', context });
  assert.equal(calls.at(-1).method, 'POST');
  await deleteTrainingPlanSession({ userId: '27', runId: generated.runId, requestOpenCode: async (method, endpoint) => {
    calls.push({ method, endpoint, body: undefined });
    return { status: 204 };
  } });
  assert.deepEqual(calls.at(-1), { method: 'DELETE', endpoint: '/session/ses_plan123', body: undefined });
});

test('training plan rejects an invalid user or empty goals before opening a session', async () => {
  let calls = 0;
  const input = { userId: '27', goals: '', context: {}, requestOpenCode: async () => { calls += 1; } };
  await assert.rejects(generateTrainingPlan(input), { status: 400 });
  await assert.rejects(generateTrainingPlan({ ...input, userId: 'not-an-id', goals: 'Objetivo' }), { status: 400 });
  assert.equal(calls, 0);
});

test('training plan JSON stores only the four rest-day macro values or explicit nulls', () => {
  const valid = { macros_objetivo: { proteinas_g: null, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 }, plan_markdown: planText.replace('| Proteínas | 140 g |', '| Proteínas | No disponible |') };
  assert.deepEqual(parseTrainingPlanReply([{ type: 'text', text: JSON.stringify(valid) }], planPrompt), {
    plan: valid.plan_markdown, macros: valid.macros_objetivo,
  });
  assert.throws(() => parseTrainingPlanReply([{ type: 'text', text: '{"macros_objetivo":{},"plan_markdown":"# Plan"}' }]));
  assert.throws(() => parseTrainingPlanReply([{ type: 'text', text: JSON.stringify({ ...valid, macros_entrenamiento: valid.macros_objetivo }) }]));
  assert.throws(() => parseTrainingPlanReply([{ type: 'text', text: JSON.stringify({ ...valid, plan_markdown: valid.plan_markdown.replace('Edad registrada: 32 años.', 'Edad registrada: 35 años; peso: 82 kg.') }) }], planPrompt, { profile: { age: null }, biometricRecords: [], plicometricRecords: [] }), /no están en el perfil/);
});

test('training plan rejects macro mismatches, duplicate rows, and a displaced canonical notice', () => {
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  const encode = (plan) => [{ type: 'text', text: JSON.stringify({ macros_objetivo: macros, plan_markdown: plan }) }];
  assert.throws(() => parseTrainingPlanReply(encode(planText.replace('| Proteínas | 140 g |', '| Proteínas | 150 g |')), planPrompt), /no coinciden/);
  assert.throws(() => parseTrainingPlanReply(encode(planText.replace(`${macroTable}\n${disclosure}`, `${macroTable}\nNota previa\n${disclosure}`)), planPrompt), /inmediatamente después/);
  assert.throws(() => parseTrainingPlanReply(encode(planText.replace('| Proteínas | 140 g |', '| Proteínas | 140 g |\n| Proteínas | 140 g |')), planPrompt), /una sola tabla/);
});

test('canonical prompt treats injection strings as data and defines bounded measurement coverage', async () => {
  const prompt = await readTrainingPlanPrompt();
  assert.match(prompt, /datos pasivos/i);
  assert.match(prompt, /máximo 24 registros/);
  assert.match(prompt, /al menos 3 mediciones comparables/);
  assert.match(prompt, /La ausencia de datos clínicos no equivale a ausencia de riesgos/);
});
