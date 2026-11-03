const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateTrainingEnergy, estimateStepEnergyKcal, saveDailySteps, saveTrainingEntry, visibleTrainingEntries } = require('./training-entries.js');

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
  assert.match(queries.find((sql) => sql.includes('INSERT INTO registros_entrenamientos')), /plan_vigencia_id/);
  assert.match(queries.find((sql) => sql.includes('INSERT INTO registros_entrenamientos')), /FROM vigencias_planes_entrenamiento/);
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

test('ambiguous Garmin matches keep manual calories and exclude uncertain device totals', () => {
  const result = calculateTrainingEnergy([
    manual(),
    garmin({ caloriesKcal: 250 }),
    garmin({ createdAt: '2026-10-15T10:03:00Z', caloriesKcal: 260 }),
  ]);
  assert.equal(result.adjustmentKcal, 220.5);
  assert.equal(result.unresolvedPossibleDuplicates, 3);
  assert.equal(result.manualSessionCount, 1);
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

test('step energy estimate uses the stored height and weight basis', () => {
  assert.equal(estimateStepEnergyKcal(10000, 70, 175), 254.2);
  assert.equal(estimateStepEnergyKcal(0, null, null), 0);
  assert.equal(estimateStepEnergyKcal(10000, null, 175), null);
});

test('manual step energy adds to manual workout energy when no Garmin daily total exists', () => {
  const result = calculateTrainingEnergy([manual()], { source: 'manual', stepsCount: 10000, caloriesKcal: 254.2, energyMethod: 'pasos_estimados' });
  assert.equal(result.manualNetKcal, 220.5);
  assert.equal(result.stepEnergyKcal, 254.2);
  assert.equal(result.adjustmentKcal, 474.7);
});

test('Garmin active calories replace device sessions and add only manual sessions not included in Garmin', () => {
  const result = calculateTrainingEnergy([
    manual({ activity: 'Ciclismo', createdAt: '2026-10-15T12:00:00Z', garminIncludedInActive: false }),
    garmin({ activity: 'running', caloriesKcal: 250 }),
  ], { source: 'garmin', stepsCount: 10000, caloriesKcal: 600, energyMethod: 'garmin_active' });
  assert.equal(result.garminActiveKcal, 600);
  assert.equal(result.deviceReportedKcal, 250);
  assert.equal(result.stepEnergyKcal, null);
  assert.equal(result.manualSupplementKcal, 220.5);
  assert.equal(result.adjustmentKcal, 820.5);
});

test('manual sessions confirmed as included in Garmin are not added twice', () => {
  const result = calculateTrainingEnergy([manual({ garminIncludedInActive: true })], {
    source: 'garmin', stepsCount: 10000, caloriesKcal: 600, energyMethod: 'garmin_active',
  });
  assert.equal(result.manualNetKcal, 0);
  assert.equal(result.manualSupplementKcal, 0);
  assert.equal(result.adjustmentKcal, 600);
});

test('step-only day with missing body dimensions has no calorie adjustment instead of zero', () => {
  const result = calculateTrainingEnergy([], { source: 'manual', stepsCount: 10000, caloriesKcal: null, energyMethod: null });
  assert.equal(result.stepEnergyUnavailable, true);
  assert.equal(result.adjustmentKcal, null);
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
    userId: '27', date: '2026-10-16', localDate: '2026-10-16', stepsCount: 8400, source: 'manual', weightKg: 70, heightCm: 175,
    dbQuery: async (sql) => { statement = sql; }, textSql: (value) => `'${value}'`,
  });
  assert.equal(saved.date, '2026-10-16');
  assert.equal(saved.caloriesKcal, 213.5);
  assert.equal(saved.energyMethod, 'pasos_estimados');
  assert.match(statement, /fuente=VALUES\(fuente\)/);
  assert.match(statement, /ON DUPLICATE KEY UPDATE pasos=VALUES\(pasos\)/);
  assert.match(statement, /energia_actividad_kcal/);
});

