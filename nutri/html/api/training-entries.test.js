const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateTrainingEnergy, saveDailySteps, visibleTrainingEntries } = require('./training-entries.js');

const manual = (overrides = {}) => ({ origin: 'manual', activity: 'Correr', createdAt: '2026-10-15T10:00:00Z', durationMinutes: 30, met: 7, weightKg: 70, ...overrides });
const garmin = (overrides = {}) => ({ origin: 'garmin', energyType: 'reportada_dispositivo', activity: 'running', createdAt: '2026-10-15T10:00:00Z', durationMinutes: 30, caloriesKcal: 250, ...overrides });

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
