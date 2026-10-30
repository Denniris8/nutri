const assert = require('node:assert/strict');
const { createHash, randomBytes, scryptSync } = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const { beforeEach } = test;
const { createServer, signJwt } = require('./server.js');
const { readBiometrics, validateBiometric } = require('./api/biometrics.js');
const { ensureFoodOpenCodeSession, forgetFoodSessionCache, openCodeRequest, requestFoodDescription, getFoodSessionDefaults } = require('./api/opencode-food.js');

beforeEach(() => forgetFoodSessionCache());
const { saveFoodEntry } = require('./api/food-entries.js');

const demo = {
  name: 'Usuario de prueba', countryIso: 'MX', phone: '0000000000', email: 'User@Example.com',
  password: 'Demo-Prueba-2026!', age: 30, heightCm: '175', sex: 'masculino', isTestAccount: true,
};

async function withServer(dbQuery, run, options = {}) {
  const { registrationRateLimitResult = '1\t3600', ...serverOptions } = options;
  const server = createServer({ sendVerificationEmail: async () => {}, ...serverOptions, dbQuery: (sql) => sql.includes('/* registration-rate-limit */') ? registrationRateLimitResult : dbQuery(sql), jwtSecret: 'test-jwt-secret-must-be-at-least-32-bytes' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const structuredOutputPart = (input) => ({
  type: 'tool', state: { status: 'completed', title: 'Structured Output', metadata: { valid: true }, input },
});

async function foodSessionMetadata(config) {
  config ||= getFoodSessionDefaults();
  const settings = { model: config.model, agent: config.agent, variant: config.variant };
  return { foodConfigSha256: createHash('sha256').update(JSON.stringify(settings)).digest('hex') };
}

const post = (url, data, headers = {}) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: new URL(url).origin, ...headers },
  body: JSON.stringify(data),
});

test('progress nutrition endpoint returns account-scoped nutrition, body, activity and coverage', async () => {
  const queries = [];
  const nutrition = { days: 7, current: { loggedDays: 1, completeDays: 1, incompleteDays: 0, kcal: 1800, protein: 100, carbs: 200, fat: 60 }, previous: { loggedDays: 0, completeDays: 0, incompleteDays: 0, kcal: null, protein: null, carbs: null, fat: null }, quality: { currentPending: 0, previousPending: 0, macroSources: { items: 1, usda: 1, declared: 0, web: 0, opencode: 0, estimated: 0 } }, goals: null };
  const body = { current: { measurements: 2, firstKg: 80, lastKg: 79 }, previous: { measurements: 0, firstKg: null, lastKg: null } };
  const activity = { current: { stepDays: 1, avgSteps: 8000, trainingSessions: 1, manualSessions: 1, deviceSessions: 0, manualMinutes: 45, deviceMinutes: null, manualKcal: 300, deviceKcal: null }, previous: { stepDays: 0, avgSteps: null, trainingSessions: 0, manualSessions: 0, deviceSessions: 0, manualMinutes: null, deviceMinutes: null, manualKcal: null, deviceKcal: null } };
  await withServer(async (sql) => {
    queries.push(sql);
    if (sql.includes('SELECT s.usuario_id')) return '27';
    if (sql.includes('WITH daily AS')) return [nutrition, body, activity, { current: 1, previous: 0 }].map(JSON.stringify).join('\n');
    throw new Error('unexpected_query');
  }, async (base) => {
    const cookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const response = await fetch(`${base}/api/progress/nutrition?dias=7&hasta=2026-10-21`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { nutrition, body, activity, plicometric: { current: 1, previous: 0 } });
  });
  assert.equal(queries.filter((sql) => !sql.includes('SELECT s.usuario_id') && sql.includes('usuario_id=27')).length, 1);
  assert.match(queries.find((sql) => sql.includes('WITH daily AS')), /estado='completado'.{0,120}fecha_consumo/);
});

test('biometric range query validates dates and reads only the selected period', async () => {
  let query = '';
  assert.deepEqual(await readBiometrics({ userId: 27, start: '2026-10-01', end: '2026-10-07', dbQuery: async (sql) => { query = sql; return '[]'; } }), []);
  assert.match(query, /medido_en>=CAST\('2026-10-01 00:00:00' AS DATETIME\)/);
  assert.match(query, /medido_en<DATE_ADD\(CAST\('2026-10-07 00:00:00' AS DATETIME\),INTERVAL 1 DAY\)/);
  assert.doesNotMatch(query, /LIMIT 100/);
  await assert.rejects(readBiometrics({ userId: 27, start: '2026-02-30', end: '2026-03-01', dbQuery: async () => '[]' }), /invalid_biometric_range/);
});

test('only versioned CSS and JavaScript assets receive immutable caching', async () => {
  await withServer(async () => { throw new Error('unexpected_query'); }, async (base) => {
    const versioned = await fetch(`${base}/dashboard_nutricional.css?v=67`);
    const unversioned = await fetch(`${base}/dashboard_nutricional.css`);
    assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(unversioned.headers.get('cache-control'), 'no-store');
  });
});

test('dummy registration creates synthetic measurement rows without completing onboarding', async () => {
  let registrationSql = '';
  await withServer(async (sql) => { registrationSql = sql; return '27'; }, async (base) => {
    const response = await post(base + '/api/auth/register', demo);
    assert.equal(response.status, 202);
  }, { testAccountPhone: '+520000000000', allowTestAccountSeeding: true });
  for (const table of ['registros_biometricos', 'registros_plicometro', 'registros_comidas', 'planes_entrenamiento', 'vigencias_planes_entrenamiento']) {
    assert.match(registrationSql, new RegExp(`INSERT INTO ${table}`));
  }
  assert.doesNotMatch(registrationSql, /INSERT INTO (preferencias_usuario|perfil_salud_usuario)/);
  assert.match(registrationSql, /INSERT INTO vigencias_planes_entrenamiento\(usuario_id,plan_id,fecha_inicio,creado_en\)/);
  assert.ok(registrationSql.includes(Buffer.from('DATO SINTÉTICO DE PRUEBA: desayuno de ejemplo; alimentos y cantidades no son consumo real.').toString('hex')));
  assert.ok(registrationSql.includes(Buffer.from('DATO SINTÉTICO DE PRUEBA: plan de demostración; no es una recomendación personalizada.').toString('hex')));
  assert.doesNotMatch(registrationSql, /INSERT INTO (registros_comida_items|alimentos_referencia)/);
  assert.ok(registrationSql.includes(Buffer.from('Datos ficticios de demostración; reemplázalos por datos personales reales.').toString('hex')));
  assert.doesNotMatch(registrationSql, /dashboard_terms_decisions/);
});

test('client cannot mark an arbitrary registration as a test account', async () => {
  let registrationSql = '';
  await withServer(async (sql) => { registrationSql = sql; return '27'; }, async (base) => {
    const response = await post(base + '/api/auth/register', { ...demo, phone: '4155550123', countryIso: 'US', isTestAccount: true });
    assert.equal(response.status, 202);
  }, { testAccountPhone: '+520000000000', allowTestAccountSeeding: true });
  assert.doesNotMatch(registrationSql, /INSERT INTO (preferencias_usuario|perfil_salud_usuario|registros_biometricos|registros_plicometro|registros_comidas|planes_entrenamiento|vigencias_planes_entrenamiento)/);
});

test('test account seed requires server-side authorization even for the reserved phone', async () => {
  let registrationSql = '';
  await withServer(async (sql) => { registrationSql = sql; return '27'; }, async (base) => {
    const response = await post(base + '/api/auth/register', demo);
    assert.equal(response.status, 202);
  }, { testAccountPhone: '+520000000000', allowTestAccountSeeding: false });
  assert.doesNotMatch(registrationSql, /INSERT INTO (registros_biometricos|registros_plicometro|registros_comidas|planes_entrenamiento|vigencias_planes_entrenamiento)/);
  assert.match(registrationSql, /,0\);/);
});

test('persistent registration rate limit rejects requests across server instances', async () => {
  let accountCreated = false;
  await withServer(async (sql) => { if (sql.includes('INSERT INTO usuarios')) accountCreated = true; return '27'; }, async (base) => {
    const response = await post(base + '/api/auth/register', demo);
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '3600');
    assert.equal(accountCreated, false);
  }, { registrationRateLimitResult: '6\t3600', testAccountPhone: '+520000000000', allowTestAccountSeeding: true });
});

test('duplicate registration response does not disclose whether the email is already registered', async () => {
  await withServer(async () => { throw new Error('Duplicate entry for correo_electronico'); }, async (base) => {
    const response = await post(base + '/api/auth/register', demo);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Datos no válidos.' });
  }, { testAccountPhone: '+520000000000', allowTestAccountSeeding: true });
});

