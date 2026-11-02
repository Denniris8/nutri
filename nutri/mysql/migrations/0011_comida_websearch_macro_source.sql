-- Additive source label: existing rows retain their current provenance.
-- Recovery: convert new 'openfoodfacts' and 'websearch' rows to
-- 'opencode_estimado', then remove those values from both ENUM definitions.
ALTER TABLE registros_comida_items
  MODIFY fuente_macros ENUM('usda_fdc','declarado_usuario','webfetch','openfoodfacts','websearch','opencode_estimado') NOT NULL,
  MODIFY metodo_energia ENUM('usda','4-4-9','declarado_usuario','webfetch','openfoodfacts','websearch','opencode_estimado') NOT NULL DEFAULT 'usda';
