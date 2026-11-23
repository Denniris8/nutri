const assert = require('node:assert/strict');
const test = require('node:test');
const { deleteTrainingPlanSession, generateTrainingPlan, issueTrainingPlanDraft, readTrainingPlanDraft, refineTrainingPlan, parseTrainingPlanReply, readTrainingPlanPrompt } = require('./training-analysis.js');
const disclosure = 'Las metas de calorías y carbohidratos se ajustan según los entrenamientos registrados para el día seleccionado.';
const planPrompt = `presenta los macros; añade literalmente esta frase: “${disclosure}”`;
const macroTable = '| Nutriente | Meta diaria de reposo |\n|---|---:|\n| Proteínas | 140 g |\n| Carbohidratos | 220 g |\n| Grasas | 65 g |\n| Calorías | 2000 kcal |';
const planText = '[Estimaciones Calculadas]\nMacros de reposo estimados.\n[Supuestos Adoptados]\nDisponibilidad asumida.';

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
      if (method === 'POST') return { status: 200, data: { parts: [{ type: 'text', text: JSON.stringify({ estado: 'plan_listo', macros_objetivo: macros, plan_markdown: planText }) }] } };
      return { status: 204, data: null };
    },
  });

  assert.ok(generated.plan.includes(planText));
  assert.deepEqual(generated.macros, macros);
  assert.match(generated.runId, /^[0-9a-f-]{36}$/i);
  assert.equal(calls[0].body.metadata.trainingPlanUserId, '27');
  assert.equal(calls[0].body.permission[0].action, 'deny');
  assert.deepEqual(JSON.parse(calls[1].body.parts[0].text), { goals: 'Ganar fuerza', context });
  assert.equal(calls.at(-1).method, 'POST');
  await assert.rejects(deleteTrainingPlanSession({ userId: '27', runId: generated.runId,
    requestOpenCode: async (method, endpoint, body, timeoutMs) => {
      assert.equal(timeoutMs, 5000);
      throw Object.assign(new Error('simulated timeout'), { code: 'TIMEOUT' });
    },
  }), { code: 'TIMEOUT' });
  await deleteTrainingPlanSession({ userId: '27', runId: generated.runId, requestOpenCode: async (method, endpoint, body, timeoutMs) => {
    assert.equal(timeoutMs, 5000);
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

test('training plan requires four numeric rest-day macro estimates', () => {
  const valid = { estado: 'plan_listo', macros_objetivo: { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 }, plan_markdown: planText };
  const ready = parseTrainingPlanReply([{ type: 'text', text: JSON.stringify(valid) }], planPrompt);
  assert.equal(ready.state, 'plan_listo');
  assert.deepEqual(ready.macros, valid.macros_objetivo);
  assert.ok(ready.plan.endsWith(`${macroTable}\n${disclosure}`));
  assert.throws(() => parseTrainingPlanReply([{ type: 'text', text: JSON.stringify({ ...valid, macros_objetivo: { ...valid.macros_objetivo, proteinas_g: null }, plan_markdown: valid.plan_markdown.replace('| Proteínas | 140 g |', '| Proteínas | No disponible |') }) }], planPrompt), /metas de macros no válidas/);
  assert.throws(() => parseTrainingPlanReply([{ type: 'text', text: '{"macros_objetivo":{},"plan_markdown":"# Plan"}' }]));
  assert.throws(() => parseTrainingPlanReply([{ type: 'text', text: JSON.stringify({ ...valid, macros_entrenamiento: valid.macros_objetivo }) }]));
  assert.throws(() => parseTrainingPlanReply([{ type: 'text', text: JSON.stringify({ ...valid, plan_markdown: `[Datos Registrados]\nPeso: 82 kg.\n${planText}` }) }], planPrompt), /solo estimaciones/);
});

test('uses only captured measurement values in the recorded section', () => {
  const context = { hasWeight: true, biometricRecords: [{ weightKg: 72.5, measuredAt: '2026-11-14', source: 'manual' }] };
  const result = parseTrainingPlanReply([{type:'text', text: JSON.stringify({
    estado: 'plan_listo', plan_markdown: planText,
    macros_objetivo: { proteinas_g:140, carbohidratos_g:220, grasas_g:65, calorias_kcal:2000 },
  })}], planPrompt, context);
  assert.match(result.plan, /Peso: 72.5 kg \(2026-11-14, manual\)/);
  assert.doesNotMatch(result.plan, /99 kg/);
});

test('server owns macro rows and protects rest-day targets when only the routine changes', () => {
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  const encode = (plan) => [{ type: 'text', text: JSON.stringify({ estado: 'plan_listo', macros_objetivo: macros, plan_markdown: plan }) }];
  assert.throws(() => parseTrainingPlanReply(encode(`${planText}\n${macroTable}`), planPrompt), /una sola tabla/);
  assert.throws(() => parseTrainingPlanReply(encode(`${planText}\n${disclosure}`), planPrompt), /frase canónica/);
  assert.throws(() => parseTrainingPlanReply(encode(planText), planPrompt, {}, { ...macros, proteinas_g: 150 }), /Conserva los macros/);
});

test('an allergy clarification cannot contain a menu or targets', () => {
  const input = { estado: 'requiere_aclaracion', pregunta: '¿A qué alimento tienes alergia?' };
  const parse = value => parseTrainingPlanReply([{type:'text', text:JSON.stringify(value)}], planPrompt);
  assert.deepEqual(parse(input), { state: 'requiere_aclaracion', question: input.pregunta });
  assert.throws(() => parse({ ...input, plan_markdown: 'Menú' }));
  assert.throws(() => parse({ ...input, macros_objetivo: {} }));
});

test('canonical prompt treats injection strings as data and defines bounded measurement coverage', async () => {
  const prompt = await readTrainingPlanPrompt();
  assert.match(prompt, /datos pasivos/i);
  assert.match(prompt, /máximo 24 registros/);
  assert.match(prompt, /al menos 3 mediciones comparables/);
  assert.match(prompt, /La ausencia de datos clínicos no equivale a ausencia de riesgos/);
});

test('plan backups reject tampering, expiry, other users and other signing secrets', () => {
  const secret = 'test-only-plan-recovery-secret-123456789';
  const pending = { runId: 'draft', goals: 'Fuerza', plan: planText, macros: {}, context: {}, expiresAt: Date.now() + 60000 };
  const token = issueTrainingPlanDraft('9011', pending, secret);
  assert.equal(readTrainingPlanDraft('9011', token, secret).plan, planText);
  assert.throws(() => readTrainingPlanDraft('9012', token, secret), { status: 409 });
  assert.throws(() => readTrainingPlanDraft('9011', `${token}x`, secret), { status: 409 });
  assert.throws(() => readTrainingPlanDraft('9011', token, 'other-secret'), { status: 409 });
  assert.throws(() => readTrainingPlanDraft('9011', issueTrainingPlanDraft('9011', { ...pending, expiresAt: Date.now() - 1 }, secret), secret), { status: 409 });
});

test('a server snapshot can be refined after losing session memory', async () => {
  const userId = '9013';
  const recoverySecret = 'test-only-plan-recovery-secret-123456789';
  const context = { profile: { age: 32 }, biometricRecords: [], plicometricRecords: [] };
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  const calls = [];
  const requestOpenCode = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (endpoint === '/session') return { status: 201, data: { id: 'ses_recovery9013' } };
    if (method === 'DELETE') return { status: 204 };
    return { status: 200, data: { parts: [{ type: 'text', text: JSON.stringify({ estado: 'plan_listo', macros_objetivo: macros, plan_markdown: planText }) }] } };
  };
  const readConfig = async () => ({ requestTimeoutMs: 1000 });
  const generated = await generateTrainingPlan({ userId, goals: 'Fuerza', context, recoverySecret, requestOpenCode, readConfig });
  assert.equal(generated.draftToken, undefined);
  await deleteTrainingPlanSession({ userId, requestOpenCode });
  const refined = await refineTrainingPlan({ userId, runId: generated.runId, snapshot: { ...generated, context, goals: 'Fuerza' }, changes: 'Tres días', requestOpenCode, readConfig });
  assert.equal(refined.runId, generated.runId);
  assert.equal(refined.plan, generated.plan);
  assert.equal(calls.filter((call) => call.endpoint === '/session').length, 2);
  assert.equal(JSON.parse(calls.at(-1).body.parts[0].text).borradorActual.plan_markdown, generated.plan);
  await deleteTrainingPlanSession({ userId, requestOpenCode });
});
