const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { readdir, readFile } = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');

async function migrate(query, files) {
  // GET_LOCK pertenece a la conexión, sobrevive a commits DDL y se libera al cerrarla.
  const lock = "CONCAT('nutri:migrate:',LEFT(SHA2(DATABASE(),256),48))";
  if ((await query(`SELECT GET_LOCK(${lock},60);`)).trim() !== '1') throw new Error('No se pudo adquirir el bloqueo de migraciones.');
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(120) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    checksum BINARY(32) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
  for (const { name, sql } of files) {
    if (!/^\d{4}_[a-zA-Z0-9_.-]+\.sql$/.test(name)) throw new Error(`Nombre de migración inválido: ${name}`);
    const version = name.slice(0, -4);
    const checksum = createHash('sha256').update(sql).digest('hex');
    const applied = (await query(`SELECT LOWER(HEX(checksum)) FROM schema_migrations WHERE version='${version}';`)).trim();
    if (applied) {
      if (applied !== checksum) throw new Error(`Migración aplicada modificada: ${name}`);
      continue;
    }
    console.log(`Aplicando migración ${name}`);
    await query(sql);
    await query(`INSERT INTO schema_migrations (version, checksum) VALUES ('${version}', UNHEX('${checksum}'));`);
  }
}

async function main() {
  const { DB_HOST: host, DB_PORT: port, DB_USER: user, DB_PASSWORD: password, DB_NAME: database } = process.env;
  if (![host, port, user, password, database].every(Boolean)) throw new Error('Falta configuración MySQL para las migraciones.');
  const directory = path.join(__dirname, 'migrations');
  const names = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const files = await Promise.all(names.map(async (name) => ({ name, sql: await readFile(path.join(directory, name), 'utf8') })));
  const child = spawn('mysql', [
    `--host=${host}`, `--port=${port}`, `--user=${user}`, `--database=${database}`,
    '--batch', '--raw', '--skip-column-names', '--default-character-set=utf8mb4',
    '--connect-timeout=5', '--skip-reconnect', '--unbuffered', '--binary-mode',
  ], { env: { ...process.env, MYSQL_PWD: password }, stdio: ['pipe', 'pipe', 'ignore'] });
  let pending;
  let failure;
  const fail = () => {
    failure = new Error('Falló el cliente MySQL; revisar el estado de la migración antes de reintentar.');
    pending?.reject(failure);
    pending = null;
  };
  child.on('error', fail);
  child.on('close', fail);
  child.stdin.on('error', fail);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (!pending) return;
    if (line === pending.marker) {
      const { resolve, rows } = pending;
      pending = null;
      resolve(rows.join('\n'));
    } else pending.rows.push(line);
  });
  const query = (sql) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const marker = `migration_${randomUUID()}`;
    pending = { marker, rows: [], resolve, reject };
    child.stdin.write(`${sql}\n;\nSELECT '${marker}';\n`);
  });
  const stop = () => { child.kill('SIGTERM'); process.exit(1); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { await migrate(query, files); }
  finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    child.stdin.end();
    lines.close();
    child.kill('SIGTERM');
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { migrate };
