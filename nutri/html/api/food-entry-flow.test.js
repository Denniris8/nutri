const assert = require('node:assert/strict');
const test = require('node:test');
const { applyExplicitQuantities, applyFoodMacroReferences, normalizeFoodReply, parseFoodReferenceTime, parseFoodReply, saveFoodEntry } = require('./food-entries.js');
const { deleteFoodOpenCodeSession, openCodeRequest } = require('./opencode-food.js');

test('registra leche y whey con cantidades del mensaje tras respuesta inválida inicial', async () => {
  const description = '250 ml de leche Alpura Pro baja en grasa deslactosada y 31 g de proteína Gold Standard Whey chocolate el 2026-10-22';
  const savedItems = [
    { itemId: '1', name: 'Leche Alpura Pro baja en grasa deslactosada', quantity: '250 ml', quantityGrams: null, basis: 'per_portion', energyKcal: 111, proteinG: 9, carbohydrateG: 12, fatG: 3, fiberG: null, macroStatus: 'estimado', macroSource: 'opencode_estimado' },
    { itemId: '2', name: 'Gold Standard Whey chocolate', quantity: '31 g', quantityGrams: 31, basis: 'per_portion', energyKcal: 117, proteinG: 24, carbohydrateG: 3, fatG: 1, fiberG: 0, macroStatus: 'estimado', macroSource: 'opencode_estimado' },
  ];
  const statements = [];
  let committed = false;
  const dbQuery = async (sql) => {
    statements.push(sql);
    if (sql.includes('SELECT zona_horaria')) return 'UTC';
    if (sql.includes('SELECT DATE_FORMAT(fecha_consumo')) return '';
    if (sql.includes("SELECT JSON_OBJECT('entryId',e.id")) return '';
    if (sql.includes('INSERT INTO registros_comidas(usuario_id')) return '501';
    if (sql.includes("SELECT JSON_OBJECT('state',estado")) return JSON.stringify({ state: 'borrador_chat', fecha: '2026-10-22', description, question: null, targetEntryId: null });
    if (sql.includes('SELECT session_id FROM sesiones_comidas_opencode')) return '';
    if (sql.includes('SELECT JSON_OBJECT(\'role\',role,\'content\',contenido)')) return '';
    if (sql.includes("SET time_zone='+00:00'; SELECT JSON_OBJECT('id',e.id")) return committed
      ? JSON.stringify({ id: '501', fecha: '2026-10-22', createdAt: '2026-10-22T12:00:00Z', state: 'completado', description }) : '';
    if (sql.includes("SELECT JSON_OBJECT('entryId',i.registro_comida_id")) return committed
      ? savedItems.map((item) => JSON.stringify({ entryId: '501', ...item })).join('\n') : '';
    if (sql.includes('COMMIT')) { committed = true; return ''; }
    return '';
  };
  const replies = [
    [{ type: 'text', text: 'Necesito más información.' }],
    [{ type: 'text', text: JSON.stringify({
      action: 'new', targetEntryId: null, clarificationQuestion: null,
      items: [
        { sourceText: 'Leche Alpura Pro baja en grasa deslactosada', name: 'Leche Alpura Pro baja en grasa deslactosada', quantityGrams: null, quantityText: null, macroBasis: 'per_portion', macroStatus: 'estimado', macroSource: 'opencode_estimado', macros: { energyKcal: 111, proteinG: 9, carbohydrateG: 12, fatG: 3, fiberG: null } },
        { sourceText: 'Gold Standard Whey chocolate', name: 'Gold Standard Whey chocolate', quantityGrams: null, quantityText: null, macroBasis: 'per_portion', macroStatus: 'estimado', macroSource: 'opencode_estimado', macros: { energyKcal: 117, proteinG: 24, carbohydrateG: 3, fatG: 1, fiberG: 0 } },
      ],
    }) }],
  ];
  const requests = [];
  const requestOpenCode = async (method, path, body) => {
    if (method === 'POST' && path === '/session') return { status: 200, data: { id: 'ses_foodFlowTest123' } };
    if (method === 'POST' && path.endsWith('/message')) {
      requests.push(body);
      return { status: 200, data: { parts: replies.shift() } };
    }
    throw new Error(`Unexpected OpenCode request: ${method} ${path}`);
  };
  const responseBody = await new Promise((resolve) => saveFoodEntry({
    response: {}, data: { fecha: '2026-10-22', descripcion: description, requestId: '8e4d53e9-4268-4b45-8b12-1b510e8db22e', timezone: 'UTC' },
    userId: 999991, dbQuery, textSql: (value) => `'${String(value).replace(/'/g, "''")}'`, json: (_response, _status, body) => resolve(body),
    requestOpenCode,
  }));

  assert.equal(responseBody.state, 'completado');
  assert.equal(requests.length, 2);
  const originalContext = JSON.parse(requests[0].parts[0].text);
  assert.equal(originalContext.initialDescription, description);
  assert.equal(requests[0].tools.websearch, true);
  assert.equal(requests[0].tools.webfetch, true);
  const insert = statements.find((sql) => sql.includes('INSERT INTO registros_comida_items('));
  assert.match(insert, /'250 ml',null/i);
  assert.match(insert, /'31 g',31/i);
  assert.match(insert, /111,111,9,12,3,null\)/i);
});

