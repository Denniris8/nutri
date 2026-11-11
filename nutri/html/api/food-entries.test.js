const assert = require('node:assert/strict');
const test = require('node:test');
const { applyExplicitGrams, applyOpenFoodFactsMacros, applyPreviewQuantityEdits, confirmedNutritionDateAnswer, foodItemIssues, getFoodEntryProgress, hasExplicitVolume, isGenericEstimatePermissionQuestion, knownFoodsShortcut, needsSelectedNutritionDateConfirmation, numberVisibleFoodMeals, parseDeclaredFoodShortcut, pendingFoodItemSql, readPendingFoodDraft, repairEstimatedEnergy, reportFoodProgress, selectedNutritionDateAnswer, usedFoodWebSearch } = require('./food-entries.js');

test('accepts confirmed teaspoon and tablespoon quantities without requiring grams', () => {
  for (const quantityText of ['1 cucharadita', 'una cucharadita', '2 cditas.', '1 cucharada', 'dos cucharadas', '2 cdas.', 'una pizca', '1 taza', 'un puñado', '2 piezas']) {
    assert.equal(hasExplicitVolume({ quantityGrams: null, quantityText }), true);
  }
});

test('confirms a mismatched selected nutrition date only during 00:00-03:59', () => {
  assert.equal(needsSelectedNutritionDateConfirmation('2026-10-29', '2026-10-30', 0), true);
  assert.equal(needsSelectedNutritionDateConfirmation('2026-10-29', '2026-10-30', 239), true);
  assert.equal(needsSelectedNutritionDateConfirmation('2026-10-29', '2026-10-30', 0, true), false);
  assert.equal(needsSelectedNutritionDateConfirmation('2026-10-29', '2026-10-30', 240), false);
  assert.equal(needsSelectedNutritionDateConfirmation('2026-10-30', '2026-10-30', 60), false);
});

test('uses the suggested end-of-day time only when the selected-date confirmation is accepted', () => {
  const question = 'Ahora son las 1:00 a. m. del 30 de octubre y está seleccionado el día 29 de octubre de 2026. ¿Confirmas registrar esta comida en el día nutricional seleccionado (2026-10-29)? Para agregarla al balance de ese día, sugiero las 11:59:59 p. m.; confirma o indica otra hora. La fecha seleccionada determina dónde se suman los macros.';
  assert.deepEqual(selectedNutritionDateAnswer(question, 'Sí'), { confirmed: true, time: { hours: [23], minute: 59 }, lastSecond: true });
  assert.equal(selectedNutritionDateAnswer(question, 'No').declined, true);
  assert.equal(selectedNutritionDateAnswer(question, 'A las 8:30 p. m.').time.hours[0], 20);
});

test('detects generic-macro permission questions so the server can resolve them automatically', () => {
  assert.equal(isGenericEstimatePermissionQuestion('¿Autorizas estimar los macros?'), true);
  assert.equal(isGenericEstimatePermissionQuestion('¿Quieres que use genéricos?'), true);
  assert.equal(isGenericEstimatePermissionQuestion('¿Cuántos gramos consumiste?'), false);
});

test('retains an accepted selected-date confirmation after a later food clarification replaces the pending question', () => {
  const messages = [
    { role: 'assistant', content: '¿Confirmas registrar esta comida en el día nutricional seleccionado (2026-11-03)? Para agregarla al balance de ese día, sugiero las 11:59:59 p. m.; confirma o indica otra hora.' },
    { role: 'user', content: 'sí' },
    { role: 'assistant', content: '¿Los 31 g son peso del polvo? ¿Autorizas estimar los macros?' },
    { role: 'user', content: 'Los 31 g son peso del polvo, autorizo' },
  ];
  assert.deepEqual(confirmedNutritionDateAnswer(messages), { confirmed: true, time: { hours: [23], minute: 59 }, lastSecond: true });
  assert.equal(needsSelectedNutritionDateConfirmation('2026-11-03', '2026-11-04', 60, Boolean(confirmedNutritionDateAnswer(messages))), false);
});

test('numbers meals in visible list order before completed-only filtering', () => {
  const meals = numberVisibleFoodMeals([{ id: 'a', state: 'completado' }, { id: 'b', state: 'pendiente' }, { id: 'c', state: 'completado' }]);
  assert.deepEqual(meals.map(({ numeroComida }) => numeroComida), [1, 2, 3]);
  assert.deepEqual(meals.filter(({ state }) => state === 'completado').map(({ numeroComida }) => numeroComida), [1, 3]);
});

