const assert = require('node:assert/strict');
const { createHash, randomBytes, scryptSync } = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const { createServer, signJwt } = require('./server.js');
const { validateBiometric } = require('./api/biometrics.js');
const { ensureFoodOpenCodeSession, openCodeRequest, requestFoodDescription, getFoodSessionDefaults } = require('./api/opencode-food.js');
const { saveFoodEntry } = require('./api/food-entries.js');
const { toMysqlTime } = require('./api/preferences.js');

const demo = {
  name: 'Usuario de prueba', countryIso: 'MX', phone: '0000000000',
  password: 'Demo-Prueba-2026!', age: 30, heightCm: '175', sex: 'masculino', isTestAccount: true,
};

async function withServer(dbQuery, run, options = {}) {
  const server = createServer({ ...options, dbQuery, jwtSecret: 'test-jwt-secret-must-be-at-least-32-bytes' });
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

test('dummy registration creates synthetic measurement rows without completing onboarding', async () => {
  let registrationSql = '';
  await withServer(async (sql) => { registrationSql = sql; return '27'; }, async (base) => {
    const response = await post(base + '/api/auth/register', demo);
    assert.equal(response.status, 201);
  });
  for (const table of ['registros_biometricos', 'registros_plicometro', 'registros_comidas', 'planes_entrenamiento']) {
    assert.match(registrationSql, new RegExp(`INSERT INTO ${table}`));
  }
  assert.doesNotMatch(registrationSql, /INSERT INTO (preferencias_usuario|perfil_salud_usuario)/);
  assert.ok(registrationSql.includes(Buffer.from('DATO SINTÉTICO DE PRUEBA: desayuno de ejemplo; alimentos y cantidades no son consumo real.').toString('hex')));
  assert.ok(registrationSql.includes(Buffer.from('DATO SINTÉTICO DE PRUEBA: plan de demostración; no es una recomendación personalizada.').toString('hex')));
  assert.doesNotMatch(registrationSql, /INSERT INTO (registros_comida_items|alimentos_referencia)/);
  assert.ok(registrationSql.includes(Buffer.from('Datos ficticios de demostración; reemplázalos por datos personales reales.').toString('hex')));
  assert.doesNotMatch(registrationSql, /dashboard_terms_decisions/);
});

test('regular registration does not seed fictitious related rows', async () => {
  let registrationSql = '';
  await withServer(async (sql) => { registrationSql = sql; return '27'; }, async (base) => {
    const response = await post(base + '/api/auth/register', { ...demo, isTestAccount: false });
    assert.equal(response.status, 201);
  });
  assert.doesNotMatch(registrationSql, /INSERT INTO (preferencias_usuario|perfil_salud_usuario|registros_biometricos|registros_plicometro|registros_comidas|planes_entrenamiento)/);
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

test('food save logs the raw OpenCode response without returning it to the page', async () => {
  const queries = [];
  let storedSession = '';
  const description = '100g frijoles negros cocidos';
  const rawReply = [{ type: 'text', text: '{"items":[{"name":"frijoles negros"}]}' }];
  await withServer(async (sql) => {
    queries.push(sql);
    if (sql.includes('SELECT s.usuario_id')) return '27';
    if (sql.includes('SELECT session_id FROM sesiones_comidas_opencode')) return storedSession;
    const sessionInsert = sql.match(/INSERT INTO sesiones_comidas_opencode[^]*?VALUES \(27,CONVERT\(0x([a-f\d]+) USING utf8mb4\)\)/i);
    if (sessionInsert) { storedSession = Buffer.from(sessionInsert[1], 'hex').toString(); return ''; }
    if (sql.includes('INSERT INTO registros_comidas(')) return '61';
    return '';
  }, async (base) => {
    const cookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const saved = await post(base + '/api/food-entries', {
      requestId: '123e4567-e89b-42d3-a456-426614174000', fecha: '2026-10-13', descripcion: description,
    }, { Cookie: cookie });
    assert.equal(saved.status, 200);
    const result = await saved.json();
    assert.equal(result.entryId, '61');
    assert.equal(result.message, 'Descripción enviada a OpenCode.');
    assert.equal(result.reply, undefined);
    assert.equal(result.trace, undefined);
    assert.equal(storedSession, 'ses_private_food');

    const empty = await post(base + '/api/food-entries', { fecha: '2026-10-13', descripcion: '  ' }, { Cookie: cookie });
    assert.equal(empty.status, 400);
  }, {
    openCodeRequest: async (method, route, body) => {
      if (method === 'GET') return { status: 200, data: { id: route.split('/').at(-1) } };
      if (route === '/session') return { status: 201, data: { id: 'ses_private_food' } };
      assert.equal(route, '/session/ses_private_food/message');
      assert.deepEqual(body.tools, {});
      assert.equal(typeof body.system, 'string');
      assert.match(body.system, /Separa la descripción en hasta \d+ alimentos/);
      assert.ok(body.system.length < 1000);
      assert.ok(JSON.stringify(body).includes(description));
      assert.equal(body.format, undefined);
      return { status: 200, data: { parts: rawReply } };
    },
  });
  assert.ok(queries.some((sql) => sql.includes('INSERT INTO registros_comidas')));
});

test('food day query returns only authenticated user records for the selected date', async () => {
  const queries = [];
  const records = [
    { id: 1, fecha: '2026-10-13', createdAt: '2026-10-13T12:10:00Z', state: 'pendiente', description: '100 g de avena' },
    { id: 2, fecha: '2026-10-13', createdAt: '2026-10-13T18:30:00Z', state: 'pendiente', description: '2 huevos' },
  ];
  await withServer(async (sql) => {
    queries.push(sql);
    if (sql.includes('SELECT s.usuario_id')) return '27';
    if (sql.includes('FROM registros_comidas e WHERE')) return records.map((record) => JSON.stringify(record)).join('\n');
    return '';
  }, async (base) => {
    const cookie = `nutri_session=${signJwt('27', '123e4567-e89b-42d3-a456-426614174000', 'test-jwt-secret-must-be-at-least-32-bytes')}`;
    const response = await fetch(`${base}/api/food-entries?fecha=2026-10-13&userId=999`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).records, records);
    const listSql = queries.find((sql) => sql.includes('FROM registros_comidas e WHERE'));
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
    sessionId: 'ses_private_food', description: '150 g de pollo cocido',
    originalDescription: 'texto anterior', replies: [{ role: 'assistant', content: 'pregunta anterior' }],
    requestOpenCode: async (method, route, body) => {
      sent = body;
      return { status: 200, data: { parts: [{ type: 'text', text: '{"items":[],"clarificationQuestion":"Aclara la cantidad."}' }] } };
    },
  });
  assert.ok(sent.system.length < 1000);
  assert.match(sent.system, /Devuelve siempre los cinco macros como números/);
  assert.match(sent.system, /macroStatus:"estimado"/);
  assert.equal(sent.format, undefined);
  assert.deepEqual(JSON.parse(sent.parts[0].text), { description: '150 g de pollo cocido' });
  assert.deepEqual(reply, [{ type: 'text', text: '{"items":[],"clarificationQuestion":"Aclara la cantidad."}' }]);
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
  const envKeys = ['OPENCODE_SERVICE_FILE', 'OPENCODE_BASE_URL', 'OPENCODE_PORT', 'OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_AUTO_START'];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalFetch = global.fetch;
  delete process.env.OPENCODE_SERVICE_FILE;
  process.env.OPENCODE_BASE_URL = `http://127.0.0.1:${server.address().port}`;
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
    if (method === 'PATCH') { assert.deepEqual(body.permission, [{ permission: '*', pattern: '*', action: 'deny' }]); return { status: 200, data: true }; }
    if (method === 'DELETE') { openCodeSessions.delete(id); return { status: 200, data: true }; }
    created += 1;
    assert.equal(body.title, 'Registro de comidas');
    assert.deepEqual(body.permission, [{ permission: '*', pattern: '*', action: 'deny' }]);
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

test('food session belongs to the authenticated user and reuses only that user session', async () => {
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
    assert.deepEqual([...sessions.keys()], ['27', '44']);
    assert.equal(created, 2);
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
  assert.ok(requests.filter((request) => ['POST', 'PATCH'].includes(request.method)).every(({ body }) => body.permission.every((rule) => rule.action === 'deny')));
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
    assert.match((await response.json()).message, /quedó guardada/);
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

test('registration creates a hashed user and grants a revocable JWT session', async () => {
  const queries = [];
  let preferencesSaved = false;
  let healthSaved = false;
  let termsAccepted = false;
  let biometricsSaved = false;
  await withServer(async (sql) => {
    queries.push(sql);
    if (sql.startsWith('START TRANSACTION')) {
      if (sql.includes('INSERT INTO preferencias_usuario')) preferencesSaved = true;
      if (sql.includes('INSERT INTO perfil_salud_usuario')) healthSaved = true;
      if (sql.includes('INSERT INTO registros_biometricos')) biometricsSaved = true;
      if (sql.includes('INSERT INTO dashboard_terms_decisions')) termsAccepted = true;
      return '27';
    }
    if (sql.includes('SELECT s.usuario_id')) return '27';
    if (sql.startsWith('SELECT EXISTS(')) return `${Number(preferencesSaved && healthSaved)}\t${Number(termsAccepted)}`;
    if (sql.includes('FROM preferencias_usuario p JOIN perfil_salud_usuario')) return JSON.stringify({ deviceMode: 'ninguno', patronAlimentario: 'vegetariano', nutritionDayStart: '00:00:00', nutritionDayEnd: '13:30:00', allergiesStatus: 'sin_informacion', medicationsStatus: 'sin_informacion' });
    if (sql.startsWith('SELECT JSON_OBJECT(')) return JSON.stringify({ sex: 'masculino', heightCm: 175, restingMetabolismKcal: 1600, restingMetabolismSource: 'mifflin' });
    if (sql.startsWith('SELECT COALESCE(JSON_ARRAYAGG')) return JSON.stringify([{ measuredAt: '2026-10-13 09:00:00', source: 'bia', weightKg: 75, bodyAge: 30, bodyFatPct: 20, restingMetabolismKcal: 1600, visceralFat: 7, bmi: 24.5, musclePct: 35, notes: null }]);
    if (sql.includes('INSERT INTO preferencias_usuario')) { preferencesSaved = true; healthSaved = true; return ''; }
    if (sql.includes('INSERT INTO registros_biometricos')) { biometricsSaved = true; return ''; }
    if (sql.includes('INSERT INTO dashboard_terms_decisions')) { termsAccepted = true; return ''; }
    return sql.includes('LAST_INSERT_ID()') ? '27' : '';
  }, async (base) => {
    assert.equal((await fetch(base + '/', { redirect: 'manual' })).status, 302);
    const response = await post(base + '/api/auth/register', demo);
    assert.equal(response.status, 201);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.doesNotMatch(queries.join('\n'), /0000000000|Demo-Prueba-2026!/);

    const dashboardBeforeSetup = await fetch(base + '/dashboard_nutricional.html', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(dashboardBeforeSetup.status, 302);
    assert.equal(dashboardBeforeSetup.headers.get('location'), '/preferencias.html');
    const preferencePage = await fetch(base + '/preferencias.html', { headers: { Cookie: cookie } });
    assert.equal(preferencePage.status, 200);
    assert.ok(queries.some((sql) => sql.includes('dashboard_sessions')));

    const saved = await post(base + '/api/onboarding/preferences', {
      deviceMode: 'ninguno', patronAlimentario: 'vegetariano',
      preferredFoods: 'pescado', avoidedFoods: '', allergiesStatus: 'sin_informacion', allergiesDetails: '',
      medicationsStatus: 'sin_informacion', medicationsDetails: '',
      nutritionWindow: { start: { hour: 12, minute: 0, period: 'AM' }, end: { hour: 1, minute: 30, period: 'PM' } },
    }, {
      Cookie: cookie.split(';')[0], 'X-Client-Timezone': 'America/Mexico_City',
    });
    assert.equal(saved.status, 200);
    const preferenceSql = queries.find((sql) => sql.includes('INSERT INTO preferencias_usuario') && sql.includes('ON DUPLICATE KEY'));
    assert.ok(preferenceSql);
    assert.doesNotMatch(preferenceSql, /America\/Mexico_City|vegetariano/);
    assert.match(preferenceSql, /00:00:00/);
    assert.match(preferenceSql, /13:30:00/);
    assert.match(queries.find((sql) => sql.includes('INSERT INTO usuarios')) || '', /estatura_cm/);

    const dashboardAfterPreferences = await fetch(base + '/dashboard_nutricional.html', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(dashboardAfterPreferences.status, 302);
    assert.equal(dashboardAfterPreferences.headers.get('location'), '/terminos.html');
    const dashboardBeforeTerms = await fetch(base + '/dashboard_nutricional.html', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(dashboardBeforeTerms.status, 302);
    assert.equal(dashboardBeforeTerms.headers.get('location'), '/terminos.html');
    const termsPage = await fetch(base + '/terminos.html', { headers: { Cookie: cookie } });
    assert.equal(termsPage.status, 200);
    const termsHtml = await termsPage.text();
    assert.match(termsHtml, /id="acceptTermsButton"/);
    assert.match(termsHtml, /id="rejectTermsButton"/);
    assert.match(termsHtml, /id="termsContent"><\/div>/);
    const acceptance = await post(base + '/api/terms/decision', { decision: 'accepted' }, { Cookie: cookie.split(';')[0] });
    assert.equal(acceptance.status, 200);
    assert.ok(queries.some((sql) => sql.includes('dashboard_terms_decisions')));
    const dashboardAfterTerms = await fetch(base + '/dashboard_nutricional.html', { headers: { Cookie: cookie } });
    assert.equal(dashboardAfterTerms.status, 200);
    assert.match(await dashboardAfterTerms.text(), /Dashboard Nutricional/);
    const accountProfileResponse = await fetch(base + '/api/dashboard/profile', { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(accountProfileResponse.status, 200);
    const { profile } = await accountProfileResponse.json();
    assert.equal(profile.heightCm, 175);
    assert.ok(queries.some((sql) => sql.includes('WHERE usuario_id=27')));
    assert.equal((await fetch(base + '/preferencias.html?edit=1', { headers: { Cookie: cookie } })).status, 200);
    const preferencesEdit = await fetch(base + '/api/onboarding/preferences', { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(preferencesEdit.status, 200);
    assert.equal((await preferencesEdit.json()).preferences.patronAlimentario, 'vegetariano');
    for (const page of ['/preferencias.html', '/terminos.html', '/login.html']) {
      const response = await fetch(base + page, { headers: { Cookie: cookie }, redirect: 'manual' });
      assert.equal(response.status, 302, page);
      assert.equal(response.headers.get('location'), '/dashboard_nutricional.html', page);
    }

    const biometricSave = await post(base + '/api/biometrics', {
      source: 'bia', weightKg: '75', bodyAge: '30', bodyFatPct: '20', restingMetabolismKcal: '1600',
      visceralFat: '7', bmi: '24.5', musclePct: '35', notes: '',
    }, { Cookie: cookie.split(';')[0] });
    assert.equal(biometricSave.status, 201);
    assert.equal(biometricsSaved, true);
    const biometrics = await fetch(base + '/api/biometrics', { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(biometrics.status, 200);
    assert.equal((await biometrics.json()).records[0].bodyAge, 30);

    const invalidTimezone = await post(base + '/api/onboarding/preferences', {
      deviceMode: 'ninguno', patronAlimentario: 'vegano',
      preferredFoods: '', avoidedFoods: '', allergiesStatus: 'sin_informacion', allergiesDetails: '',
      medicationsStatus: 'sin_informacion', medicationsDetails: '',
      nutritionWindow: { start: { hour: 9, minute: 0, period: 'AM' }, end: { hour: 10, minute: 0, period: 'PM' } },
    }, {
      Cookie: cookie.split(';')[0], 'X-Client-Timezone': 'No/Such_Zone',
    });
    assert.equal(invalidTimezone.status, 400);
    assert.equal(queries.filter((sql) => sql.includes('INSERT INTO preferencias_usuario')).length, 1);

    const invalidClock = await post(base + '/api/onboarding/preferences', {
      deviceMode: 'ninguno', patronAlimentario: 'vegano',
      preferredFoods: '', avoidedFoods: '', allergiesStatus: 'sin_informacion', allergiesDetails: '',
      medicationsStatus: 'sin_informacion', medicationsDetails: '',
      nutritionWindow: { start: { hour: 13, minute: 0, period: 'PM' }, end: { hour: 10, minute: 0, period: 'PM' } },
    }, { Cookie: cookie.split(';')[0], 'X-Client-Timezone': 'America/Mexico_City' });
    assert.equal(invalidClock.status, 400);
    assert.equal(queries.filter((sql) => sql.includes('INSERT INTO preferencias_usuario')).length, 1);
  });
});

test('12-hour clock converts midnight, noon and PM to MySQL TIME', () => {
  assert.equal(toMysqlTime({ hour: '12', minute: '00', period: 'AM' }), '00:00:00');
  assert.equal(toMysqlTime({ hour: '12', minute: '15', period: 'PM' }), '12:15:00');
  assert.equal(toMysqlTime({ hour: '1', minute: '30', period: 'PM' }), '13:30:00');
  assert.equal(toMysqlTime({ hour: '0', minute: '30', period: 'AM' }), null);
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
  await withServer(async (sql) => {
    queries.push(sql);
    if (sql.includes('FROM usuarios WHERE celular_e164')) return `27\t${salt.toString('hex')}\t${hash.toString('hex')}\t1`;
    if (sql.includes('FROM dashboard_sessions')) return '27';
    return '';
  }, async (base) => {
    const login = await post(base + '/api/auth/login', {
      phone: '+52 0000000000', password: demo.password,
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.ok(cookie);
    const logout = await post(base + '/api/auth/logout', {}, { Cookie: cookie });
    assert.equal(logout.status, 200);
    assert.match(queries.join('\n'), /UPDATE dashboard_sessions/);
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
    const signup = await post(base + '/api/auth/register', demo);
    const cookie = signup.headers.get('set-cookie').split(';')[0];
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
    const signup = await post(base + '/api/auth/register', demo);
    const cookie = signup.headers.get('set-cookie').split(';')[0];
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
    const missingHeight = await post(base + '/api/auth/register', { ...demo, heightCm: '' });
    assert.equal(missingHeight.status, 400);
    const unsupportedSex = await post(base + '/api/auth/register', { ...demo, sex: 'otro' });
    assert.equal(unsupportedSex.status, 400);
    assert.equal(calls, 0);
  });
});
