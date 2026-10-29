const assert = require('node:assert/strict');
const test = require('node:test');
const { createAnalysisProgressRecorder } = require('./analysis-progress.js');

test('records event durations and elapsed time without analysis content', async () => {
  const statements = [];
  let time = 1000;
  const recorder = createAnalysisProgressRecorder({
    dbQuery: async (sql) => statements.push(sql),
    textSql: (value) => `'${value}'`,
    userId: 27,
    flow: 'comida',
    operationId: '00000000-0000-4000-8000-000000000001',
    now: () => time,
  });
  recorder.record('session_ready');
  time += 125;
  recorder.record('message_received');
  await recorder.flush();
  assert.match(statements[0], /'session_ready',UTC_TIMESTAMP\(3\),0,0/);
  assert.match(statements[1], /'message_received',UTC_TIMESTAMP\(3\),125,125/);
  assert.ok(statements.every((sql) => !sql.includes('food text')));
});