test('draft candidate SQL writes the four supported macros as numbers', () => {
  const textSql = (value) => `CONVERT(0x${Buffer.from(value, 'utf8').toString('hex')} USING utf8mb4)`;
  const item = { name: 'Ensalada', sourceText: 'Ensalada', quantityGrams: 120, quantityText: '120 g', macroBasis: 'per_portion', macroStatus: 'estimado', macroSource: 'opencode_estimado', macros: { energyKcal: 60, proteinG: 2, carbohydrateG: 6, fatG: 3 } };
  assert.match(pendingFoodItemSql(1, item, textSql), /,60,59,2,6,3\)$/);
});

test('parses only a complete, validated user-declared single-food shortcut', () => {
  const reply = parseDeclaredFoodShortcut('Yogur natural | cantidad consumida: 150 g | 135 kcal; 15 g proteína; 9 g carbohidratos; 4 g grasa');
  assert.equal(reply.items[0].macroSource, 'declarado_usuario');
  assert.equal(reply.items[0].quantityGrams, 150);
  assert.equal(reply.items[0].macros.energyKcal, 135);
  assert.equal(parseDeclaredFoodShortcut('Yogur natural 150 g, 135 kcal'), null);
  assert.deepEqual(Object.keys(reply.items[0].macros), ['energyKcal', 'proteinG', 'carbohydrateG', 'fatG']);
});

test('detects actual websearch calls and ignores webfetch', () => {
  assert.equal(usedFoodWebSearch([{ type: 'text', text: 'respuesta' }]), false);
  assert.equal(usedFoodWebSearch([{ type: 'tool', tool: 'websearch' }]), true);
  assert.equal(usedFoodWebSearch([{ type: 'tool', state: { title: 'Web Search' } }]), true);
  assert.equal(usedFoodWebSearch([{ type: 'tool', state: { title: 'Web Fetch' } }]), false);
});

test('reports safe food-analysis progress scoped to the authenticated user and request', () => {
  reportFoodProgress('27', 'req-progress-test', 'web_resolution_started', { description: 'private food text' });
  assert.equal(getFoodEntryProgress('27', 'req-progress-test').label, 'Buscando resultados web…');
  assert.equal(getFoodEntryProgress('28', 'req-progress-test'), null);
});

test('uses compact explicit gram amounts to resolve a single missing food quantity', () => {
  const [item] = applyExplicitGrams([{ name: 'Lentejas', quantityGrams: null }], '150g');
  assert.equal(item.quantityGrams, 150);
  assert.equal(item.quantityText, '150 g');
});

test('does not guess which food receives ambiguous multiple gram amounts', () => {
  const items = [{ quantityGrams: null }, { quantityGrams: null }];
  applyExplicitGrams(items, '150g y 100 g');
  assert.deepEqual(items.map(({ quantityGrams }) => quantityGrams), [null, null]);
});

test('converts compact kilograms only for a single pending food', () => {
  const items = [{ name: 'Yogur', quantityGrams: null }, { name: 'Avena', quantityGrams: 40 }];
  applyExplicitGrams(items, '0,15kg', true);
  assert.equal(items[0].quantityGrams, 150);
});

test('assigns contextual quantities to the matching foods', () => {
  const items = [
    { name: 'pollo', sourceText: 'pollo', quantityGrams: null },
    { name: 'arroz', sourceText: 'arroz', quantityGrams: null },
  ];
  applyExplicitGrams(items, 'pollo 150g, arroz 200g');
  assert.deepEqual(items.map(({ quantityGrams }) => quantityGrams), [150, 200]);
});

test('flags macro values that exceed physical or 4-4-9 plausibility bounds', () => {
  const issues = foodItemIssues({
    name: 'Alimento', sourceText: 'Alimento 100 g', macroBasis: 'per_portion', macroStatus: 'declarado', macroSource: 'declarado_usuario',
    quantityGrams: 100, macros: { energyKcal: 1000, proteinG: 10, carbohydrateG: 10, fatG: 10 },
  });
  assert.ok(issues.includes('energy_4_4_9_mismatch'));
  assert.ok(issues.includes('energy_unit_bounds'));
});

