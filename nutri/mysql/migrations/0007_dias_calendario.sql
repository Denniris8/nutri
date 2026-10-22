-- Irreversible: los límites horarios dejan de aplicarse y sus valores anteriores se descartan.
-- Recuperación: una futura migración correctiva puede recrear las columnas con 00:00:00; los valores previos no se recuperan.
-- MySQL DDL no es transaccional; verificar schema_migrations y columnas antes de reintentar.
ALTER TABLE preferencias_usuario
  DROP COLUMN nutrition_day_start,
  DROP COLUMN nutrition_day_end;
