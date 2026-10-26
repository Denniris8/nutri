const assert = require('node:assert/strict');
const test = require('node:test');
const { foodItemIssues, normalizeFoodReply } = require('./food-entries.js');

const item = (overrides = {}) => ({
  name: 'Alimento', sourceText: 'Alimento', macroBasis: 'per_portion', macroStatus: 'declarado', macroSource: 'declarado_usuario',
  quantityGrams: 100, macros: { energyKcal: 185, proteinG: 15, carbohydrateG: 20, fatG: 5, fiberG: null },
  ...overrides,
});

test('allows omitted fiber when validating otherwise complete macros', () => {
  assert.deepEqual(foodItemIssues(item()), []);
});

test('normalizes OpenCode estimated status and decimal-comma macros before validation', () => {
  const [normalized] = normalizeFoodReply({ items: [{
    name: 'Arroz', macroBasis: 'per_portion', macroStatus: 'opencode_estimado', macroSource: 'opencode_estimado',
    macros: { energyKcal: '110,0', proteinG: '2,5', carbohydrateG: '24,0', fatG: '0,3', fiberG: null },
  }] }).items;

  assert.equal(normalized.macroStatus, 'estimado');
  assert.deepEqual(normalized.macros, { energyKcal: 110, proteinG: 2.5, carbohydrateG: 24, fatG: 0.3, fiberG: null });
  assert.deepEqual(foodItemIssues(normalized), []);
});

test('preserves unresolved macros only as an invalid intermediate Open Food Facts candidate', () => {
  const [candidate] = normalizeFoodReply({ items: [{
    name: 'Producto envasado', macroBasis: 'per_100g', macroStatus: 'pendiente', macroSource: 'pendiente',
    quantityGrams: null, quantityText: null,
    macros: { energyKcal: null, proteinG: null, carbohydrateG: null, fatG: null, fiberG: null },
  }] }).items;

  assert.equal(candidate.macroSource, 'pendiente');
  assert.equal(candidate.macroStatus, 'pendiente');
  assert.ok(foodItemIssues(candidate).includes('macroSource'));
  assert.ok(foodItemIssues(candidate).includes('macroStatus'));
});

test('does not coerce non-decimal macro strings into valid numbers', () => {
  const [normalized] = normalizeFoodReply({ items: [{
    name: 'Alimento', macroBasis: 'per_portion', macroStatus: 'estimado', macroSource: 'opencode_estimado',
    macros: { energyKcal: '0x10', proteinG: '2', carbohydrateG: '3', fatG: '1', fiberG: null },
  }] }).items;

  assert.ok(foodItemIssues(normalized).includes('macros'));
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