test('checks 4-4-9 energy for the supported macros', () => {
  const issues = foodItemIssues({
    name: 'Alimento', sourceText: 'Alimento 100 g', macroBasis: 'per_portion', macroStatus: 'declarado', macroSource: 'declarado_usuario',
    quantityGrams: 100, macros: { energyKcal: 400, proteinG: 10, carbohydrateG: 10, fatG: 10 },
  });
  assert.ok(issues.includes('energy_4_4_9_mismatch'));
});

test('declared shortcut accepts several complete lines and rejects mixed input', () => {
  const yogur = 'Yogur natural | cantidad consumida: 150 g | 135 kcal; 15 g proteína; 9 g carbohidratos; 4 g grasa';
  const queso = 'Queso fresco | cantidad consumida: 50 g | 130 kcal; 9 g proteína; 2 g carbohidratos; 9 g grasa';
  assert.equal(parseDeclaredFoodShortcut(`${yogur}\n${queso}`).items.length, 2);
  assert.equal(parseDeclaredFoodShortcut(`${yogur}\nQueso fresco 50 g`), null);
});

test('estimated energy is recomputed with 4/4/9 only for estimated macros that disagree', () => {
  const estimated = { macroSource: 'opencode_estimado', macros: { energyKcal: 999, proteinG: 10, carbohydrateG: 10, fatG: 5 } };
  const web = { ...estimated, macroSource: 'webfetch' };
  const consistent = { ...estimated, macros: { ...estimated.macros, energyKcal: 130 } };
  const [fixed, untouchedWeb, untouchedConsistent] = repairEstimatedEnergy([estimated, web, consistent]);
  assert.equal(fixed.macros.energyKcal, 125);
  assert.equal(untouchedWeb.macros.energyKcal, 999);
  assert.equal(untouchedConsistent.macros.energyKcal, 130);
});

test('known foods shortcut scales previously saved macros and ignores unknown foods', async () => {
  const textSql = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const row = JSON.stringify({ name: 'Pollo', grams: 150, macroStatus: 'estimado', macroSource: 'opencode_estimado', sourceName: null, sourceUrl: null, sourceQuote: null, energyKcal: 200, proteinG: 38, carbohydrateG: 0, fatG: 5 });
  const dbQuery = async () => row;
  const reply = await knownFoodsShortcut({ description: 'pollo 200 g', userId: 1, dbQuery, textSql });
  assert.equal(reply.items[0].macros.energyKcal, 266.67);
  assert.equal(reply.items[0].name, 'Pollo');
  assert.equal(await knownFoodsShortcut({ description: 'Pavo 200 g', userId: 1, dbQuery, textSql }), null);
  assert.equal(await knownFoodsShortcut({ description: 'Pollo 200 g; Pavo 100 g', userId: 1, dbQuery, textSql }), null, 'Una coincidencia parcial no debe omitir alimentos desconocidos');
  assert.equal(await knownFoodsShortcut({ description: 'pollo asado con salsa', userId: 1, dbQuery, textSql }), null);
});

test('known food matching tolerates accents, whitespace, and typographic dashes without fuzzy item substitutions', async () => {
  const textSql = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const row = JSON.stringify({ name: 'Pollo-asado', grams: 100, macroStatus: 'estimado', macroSource: 'opencode_estimado', energyKcal: 150, proteinG: 25, carbohydrateG: 0, fatG: 5 });
  const dbQuery = async () => row;
  const reply = await knownFoodsShortcut({ description: 'pollo–asado 100 g', userId: 1, dbQuery, textSql });
  assert.equal(reply.items[0].name, 'Pollo-asado');
  assert.equal(await knownFoodsShortcut({ description: 'pollo empanizado 100 g', userId: 1, dbQuery, textSql }), null);
});

