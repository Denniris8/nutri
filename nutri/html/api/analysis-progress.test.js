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
  assert.equal(statements.length, 1);
  assert.match(statements[0], /'session_ready','1970-01-01 00:00:01\.000',0,0/);
  assert.match(statements[0], /'message_received','1970-01-01 00:00:01\.125',125,125/);
  assert.ok(statements.every((sql) => !sql.includes('food text')));
});

test('progress batches are bounded, ordered and safe to flush repeatedly', async () => {
  const statements = [];
  const recorder = createAnalysisProgressRecorder({ dbQuery: async (sql) => statements.push(sql), textSql: (value) => `'${value}'`, userId: 27, flow: 'plan', operationId: 'test', now: () => 1000 });
  for (let index = 0; index < 21; index += 1) recorder.record(`event_${index}`);
  recorder.record('invalid event with private text');
  await Promise.all([recorder.flush(), recorder.flush()]);
  assert.equal(statements.length, 2);
  assert.equal((statements[0].match(/'event_\d+'/g) || []).length, 20);
  assert.match(statements[1], /'event_20'/);
  assert.doesNotMatch(statements.join(''), /private text/);
  await recorder.flush();
  assert.equal(statements.length, 2);
});

test('a failed telemetry batch does not reject the analysis or stop later batches', async () => {
  const errors = [];
  const originalError = console.error;
  let calls = 0;
  console.error = (message) => errors.push(message);
  try {
    const recorder = createAnalysisProgressRecorder({
      dbQuery: async () => { if (++calls === 1) throw new Error('private database detail'); },
      textSql: (value) => `'${value}'`, userId: 27, flow: 'plan', operationId: 'test',
    });
    recorder.record('started');
    await recorder.flush();
    recorder.record('completed');
    await recorder.flush();
    assert.equal(calls, 2);
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0], /private database detail/);
  } finally { console.error = originalError; }
});
