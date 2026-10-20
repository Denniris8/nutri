const tmb = "ROUND(10*w.peso_kg+6.25*u.estatura_cm-5*u.edad+IF(u.sexo='masculino',5,-161))";
const latestWeight = "(SELECT rb.id FROM registros_biometricos rb WHERE rb.usuario_id=u.id AND rb.fuente IN ('manual','bia') ORDER BY rb.medido_en DESC,rb.id DESC LIMIT 1)";
const latestTmb = "(SELECT rb.id FROM registros_biometricos rb WHERE rb.usuario_id=u.id AND rb.metabolismo_basal_kcal IS NOT NULL ORDER BY rb.medido_en DESC,rb.id DESC LIMIT 1)";

function insertMifflinTmbSql(userId, { weightChanged = false } = {}) {
  const notes = "CONCAT('Estimación Mifflin-St Jeor (',IF(u.sexo='masculino','hombre','mujer'),', ',u.edad,' años, ',u.estatura_cm,' cm); estimada, no BIA.')";
  const biaGuard = weightChanged
    ? `AND NOT EXISTS (SELECT 1 FROM registros_biometricos b WHERE b.id=${latestTmb} AND b.fuente='bia' AND b.peso_kg=w.peso_kg)`
    : `AND NOT EXISTS (SELECT 1 FROM registros_biometricos b WHERE b.id=${latestTmb} AND b.fuente='bia')`;
  const duplicateGuard = `AND NOT EXISTS (SELECT 1 FROM registros_biometricos m WHERE m.id=${latestTmb} AND m.fuente='mifflin' AND m.peso_kg=w.peso_kg AND m.metabolismo_basal_kcal=${tmb} AND m.notas=${notes})`;
  return `INSERT INTO registros_biometricos(usuario_id,fuente,peso_kg,metabolismo_basal_kcal,notas,medido_en) SELECT u.id,'mifflin',w.peso_kg,${tmb},${notes},UTC_TIMESTAMP() FROM usuarios u JOIN registros_biometricos w ON w.id=${latestWeight} WHERE u.id=${userId} AND u.sexo IN ('masculino','femenino') AND u.edad BETWEEN 19 AND 78 AND u.estatura_cm IS NOT NULL AND ${tmb} BETWEEN 800 AND 20000 AND NOT (w.fuente='bia' AND w.metabolismo_basal_kcal IS NOT NULL) ${biaGuard} ${duplicateGuard};`;
}

function mifflinTmbStatusSql(userId) {
  return `SELECT JSON_OBJECT('inserted',ROW_COUNT(),'hasTmb',EXISTS(SELECT 1 FROM registros_biometricos WHERE usuario_id=u.id AND metabolismo_basal_kcal IS NOT NULL),'sex',u.sexo,'age',u.edad,'weightKg',w.peso_kg,'heightCm',u.estatura_cm,'tmbKcal',${tmb}) FROM usuarios u LEFT JOIN registros_biometricos w ON w.id=${latestWeight} WHERE u.id=${userId};`;
}

function mifflinTmbStatus(result) {
  if (Number(result.inserted) > 0) return 'created';
  if (result.hasTmb) return 'existing';
  if (result.weightKg == null || result.heightCm == null) return 'missing_data';
  if (!['masculino', 'femenino'].includes(result.sex)) return 'unsupported_sex';
  if (Number(result.age) < 19 || Number(result.age) > 78) return 'age_out_of_range';
  return 'out_of_range';
}

module.exports = { insertMifflinTmbSql, mifflinTmbStatus, mifflinTmbStatusSql };
