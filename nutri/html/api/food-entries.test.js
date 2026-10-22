const assert = require('node:assert/strict');
const test = require('node:test');
const { applyExplicitGrams, foodItemIssues } = require('./food-entries.js');

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