test('reutiliza macros del alimento referenciado y los escala a la cantidad nueva', () => {
  const item = { name: 'Pollo asado', quantityGrams: 60, quantityText: '60 g', macroBasis: 'per_portion', macros: {} };
  const source = { itemId: '41', name: 'Pollo asado', quantityGrams: 100, energyKcal: 165, proteinG: 31, carbohydrateG: 0, fatG: 3.6, fiberG: null, macroStatus: 'declarado', macroSource: 'webfetch', sourceName: 'USDA', sourceUrl: 'https://fdc.nal.usda.gov/food/1', sourceQuote: 'Datos por porción.' };
  const [reused] = applyFoodMacroReferences([item], [source]);
  assert.deepEqual(reused.macros, { energyKcal: 99, proteinG: 18.6, carbohydrateG: 0, fatG: 2.16, fiberG: null });
  assert.equal(reused.macroSource, 'webfetch');
  assert.equal(reused.sourceUrl, source.sourceUrl);
  assert.equal(reused.referenceMacrosReused, true);
  const [ambiguous] = applyFoodMacroReferences([item], [source, { ...source, itemId: '42', energyKcal: 160 }]);
  assert.equal(ambiguous.referenceMacrosReused, undefined);
  const [missingQuantity] = applyFoodMacroReferences([{ name: 'Pollo asado', quantityGrams: null }], [source]);
  assert.equal(missingQuantity.referenceSourceMatched, true);
  assert.equal(missingQuantity.referenceMacrosReused, undefined);
  assert.deepEqual(parseFoodReferenceTime('60 g de pollo como el de las 4pm a las 7pm').time.hours, [16]);
  assert.deepEqual(parseFoodReferenceTime('60 g de pollo como el de las 4pm a las 7pm').withoutReferenceTime, '60 g de pollo como el de las  a las 7pm');
});

