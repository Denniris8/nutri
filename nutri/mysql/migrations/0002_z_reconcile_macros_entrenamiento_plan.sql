INSERT INTO schema_migrations (version, checksum)
SELECT
  '0003_macros_entrenamiento_plan',
  UNHEX('c2e421c4da7f8dfff911202e7ef55c48811f5cd8957cb9a843f769e2b816eb7e')
WHERE NOT EXISTS (
  SELECT 1
  FROM schema_migrations
  WHERE version = '0003_macros_entrenamiento_plan'
)
AND (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'planes_entrenamiento'
    AND column_name IN (
      'objetivo_entrenamiento_proteinas_g',
      'objetivo_entrenamiento_carbohidratos_g',
      'objetivo_entrenamiento_grasas_g',
      'objetivo_entrenamiento_calorias_kcal'
    )
) = 4
AND (
  SELECT COUNT(*)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'planes_entrenamiento'
    AND constraint_type = 'CHECK'
    AND constraint_name IN (
      'chk_planes_entrenamiento_objetivo_entrenamiento_proteinas',
      'chk_planes_entrenamiento_objetivo_entrenamiento_carbohidratos',
      'chk_planes_entrenamiento_objetivo_entrenamiento_grasas',
      'chk_planes_entrenamiento_objetivo_entrenamiento_calorias'
    )
) = 4;
