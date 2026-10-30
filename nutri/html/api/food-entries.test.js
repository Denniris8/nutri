const assert = require('node:assert/strict');
const test = require('node:test');
const { applyExplicitGrams, applyOpenFoodFactsMacros, foodItemIssues, getFoodEntryProgress, hasExplicitVolume, knownFoodsShortcut, needsSelectedNutritionDateConfirmation, parseDeclaredFoodShortcut, pendingFoodItemSql, repairEstimatedEnergy, reportFoodProgress, selectedNutritionDateAnswer, usedFoodWebFetch, usedFoodWebTools } = require('./food-entries.js');

test('accepts confirmed teaspoon and tablespoon quantities without requiring grams', () => {
  for (const quantityText of ['1 cucharadita', 'una cucharadita', '2 cditas.', '1 cucharada', 'dos cucharadas', '2 cdas.', 'una pizca', '1 taza', 'un puñado', '2 piezas']) {
    assert.equal(hasExplicitVolume({ quantityGrams: null, quantityText }), true);
  }
});

test('confirms a mismatched selected nutrition date only during 00:00-03:59', () => {
  assert.equal(needsSelectedNutritionDateConfirmation('2026-10-29', '2026-10-30', 0), true);
  assert.equal(needsSelectedNutritionDateConfirmation('2026-10-29', '2026-10-30', 239), true);
  assert.equal(needsSelectedNutritionDateConfirmation('2026-10-29', '2026-10-30', 240), false);
  assert.equal(needsSelectedNutritionDateConfirmation('2026-10-30', '2026-10-30', 60), false);
});

test('uses the suggested end-of-day time only when the selected-date confirmation is accepted', () => {
  const question = '¿Confirmas registrar esta comida en el día nutricional seleccionado (2026-10-29)? Sugiero las 11:59:59 p. m.; confirma o indica otra hora.';
  assert.deepEqual(selectedNutritionDateAnswer(question, 'Sí'), { confirmed: true, time: { hours: [23], minute: 59 }, lastSecond: true });
  assert.equal(selectedNutritionDateAnswer(question, 'No').declined, true);
  assert.equal(selectedNutritionDateAnswer(question, 'A las 8:30 p. m.').time.hours[0], 20);
});

test('draft candidate SQL accepts numeric fiber without treating it as text', () => {
  const textSql = (value) => `CONVERT(0x${Buffer.from(value, 'utf8').toString('hex')} USING utf8mb4)`;
  const item = { name: 'Ensalada', sourceText: 'Ensalada', quantityGrams: 120, quantityText: '120 g', macroBasis: 'per_portion', macroStatus: 'estimado', macroSource: 'opencode_estimado', macros: { energyKcal: 60, proteinG: 2, carbohydrateG: 6, fatG: 3, fiberG: 2 } };
  assert.match(pendingFoodItemSql(1, item, textSql), /,2\)$/);
  assert.match(pendingFoodItemSql(1, { ...item, macros: { ...item.macros, fiberG: null } }, textSql), /,NULL\)$/);
});

test('parses only a complete, validated user-declared single-food shortcut', () => {
  const reply = parseDeclaredFoodShortcut('Yogur natural | cantidad consumida: 150 g | 135 kcal; 15 g proteína; 9 g carbohidratos; 4 g grasa; 0 g fibra');
  assert.equal(reply.items[0].macroSource, 'declarado_usuario');
  assert.equal(reply.items[0].quantityGrams, 150);
  assert.equal(reply.items[0].macros.energyKcal, 135);
  assert.equal(parseDeclaredFoodShortcut('Yogur natural 150 g, 135 kcal'), null);
  const noFiber = parseDeclaredFoodShortcut('Yogur | cantidad consumida: 150 g | 135 kcal; 15 g proteína; 9 g carbohidratos; 4 g grasa');
  assert.equal(noFiber.items[0].macros.fiberG, null);
});

test('detects actual web tool calls rather than merely enabled tools', () => {
  assert.equal(usedFoodWebTools([{ type: 'text', text: 'respuesta' }]), false);
  assert.equal(usedFoodWebTools([{ type: 'tool', tool: 'websearch' }]), true);
  assert.equal(usedFoodWebTools([{ type: 'tool', state: { title: 'Web Fetch' } }]), true);
});

