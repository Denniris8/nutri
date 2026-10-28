const assert = require('node:assert/strict');
const test = require('node:test');
const { applyExplicitGrams, foodItemIssues, getFoodEntryProgress, parseDeclaredFoodShortcut, reportFoodProgress, usedFoodWebFetch, usedFoodWebTools } = require('./food-entries.js');

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
