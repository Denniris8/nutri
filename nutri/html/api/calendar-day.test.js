const assert = require('node:assert/strict');
const test = require('node:test');
const { calendarDayRange, readCalendarTimezone } = require('./calendar-day.js');

test('calendar-day range respects 23-hour daylight-saving days', () => {
  assert.deepEqual(calendarDayRange('2026-03-08', 'America/New_York'), {
    start: '2026-03-08 05:00:00', end: '2026-03-09 04:00:00', endDate: '2026-03-09',
  });
});

test('calendar-day range respects 25-hour daylight-saving days', () => {
  assert.deepEqual(calendarDayRange('2026-11-01', 'America/New_York'), {
    start: '2026-11-01 04:00:00', end: '2026-11-02 05:00:00', endDate: '2026-11-02',
  });
});

test('calendar timezone reads only the account timezone and falls back when absent', async () => {
  let query;
  assert.equal(await readCalendarTimezone('27', async (sql) => { query = sql; return ''; }, 'UTC'), 'UTC');
  assert.match(query, /SELECT zona_horaria FROM preferencias_usuario WHERE usuario_id=27/);
});