test('pending food draft returns saved candidate items for its preview', async () => {
  const draft = JSON.stringify({ id: 12, requestId: 'request', fecha: '2026-11-04', description: 'pollo', question: '¿Cuántos gramos?', state: 'borrador_chat' });
  const item = JSON.stringify({ sourceText: 'pollo asado', name: 'Pollo', quantityText: '150 g', quantityGrams: 150, macroBasis: 'per_100g', macroStatus: 'estimado', macroSource: 'websearch', sourceName: 'Ficha', sourceUrl: 'https://example.com/pollo', sourceQuote: 'Datos nutricionales', macros: { energyKcal: 200 } });
  let call = 0;
  let query;
  const result = await readPendingFoodDraft({ userId: 7, dbQuery: async (sql) => {
    call += 1;
    query = sql;
    return `draft\n${draft}\nmessages\nitems\n${item}`;
  } });
  assert.equal(call, 1);
  assert.match(query, /START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY/);
  assert.match(query, /usuario_id=7 AND estado='borrador_chat'/);
  assert.match(query, /registro_comida_id=@food_draft_id ORDER BY id/);
  assert.match(query, /COMMIT;/);
  assert.deepEqual(result.messages.map(({ role }) => role), ['user', 'assistant']);
  assert.equal(result.previewItems[0].name, 'Pollo');
  assert.equal(result.previewItems[0].quantityText, '150 g');
  assert.equal(result.previewItems[0].sourceText, 'pollo asado');
  assert.equal(result.previewItems[0].macroSource, 'websearch');
  assert.equal(result.previewItems[0].macroBasis, 'per_100g');
});

test('pending draft batch preserves message order and filters legacy identity failures', async () => {
  const draft = { id: 12, description: 'Pollo', question: null };
  const messages = [
    { role: 'user', content: '150 g de pollo' },
    { role: 'assistant', content: 'No me proporciona la identidad autenticada.' },
    { role: 'assistant', content: '¿Crudo o cocido?' },
    { role: 'user', content: 'Cocido' },
  ];
  const result = await readPendingFoodDraft({ userId: 7, dbQuery: async () => `draft\n${JSON.stringify(draft)}\nmessages\n${messages.map((message) => JSON.stringify(message)).join('\n')}\nitems` });
  assert.deepEqual(result.messages, [messages[0], messages[2], messages[3]]);
  assert.deepEqual(result.previewItems, []);
  assert.equal(await readPendingFoodDraft({ userId: 7, dbQuery: async () => 'draft\nmessages\nitems' }), null);
  let queried = false;
  await assert.rejects(readPendingFoodDraft({ userId: '7 OR 1=1', dbQuery: async () => { queried = true; } }), { status: 400 });
  assert.equal(queried, false);
});

test('preview quantity edits scale saved portion macros and preserve source metadata', () => {
  const prior = {
    sourceText: 'pollo', name: 'Pollo', quantityText: '100 g', quantityGrams: 100,
    macroBasis: 'per_portion', macroStatus: 'estimado', macroSource: 'websearch',
    sourceName: 'Ficha', sourceUrl: 'https://example.com/pollo', sourceQuote: 'Datos',
    macros: { energyKcal: 232, proteinG: 20, carbohydrateG: 20, fatG: 8 },
  };
  const resultItem = { ...prior, macros: { energyKcal: 1, proteinG: 1, carbohydrateG: 1, fatG: 1 } };
  applyPreviewQuantityEdits([resultItem], [prior], [{
    originalName: 'Pollo', originalSourceText: 'pollo', originalQuantityText: '100 g',
    name: 'Pollo', quantityText: '0.15 kg',
  }]);
  assert.equal(resultItem.quantityGrams, 150);
  assert.equal(resultItem.quantityText, '0.15 kg');
  assert.equal(resultItem.sourceText, 'pollo');
  assert.deepEqual(resultItem.macros, { energyKcal: 348, proteinG: 30, carbohydrateG: 30, fatG: 12 });
  assert.equal(resultItem.macroSource, 'websearch');
  assert.equal(resultItem.sourceUrl, prior.sourceUrl);
});

test('per-100 g source products are never applied to foods measured by volume', () => {
  const product = { name: 'Leche', macroBasis: 'per_100g', macroStatus: 'estimado', macroSource: 'opencode_estimado', macros: { energyKcal: 50, proteinG: 3.3, carbohydrateG: 4.8, fatG: 2 } };
  const volume = { name: 'Leche', quantityGrams: null, quantityText: '250 ml', macroBasis: 'per_portion', macros: { energyKcal: 125, proteinG: 8, carbohydrateG: 12, fatG: 5 } };
  const grams = { name: 'Leche', quantityGrams: 200, quantityText: '200 g', macroBasis: 'per_portion', macros: {} };
  const [kept, replaced] = applyOpenFoodFactsMacros([volume, grams], [product]);
  assert.equal(kept.macroBasis, 'per_portion');
  assert.equal(replaced.macroBasis, 'per_100g');
});
