const assert = require('node:assert/strict');
const test = require('node:test');
const { extractExplicitSteps, parseReply } = require('./training-analysis.js');

const context = { latestWeightKg: 70, latestWeightStale: false };
const reply = (overrides = {}) => [{ type: 'text', text: JSON.stringify({
  trainingSession: true, question: null, activity: 'Correr', durationMinutes: 30, met: 7, ...overrides,
}) }];

test('calories are calculated from MET, duration and server-selected weight', () => {
  const result = parseReply(reply(), context, null, 'Corrí 30 minutos', { localDate: '2026-10-26', timezone: 'UTC' });
  assert.equal(result.weightKg, 70);
  assert.equal(result.caloriesKcal, 257.3);
  assert.match(result.formula, /7 MET.*70 kg.*30 min/);
});

test('an explicit current weight takes precedence over the registered value', () => {
  const result = parseReply(reply(), context, 80, 'Corrí 30 minutos; peso actual 80 kg', { localDate: '2026-10-26', timezone: 'UTC' });
  assert.equal(result.weightKg, 80);
  assert.equal(result.caloriesKcal, 294);
});

test('steps are extracted only from one explicit total and the server resolves yesterday', () => {
  assert.deepEqual(extractExplicitSteps('Ayer hice 8,400 pasos y corrí 30 minutos', { localDate: '2026-10-26' }), {
    stepsCount: 8400, stepsDate: '2026-10-25',
  });
  const result = parseReply(reply(), context, null, 'Ayer hice 8,400 pasos y corrí 30 minutos', { localDate: '2026-10-26', timezone: 'UTC' });
  assert.equal(result.stepsCount, 8400);
  assert.equal(result.stepsDate, '2026-10-25');
  assert.deepEqual(extractExplicitSteps('Anteayer: 6 mil pasos', { localDate: '2026-10-26' }), { stepsCount: 6000, stepsDate: '2026-10-24' });
  assert.deepEqual(extractExplicitSteps('El 2026-10-20 hice 4000 pasos', { localDate: '2026-10-26' }), { stepsCount: 4000, stepsDate: '2026-10-20' });
  assert.deepEqual(extractExplicitSteps('Mañana haré 4000 pasos', { localDate: '2026-10-26' }), { stepsCount: null, stepsDate: null });
});

test('rejects model-supplied calories, weight, or steps outside the analysis contract', () => {
  assert.throws(() => parseReply(reply({ caloriesKcal: 99999 }), context, null, 'Corrí 30 minutos'), /no válidos/);
  assert.throws(() => parseReply(reply({ stepsCount: 2000 }), context, null, 'Corrí 30 minutos'), /no válidos/);
});

test('steps-only reports do not create sessions and ambiguous totals are not persisted', () => {
  const stepsOnly = [{ type: 'text', text: JSON.stringify({ trainingSession: false, question: null, activity: null, durationMinutes: null, met: null }) }];
  assert.equal(parseReply(stepsOnly, context, null, 'Hoy hice 2500 pasos', { localDate: '2026-10-26' }).trainingSession, false);
  assert.deepEqual(extractExplicitSteps('Hoy hice 2500 pasos y ayer 1800 pasos', { localDate: '2026-10-26' }), { stepsCount: null, stepsDate: null });
  assert.deepEqual(extractExplicitSteps('Hoy caminé un rato', { localDate: '2026-10-26' }), { stepsCount: null, stepsDate: null });
});

test('a session without a trusted weight asks instead of estimating calories', () => {
  const result = parseReply(reply(), { latestWeightKg: null, latestWeightStale: true }, null, 'Corrí 30 minutos', { localDate: '2026-10-26', timezone: 'UTC' });
  assert.equal(result.caloriesKcal, null);
  assert.equal(result.weightKg, null);
  assert.match(result.question, /peso actual/);
});

test('a session missing MET must request clarification instead of returning an incomplete estimate', () => {
  const fallback = parseReply(reply({ met: null }), context, null, 'Corrí 30 minutos');
  assert.equal(fallback.caloriesKcal, null);
  assert.match(fallback.question, /intensidad/);
  const result = parseReply(reply({ met: null, question: '¿A qué intensidad corriste?' }), context, null, 'Corrí 30 minutos');
  assert.equal(result.caloriesKcal, null);
  assert.match(result.question, /intensidad/);
});
