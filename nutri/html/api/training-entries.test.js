const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateTrainingEnergy, saveDailySteps, saveTrainingEntry, visibleTrainingEntries } = require('./training-entries.js');

const manual = (overrides = {}) => ({ origin: 'manual', activity: 'Correr', createdAt: '2026-10-15T10:00:00Z', durationMinutes: 30, met: 7, weightKg: 70, ...overrides });
const garmin = (overrides = {}) => ({ origin: 'garmin', energyType: 'reportada_dispositivo', activity: 'running', createdAt: '2026-10-15T10:00:00Z', durationMinutes: 30, caloriesKcal: 250, ...overrides });
const trainingRequest = (overrides = {}) => ({
  requestId: '123e4567-e89b-42d3-a456-426614174000', description: '30 minutos de correr',
  analysis: { activity: 'Correr', durationMinutes: 30, weightKg: 70, met: 7 }, suppressNotification: true, ...overrides,
});
const trainingJson = (response, status, body) => { response.status = status; response.body = body; };

test('manual training registration persists and verifies the calculated session', async () => {
  const queries = [];
  const response = {};
  const persisted = {
    id: '41', requestId: trainingRequest().requestId, description: '30 minutos de correr', activity: 'Correr',
    durationMinutes: 30, weightKg: 70, met: 7, caloriesKcal: 257.3, createdAt: '2026-10-22T11:00:00Z',
  };
  await saveTrainingEntry({
    response, data: trainingRequest(), userId: '27', timezone: 'UTC',
    textSql: (value) => `'${String(value).replaceAll("'", "''")}'`, json: trainingJson,
    dbQuery: async (sql) => {
      queries.push(sql);
      if (sql.includes('SELECT zona_horaria')) return 'UTC';
      if (sql.includes('INSERT INTO registros_entrenamientos')) return '41';
      if (sql.includes('SELECT JSON_OBJECT')) return JSON.stringify(persisted);
      return '';
    },
  });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body, { ok: true, entryId: '41', requestId: trainingRequest().requestId, caloriesKcal: 257.3, createdAt: persisted.createdAt, savedAt: null });
  assert.match(queries.find((sql) => sql.includes('INSERT INTO registros_entrenamientos')), /'manual'/);
  assert.match(queries.find((sql) => sql.includes('INSERT INTO registros_entrenamientos')), /'123e4567-e89b-42d3-a456-426614174000'/);
  assert.ok(queries.some((sql) => sql.includes('SELECT JSON_OBJECT') && sql.includes('usuario_id=27')));
});

test('manual training registration rejects incomplete measurements before persistence', async () => {
  let persisted = false;
  const response = {};
  await saveTrainingEntry({
    response, data: trainingRequest({ analysis: { activity: 'Correr', durationMinutes: 30, weightKg: null, met: 7 } }),
    userId: '27', timezone: 'UTC', textSql: (value) => `'${value}'`, json: trainingJson,
    dbQuery: async (sql) => { if (sql.includes('INSERT INTO registros_entrenamientos')) persisted = true; return 'UTC'; },
  });
  assert.equal(response.status, 400);
  assert.equal(persisted, false);
});

test('manual training registration rejects a requestId reused for different saved data', async () => {
  const response = {};
  await saveTrainingEntry({
    response, data: trainingRequest(), userId: '27', timezone: 'UTC',
    textSql: (value) => `'${value}'`, json: trainingJson,
    dbQuery: async (sql) => {
      if (sql.includes('SELECT zona_horaria')) return 'UTC';
      if (sql.includes('INSERT INTO registros_entrenamientos')) return '41';
      if (sql.includes('SELECT JSON_OBJECT')) return JSON.stringify({ ...trainingRequest().analysis, id: '41', requestId: trainingRequest().requestId, description: trainingRequest().description, activity: 'Caminar', caloriesKcal: 257.3 });
      return '';
    },
  });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /clave de reintento/);
});