test('registra comidas con respuestas reales de OpenCode y MySQL simulado', { skip: process.env.NUTRI_TEST_OPENCODE_LIVE !== '1' }, async () => {
  const milkWheyCase = process.env.NUTRI_TEST_OPENCODE_CASE === 'milk-whey';
  const bonelessRepro = process.env.NUTRI_TEST_OPENCODE_CASE === 'boneless-repro';
  const bonelessBatch = process.env.NUTRI_TEST_OPENCODE_CASE === 'boneless-batch';
  const overnightCase = /^overnight(?:-previous)?$/.test(process.env.NUTRI_TEST_OPENCODE_CASE || '');
  const previousDayCase = process.env.NUTRI_TEST_OPENCODE_CASE === 'overnight-previous';
  const meals = bonelessBatch ? [
    ['Puré, spaghetti con queso y boneless 1', '', ''],
    ['Puré, spaghetti con queso y boneless 2', '', ''],
    ['Puré, spaghetti con queso y boneless 3', '', ''],
    ['Puré, spaghetti con queso y boneless 4', '', ''],
    ['Puré, spaghetti con queso y boneless 5', '', ''],
  ] : bonelessRepro ? [
    ['Puré de papa, spaghetti con queso y boneless', '', ''],
  ] : milkWheyCase ? [
    ['Leche Alpura Pro y proteína ON Gold Nutrition', 'leche Alpura Pro', 'Optimum Nutrition Gold Standard 100% Whey'],
  ] : overnightCase ? [
    ['Arroz con huevo a la 1:00 a. m.', 'arroz cocido', 'huevo cocido'],
    ['Arroz con huevo a las 2:00 a. m.', 'arroz cocido', 'huevo cocido'],
    ['Arroz con huevo a las 3:00 a. m.', 'arroz cocido', 'huevo cocido'],
  ] : [
    ['Avena con yogur', 'Yogur griego natural de etiqueta', 'avena genérica'],
    ['Tacos de pollo', 'Tortillas de maíz de etiqueta', 'pechuga de pollo genérica'],
    ['Sándwich de atún', 'Pan integral de etiqueta', 'atún genérico escurrido'],
    ['Licuado de plátano', 'Leche alta en proteína de etiqueta', 'plátano genérico'],
    ['Ensalada con garbanzo', 'Aderezo de etiqueta', 'garbanzos genéricos cocidos'],
    ['Arroz con huevo', 'Salsa de tomate de etiqueta', 'arroz cocido'],
    ['Pasta con queso', 'Pasta integral de etiqueta', 'queso fresco genérico'],
    ['Quesadillas', 'Tortillas de harina de etiqueta', 'queso Oaxaca genérico'],
    ['Bowl de carne', 'Frijoles refritos de etiqueta', 'carne de res genérica'],
    ['Hotcakes', 'Mezcla para hotcakes de etiqueta', 'huevo genérico'],
    ['Tostadas de tinga', 'Tostadas horneadas de etiqueta', 'pollo deshebrado genérico'],
    ['Sopa de lentejas', 'Caldo envasado de etiqueta', 'lentejas genéricas cocidas'],
    ['Papa con requesón', 'Requesón de etiqueta', 'papa genérica cocida'],
    ['Cereal con leche', 'Cereal integral de etiqueta', 'leche genérica'],
    ['Burrito de frijol', 'Tortilla integral de etiqueta', 'frijoles bayos genéricos'],
    ['Salmón con quinoa', 'Quinoa envasada de etiqueta', 'salmón genérico cocido'],
    ['Ensalada de pasta', 'Mayonesa ligera de etiqueta', 'pasta genérica cocida'],
    ['Molletes', 'Bolillo integral de etiqueta', 'frijoles negros genéricos'],
    ['Yogur con fruta', 'Yogur alto en proteína de etiqueta', 'fresas genéricas'],
    ['Wrap de pavo', 'Tortilla de nopal de etiqueta', 'pechuga de pavo genérica'],
  ];
  const startIndex = Math.min(9, Math.max(0, Number.parseInt(process.env.NUTRI_TEST_OPENCODE_START || '0', 10) || 0));
  const endIndex = Math.min(10, Math.max(startIndex + 1, Number.parseInt(process.env.NUTRI_TEST_OPENCODE_END || '10', 10) || 10));
  const messageLimit = Math.min(bonelessBatch ? 20 : 10, Math.max(1, Number.parseInt(process.env.NUTRI_TEST_OPENCODE_LIMIT || (bonelessBatch ? '20' : '10'), 10) || 10));
  let realMessageCalls = 0;
  let reproStatus = null;
  const reproResults = [];
  const savedMeals = [];
  const failures = [];
  for (const [offset, [meal, packaged, generic]] of meals.slice(startIndex, endIndex).entries()) {
    if (realMessageCalls >= messageLimit) break;
    const index = startIndex + offset;
    const entryId = String(600 + index);
    const protein = 5 + index % 8, carbohydrate = 15 + index % 9, fat = 2 + index % 5;
    const energy = 4 * protein + 4 * carbohydrate + 9 * fat;
    const description = bonelessBatch
      ? [
        '51g puré de papa, 90g spaghetti con queso (no sé cuánto de queso calcula), 179g estilo boneless',
        '65g puré de papa, 100g spaghetti con queso (no sé cuánto de queso calcula), 160g boneless',
        '80g puré de papa, 120g pasta con queso (no sé cuánto de queso calcula), 150g boneless estilo búfalo',
        '55g de puré de papa, 110g de spaghetti con queso (cantidad de queso desconocida), 175g de boneless',
        '70g puré de papa, 95g spaghetti con queso (no sé el gramaje del queso), 185g boneless de pollo',
      ][index]
      : bonelessRepro
      ? '51g puré de papa, 90g spagetti con queso (no sé cuánto de queso calcula),179g estilo boneless traza'
      : overnightCase
      ? `${meal}: 100 g de arroz blanco cocido en casa, no envasado y sin marca; 50 g de huevo cocido en casa, genérico y sin marca.`
      : milkWheyCase
      ? `${meal}: 250 ml de leche Alpura Pro y 31 g de proteína Optimum Nutrition Gold Standard 100% Whey (ON). Fecha 2026-10-22.`
      : `${meal}: 100 g de ${packaged}; etiqueta sintética declarada para esta prueba por 100 g: ${energy} kcal, ${protein} g proteína, ${carbohydrate} g carbohidratos, ${fat} g grasa. Además 100 g de ${generic}, cocido.${index === 5 ? ' Además 50 g de huevo cocido.' : ''} Fecha 2026-10-22.`;
    const clarificationReply = (pendingQuestion) => {
      const question = String(pendingQuestion || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (/confirmas las 11:59:59/.test(question)) return 'Sí, confirmo las 11:59:59 p. m.';
      if (/(cuantos|cantidad|gramos|mililitros|porcion)/.test(question)) return milkWheyCase
        ? `Confirmo 250 ml de leche Alpura Pro y 31 g de proteína Optimum Nutrition Gold Standard 100% Whey (ON).`
        : overnightCase ? 'Confirmo 100 g de arroz cocido y 50 g de huevo cocido, preparados cocidos.'
        : `Son 100 g de ${packaged} y 100 g de ${generic}${index === 5 ? ' y 50 g de huevo cocido' : ''}.`;
      if (/(preparacion|coccion|crudo|cocido)/.test(question)) return `${generic} esta cocido; ${packaged} es un producto envasado.`;
      if (/(etiqueta|macro|caloria|fibra|nutriente)/.test(question)) return milkWheyCase
        ? 'No tengo una foto ni datos de etiqueta, ni se indicó variante o sabor. Usa una fuente que coincida con el producto; si no hay una, estima y etiqueta los macros como estimados.'
        : overnightCase ? 'No hay etiqueta; son arroz blanco y huevo genéricos cocidos en casa. Usa una fuente verificable o macros típicos marcados como estimados.'
        : `La etiqueta de ${packaged} es sintetica para esta prueba: ${energy} kcal, ${protein} g de proteina, ${carbohydrate} g de carbohidratos y ${fat} g de grasa por 100 g.`;
      if (/(marca|variante|producto|identifica|sabor)/.test(question)) return milkWheyCase
        ? 'Solo conozco los nombres Alpura Pro y ON Gold Nutrition; no se indicó variante de leche ni sabor de proteína.'
        : overnightCase ? 'No son productos envasados y no tienen marca ni etiqueta; son arroz blanco cocido en casa y huevo cocido genérico. Usa una fuente compatible o estima y marca los macros.'
        : `${packaged} es una etiqueta ficticia de prueba, no una marca real; ${generic} es generico y esta cocido.`;
      return milkWheyCase
        ? 'Confirmo únicamente 250 ml de leche Alpura Pro y 31 g de proteína Optimum Nutrition Gold Standard 100% Whey (ON). No tengo variante, sabor ni etiqueta; consulta una fuente coincidente o marca los valores típicos como estimados.'
        : overnightCase ? `Confirmo 100 g de arroz blanco cocido en casa y 50 g de huevo cocido en casa, ambos genéricos sin marca ni envase. ${previousDayCase ? 'Confirmo el día nutricional anterior.' : 'Elijo el día nutricional actual.'} Si no hay fuente compatible, usa macros típicos marcados como estimados.`
        : `Es ${meal}: 100 g de ${packaged} con la etiqueta sintetica indicada y 100 g de ${generic} cocido${index === 5 ? ' y 50 g de huevo cocido' : ''}. No tengo otros datos; estima solo lo que sea razonable y marca la estimacion.`;
    };
    const interactions = [], modelContexts = [];
    let draftExists = false, draftDate = '2026-10-22', question = null, completed = false, storedSession = '', currentSession = '', liveParts = [];
    const textSql = (value) => value == null ? 'NULL' : `CONVERT(0x${Buffer.from(String(value)).toString('hex')} USING utf8mb4)`;
    const dbQuery = async (sql) => {
      for (const match of sql.matchAll(/INSERT INTO registros_comida_interacciones\(registro_comida_id,role,contenido\) VALUES \((\d+),CONVERT\(0x([a-f\d]*) USING utf8mb4\),CONVERT\(0x([a-f\d]*) USING utf8mb4\)\)/gi)) {
        interactions.push({ role: Buffer.from(match[2], 'hex').toString(), content: Buffer.from(match[3], 'hex').toString() });
      }
      const pendingQuestion = sql.match(/pregunta_pendiente=CONVERT\(0x([a-f\d]+) USING utf8mb4\)/i);
      if (pendingQuestion) question = Buffer.from(pendingQuestion[1], 'hex').toString();
      const changedDate = sql.match(/UPDATE registros_comidas SET fecha_consumo=CONVERT\(0x([a-f\d]+) USING utf8mb4\)/i);
      if (changedDate) draftDate = Buffer.from(changedDate[1], 'hex').toString();
      if (/UPDATE registros_comidas SET estado='completado'/.test(sql)) { completed = true; question = null; }
      if (sql.includes('SELECT zona_horaria')) return 'UTC';
      if (sql.includes('SELECT DATE_FORMAT(fecha_consumo')) return draftExists ? draftDate : '';
      if (sql.includes("SELECT JSON_OBJECT('entryId',e.id")) return '';
      if (sql.includes('INSERT INTO registros_comidas(usuario_id')) { draftExists = true; return entryId; }
      if (sql.includes("SELECT JSON_OBJECT('state',estado")) return JSON.stringify({ state: completed ? 'completado' : 'borrador_chat', fecha: draftDate, description, question, targetEntryId: null });
      if (sql.includes('SELECT session_id FROM sesiones_comidas_opencode')) return storedSession;
      if (sql.includes('INSERT INTO sesiones_comidas_opencode')) { storedSession = currentSession; return ''; }
      if (sql.includes('DELETE FROM sesiones_comidas_opencode')) { storedSession = ''; return ''; }
      if (sql.includes("JSON_OBJECT('role',role,'content',contenido)")) {
        const rows = sql.includes('ORDER BY id DESC LIMIT 1') ? interactions.slice(-1) : interactions;
        return rows.map((message) => JSON.stringify(message)).join('\n');
      }
      if (sql.includes("JSON_OBJECT('content',contenido)")) return interactions.filter(({ role }) => role === 'user').map(({ content }) => JSON.stringify({ content })).join('\n');
      if (sql.includes('COMMIT')) return '';
      if (sql.includes("SET time_zone='+00:00'; SELECT JSON_OBJECT('id',e.id")) return completed
        ? JSON.stringify({ id: entryId, fecha: draftDate, createdAt: `${draftDate}T12:00:00Z`, state: 'completado', description }) : '';
      if (sql.includes("SELECT JSON_OBJECT('entryId',i.registro_comida_id")) {
        if (!completed) return '';
        const items = applyExplicitQuantities(normalizeFoodReply(parseFoodReply(liveParts)).items, description);
        return items.map((item, itemIndex) => {
          const factor = item.macroBasis === 'per_100g' ? item.quantityGrams / 100 : 1;
          return JSON.stringify({ entryId, itemId: String(itemIndex + 1), sourceText: item.sourceText, name: item.name,
            quantity: item.quantityText || `${item.quantityGrams} g`, quantityGrams: item.quantityGrams, basis: 'per_portion',
            energyKcal: item.macros.energyKcal * factor, proteinG: item.macros.proteinG * factor,
            carbohydrateG: item.macros.carbohydrateG * factor, fatG: item.macros.fatG * factor,
            fiberG: item.macros.fiberG == null ? null : item.macros.fiberG * factor,
            macroStatus: item.macroStatus, macroSource: item.macroSource,
            sourceName: item.sourceName, sourceUrl: item.sourceUrl, sourceQuote: item.sourceQuote });
        }).join('\n');
      }
      return '';
    };
    const requestOpenCode = async (...args) => {
      if (args[0] === 'POST' && args[1] === '/session') {
        const result = await openCodeRequest(...args);
        currentSession = result.data?.id || '';
        return result;
      }
      if (args[0] === 'POST' && args[1].endsWith('/message')) {
        if (realMessageCalls >= messageLimit) throw new Error(`Se alcanzó el límite autorizado de ${messageLimit} mensajes reales a OpenCode.`);
        realMessageCalls += 1;
        if (overnightCase) modelContexts.push(JSON.parse(args[2].parts[0].text));
        const result = await openCodeRequest(...args);
        liveParts = result.data?.parts || [];
        return result;
      }
      return openCodeRequest(...args);
    };
    const requestId = `8e4d53e9-4268-4b45-8b12-${String(index + 1).padStart(12, '0')}`;
    const userId = 2099980 + index;
    let result, lastQuestion = '';
    try {
      if (overnightCase) {
        const callsBeforeDayChoice = realMessageCalls;
        await saveFoodEntry({ response: {}, data: { fecha: '2026-10-22', descripcion: description, requestId, timezone: 'UTC' },
          userId, dbQuery, textSql, json: (_response, status, body) => { result = { status, ...body }; }, requestOpenCode });
        assert.equal(result.status, 200, `${meal}: servidor rechaza la hora temprana`);
        assert.equal(result.state, 'requiere_aclaracion', `${meal}: debió pedir la elección del día`);
        assert.match(result.question, /¿Esta comida pertenece al día nutricional seleccionado/);
        assert.equal(realMessageCalls, callsBeforeDayChoice, `${meal}: no debe consultar OpenCode antes de elegir el día`);
        await saveFoodEntry({ response: {}, data: { fecha: '2026-10-22', descripcion: previousDayCase ? 'anterior' : 'actual', requestId, timezone: 'UTC' },
          userId, dbQuery, textSql, json: (_response, status, body) => { result = { status, ...body }; }, requestOpenCode });
        assert.equal(result.state, 'requiere_aclaracion', `${meal}: la elección del día debe conservar el borrador`);
        assert.equal(realMessageCalls, callsBeforeDayChoice, `${meal}: OpenCode debe esperar la confirmación de fecha`);
        if (previousDayCase) {
          assert.match(result.question, /¿La guardo en el día nutricional anterior .*11:59:59 p\. m\./);
          await saveFoodEntry({ response: {}, data: { fecha: '2026-10-22', descripcion: 'Sí', requestId, timezone: 'UTC' },
            userId, dbQuery, textSql, json: (_response, status, body) => { result = { status, ...body }; }, requestOpenCode });
          assert.equal(draftDate, '2026-10-21', `${meal}: fecha anterior simulada`);
        }
      }
      for (let turn = 0; turn < (bonelessRepro || bonelessBatch ? 1 : 5) && realMessageCalls < messageLimit && result?.state !== 'completado'; turn += 1) {
        const userReply = overnightCase || turn ? clarificationReply(result?.question) : description;
        await saveFoodEntry({ response: {}, data: { fecha: '2026-10-22', descripcion: userReply, requestId, timezone: 'UTC' },
          userId, dbQuery, textSql, json: (_response, status, body) => { result = { status, ...body }; }, requestOpenCode });
        if (bonelessRepro) reproStatus = result?.status;
        if (bonelessBatch) {
          reproResults.push({ status: result?.status, state: result?.state, question: result?.question });
          if (result?.state === 'requiere_aclaracion') {
            assert.match(result.question || '', /queso/i, `${meal}: debe aclarar la cantidad de queso`);
            break;
          }
          if (result?.status === 502) break;
          failures.push(`${meal}: no pidió aclaración por la cantidad de queso`);
          break;
        }
        if (result?.state === 'completado') {
          const expectedIngredients = bonelessRepro ? ['puré de papa', 'spaghetti', 'boneless'] : overnightCase ? ['arroz cocido', 'huevo cocido'] : milkWheyCase ? ['Alpura Pro', 'Gold Standard'] : index === 5 ? [packaged, generic, 'huevo cocido'] : [packaged, generic];
          assert.ok(result.records[0].items.length >= expectedIngredients.length, `${meal}: devolvió ${result.records[0].items.length} de ${expectedIngredients.length} ingredientes esperados`);
          for (const ingredient of expectedIngredients) {
            const key = ingredient.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]{4,}/)?.[0];
            assert.ok(result.records[0].items.some(({ name, sourceText }) => `${name} ${sourceText}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(key)), `${meal}: OpenCode omitió ${key}`);
          }
          if (milkWheyCase) {
            const milk = result.records[0].items.find(({ name, sourceText }) => /alpura pro/i.test(`${name} ${sourceText}`));
            const whey = result.records[0].items.find(({ name, sourceText }) => /gold standard/i.test(`${name} ${sourceText}`));
            assert.match(milk.quantity, /250\s*ml/i);
            assert.equal(milk.quantityGrams, null);
            assert.equal(whey.quantityGrams, 31);
          }
          if (overnightCase) {
            if (previousDayCase) assert.ok(modelContexts.some(({ description: modelDescription, initialDescription }) => modelDescription === description && initialDescription === description), `${meal}: al confirmar el día anterior, OpenCode debe recibir la descripción original del alimento, no solo la confirmación`);
            const savedItems = result.records[0].items;
            const rice = savedItems.find(({ name, sourceText }) => /arroz/i.test(`${name} ${sourceText}`));
            const egg = savedItems.find(({ name, sourceText }) => /huevo/i.test(`${name} ${sourceText}`));
            assert.ok(rice, `${meal}: falta arroz; persistidos: ${JSON.stringify(savedItems)}`);
            assert.ok(egg, `${meal}: falta huevo; persistidos: ${JSON.stringify(savedItems)}`);
            assert.equal(rice.quantityGrams, 100, `${meal}: cantidad de arroz`);
            assert.equal(egg.quantityGrams, 50, `${meal}: cantidad de huevo`);
            assert.equal(result.fecha, previousDayCase ? '2026-10-21' : '2026-10-22', `${meal}: día nutricional elegido`);
          }
          assert.ok(completed, `${meal}: la respuesta no coincide con el estado persistido`);
          savedMeals.push(meal);
          break;
        }
        if (bonelessRepro && result?.state === 'requiere_aclaracion') {
          assert.match(result.question || '', /queso/i, 'debe pedir la cantidad de queso sin asumirla');
          lastQuestion = result.question;
          break;
        }
        if (bonelessRepro && result?.status === 502) break;
        if (result?.state !== 'requiere_aclaracion' || !result.question) {
          failures.push(`${meal}: HTTP ${result?.status}, estado ${result?.state || 'sin respuesta'}, ${result?.error || result?.message || ''}; aclaración: ${lastQuestion}`);
          break;
        }
        lastQuestion = result.question;
        if (realMessageCalls >= messageLimit) { failures.push(`${meal}: quedó pendiente al alcanzar el límite de ${messageLimit} mensajes reales; última aclaración: ${lastQuestion}`); break; }
      }
      if (!completed && !bonelessRepro && !bonelessBatch && !failures.some((failure) => failure.startsWith(`${meal}:`))) failures.push(`${meal}: no se guardó tras sus aclaraciones; última: ${lastQuestion}${overnightCase ? `; historial: ${JSON.stringify(interactions.slice(-8))}` : ''}`);
    } catch (error) {
      failures.push(`${meal}: ${error.message}`);
    } finally {
      if (storedSession) await deleteFoodOpenCodeSession({ userId, dbQuery, requestOpenCode });
    }
  }
  assert.deepEqual(failures, [], `Llamadas reales: ${realMessageCalls}/${messageLimit}; comidas guardadas: ${savedMeals.length}/${endIndex - startIndex}; fallos: ${failures.join(' | ')}`);
  if (bonelessRepro) {
    assert.equal(reproStatus, 200, `respuesta HTTP inesperada: ${reproStatus}`);
    assert.ok(realMessageCalls >= 1 && realMessageCalls <= 4, `se esperaban 1-4 mensajes, recibidos: ${realMessageCalls}`);
  } else if (bonelessBatch) {
    assert.equal(reproResults.length, 5, `se probaron ${reproResults.length} de 5 comidas; llamadas reales: ${realMessageCalls}/${messageLimit}`);
    reproResults.forEach((result, index) => {
      assert.equal(result.status, 200, `comida ${index + 1}: HTTP ${result.status}`);
      assert.equal(result.state, 'requiere_aclaracion', `comida ${index + 1}: el queso sin gramaje no debe darse por registrado`);
      assert.match(result.question || '', /queso/i, `comida ${index + 1}: debe aclarar la cantidad de queso`);
    });
  }
  else assert.equal(savedMeals.length, endIndex - startIndex, `solo se guardaron ${savedMeals.length} de ${endIndex - startIndex} comidas en ${realMessageCalls} llamadas reales`);
});
