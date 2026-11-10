-- Retirada de columnas antiguas tras desplegar el contrato de cuatro valores.
-- DDL no transaccional: detener versiones antiguas y conservar copia previa.
-- Los guardas permiten recuperar un DDL parcialmente aplicado sin inventar datos.
SET @ddl=IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='alimentos_referencia' AND COLUMN_NAME='fibra_g_100g'),
  'ALTER TABLE alimentos_referencia DROP COLUMN fibra_g_100g', 'DO 0');
PREPARE remove_column FROM @ddl;
EXECUTE remove_column;
DEALLOCATE PREPARE remove_column;

SET @ddl=IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='registros_comida_items' AND COLUMN_NAME='fibra_g'),
  'ALTER TABLE registros_comida_items DROP COLUMN fibra_g', 'DO 0');
PREPARE remove_column FROM @ddl;
EXECUTE remove_column;
DEALLOCATE PREPARE remove_column;

SET @ddl=IF(EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='registros_comidas' AND COLUMN_NAME='fibra_g'),
  'ALTER TABLE registros_comidas DROP COLUMN fibra_g', 'DO 0');
PREPARE remove_column FROM @ddl;
EXECUTE remove_column;
DEALLOCATE PREPARE remove_column;