test('Garmin daily steps store Garmin active calories as the daily energy source', async () => {
  let statement = '';
  const saved = await saveDailySteps({
    userId: '27', date: '2026-10-16', localDate: '2026-10-16', stepsCount: 8400, source: 'garmin', activeKcal: 612.4,
    dbQuery: async (sql) => { statement = sql; }, textSql: (value) => `'${value}'`,
  });
  assert.equal(saved.caloriesKcal, 612.4);
  assert.equal(saved.energyMethod, 'garmin_active');
  assert.match(statement, /'garmin_active'/);
});

test('manual step correction preserves a Garmin active total already stored for that date', async () => {
  let insert = '';
  const saved = await saveDailySteps({
    userId: '27', date: '2026-10-16', localDate: '2026-10-16', stepsCount: 9000, source: 'manual', weightKg: 70, heightCm: 175,
    dbQuery: async (sql) => {
      if (sql.includes("JSON_OBJECT('stepsCount'")) return JSON.stringify({ stepsCount: 8400, source: 'garmin', caloriesKcal: 612.4, energyMethod: 'garmin_active' });
      insert = sql;
      return '';
    }, textSql: (value) => `'${value}'`,
  });
  assert.equal(saved.caloriesKcal, 612.4);
  assert.equal(saved.energyMethod, 'garmin_active');
  assert.match(insert, /612\.4,'garmin_active'/);
});

test('Garmin-linked manual training without a matching Garmin activity asks before persistence', async () => {
  const response = {};
  const queries = [];
  await saveTrainingEntry({
    response, data: trainingRequest({ date: '2026-10-15', savedAt: '10:00' }), garminEnabled: true,
    userId: '27', timezone: 'UTC', textSql: (value) => `'${String(value)}'`, json: trainingJson,
    dbQuery: async (sql) => {
      queries.push(sql);
      if (sql.includes('SELECT zona_horaria')) return 'UTC';
      if (sql.includes('SELECT garmin_incluido_en_active')) return '';
      if (sql.includes("'stepsCount'")) return JSON.stringify({ stepsCount: 9000, source: 'garmin', caloriesKcal: 600, energyMethod: 'garmin_active' });
      if (sql.startsWith('SET time_zone')) return '';
      if (sql.includes('INSERT INTO registros_entrenamientos')) throw new Error('should not persist before answer');
      return '';
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.requiresGarminConfirmation, true);
  assert.ok(!queries.some((sql) => sql.includes('INSERT INTO registros_entrenamientos')));
});

test('manual training matching one Garmin activity saves without an inclusion question', async () => {
  const response = {};
  const request = trainingRequest({ date: '2026-10-15', savedAt: '10:00' });
  const persisted = {
    id: '41', requestId: request.requestId, description: request.description, activity: 'Correr',
    durationMinutes: 30, weightKg: 70, met: 7, caloriesKcal: 257.3, garminIncluded: 1,
    createdAt: '2026-10-15T10:00:00Z',
  };
  let insert = '';
  await saveTrainingEntry({
    response, data: request, garminEnabled: true, userId: '27', timezone: 'UTC',
    textSql: (value) => `'${String(value)}'`, json: trainingJson,
    dbQuery: async (sql) => {
      if (sql.includes('SELECT zona_horaria')) return 'UTC';
      if (sql.includes('SELECT garmin_incluido_en_active')) return '';
      if (sql.startsWith('SET time_zone')) return JSON.stringify({
        id: '90', origin: 'garmin', energyType: 'reportada_dispositivo', activity: 'running',
        durationMinutes: 30, createdAt: '2026-10-15T10:02:00Z', caloriesKcal: 250,
      });
      if (sql.includes('INSERT INTO registros_entrenamientos')) { insert = sql; return '41'; }
      if (sql.includes("'garminIncluded'")) return JSON.stringify(persisted);
      return '';
    },
  });
  assert.equal(response.status, 201);
  assert.match(insert, /garmin_incluido_en_active/);
  assert.match(insert, /257\.3,1,/);
});
