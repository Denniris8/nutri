-- Authorized historical BIA entry for production account 25.
-- 00:00 is only a date marker because no measurement time was provided.
-- No overwrite: if a BIA record already exists for that account and date, this is a no-op.
-- Recovery: remove only this row by account, timestamp, source, and exact metric values.
INSERT INTO registros_biometricos (
  usuario_id, fuente, medido_en, peso_kg, edad_corporal, grasa_pct,
  metabolismo_basal_kcal, grasa_visceral, imc, musculo_pct, notas
)
SELECT
  u.id, 'bia', '2026-11-02 00:00:00', 80.50, 48, 27.30,
  1763, 11, 27.90, 35.00,
  'Hora de medición no proporcionada; 00:00 se usa solo como marcador de fecha.'
FROM usuarios u
WHERE u.id = 25
  AND BINARY u.nombre = BINARY CONVERT(0x4f73697269732042616c74617a617220457370696e6f7a61206465206c6120526f7361 USING utf8mb4)
  AND NOT EXISTS (
    SELECT 1 FROM registros_biometricos b
    WHERE b.usuario_id = u.id
      AND b.fuente = 'bia'
      AND b.medido_en >= '2026-11-02 00:00:00'
      AND b.medido_en < '2026-11-03 00:00:00'
  );