test('plicometer API validates and saves records for the authenticated account', async () => {
  let insertSql = '';
  const records = [{ fecha: '2026-10-13', triceps_mm: 12.5, biceps_mm: null, subescapular_mm: null, suprailiaco_mm: null, abdominal_mm: null, muslo_anterior_mm: null, pantorrilla_mm: null }];
  await withServer(async (sql) => {
    if (sql.includes('SELECT s.usuario_id')) return '27';
    if (sql.includes('FROM registros_plicometro')) return JSON.stringify(records);
    if (sql.includes('INSERT INTO registros_plicometro')) { insertSql = sql; return ''; }
    return '';
  }, async (base) => {
    const cookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const headers = { Cookie: cookie };
    const listed = await fetch(base + '/api/plicometrics', { headers });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).records, records);

    const saved = await post(base + '/api/plicometrics', {
      fecha: '2026-10-13', tricepsMm: '12.5', bicepsMm: '', subescapularMm: '',
      suprailiacoMm: '', abdominalMm: '', musloAnteriorMm: '', pantorrillaMm: '',
    }, headers);
    assert.equal(saved.status, 201);
    assert.match(insertSql, /INSERT INTO registros_plicometro\s*\(usuario_id,fecha,triceps_mm,biceps_mm,subescapular_mm,suprailiaco_mm,abdominal_mm,muslo_anterior_mm,pantorrilla_mm\)/);
    assert.match(insertSql, /VALUES \(27,CONVERT\(0x323032362d31302d3133 USING utf8mb4\),12\.5,NULL,NULL,NULL,NULL,NULL,NULL\)/);

    const empty = await post(base + '/api/plicometrics', { fecha: '2026-10-13' }, headers);
    assert.equal(empty.status, 400);
    const invalid = await post(base + '/api/plicometrics', {
      fecha: '2026-10-13', tricepsMm: '120.1',
    }, headers);
    assert.equal(invalid.status, 400);
  });
});

test('food save rejects an invalid OpenCode response without exposing it to the page', async () => {
  const queries = [];
  let storedSession = '';
  let sent;
  let firstSent;
  const description = '100g frijoles negros cocidos';
  const rawReply = [{ type: 'text', text: '{"items":[{"name":"frijoles negros"}]}' }];
  await withServer(async (sql) => {
    queries.push(sql);
    if (sql.includes('SELECT s.usuario_id')) return '27';
    if (sql.includes('SELECT session_id FROM sesiones_comidas_opencode')) return storedSession;
    if (sql.includes('INSERT INTO registros_comidas(')) return `61\n${JSON.stringify({ state: 'borrador_chat', fecha: '2026-10-13', description, question: null, targetEntryId: null })}`;
    const sessionInsert = sql.match(/INSERT INTO sesiones_comidas_opencode[^]*?VALUES \(27,CONVERT\(0x([a-f\d]+) USING utf8mb4\)\)/i);
    if (sessionInsert) { storedSession = Buffer.from(sessionInsert[1], 'hex').toString(); return ''; }
    return '';
  }, async (base) => {
    const cookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const saved = await post(base + '/api/food-entries', {
      requestId: '123e4567-e89b-42d3-a456-426614174000', fecha: '2026-10-13', descripcion: description,
    }, { Cookie: cookie });
    assert.equal(saved.status, 502);
    const result = await saved.json();
    assert.equal(result.entryId, '61');
    assert.match(result.message, /No pude validar la respuesta/);
    assert.equal(result.reply, undefined);
    assert.equal(result.trace, undefined);
    assert.equal(storedSession, 'ses_private_food');
    assert.equal(sent.route, '/session/ses_private_food/message');
    assert.deepEqual(sent.body.tools, { websearch: true, webfetch: true });
    assert.equal(typeof firstSent.body.system, 'string');
    assert.match(firstSent.body.system, /Si se excede `\d+`/);
    assert.equal(sent.body.system, undefined);
    assert.ok(JSON.stringify(sent.body).includes(description));
    assert.equal(sent.body.format, undefined);

    const empty = await post(base + '/api/food-entries', { fecha: '2026-10-13', descripcion: '  ' }, { Cookie: cookie });
    assert.equal(empty.status, 400);
  }, {
    openCodeRequest: async (method, route, body) => {
      if (method === 'GET') return { status: 200, data: { id: route.split('/').at(-1) } };
      if (route === '/session') return { status: 201, data: { id: 'ses_private_food' } };
      sent = { route, body };
      firstSent ||= sent;
      return { status: 200, data: { parts: rawReply } };
    },
  });
  assert.ok(queries.some((sql) => sql.includes('INSERT INTO registros_comidas')));
});

test('food day query returns only authenticated user records for the selected date', async () => {
  const queries = [];
  const records = [
    { id: 1, fecha: '2026-10-13', createdAt: '2026-10-13T12:10:00Z', state: 'pendiente', description: '100 g de avena', items: [], clarifications: [] },
    { id: 2, fecha: '2026-10-13', createdAt: '2026-10-13T18:30:00Z', state: 'pendiente', description: '2 huevos', items: [], clarifications: [] },
  ];
  await withServer(async (sql) => {
    queries.push(sql);
    if (sql.includes('SELECT s.usuario_id')) return '27';
    if (sql.includes("SELECT 'records';")) return ['records', ...records.map((record) => JSON.stringify(record)), 'items', 'clarifications'].join('\n');
    return '';
  }, async (base) => {
    const cookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const response = await fetch(`${base}/api/food-entries?fecha=2026-10-13&userId=999`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).records, records);
    const listSql = queries.find((sql) => sql.includes("SELECT 'records';"));
    assert.match(listSql, /e\.usuario_id=27/);
    assert.doesNotMatch(listSql, /999/);
  });
});

test.skip('retired macro-resolution flow: food macro resolution uses the MySQL lookup cache before USDA', async () => {
  let usdaCalls = 0;
  const result = await resolveFoodMacros({
    items: [{ sourceText: 'Arroz 150 g cocido', name: 'Arroz cocido', quantityText: '150 g', quantityGrams: 150, preparation: 'cocido', macros: null }],
    sessionId: 'ses_private_food', textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`,
    dbQuery: async () => JSON.stringify({ id: 8, fdcId: 991, sourceName: 'Rice, cooked', energyKcal: 130, proteinG: 2.7, carbohydrateG: 28.2, fatG: 0.3, fiberG: 0.4 }),
    requestOpenCode: async () => { throw new Error('cache hit must not require candidate selection'); },
    apiKey: 'test-only', fetchImpl: async () => { usdaCalls += 1; throw new Error('cache hit must not query USDA'); },
  });
  assert.equal(result.items[0].total.energyKcal, 195);
  assert.equal(result.items[0].total.proteinG, 4.05);
  assert.equal(usdaCalls, 0);
});

test.skip('retired macro-resolution flow: USDA lookup runs after a cache miss and saves nutrients per 100 g', async () => {
  const order = [];
  const result = await resolveFoodMacros({
    items: [{ sourceText: 'Pollo 150 g', name: 'Pollo', quantityText: '150 g', quantityGrams: 150, preparation: '', macros: null }],
    sessionId: 'ses_private_food', textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`,
    dbQuery: async (sql) => {
      order.push(sql.startsWith('SELECT JSON_OBJECT') ? 'cache' : 'store');
      return sql.startsWith('SELECT JSON_OBJECT') ? '' : '8';
    },
    requestOpenCode: async () => { throw new Error('unique exact FDC match needs no model selection'); },
    apiKey: 'test-only',
    fetchImpl: async (input) => {
      const url = new URL(input);
      order.push(url.pathname.endsWith('/search') ? 'search' : 'detail');
      return { ok: true, json: async () => url.pathname.endsWith('/search')
        ? { foods: [{ fdcId: 123, description: 'Pollo' }] }
        : { foodNutrients: [
          { nutrient: { id: 1003 }, amount: 31 }, { nutrient: { id: 1004 }, amount: 3.6 },
          { nutrient: { id: 1005 }, amount: 0 }, { nutrient: { id: 1079 }, amount: 0 },
          { nutrient: { id: 1008 }, amount: 165 },
        ] } };
    },
  });
  assert.deepEqual(order, ['cache', 'search', 'detail', 'store']);
  assert.equal(result.items[0].total.energyKcal, 247.5);
  assert.equal(result.items[0].total.proteinG, 46.5);
  assert.equal(result.items[0].energy449Kcal, 234.6);
});