test('manual training registration reports persistence failures without exposing database details', async () => {
  const response = {};
  const queries = [];
  await saveTrainingEntry({
    response, data: trainingRequest(), userId: '27', timezone: 'UTC',
    textSql: (value) => `'${value}'`, json: trainingJson,
    dbQuery: async (sql) => {
      queries.push(sql);
      if (sql.includes('SELECT zona_horaria')) return 'UTC';
      if (sql.includes('INSERT INTO registros_entrenamientos')) throw new Error('private database detail');
      return '';
    },
  });
  assert.equal(response.status, 503);
  assert.match(response.body.error, /No se pudo guardar/);
  assert.ok(queries.some((sql) => sql.includes('INSERT INTO errores_aplicacion')));
  assert.ok(queries.every((sql) => !sql.includes('private database detail')));
});

test('distinct manual and Garmin sessions both contribute to the daily exercise adjustment', () => {
  const result = calculateTrainingEnergy([
    manual(),
    garmin({ activity: 'cycling', createdAt: '2026-10-15T15:00:00Z', durationMinutes: 60, caloriesKcal: 500 }),
  ]);
  assert.equal(result.manualNetKcal, 220.5);
  assert.equal(result.deviceReportedKcal, 500);
  assert.equal(result.adjustmentKcal, 720.5);
});

test('Garmin replaces the manual calories for a clearly matching activity', () => {
  const result = calculateTrainingEnergy([manual(), garmin({ createdAt: '2026-10-15T10:02:00Z' })]);
  assert.equal(result.manualNetKcal, 0);
  assert.equal(result.deviceReportedKcal, 250);
  assert.equal(result.adjustmentKcal, 250);
  assert.equal(result.matchedManualDuplicates, 1);
});

test('ambiguous source matches are excluded from the adjustment and reported', () => {
  const result = calculateTrainingEnergy([
    manual(),
    garmin({ caloriesKcal: 250 }),
    garmin({ createdAt: '2026-10-15T10:03:00Z', caloriesKcal: 260 }),
  ]);
  assert.equal(result.adjustmentKcal, 0);
  assert.equal(result.unresolvedPossibleDuplicates, 3);
});

test('invalid manual metrics and device calories are excluded and counted', () => {
  const result = calculateTrainingEnergy([
    manual({ weightKg: null }),
    manual({ durationMinutes: 1441 }),
    garmin({ caloriesKcal: -1, activity: 'cycling' }),
    garmin({ caloriesKcal: 100001, activity: 'swimming' }),
  ]);
  assert.equal(result.adjustmentKcal, 0);
  assert.equal(result.uncalculableManualCount, 2);
  assert.equal(result.uncalculableDeviceCount, 2);
  assert.equal(result.manualSessionCount, 0);
  assert.equal(result.deviceSessionCount, 0);
});

test('valid source totals are rounded once and session counts remain traceable', () => {
  const result = calculateTrainingEnergy([
    manual({ durationMinutes: 30.01 }),
    garmin({ activity: 'cycling', caloriesKcal: 100.04 }),
  ]);
  assert.equal(result.manualSessionCount, 1);
  assert.equal(result.deviceSessionCount, 1);
  assert.equal(result.adjustmentKcal, Math.round((Math.max(0, (7 - 1) * 3.5 * 70 / 200 * 30.01) + 100.04) * 10) / 10);
});

test('Garmin records are visible only when Garmin is linked and selected', () => {
  const records = [manual(), garmin()];
  assert.deepEqual(visibleTrainingEntries(records, { deviceMode: 'garmin', garminConnected: true }), records);
  assert.deepEqual(visibleTrainingEntries(records, { deviceMode: 'garmin', garminConnected: false }), [records[0]]);
  assert.deepEqual(visibleTrainingEntries(records, { deviceMode: 'ninguno', garminConnected: true }), [records[0]]);
  assert.deepEqual(visibleTrainingEntries(records, null), [records[0]]);
});

test('daily steps replace the existing total for the same local date', async () => {
  let statement = '';
  const saved = await saveDailySteps({
    userId: '27', date: '2026-10-16', localDate: '2026-10-16', stepsCount: 8400, source: 'manual',
    dbQuery: async (sql) => { statement = sql; }, textSql: (value) => `'${value}'`,
  });
  assert.deepEqual(saved, { date: '2026-10-16', stepsCount: 8400, source: 'manual' });
  assert.match(statement, /fuente=VALUES\(fuente\)/);
  assert.match(statement, /ON DUPLICATE KEY UPDATE pasos=VALUES\(pasos\)/);
});
