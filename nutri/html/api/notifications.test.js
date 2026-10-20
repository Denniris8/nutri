const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { notificationInsertSql } = require('./notifications.js');

const textSql = (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`;

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
