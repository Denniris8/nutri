ALTER TABLE planes_entrenamiento
  ADD COLUMN objetivo_entrenamiento_proteinas_g DECIMAL(7,2) NULL,
  ADD COLUMN objetivo_entrenamiento_carbohidratos_g DECIMAL(7,2) NULL,
  ADD COLUMN objetivo_entrenamiento_grasas_g DECIMAL(7,2) NULL,
  ADD COLUMN objetivo_entrenamiento_calorias_kcal DECIMAL(8,1) NULL,
  ADD CONSTRAINT chk_planes_entrenamiento_objetivo_entrenamiento_proteinas CHECK (objetivo_entrenamiento_proteinas_g IS NULL OR objetivo_entrenamiento_proteinas_g BETWEEN 0 AND 10000),
  ADD CONSTRAINT chk_planes_entrenamiento_objetivo_entrenamiento_carbohidratos CHECK (objetivo_entrenamiento_carbohidratos_g IS NULL OR objetivo_entrenamiento_carbohidratos_g BETWEEN 0 AND 10000),
  ADD CONSTRAINT chk_planes_entrenamiento_objetivo_entrenamiento_grasas CHECK (objetivo_entrenamiento_grasas_g IS NULL OR objetivo_entrenamiento_grasas_g BETWEEN 0 AND 10000),
  ADD CONSTRAINT chk_planes_entrenamiento_objetivo_entrenamiento_calorias CHECK (objetivo_entrenamiento_calorias_kcal IS NULL OR objetivo_entrenamiento_calorias_kcal BETWEEN 0 AND 100000);
