-- Add daily activity energy without rewriting existing step or training records.
-- Manual sessions default to not included in Garmin active calories; new Garmin-linked
-- manual entries require an explicit yes/no before saving when no duplicate is found.
-- Recovery: the nullable step-energy columns are additive; old code can ignore them.
-- Before removing the manual-session flag, export its values; removing it loses inclusion choices.
ALTER TABLE registros_pasos_diarios
  ADD COLUMN energia_actividad_kcal DECIMAL(8,1) NULL,
  ADD COLUMN metodo_energia ENUM('pasos_estimados','garmin_active') NULL,
  ADD COLUMN peso_calculo_kg DECIMAL(6,2) NULL,
  ADD COLUMN estatura_calculo_cm DECIMAL(5,2) NULL;

ALTER TABLE registros_entrenamientos
  ADD COLUMN garmin_incluido_en_active TINYINT(1) NOT NULL DEFAULT 0;
