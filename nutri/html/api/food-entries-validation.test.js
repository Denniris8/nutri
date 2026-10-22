const assert = require('node:assert/strict');
const test = require('node:test');
const { foodItemIssues } = require('./food-entries.js');

const item = (overrides = {}) => ({
  name: 'Alimento', sourceText: 'Alimento', macroBasis: 'per_portion', macroStatus: 'declarado', macroSource: 'declarado_usuario',
  quantityGrams: 100, macros: { energyKcal: 185, proteinG: 15, carbohydrateG: 20, fatG: 5, fiberG: null },
  ...overrides,
});

test('allows omitted fiber when validating otherwise complete macros', () => {
  assert.deepEqual(foodItemIssues(item()), []);
});

test('rejects impossible macro mass for a portion', () => {
  const issues = foodItemIssues(item({ macros: { energyKcal: 185, proteinG: 106, carbohydrateG: 20, fatG: 5, fiberG: null } }));
  assert.ok(issues.includes('macro_unit_bounds'));
});

test('scales per-100g macros by the stated portion before checking physical bounds', () => {
  const valid = item({ macroBasis: 'per_100g', quantityGrams: 250, macros: { energyKcal: 200, proteinG: 40, carbohydrateG: 20, fatG: 5, fiberG: 2 } });
  const invalid = { ...valid, macros: { ...valid.macros, proteinG: 120 } };
  assert.ok(!foodItemIssues(valid).includes('macro_unit_bounds'));
  assert.ok(foodItemIssues(invalid).includes('macro_unit_bounds'));
});

test('checks energy density using the portion-scaled per-100g value', () => {
  const value = item({ macroBasis: 'per_100g', quantityGrams: 200, macros: { energyKcal: 1000, proteinG: 0, carbohydrateG: 0, fatG: 0, fiberG: 0 } });
  assert.ok(foodItemIssues(value).includes('energy_unit_bounds'));
});
