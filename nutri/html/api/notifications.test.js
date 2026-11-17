const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { notificationInsertSql, readNotifications } = require('./notifications.js');

const textSql = (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`;

test('notification list and full unread total share one read-only snapshot and connection', async () => {
  let calls = 0;
  const result = await readNotifications({ userId: '27', dbQuery: async (sql) => {
    calls += 1;
    assert.match(sql, /START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY/);
    assert.match(sql, /ORDER BY creado_en DESC,id DESC LIMIT 50/);
    assert.match(sql, /SELECT COUNT\(\*\).*usuario_id=27 AND leida_en IS NULL;/);
    return `${JSON.stringify({ id: '1', title: 'Aviso' })}\nunreadCount\n75`;
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { notifications: [{ id: '1', title: 'Aviso' }], unreadCount: 75 });
  assert.deepEqual(await readNotifications({ userId: '27', dbQuery: async () => 'unreadCount\n0' }),
    { notifications: [], unreadCount: 0 });
  await assert.rejects(readNotifications({ userId: '27', dbQuery: async () => '' }), /notification_read_failed/);
});

test('notification insert is bound to the authenticated user and escaped text', () => {
  const sql = notificationInsertSql({ userId: '27', category: 'comida', state: 'requiere_respuesta', title: 'Pregunta', message: "¿Cuántos gramos?'; DROP TABLE usuarios;", textSql });
  assert.match(sql, /VALUES \(27,/);
  assert.match(sql, /UTC_TIMESTAMP\(3\)/);
  assert.ok(!sql.includes("DROP TABLE usuarios"));
});

test('notification insert rejects invalid users and states', () => {
  assert.throws(() => notificationInsertSql({ userId: '1 OR 1=1', category: 'comida', state: 'guardado', title: 'A', message: 'B', textSql }));
  assert.throws(() => notificationInsertSql({ userId: '1', category: 'comida', state: 'unknown', title: 'A', message: 'B', textSql }));
});

test('synthetic alert seed is restricted to dummy accounts and visibly labeled', () => {
  const migration = readFileSync(path.resolve(__dirname, '../../mysql/migrations/0002_notificacion_dummy.sql'), 'utf8');
  assert.match(migration, /WHERE es_prueba=1/);
  assert.match(migration, /\[DATO SINTÉTICO DE PRUEBA\]/);
});