test.skip('retired macro-resolution flow: USDA miss falls back to OpenCode webfetch and requires cited per-100 g macros', async () => {
  const result = await resolveFoodMacros({
    items: [{ sourceText: 'tofu firme 120 g', name: 'tofu firme', quantityText: '120 g', quantityGrams: 120, preparation: '', macros: null }],
    sessionId: 'ses_private_food', textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`,
    dbQuery: async (sql) => sql.startsWith('SELECT JSON_OBJECT') ? '' : '',
    requestOpenCode: async (method, route, body) => {
      assert.equal(method, 'POST');
      assert.equal(route, '/session/ses_private_food/message');
      assert.deepEqual(body.tools, { webfetch: true });
      assert.ok(body.system.includes('webfetch'));
      const fallback = {
        found: true, sourceUrl: 'https://nutrition.example/tofu', sourceName: 'Nutrition reference',
        sourceQuote: 'Per 100 g: Calories 144, protein 17.3 g, carbohydrates 2.8 g, fat 8.7 g, fiber 2.3 g.',
        macros: { energyKcal: 144, proteinG: 17.3, carbohydrateG: 2.8, fatG: 8.7, fiberG: 2.3 },
      };
      return { status: 200, data: { parts: [structuredOutputPart(fallback)] } };
    },
    apiKey: 'test-only', fetchImpl: async () => ({ ok: true, json: async () => ({ foods: [] }) }),
  });
  assert.equal(result.items[0].source, 'webfetch');
  assert.equal(result.items[0].sourceUrl, 'https://nutrition.example/tofu');
  assert.equal(result.items[0].sourceQuote.includes('protein 17.3 g'), true);
  assert.equal(result.items[0].total.energyKcal, 172.8);
});

test.skip('retired macro-resolution flow: food save parses first, checks USDA, then persists cited webfetch macros', async () => {
  const order = [];
  const foodSource = {
    found: true, sourceUrl: 'https://nutrition.example/tofu', sourceName: 'Nutrition reference',
    sourceQuote: 'Per 100 g: Calories 144, protein 17.3 g, carbohydrates 2.8 g, fat 8.7 g, fiber 2.3 g.',
    macros: { energyKcal: 144, proteinG: 17.3, carbohydrateG: 2.8, fatG: 8.7, fiberG: 2.3 },
  };
  let savedSql = '';
  let outcome;
  const sqls = [];
  const openCalls = [];
  const description = 'tofu firme 120 g';
  const textSql = (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`;
  await saveFoodEntry({
    data: { requestId: '123e4567-e89b-42d3-a456-426614174000', fecha: '2026-10-13', descripcion: description },
    userId: '27', textSql, response: {}, json: (_, status, body) => { outcome = { status, body }; },
    dbQuery: async (sql) => {
      sqls.push(sql);
      if (sql.startsWith('INSERT INTO registros_comidas(')) return '61';
      if (sql.includes("SELECT JSON_OBJECT('id',id,'fecha'")) return JSON.stringify({ id: 61, fecha: '2026-10-13', descripcion: description, estado: 'pendiente' });
      if (sql.includes('SELECT session_id FROM sesiones_comidas_opencode')) return '';
      if (sql.includes('INSERT INTO sesiones_comidas_opencode')) return '';
      if (sql.includes('FROM registros_comida_interacciones')) return '[]';
      if (sql.startsWith('SELECT JSON_OBJECT(\'id\',f.id')) return '';
      if (sql.includes('INSERT INTO registros_comida_items')) savedSql = sql;
      return '';
    },
    requestOpenCode: async (method, route, body) => {
      openCalls.push({ method, route });
      if (route === '/session') return { status: 201, data: { id: 'ses_private_food' } };
      const payload = JSON.parse(body.parts[0].text);
      if (typeof payload.description === 'string') {
        order.push('parse');
        return { status: 200, data: { parts: [structuredOutputPart({
          items: [{ sourceText: description, name: 'tofu firme', quantityGrams: null, quantityText: '120 g', preparation: null, macroBasis: 'unknown', macros: null }],
          clarificationQuestion: null,
        })] } };
      }
      assert.equal(payload.action, 'buscar_macros_web');
      order.push('webfetch');
      assert.deepEqual(body.tools, { webfetch: true });
      return { status: 200, data: { parts: [structuredOutputPart(foodSource)] } };
    },
    usdaKey: 'test-only',
    fetchImpl: async () => { order.push('usda'); return { ok: true, json: async () => ({ foods: [] }) }; },
  });
  assert.deepEqual(order, ['parse', 'usda', 'webfetch'], JSON.stringify({ outcome, sqls, openCalls }));
  assert.equal(outcome.body.state, 'completado');
  assert.ok(savedSql.includes(Buffer.from('webfetch').toString('hex')));
  for (const value of [foodSource.sourceName, foodSource.sourceUrl, foodSource.sourceQuote]) assert.ok(savedSql.includes(Buffer.from(value).toString('hex')));
  assert.match(savedSql, /,120,CONVERT\(0x7765626665746368 USING utf8mb4\),CONVERT\(0x7765626665746368 USING utf8mb4\),172\.8,190\.44/);
});

test.skip('retired macro-resolution flow: webfetch fallback rejects macros without a matching source citation', async () => {
  const result = await resolveFoodMacros({
    items: [{ sourceText: 'tofu 100 g', name: 'tofu', quantityText: '100 g', quantityGrams: 100, preparation: '', macros: null }],
    sessionId: 'ses_private_food', textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`,
    dbQuery: async () => '',
    requestOpenCode: async () => ({ status: 200, data: { parts: [structuredOutputPart({
      found: true, sourceUrl: 'https://nutrition.example/tofu', sourceName: 'Nutrition reference', sourceQuote: 'Per serving: protein 17 g, carbohydrates 3 g, fat 9 g.',
      macros: { energyKcal: 144, proteinG: 17, carbohydrateG: 3, fatG: 9, fiberG: 2 },
    })] } }),
    apiKey: 'test-only', fetchImpl: async () => ({ ok: true, json: async () => ({ foods: [] }) }),
  });
  assert.match(result.question, /fuente web verificable/);
});

test.skip('retired macro-resolution flow: food without a verified amount stays unresolved without an external lookup', async () => {
  let searched = false;
  const result = await resolveFoodMacros({
    items: [{ sourceText: 'Un plato de lentejas', name: 'Lentejas', quantityText: null, quantityGrams: null, preparation: '', macros: null }],
    sessionId: 'ses_private_food', textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`,
    dbQuery: async () => { searched = true; return ''; }, requestOpenCode: async () => { throw new Error('no lookup needed'); },
    apiKey: 'test-only', fetchImpl: async () => { throw new Error('must not query USDA without an amount'); },
  });
  assert.match(result.question, /gramos/);
  assert.equal(searched, false);
});

test.skip('retired macro-resolution flow: food parser accepts reordered grounded items and confirms declared macro values', () => {
  assert.match(validateParsedItems({ items: [{ sourceText: 'Pasta', name: 'Pasta' }] }, 'Avena 60 g').question, /corresponda/);
  const reordered = validateParsedItems({ items: [
    { sourceText: 'pollo 150 g', name: 'Pollo', quantityText: '150 g', preparation: '', macroBasis: 'unknown', macros: null },
    { sourceText: 'arroz cocido 100 g', name: 'Arroz cocido', quantityText: '100 g', preparation: 'cocido', macroBasis: 'unknown', macros: null },
  ] }, '150 g de pollo y 100 g de arroz cocido');
  assert.equal(reordered.items.length, 2);
  assert.deepEqual(reordered.items.map(({ quantityGrams }) => quantityGrams), [150, 100]);
  const mismatched = validateParsedItems({ items: [{
    sourceText: 'Avena: proteína 8 g, carbohidratos 40 g, grasa 4 g', name: 'Avena', macroBasis: 'per_portion', quantityText: null,
    macros: { energyKcal: null, proteinG: 18, carbohydrateG: 40, fatG: 4, fiberG: null },
  }] }, 'Avena: proteína 8 g, carbohidratos 40 g, grasa 4 g');
  assert.match(mismatched.question, /Confirma los macros/);
});

test('food request sends the current description and returns OpenCode parts unchanged', async () => {
  let sent;
  const reply = await requestFoodDescription({
    sessionId: 'ses_private_food_parts', description: '150 g de pollo cocido',
    comidasReferencia: [{ id: 'meal-4pm', items: [{ targetItemId: '41', name: 'Pollo asado', quantityGrams: 100 }] }],
    referenciaComidaSolicitada: true,
    originalDescription: 'texto anterior', replies: [{ role: 'assistant', content: 'pregunta anterior' }],
    requestOpenCode: async (method, route, body) => {
      sent = body;
      return { status: 200, data: { parts: [{ type: 'text', text: '{"items":[],"clarificationQuestion":"Aclara la cantidad."}' }] } };
    },
  });
  assert.match(sent.system, /`macros` con `energyKcal`, `proteinG`, `carbohydrateG`, `fatG`/);
  assert.match(sent.system, /macroStatus:"estimado"/);
  assert.equal(sent.format, undefined);
  assert.deepEqual(sent.tools, {});
  assert.deepEqual(JSON.parse(sent.parts[0].text), {
    description: '150 g de pollo cocido',
    referenciaComidaSolicitada: true,
    comidasReferencia: [{ id: 'meal-4pm', items: [{ targetItemId: '41', name: 'Pollo asado', quantityGrams: 100 }] }],
  });
  assert.deepEqual(reply, [{ type: 'text', text: '{"items":[],"clarificationQuestion":"Aclara la cantidad."}' }]);
});

test('food request disables web tools after the server confirms generic authorization', async () => {
  let sent;
  await requestFoodDescription({
    sessionId: 'ses_private_food_generic', description: 'Sí', initialDescription: '24 g salchicha Kir', genericEstimateApproved: true,
    requestOpenCode: async (_method, _route, body) => {
      sent = body;
      return { status: 200, data: { parts: [{ type: 'text', text: '{}' }] } };
    },
  });
  assert.deepEqual(sent.tools, {});
  assert.equal(JSON.parse(sent.parts[0].text).genericEstimateApproved, true);
  assert.match(sent.system, /Estimación autorizada/);
});

test('the canonical food prompt is sent only with the first message of each session', async () => {
  const systems = [];
  const requestOpenCode = async (_method, _route, body) => { systems.push(body.system); return { status: 200, data: { parts: [{ type: 'text', text: '{}' }] } }; };
  await requestFoodDescription({ sessionId: 'ses_private_food_once', description: 'Pollo 100 g', requestOpenCode });
  await requestFoodDescription({ sessionId: 'ses_private_food_once', description: 'Es pollo cocido', requestOpenCode });
  await requestFoodDescription({ sessionId: 'ses_private_food_other', description: 'Pollo 100 g', requestOpenCode });
  assert.equal(typeof systems[0], 'string');
  assert.equal(systems[1], undefined);
  assert.equal(typeof systems[2], 'string');
});

test('food first pass has web tools disabled and carries the exact Open Food Facts candidate', async () => {
  let sent;
  await requestFoodDescription({
    sessionId: 'ses_private_food', description: 'Yogur Griego Natural', allowWebSearch: false,
    openFoodFactsCandidates: [{ name: 'Yogur Griego Natural', sourceName: 'Open Food Facts (dato colaborativo)' }],
    requestOpenCode: async (_method, _route, body) => {
      sent = body;
      return { status: 200, data: { parts: [{ type: 'text', text: '{"items":[],"clarificationQuestion":null}' }] } };
    },
  });
  assert.deepEqual(sent.tools, {});
  assert.deepEqual(JSON.parse(sent.parts[0].text).candidatosOpenFoodFacts, [
    { name: 'Yogur Griego Natural', sourceName: 'Open Food Facts (dato colaborativo)' },
  ]);
});

test('food Open Food Facts extraction pass disables web tools and marks the pass', async () => {
  let sent;
  await requestFoodDescription({
    sessionId: 'ses_private_food', description: 'Yogur Griego Natural', allowWebSearch: false, openFoodFactsFirstPass: true,
    requestOpenCode: async (_method, _route, body) => {
      sent = body;
      return { status: 200, data: { parts: [{ type: 'text', text: '{"items":[],"clarificationQuestion":null}' }] } };
    },
  });
  assert.deepEqual(sent.tools, {});
  assert.equal(JSON.parse(sent.parts[0].text).openFoodFactsFirstPass, true);
});

test.skip('retired clarification flow: same-description save reprocesses an item-validation clarification', async () => {
  const description = '100g frijoles negros cocidos';
  const oldQuestion = 'No pude confirmar que “black beans” corresponda a lo escrito. Aclara su nombre en la misma descripción.';
  const history = [{ role: 'user', content: description }, { role: 'assistant', content: oldQuestion }];
  let state = 'requiere_aclaracion';
  let clarificationReachedModel = true;
  let responseBody;
  const textSql = (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`;
  await saveFoodEntry({
    data: { requestId: '123e4567-e89b-42d3-a456-426614174000', fecha: '2026-10-13', descripcion: description },
    userId: '27', response: {}, textSql,
    json: (_, __, body) => { responseBody = body; },
    dbQuery: async (sql) => {
      if (sql.startsWith('INSERT INTO registros_comidas(')) return '61';
      if (sql.includes("SELECT JSON_OBJECT('id',id,'fecha'")) return JSON.stringify({ id: 61, fecha: '2026-10-13', descripcion: description, estado: state, pregunta: oldQuestion });
      if (sql.includes('FROM registros_comida_interacciones')) return JSON.stringify(history);
      if (sql.includes("UPDATE registros_comidas SET estado='pendiente',pregunta_pendiente=NULL")) { state = 'pendiente'; return ''; }
      if (sql.includes('SELECT session_id FROM sesiones_comidas_opencode')) return 'ses_legacy_food';
      if (sql.includes('SELECT JSON_OBJECT(\'id\',f.id')) return JSON.stringify({ id: 5, fdcId: 111, sourceName: 'Beans, black, cooked', energyKcal: 132, energyMethod: 'usda', proteinG: 8.9, carbohydrateG: 23.7, fatG: 0.5, fiberG: 8.7 });
      return '';
    },
    requestOpenCode: async (method, route, body) => {
      if (method === 'GET') return { status: 200, data: { id: 'ses_legacy_food', metadata: await foodSessionMetadata() } };
      if (method === 'PATCH') return { status: 200, data: true };
      const payload = JSON.parse(body.parts[0].text);
      clarificationReachedModel = JSON.stringify(payload).includes(oldQuestion);
      return { status: 200, data: { parts: [{ type: 'text', text: JSON.stringify({
        items: [{ sourceText: description, name: 'frijoles negros cocidos', quantityGrams: 100, quantityText: '100g', preparation: 'cocidos', macroBasis: 'unknown', macros: null }],
        clarificationQuestion: null,
      }) }] } };
    },
    usdaKey: 'test-only', fetchImpl: async () => { throw new Error('cache hit should skip USDA'); },
  });
  assert.equal(clarificationReachedModel, false);
  assert.equal(responseBody.state, 'completado');
  assert.ok(responseBody.traceId);
  assert.ok(responseBody.trace.some((event) => event.event === 'stored_clarification_reprocessed'));
  assert.ok(responseBody.trace.some((event) => event.event === 'message_sent' && event.stage === 'separar_alimentos'));
  assert.ok(responseBody.trace.some((event) => event.event === 'message_received' && event.messageId === null));
  assert.doesNotMatch(JSON.stringify(responseBody.trace), /frijoles negros/);
});

test('OpenCode structured-output parts are returned without interpretation', async () => {
  const expected = { items: [], clarificationQuestion: 'Aclara la cantidad.' };
  const result = await requestFoodDescription({
    sessionId: 'ses_private_food', description: 'Avena',
    requestOpenCode: async () => ({ status: 200, data: { parts: [{ type: 'tool', state: {
      status: 'completed', title: 'Structured Output', metadata: { valid: true }, input: expected,
    } }] } }),
  });
  assert.deepEqual(result, [{ type: 'tool', state: {
    status: 'completed', title: 'Structured Output', metadata: { valid: true }, input: expected,
  } }]);
});

test('OpenCode failure trace reports a safe transport code without request text', async () => {
  const trace = { id: 'trace-test', events: [] };
  await assert.rejects(requestFoodDescription({
    sessionId: 'ses_private_food', description: 'dato privado de prueba', trace,
    requestOpenCode: async () => { throw Object.assign(new Error('dato privado de prueba'), { code: 'ECONNREFUSED' }); },
  }));
  const failure = trace.events.find((event) => event.event === 'message_failed');
  assert.equal(failure.errorCode, 'ECONNREFUSED');
  assert.doesNotMatch(JSON.stringify(trace), /dato privado de prueba/);
});

test('OpenCode HTTP waits for delayed headers without Undici headers timeout', async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/global/health') { response.writeHead(200).end('{"healthy":true}'); return; }
    const delay = request.url === '/slow' ? 80 : 200;
    setTimeout(() => response.writeHead(200).end('{"ok":true}'), delay);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const envKeys = ['OPENCODE_SERVICE_FILE', 'OPENCODE_SERVICE_PROXY_URL', 'OPENCODE_BASE_URL', 'OPENCODE_PORT', 'OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_AUTO_START'];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = global.fetch;
  delete process.env.OPENCODE_SERVICE_FILE;
  process.env.OPENCODE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENCODE_SERVICE_PROXY_URL = process.env.OPENCODE_BASE_URL;
  process.env.OPENCODE_AUTO_START = 'false';
  delete process.env.OPENCODE_PASSWORD;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  global.fetch = async (input, options) => new URL(input).pathname === '/global/health'
    ? originalFetch(input, options)
    : Promise.reject(Object.assign(new Error('simulated header timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }));
  try {
    const delayed = await openCodeRequest('GET', '/slow', undefined, 1000);
    assert.equal(delayed.status, 200);
    await assert.rejects(openCodeRequest('GET', '/slow', undefined, 20), (error) => ['TIMEOUT', 'ABORT_ERR'].includes(error.code));
  } finally {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test('OpenCode message submission, wait, and history share one timeout budget', async (t) => {
  let waitRequests = 0;
  let historyRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/global/health') { response.writeHead(200).end('{"healthy":true}'); return; }
    if (request.url.endsWith('/prompt')) { setTimeout(() => response.writeHead(200).end('{"id":"user-message"}'), 50); return; }
    if (request.url.endsWith('/wait')) { waitRequests += 1; setTimeout(() => response.writeHead(200).end('{"ok":true}'), 600); return; }
    if (request.url.includes('/message?')) { historyRequests += 1; response.writeHead(200).end('{"data":[]}'); return; }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const envKeys = ['OPENCODE_SERVICE_FILE', 'OPENCODE_SERVICE_PROXY_URL', 'OPENCODE_BASE_URL', 'OPENCODE_PORT', 'OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_AUTO_START'];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  delete process.env.OPENCODE_SERVICE_FILE;
  process.env.OPENCODE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.OPENCODE_SERVICE_PROXY_URL = process.env.OPENCODE_BASE_URL;
  process.env.OPENCODE_AUTO_START = 'false';
  delete process.env.OPENCODE_PASSWORD;
  delete process.env.OPENCODE_SERVER_PASSWORD;
  try {
    await assert.rejects(openCodeRequest('POST', '/session/ses_deadline/message', { parts: [] }, 500));
    assert.equal(waitRequests, 1);
    assert.equal(historyRequests, 0);
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test.skip('retired macro-resolution flow: ambiguous USDA candidates go directly to webfetch without another selection turn', async () => {
  let usdaCalls = 0;
  let webCalls = 0;
  const result = await resolveFoodMacros({
    items: [{ sourceText: 'Pollo 100 g', name: 'Pollo', quantityText: '100 g', quantityGrams: 100, preparation: '', macros: null }],
    sessionId: 'ses_private_food', textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`,
    dbQuery: async () => '',
    requestOpenCode: async (method, route, body) => {
      webCalls += 1;
      assert.deepEqual(body.tools, { webfetch: true });
      return { status: 200, data: { parts: [structuredOutputPart({ found: false, sourceUrl: null, sourceName: null, sourceQuote: null, macros: null, clarificationQuestion: 'Aclara el corte del pollo.' })] } };
    },
    apiKey: 'test-only',
    fetchImpl: async (url) => {
      usdaCalls += 1;
      assert.match(new URL(url).pathname, /foods\/search$/);
      return { ok: true, json: async () => ({ foods: [{ fdcId: 100, description: 'Chicken breast' }, { fdcId: 101, description: 'Chicken thigh' }] }) };
    },
  });
  assert.match(result.question, /Aclara el corte/);
  assert.equal(usdaCalls, 1);
  assert.equal(webCalls, 1);
});

test('OpenCode food sessions are private per authenticated user and reused on reopen', async () => {
  const sessions = new Map();
  const openCodeSessions = new Map();
  let created = 0;
  const dbQuery = async (sql) => {
    const lookup = sql.match(/SELECT session_id FROM sesiones_comidas_opencode WHERE usuario_id=(\d+)/);
    if (lookup) return sessions.get(lookup[1]) || '';
    const insert = sql.match(/INSERT INTO sesiones_comidas_opencode[^]*?VALUES \((\d+),CONVERT\(0x([a-f\d]+) USING utf8mb4\)\)/i);
    if (insert) { sessions.set(insert[1], Buffer.from(insert[2], 'hex').toString()); return ''; }
    return '';
  };
  const requestOpenCode = async (method, route, body) => {
    const id = route.split('/').at(-1);
    if (method === 'GET') return { status: 200, data: openCodeSessions.get(id) };
      if (method === 'PATCH') { assert.deepEqual(body.permission, [{ permission: '*', pattern: '*', action: 'deny' }, { permission: 'webfetch', pattern: '*', action: 'allow' }, { permission: 'websearch', pattern: '*', action: 'allow' }]); return { status: 200, data: true }; }
    if (method === 'DELETE') { openCodeSessions.delete(id); return { status: 200, data: true }; }
    created += 1;
    assert.equal(body.title, 'Registro de comidas');
    assert.deepEqual(body.permission, [{ permission: '*', pattern: '*', action: 'deny' }, { permission: 'webfetch', pattern: '*', action: 'allow' }, { permission: 'websearch', pattern: '*', action: 'allow' }]);
    const sessionId = `ses_private${created}`;
    openCodeSessions.set(sessionId, { id: sessionId, metadata: body.metadata });
    return { status: 201, data: { id: sessionId } };
  };
  assert.equal(await ensureFoodOpenCodeSession({ userId: '27', dbQuery, textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`, requestOpenCode }), 'ses_private1');
  assert.equal(await ensureFoodOpenCodeSession({ userId: '27', dbQuery, textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`, requestOpenCode }), 'ses_private1');
  assert.equal(await ensureFoodOpenCodeSession({ userId: '44', dbQuery, textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`, requestOpenCode }), 'ses_private2');
  assert.deepEqual([...sessions.entries()], [['27', 'ses_private1'], ['44', 'ses_private2']]);
  assert.equal(created, 2);
});

test('a food session verified within 30 seconds is reused without querying OpenCode again', async () => {
  const methods = [];
  const requestOpenCode = async (method, route, body) => {
    methods.push(method);
    if (method === 'POST') return { status: 201, data: { id: 'ses_recheck1' } };
    return { status: 200, data: { id: 'ses_recheck1', metadata: body?.metadata } };
  };
  const textSql = (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)`;
  assert.equal(await ensureFoodOpenCodeSession({ userId: '61', dbQuery: async () => '', textSql, requestOpenCode }), 'ses_recheck1');
  const afterCreate = methods.length;
  assert.equal(await ensureFoodOpenCodeSession({ userId: '61', dbQuery: async () => '', textSql, requestOpenCode }), 'ses_recheck1');
  assert.equal(methods.length, afterCreate);
});

test('an existing session is recreated when injected session defaults change', async () => {
  const config = (modelID, variant) => ({ model: { providerID: 'ollama', modelID }, agent: 'food-parser', variant, requestTimeoutMs: 600000, usdaTimeoutMs: 7000, maxFoodItems: 8, usdaCandidateLimit: 5 });
  let activeConfig = config('qwen3:8b', 'low');
  const readConfig = async () => activeConfig;
  const sessions = new Map();
  let storedSession = '';
  let created = 0;
  const dbQuery = async (sql) => {
    if (sql.includes('SELECT session_id FROM sesiones_comidas_opencode')) return storedSession;
    const insert = sql.match(/INSERT INTO sesiones_comidas_opencode[^]*?VALUES \((\d+),CONVERT\(0x([a-f\d]+) USING utf8mb4\)\)/i);
    if (insert) { storedSession = Buffer.from(insert[2], 'hex').toString(); return ''; }
    return '';
  };
  const requestOpenCode = async (method, route, body) => {
    if (method === 'POST') {
      const id = `ses_config${++created}`;
      sessions.set(id, { id, agent: body.agent, model: body.model, metadata: body.metadata, permission: body.permission });
      return { status: 201, data: { id } };
    }
    const id = route.split('/').at(-1);
    if (method === 'GET') return { status: 200, data: sessions.get(id) };
    if (method === 'PATCH') { sessions.get(id).permission = body.permission; return { status: 200, data: true }; }
    if (method === 'DELETE') { sessions.delete(id); return { status: 200, data: true }; }
    throw new Error(`unexpected ${method}`);
  };
  const options = { userId: '27', dbQuery, requestOpenCode, readConfig, textSql: (value) => `CONVERT(0x${Buffer.from(value).toString('hex')} USING utf8mb4)` };
  const first = await ensureFoodOpenCodeSession(options);
  assert.equal(await ensureFoodOpenCodeSession(options), first);
  assert.equal(created, 1);
  activeConfig = config('qwen3:14b', 'high');
  const changed = await ensureFoodOpenCodeSession(options);
  assert.notEqual(changed, first);
  assert.equal(created, 2);
  assert.deepEqual(sessions.get(changed).model, { id: 'qwen3:14b', providerID: 'ollama', variant: 'high' });
});

test('food sessions use OpenCode global model defaults instead of Nutri overrides', async () => {
  const defaults = getFoodSessionDefaults();
  assert.equal(defaults.model, null);
  assert.equal(defaults.agent, null);
  assert.equal(defaults.variant, null);
  assert.equal(defaults.requestTimeoutMs, 600000);
  assert.equal(defaults.maxFoodItems, 12);
  const sent = [];
  await requestFoodDescription({
    sessionId: 'ses_global_default', description: 'Avena', config: defaults,
    requestOpenCode: async (method, route, body, timeout) => {
      sent.push({ method, route, body, timeout });
      return { status: 200, data: { parts: [{ type: 'text', text: '{"items":[],"clarificationQuestion":"Aclara la cantidad."}' }] } };
    },
  });
  assert.equal(sent[0].body.model, undefined);
  assert.equal(sent[0].body.agent, undefined);
  assert.equal(sent[0].timeout, 600000);
});

test('opening food chat does not create OpenCode sessions before the first message', async () => {
  const sessions = new Map();
  const openCodeSessions = new Map();
  const requests = [];
  let created = 0;
  await withServer(async (sql) => {
    const authenticated = sql.match(/SELECT s\.usuario_id[\s\S]*?s\.usuario_id=(\d+)/);
    if (authenticated) return authenticated[1];
    const lookup = sql.match(/SELECT session_id FROM sesiones_comidas_opencode WHERE usuario_id=(\d+)/);
    if (lookup) return sessions.get(lookup[1]) || '';
    const insert = sql.match(/INSERT INTO sesiones_comidas_opencode[^]*?VALUES \((\d+),CONVERT\(0x([a-f\d]+) USING utf8mb4\)\)/i);
    if (insert) { sessions.set(insert[1], Buffer.from(insert[2], 'hex').toString()); return ''; }
    return '';
  }, async (base) => {
    const token = (id) => `nutri_session=${signJwt(String(id), `123e4567-e89b-42d3-a456-${String(id).padStart(12, '0')}`, 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const open = async (userId) => post(base + '/api/food/session', { userId: 999 }, { Cookie: token(userId) });
    const first = await open(27);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { ok: true });
    assert.equal((await open(27)).status, 200);
    assert.equal((await open(44)).status, 200);
    assert.deepEqual([...sessions.keys()], []);
    assert.equal(created, 0);
  }, { openCodeRequest: async (method, route, body) => {
    requests.push({ method, route, body });
    const id = route.split('/').at(-1);
    if (method === 'GET') return { status: 200, data: openCodeSessions.get(id) };
    if (method === 'PATCH') return { status: 200, data: true };
    if (method === 'DELETE') { openCodeSessions.delete(id); return { status: 200, data: true }; }
    created += 1;
    const sessionId = `ses_private${created}`;
    openCodeSessions.set(sessionId, { id: sessionId, metadata: body.metadata });
    return { status: 201, data: { id: sessionId } };
  } });
  assert.ok(requests.filter((request) => ['POST', 'PATCH'].includes(request.method)).every(({ body }) => ['webfetch', 'websearch'].every((permission) => body.permission.some((rule) => rule.permission === permission && rule.action === 'allow'))));
});

test('food description remains saved when OpenCode is unavailable', async () => {
  const queries = [];
  await withServer(async (sql) => {
    queries.push(sql);
    if (sql.includes('SELECT s.usuario_id')) return '27';
    if (sql.includes('SELECT session_id FROM sesiones_comidas_opencode')) return '';
    if (sql.includes('INSERT INTO sesiones_comidas_opencode')) return '';
    if (sql.includes('INSERT INTO registros_comidas(')) return '61';
    return '';
  }, async (base) => {
    const cookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const response = await post(base + '/api/food-entries', {
      requestId: '123e4567-e89b-42d3-a456-426614174000', fecha: '2026-10-13', descripcion: 'Pollo 150 g',
    }, { Cookie: cookie });
    assert.equal(response.status, 502);
    assert.match((await response.json()).message, /quedó guardado/);
    assert.ok(queries.some((sql) => sql.includes('INSERT INTO registros_comidas')));
  }, { openCodeRequest: async () => { throw new Error('OpenCode unavailable'); } });
});

test.skip('retired clarification flow: editing the same food description resolves ambiguity while preserving its original text', async () => {
  const queries = [];
  const original = 'Pollo';
  const corrected = 'Pollo cocido 150 g: 248 kcal, proteína 46 g, carbohidratos 0 g, grasa 5.4 g';
  const parsed = { items: [{ sourceText: corrected, name: 'Pollo cocido', quantityText: '150 g', preparation: 'cocido', macroBasis: 'per_portion', macros: { energyKcal: 248, proteinG: 46, carbohydrateG: 0, fatG: 5.4, fiberG: null } }], clarificationQuestion: null };
  let estado = 'requiere_aclaracion';
  let history = [{ role: 'assistant', content: '¿Cuántos gramos de pollo consumiste?' }];
  let itemInsert = '';
  let modelPayload;
  await withServer(async (sql) => {
    queries.push(sql);
    if (sql.includes('SELECT s.usuario_id')) return '27';
    if (sql.includes('INSERT INTO registros_comidas(')) return '61';
    if (sql.includes('FROM registros_comidas WHERE id=61 AND usuario_id=27')) return JSON.stringify({ id: 61, fecha: '2026-10-13', descripcion: original, estado, pregunta: history.at(-1).content });
    if (sql.includes('SELECT session_id FROM sesiones_comidas_opencode')) return 'ses_private_food';
    if (sql.includes('FROM registros_comida_interacciones')) return JSON.stringify(history);
    if (sql.includes("UPDATE registros_comidas SET estado='pendiente'")) { estado = 'pendiente'; return ''; }
    if (sql.includes("INSERT INTO registros_comida_interacciones(registro_comida_id,role,contenido) VALUES (61,'user'")) {
      history.push({ role: 'user', content: corrected });
      if (sql.includes("UPDATE registros_comidas SET estado='pendiente'")) estado = 'pendiente';
      return '';
    }
    if (sql.includes('INSERT INTO registros_comida_items')) itemInsert = sql;
    return '';
  }, async (base) => {
    const cookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const response = await post(base + '/api/food-entries', { requestId: '123e4567-e89b-42d3-a456-426614174000', fecha: '2026-10-13', descripcion: corrected }, { Cookie: cookie });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, 'completado');
  }, { openCodeRequest: async (method, route, body) => {
    if (method === 'GET') return { status: 200, data: { id: 'ses_private_food', metadata: await foodSessionMetadata() } };
    if (method === 'PATCH') return { status: 200, data: true };
    if (route.endsWith('/message')) modelPayload = JSON.parse(body.parts[0].text);
    return { status: 200, data: { parts: [{ type: 'text', text: JSON.stringify(parsed) }] } };
  }, usdaFetch: async () => { throw new Error('USDA must not be queried for declared macros'); } });
  assert.deepEqual(modelPayload, { description: corrected });
  assert.ok(itemInsert.includes(Buffer.from(corrected).toString('hex')));
  assert.equal(queries.filter((sql) => sql.includes('INSERT INTO registros_comidas(')).length, 1);
  assert.equal(queries.some((sql) => /UPDATE registros_comidas SET descripcion_original/.test(sql)), false);
});

test('registration stores email and waits for one-time verification', async () => {
  let registrationSql = '';
  let sent;
  await withServer(async (sql) => { registrationSql = sql; return '27'; }, async (base) => {
    const response = await post(base + '/api/auth/register', { ...demo, phone: '' });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).pendingVerification, true);
    assert.equal(response.headers.get('set-cookie'), null);
  }, { sendVerificationEmail: async (...args) => { sent = args; } });
  assert.match(registrationSql, /correo_electronico/);
  assert.ok(registrationSql.includes(Buffer.from('user@example.com').toString('hex')));
  assert.match(registrationSql, /celular_e164,[^;]*NULL/);
  assert.match(registrationSql, /tokens_cuenta_email/);
  assert.doesNotMatch(registrationSql, /INSERT INTO dashboard_sessions/);
  assert.doesNotMatch(registrationSql, /Demo-Prueba-2026!/);
  assert.equal(sent?.[0], 'user@example.com');
  assert.match(sent?.[1] || '', /^[A-Za-z0-9_-]{43}$/);
});

test('email verification consumes the one-time token and marks the account verified', async () => {
  let verificationSql = '';
  await withServer(async (sql) => { verificationSql = sql; return '1\tuser@example.com'; }, async (base) => {
    const response = await post(base + '/api/auth/verify-email', { token: 'A'.repeat(43) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, email: 'user@example.com' });
  });
  assert.match(verificationSql, /UPDATE tokens_cuenta_email/);
  assert.match(verificationSql, /correo_verificado_en/);
  assert.match(verificationSql, /consumido_en IS NULL/);
  assert.match(verificationSql, /correo_electronico/);
});

test('resending verification uses a fresh token and does not reveal whether an account exists', async () => {
  let resendSql = '';
  let sent;
  await withServer(async (sql) => { resendSql += sql; return sql.includes('SELECT id,correo_verificado_en') ? '27\t0' : ''; }, async (base) => {
    const response = await post(base + '/api/auth/resend-verification', { email: 'user@example.com' });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, message: 'Si la cuenta necesita verificación, enviaremos un enlace al correo registrado.' });
  }, { sendVerificationEmail: async (...args) => { sent = args; } });
  assert.match(resendSql, /INSERT INTO tokens_cuenta_email/);
  assert.equal(sent?.[0], 'user@example.com');
  assert.match(sent?.[1] || '', /^[A-Za-z0-9_-]{43}$/);
});

test('password recovery sends a one-hour token for active accounts and hides account existence', async () => {
  let recoverySql = '';
  let sent;
  await withServer(async (sql) => { recoverySql += sql; return sql.includes('SELECT id FROM usuarios WHERE correo_electronico') ? '27' : ''; }, async (base) => {
    const response = await post(base + '/api/auth/request-password-reset', { email: 'USER@EXAMPLE.COM' });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true, message: 'Si existe una cuenta con ese correo, enviaremos instrucciones para restablecer la contraseña.' });
  }, { sendPasswordRecoveryEmail: async (...args) => { sent = args; } });
  assert.match(recoverySql, /WHERE correo_electronico=.* AND activo=1/);
  assert.match(recoverySql, /proposito='recuperacion'/);
  assert.match(recoverySql, /INTERVAL 1 HOUR/);
  assert.equal(sent?.[0], 'user@example.com');
  assert.match(sent?.[1] || '', /^[A-Za-z0-9_-]{43}$/);
});

test('password reset consumes its token, updates the password hash, and revokes active sessions', async () => {
  let resetSql = '';
  await withServer(async (sql) => { resetSql += sql; return '1'; }, async (base) => {
    const response = await post(base + '/api/auth/reset-password', { token: 'A'.repeat(43), password: 'new-safe-password-123' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
  });
  assert.match(resetSql, /proposito='recuperacion'/);
  assert.match(resetSql, /t\.consumido_en IS NULL/);
  assert.match(resetSql, /t\.vence_en>UTC_TIMESTAMP\(3\)/);
  assert.match(resetSql, /password_salt=UNHEX/);
  assert.match(resetSql, /password_hash=UNHEX/);
  assert.match(resetSql, /correo_verificado_en=COALESCE/);
  assert.match(resetSql, /SET @password_reset_changed=\(ROW_COUNT\(\)>0\)/);
  assert.match(resetSql, /UPDATE dashboard_sessions/);
  assert.doesNotMatch(resetSql, /new-safe-password-123/);
});

test('biometric validation requires weight and keeps optional BIA fields source-bound', () => {
  const manual = validateBiometric({ source: 'manual', weightKg: '70.5' });
  assert.equal(manual.weight, '70.5');
  assert.equal(manual.bodyAge, null);
  assert.throws(() => validateBiometric({ source: 'manual', weightKg: '70', bmi: '22' }));
  assert.throws(() => validateBiometric({ source: 'bia', weightKg: '10' }));
  assert.equal(validateBiometric({ source: 'bia', weightKg: '70', bodyAge: '30' }).bodyAge, '30');
});

test('login accepts the stored password and logout revokes the session', async () => {
  const salt = randomBytes(16);
  const hash = scryptSync(demo.password, salt, 64);
  const queries = [];
  let sessionActive = true;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await withServer(async (sql) => {
      queries.push(sql);
      if (sql.includes('INSERT INTO auth_login_rate_limits')) return '1\t900';
      if (sql.includes('UPDATE auth_login_rate_limits')) return '';
      if (sql.includes('FROM usuarios WHERE correo_electronico')) return `27\t${salt.toString('hex')}\t${hash.toString('hex')}\t1\t1`;
      if (sql.includes('SELECT s.usuario_id')) return sessionActive ? '27' : '';
      if (sql.includes('UPDATE dashboard_sessions')) sessionActive = false;
      return '';
    }, async (base) => {
      const login = await post(base + '/api/auth/login', {
        email: 'USER@EXAMPLE.COM', password: demo.password,
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie');
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      assert.match(cookie, /Secure/);
      assert.match(cookie, /Max-Age=604800/);
      assert.match(queries.find((sql) => sql.includes('INSERT INTO dashboard_sessions')) || '', /INTERVAL 604800 SECOND/);
      const logout = await post(base + '/api/auth/logout', {}, { Cookie: cookie });
      assert.equal(logout.status, 200);
      assert.match(queries.join('\n'), /UPDATE dashboard_sessions/);
      const protectedPage = await fetch(base + '/dashboard_nutricional.html', { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(protectedPage.status, 302);
      assert.equal(protectedPage.headers.get('location'), '/login.html');
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('expired JWT sessions are rejected before consulting the database', async () => {
  let queries = 0;
  const secret = 'test-jwt-secret-must-be-at-least-32-bytes';
  const expiredCookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', secret, 0)}`;
  await withServer(async () => { queries += 1; return '27'; }, async (base) => {
    const response = await fetch(base + '/api/dashboard/profile', { headers: { Cookie: expiredCookie } });
    assert.equal(response.status, 401);
    assert.equal(queries, 0);
  }, { now: () => 8 * 24 * 60 * 60 });
});

test('login rejects unverified email addresses without disclosing verification state', async () => {
  const queries = [];
  await withServer(async (sql) => { queries.push(sql); return sql.includes('INSERT INTO auth_login_rate_limits') ? '1\t900' : ''; }, async (base) => {
    const response = await post(base + '/api/auth/login', { email: 'UNVERIFIED@example.com', password: 'wrong-password-123' });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Correo o contraseña incorrectos.' });
  });
  const lookup = queries.find((sql) => sql.includes('FROM usuarios WHERE correo_electronico')) || '';
  assert.match(lookup, /correo_verificado_en IS NOT NULL/);
  assert.ok(lookup.includes(Buffer.from('unverified@example.com').toString('hex')));
});

test('login persists failed credential buckets and logs no credential data', async () => {
  const queries = [];
  const email = 'failed@example.com';
  await withServer(async (sql) => {
    queries.push(sql);
    if (sql.includes('INSERT INTO auth_login_rate_limits')) return '1\t900';
    if (sql.includes('SELECT id,HEX(password_salt)')) return '';
    return '';
  }, async (base) => {
    const response = await post(base + '/api/auth/login', { email, password: 'wrong-password-123' });
    assert.equal(response.status, 401);
    const audit = queries.find((sql) => sql.includes('INSERT INTO errores_aplicacion')) || '';
    assert.ok(audit.includes(Buffer.from('AUTH_INVALID_CREDENTIALS').toString('hex')));
    assert.doesNotMatch(audit, /wrong-password-123|failed@example.com/);
    assert.ok(queries.some((sql) => sql.includes('auth_login_rate_limits') && sql.includes('UNHEX(')));
  });
});

test('login rate limiter rejects an exhausted shared IP bucket', async () => {
  let accountLookup = false;
  await withServer(async (sql) => {
    if (sql.includes('INSERT INTO auth_login_rate_limits')) return '11\t321';
    if (sql.includes('FROM usuarios WHERE correo_electronico')) accountLookup = true;
    return '';
  }, async (base) => {
    const response = await post(base + '/api/auth/login', { email: 'failed@example.com', password: 'wrong-password-123' });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '321');
    assert.equal(accountLookup, false);
  });
});

test('rejecting terms revokes the active session', async () => {
  let sessionActive = true;
  let rejected = false;
  await withServer(async (sql) => {
    if (sql.includes('SELECT s.usuario_id')) return sessionActive ? '27' : '';
    if (sql.includes('INSERT INTO dashboard_terms_decisions')) rejected = true;
    if (sql.includes('UPDATE dashboard_sessions')) sessionActive = false;
    return sql.includes('LAST_INSERT_ID()') ? '27' : '';
  }, async (base) => {
    const cookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const response = await post(base + '/api/terms/decision', { decision: 'rejected' }, { Cookie: cookie });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal(rejected, true);
    const dashboard = await fetch(base + '/dashboard_nutricional.html', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(dashboard.status, 302);
    assert.equal(dashboard.headers.get('location'), '/login.html');
  });
});

test('account deletion requires the current password and sends a cascade delete', async () => {
  const salt = randomBytes(16);
  const hash = scryptSync(demo.password, salt, 64);
  const queries = [];
  await withServer(async (sql) => {
    queries.push(sql);
    if (sql.includes('SELECT s.usuario_id')) return '27';
    if (sql.includes('DELETE FROM usuarios WHERE id=27')) return '1';
    if (sql.includes('FROM usuarios WHERE id=27')) return `${salt.toString('hex')}\t${hash.toString('hex')}\t1`;
    return sql.includes('LAST_INSERT_ID()') ? '27' : '';
  }, async (base) => {
    const cookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const wrongPassword = await post(base + '/api/auth/delete', { password: 'Wrong-Password-123!' }, { Cookie: cookie });
    assert.equal(wrongPassword.status, 401);
    assert.equal(queries.some((sql) => sql.includes('DELETE FROM usuarios')), false);
    const deletion = await post(base + '/api/auth/delete', { password: demo.password, userId: 9999 }, { Cookie: cookie });
    assert.equal(deletion.status, 200);
    assert.match(deletion.headers.get('set-cookie'), /Max-Age=0/);
    assert.ok(queries.some((sql) => sql.includes('DELETE FROM usuarios WHERE id=27')));
    assert.ok(queries.every((sql) => !sql.includes('9999')));
  });
});

test('registration rejects invalid origins and invalid fields before database access', async () => {
  let calls = 0;
  await withServer(async () => { calls += 1; return ''; }, async (base) => {
    const wrongOrigin = await post(base + '/api/auth/register', demo, { Origin: 'https://attacker.invalid' });
    assert.equal(wrongOrigin.status, 403);
    const invalid = await post(base + '/api/auth/register', { ...demo, age: 12 });
    assert.equal(invalid.status, 400);
    const missingEmail = await post(base + '/api/auth/register', { ...demo, email: '' });
    assert.equal(missingEmail.status, 400);
    const missingHeight = await post(base + '/api/auth/register', { ...demo, heightCm: '' });
    assert.equal(missingHeight.status, 400);
    const unsupportedSex = await post(base + '/api/auth/register', { ...demo, sex: 'otro' });
    assert.equal(unsupportedSex.status, 400);
    assert.equal(calls, 0);
  });
});

test('authenticated user can generate and save a training plan through the API', async () => {
  const queries = [];
  const requests = [];
  const disclosure = 'Las metas de calorías y carbohidratos se ajustan según los entrenamientos registrados para el día seleccionado.';
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  const plan = `[Datos Registrados]\nEdad: 32 años; sexo masculino; estatura 175 cm.\n[Estimaciones Calculadas]\nMacros estimados.\n| Macro | Meta diaria |\n| --- | --- |\n| Proteínas | 140 g |\n| Carbohidratos | 220 g |\n| Grasas | 65 g |\n| Calorías | 2000 kcal |\n${disclosure}\n[Supuestos Adoptados]\nDisponibilidad asumida.`;
  let saveRequest;
  await withServer(async (sql) => {
    queries.push(sql);
    if (sql.includes('SELECT s.usuario_id')) return '27';
    if (sql.includes("SELECT 'profile';")) return ['profile', JSON.stringify({ sex: 'masculino', heightCm: 175, restingMetabolismKcal: null }), 'preferences', 'biometrics', '[]', 'plicometrics', '[]', 'age', JSON.stringify({ age: 32 }), 'previousPlan'].join('\n');
    if (sql.includes("SELECT JSON_OBJECT('accountName'")) return JSON.stringify({ sex: 'masculino', heightCm: 175, restingMetabolismKcal: null });
    if (sql.includes("SELECT JSON_OBJECT('age',edad)")) return JSON.stringify({ age: 32 });
    if (sql.includes("SELECT JSON_OBJECT('age',(SELECT edad")) return JSON.stringify({
      age: 32, hasWeight: false,
      bodyFacts: { bmi: false, bodyFatPct: false, musclePct: false, visceralFat: false, bodyAge: false, restingMetabolismKcal: false },
      plicometryFacts: { tricepsMm: false, bicepsMm: false, subescapularMm: false, suprailiacoMm: false, abdominalMm: false, musloAnteriorMm: false, pantorrillaMm: false },
    });
    if (sql.includes('JSON_ARRAYAGG')) return '[]';
    if (sql.includes('INSERT INTO planes_entrenamiento')) return JSON.stringify({ id: 5, requestId: saveRequest.runId, createdAt: '2026-10-22T17:00:00Z', goals: saveRequest.goals, plan: saveRequest.plan, macros: saveRequest.macros, inserted: true });
    if (sql.includes('FROM planes_entrenamiento')) return '';
    return '';
  }, async (base) => {
    const cookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const generatedResponse = await post(base + '/api/training-plan', { goals: 'Ganar fuerza', suppressNotification: true }, { Cookie: cookie });
    assert.equal(generatedResponse.status, 200);
    const generated = await generatedResponse.json();
    assert.equal(generated.plan, plan);
    assert.deepEqual(generated.macros, macros);
    assert.match(generated.runId, /^[0-9a-f-]{36}$/i);

    saveRequest = { runId: generated.runId, goals: 'Ganar fuerza', plan: generated.plan, macros: generated.macros, suppressNotification: true };
    const savedResponse = await post(base + '/api/training-plans', saveRequest, { Cookie: cookie });
    assert.equal(savedResponse.status, 201);
    const saved = await savedResponse.json();
    assert.equal(saved.id, 5);
    assert.equal(saved.requestId, generated.runId);
    assert.equal(saved.inserted, true);
    assert.ok(queries.some((sql) => sql.includes('INSERT INTO planes_entrenamiento') && sql.includes('usuario_id=27')));
    assert.deepEqual(requests, [
      { method: 'POST', endpoint: '/session' },
      { method: 'POST', endpoint: '/session/ses_plan123/message' },
      { method: 'DELETE', endpoint: '/session/ses_plan123' },
    ]);
  }, {
    openCodeRequest: async (method, endpoint, body) => {
      requests.push({ method, endpoint });
      if (method === 'POST' && endpoint === '/session') {
        assert.equal(body.metadata.trainingPlanUserId, '27');
        assert.equal(body.permission[0].action, 'deny');
        return { status: 201, data: { id: 'ses_plan123' } };
      }
      if (method === 'POST') {
        assert.deepEqual(JSON.parse(body.parts[0].text), { goals: 'Ganar fuerza', context: {
          profile: { age: 32, sex: 'masculino', heightCm: 175, restingMetabolismKcal: null, restingMetabolismSource: null },
          preferences: null, biometricRecords: [], plicometricRecords: [], previousTrainingPlanSummary: null,
        } });
        return { status: 200, data: { parts: [{ type: 'text', text: JSON.stringify({ macros_objetivo: macros, plan_markdown: plan }) }] } };
      }
      return { status: 204, data: null };
    },
  });
});

test('training plan save logs a sanitized MySQL error code', async () => {
  const statements = [];
  const opencodeCalls = [];
  const disclosure = 'Las metas de calorías y carbohidratos se ajustan según los entrenamientos registrados para el día seleccionado.';
  const goals = 'Ganar fuerza';
  const plan = `[Datos Registrados]\nEdad: 32 años; sexo masculino; estatura 175 cm.\n[Estimaciones Calculadas]\nMacros estimados.\n| Macro | Meta diaria |\n| --- | --- |\n| Proteínas | 140 g |\n| Carbohidratos | 220 g |\n| Grasas | 65 g |\n| Calorías | 2000 kcal |\n${disclosure}\n[Supuestos Adoptados]\nDisponibilidad asumida.`;
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  await withServer(async (sql) => {
    statements.push(sql);
    if (sql.includes('SELECT s.usuario_id')) return '27';
    if (sql.includes("SELECT 'profile';")) return ['profile', JSON.stringify({ sex: 'masculino', heightCm: 175, restingMetabolismKcal: null }), 'preferences', 'biometrics', '[]', 'plicometrics', '[]', 'age', JSON.stringify({ age: 32 }), 'previousPlan'].join('\n');
    if (sql.includes("SELECT JSON_OBJECT('accountName'")) return JSON.stringify({ sex: 'masculino', heightCm: 175, restingMetabolismKcal: null });
    if (sql.includes("SELECT JSON_OBJECT('age',edad)")) return JSON.stringify({ age: 32 });
    if (sql.includes("SELECT JSON_OBJECT('age',(SELECT edad")) return JSON.stringify({
      age: 32, hasWeight: false,
      bodyFacts: { bmi: false, bodyFatPct: false, musclePct: false, visceralFat: false, bodyAge: false, restingMetabolismKcal: false },
      plicometryFacts: { tricepsMm: false, bicepsMm: false, subescapularMm: false, suprailiacoMm: false, abdominalMm: false, musloAnteriorMm: false, pantorrillaMm: false },
    });
    if (sql.includes('INSERT INTO planes_entrenamiento')) throw new Error('ERROR 1364 (HY000): private db detail');
    return '';
  }, async (base) => {
    const cookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const generatedResponse = await post(base + '/api/training-plan', { goals, suppressNotification: true }, { Cookie: cookie });
    assert.equal(generatedResponse.status, 200);
    const generated = await generatedResponse.json();
    assert.equal(generated.plan, plan);
    const saveResponse = await post(base + '/api/training-plans', {
      runId: generated.runId, goals, plan: generated.plan, macros: generated.macros, suppressNotification: true,
    }, { Cookie: cookie });
    assert.equal(saveResponse.status, 503);
    assert.deepEqual(opencodeCalls, ['POST /session', 'POST /session/ses_plan123/message']);
    assert.ok(statements.some((sql) => sql.includes(Buffer.from('MYSQL_1364_HY000').toString('hex'))));
    assert.ok(statements.every((sql) => !sql.includes('private db detail')));
  }, { openCodeRequest: async (method, endpoint) => {
    opencodeCalls.push(`${method} ${endpoint}`);
    if (endpoint === '/session') return { status: 200, data: { id: 'ses_plan123' } };
    if (endpoint === '/session/ses_plan123/message') return {
      status: 200, data: { parts: [{ type: 'text', text: JSON.stringify({ plan_markdown: plan, macros_objetivo: macros }) }] },
    };
    return { status: 200, data: {} };
  } });
});