test('distinguishes web search from opening a source', () => {
  assert.equal(usedFoodWebFetch([{ type: 'tool', tool: 'websearch' }]), false);
  assert.equal(usedFoodWebFetch([{ type: 'tool', state: { title: 'Web Fetch' } }]), true);
});

test('reports safe food-analysis progress scoped to the authenticated user and request', () => {
  reportFoodProgress('27', 'req-progress-test', 'usda_lookup_started', { description: 'private food text' });
  assert.equal(getFoodEntryProgress('27', 'req-progress-test').label, 'Consultando USDA…');
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

test('flags macro values that exceed physical or 4-4-9 plausibility bounds', () => {
  const issues = foodItemIssues({
    name: 'Alimento', sourceText: 'Alimento 100 g', macroBasis: 'per_portion', macroStatus: 'declarado', macroSource: 'declarado_usuario',
    quantityGrams: 100, macros: { energyKcal: 1000, proteinG: 10, carbohydrateG: 10, fatG: 10, fiberG: 0 },
  });
  assert.ok(issues.includes('energy_4_4_9_mismatch'));
  assert.ok(issues.includes('energy_unit_bounds'));
});

test('checks 4-4-9 energy even when fiber was not declared', () => {
  const issues = foodItemIssues({
    name: 'Alimento', sourceText: 'Alimento 100 g', macroBasis: 'per_portion', macroStatus: 'declarado', macroSource: 'declarado_usuario',
    quantityGrams: 100, macros: { energyKcal: 400, proteinG: 10, carbohydrateG: 10, fatG: 10, fiberG: null },
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
  const estimated = { macroSource: 'opencode_estimado', macros: { energyKcal: 999, proteinG: 10, carbohydrateG: 10, fatG: 5, fiberG: null } };
  const web = { ...estimated, macroSource: 'webfetch' };
  const consistent = { ...estimated, macros: { ...estimated.macros, energyKcal: 130 } };
  const [fixed, untouchedWeb, untouchedConsistent] = repairEstimatedEnergy([estimated, web, consistent]);
  assert.equal(fixed.macros.energyKcal, 125);
  assert.equal(untouchedWeb.macros.energyKcal, 999);
  assert.equal(untouchedConsistent.macros.energyKcal, 130);
});

test('known foods shortcut scales previously saved macros and ignores unknown foods', async () => {
  const textSql = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const row = JSON.stringify({ name: 'Pollo', grams: 150, macroStatus: 'estimado', macroSource: 'opencode_estimado', sourceName: null, sourceUrl: null, sourceQuote: null, energyKcal: 200, proteinG: 38, carbohydrateG: 0, fatG: 5, fiberG: null });
  const dbQuery = async () => row;
  const reply = await knownFoodsShortcut({ description: 'pollo 200 g', userId: 1, dbQuery, textSql });
  assert.equal(reply.items[0].macros.energyKcal, 266.67);
  assert.equal(reply.items[0].name, 'Pollo');
  assert.equal(await knownFoodsShortcut({ description: 'Pavo 200 g', userId: 1, dbQuery, textSql }), null);
  assert.equal(await knownFoodsShortcut({ description: 'pollo asado con salsa', userId: 1, dbQuery, textSql }), null);
});

test('per-100 g source products are never applied to foods measured by volume', () => {
  const product = { name: 'Leche', macroBasis: 'per_100g', macroStatus: 'estimado', macroSource: 'opencode_estimado', macros: { energyKcal: 50, proteinG: 3.3, carbohydrateG: 4.8, fatG: 2, fiberG: null } };
  const volume = { name: 'Leche', quantityGrams: null, quantityText: '250 ml', macroBasis: 'per_portion', macros: { energyKcal: 125, proteinG: 8, carbohydrateG: 12, fatG: 5, fiberG: null } };
  const grams = { name: 'Leche', quantityGrams: 200, quantityText: '200 g', macroBasis: 'per_portion', macros: {} };
  const [kept, replaced] = applyOpenFoodFactsMacros([volume, grams], [product]);
  assert.equal(kept.macroBasis, 'per_portion');
  assert.equal(replaced.macroBasis, 'per_100g');
});
