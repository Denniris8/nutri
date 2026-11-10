const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { migrate } = require('./migrate.js');

test('migration lock is acquired before inspecting or modifying the schema', async () => {
  const queries = [];
  await assert.rejects(migrate(async (sql) => { queries.push(sql); return '0'; }, []), /bloqueo/);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /SELECT GET_LOCK\(.+,60\)/);
});

test('migrations and checksum writes use the locked connection in order', async () => {
  const file = { name: '0001_example.sql', sql: 'SELECT 42;' };
  const checksum = createHash('sha256').update(file.sql).digest('hex');
  const queries = [];
  await migrate(async (sql) => {
    queries.push(sql);
    return sql.includes('GET_LOCK') ? '1' : '';
  }, [file]);
  assert.match(queries[0], /GET_LOCK/);
  assert.match(queries[1], /CREATE TABLE IF NOT EXISTS schema_migrations/);
  assert.match(queries[2], /SELECT LOWER\(HEX\(checksum\)\)/);
  assert.equal(queries[3], file.sql);
  assert.ok(queries[4].includes(checksum));
  const skipped = [];
  await migrate(async (sql) => {
    skipped.push(sql);
    return sql.includes('GET_LOCK') ? '1' : sql.includes('SELECT LOWER') ? checksum : '';
  }, [file]);
  assert.equal(skipped.length, 3);
});

test('failed migration is not recorded and changed checksums stop execution', async () => {
  const files = [{ name: '0001_example.sql', sql: 'SELECT 42;' }];
  const queries = [];
  await assert.rejects(migrate(async (sql) => {
    queries.push(sql);
    if (sql === files[0].sql) throw new Error('connection_lost');
    return sql.includes('GET_LOCK') ? '1' : '';
  }, files), /connection_lost/);
  assert.ok(queries.every((sql) => !sql.startsWith('INSERT INTO schema_migrations')));
  await assert.rejects(migrate(async (sql) => sql.includes('GET_LOCK') ? '1' : sql.includes('SELECT LOWER') ? 'different' : '', files), /modificada/);
});
