const { insertMifflinTmbSql, mifflinTmbStatus, mifflinTmbStatusSql } = require('./mifflin.js');

function metric(value, min, max, decimals = 1) {
  if (value == null || value === '') return null;
  const text = String(value);
  const pattern = decimals ? new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`) : /^\d+$/;
  if (!pattern.test(text)) throw new Error('invalid_metric');
  const number = Number(text);
  if (number < min || number > max) throw new Error('invalid_metric');
  return number.toFixed(decimals);
}

function validateBiometric(data) {
  if (!['manual', 'bia'].includes(data.source)) throw new Error('invalid_source');
  const record = {
    source: data.source,
    weight: metric(data.weightKg, 20, 400),
    bodyAge: metric(data.bodyAge, 5, 120, 0),
    bodyFat: metric(data.bodyFatPct, 0, 80),
    bmr: metric(data.restingMetabolismKcal, 800, 20000, 0),
    visceral: metric(data.visceralFat, 0, 59, 0),
    bmi: metric(data.bmi, 8, 90),
    muscle: metric(data.musclePct, 0, 80),
    notes: data.notes == null || data.notes === '' ? '' : typeof data.notes === 'string' ? data.notes.trim() : null,
  };
  if (record.weight === null || record.notes === null || record.notes.length > 1000) throw new Error('invalid_record');
  if (record.source === 'manual' && [record.bodyAge, record.bodyFat, record.bmr, record.visceral, record.bmi, record.muscle].some((value) => value !== null)) throw new Error('manual_weight_only');
  return record;
}

async function saveBiometric({ response, data, userId, dbQuery, textSql, json }) {
  if (!/^\d+$/.test(String(userId))) { json(response, 400, { error: 'Cuenta no válida.' }); return; }
  let record;
  try { record = validateBiometric(data); }
  catch { json(response, 400, { error: 'Revisa la fuente y los rangos de la medición.' }); return; }
  const nullable = (value) => value === null ? 'NULL' : value;
  try {
    const result = await dbQuery(`START TRANSACTION;
SELECT id FROM usuarios WHERE id=${userId} FOR UPDATE;
INSERT INTO registros_biometricos(usuario_id,fuente,peso_kg,edad_corporal,grasa_pct,metabolismo_basal_kcal,grasa_visceral,imc,musculo_pct,notas) VALUES (${userId},${textSql(record.source)},${record.weight},${nullable(record.bodyAge)},${nullable(record.bodyFat)},${nullable(record.bmr)},${nullable(record.visceral)},${nullable(record.bmi)},${nullable(record.muscle)},${record.notes ? textSql(record.notes) : 'NULL'});
${insertMifflinTmbSql(userId, { weightChanged: true })}
${mifflinTmbStatusSql(userId)}
COMMIT;`);
    json(response, 201, { ok: true, tmbStatus: mifflinTmbStatus(JSON.parse(result.split(/\r?\n/).at(-1))) });
  } catch { json(response, 503, { error: 'No se pudo guardar la medición.' }); }
}

async function readBiometrics({ userId, dbQuery, start, end }) {
  const id = String(userId);
  if (!/^\d+$/.test(id)) throw new Error('invalid_user_id');
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if ((start != null || end != null) && (!validDate(start) || !validDate(end) || start > end)) throw new Error('invalid_biometric_range');
  const where = start == null ? '' : ` AND medido_en>=CAST('${start} 00:00:00' AS DATETIME) AND medido_en<DATE_ADD(CAST('${end} 00:00:00' AS DATETIME),INTERVAL 1 DAY)`;
  const limit = start == null ? ' LIMIT 100' : '';
  const result = await dbQuery(`SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('measuredAt',DATE_FORMAT(medido_en,'%Y-%m-%d %H:%i:%s'),'source',fuente,'weightKg',peso_kg,'bodyAge',edad_corporal,'bodyFatPct',grasa_pct,'restingMetabolismKcal',metabolismo_basal_kcal,'visceralFat',grasa_visceral,'bmi',imc,'musclePct',musculo_pct,'notes',notas)),JSON_ARRAY()) FROM (SELECT medido_en,fuente,peso_kg,edad_corporal,grasa_pct,metabolismo_basal_kcal,grasa_visceral,imc,musculo_pct,notas FROM registros_biometricos WHERE usuario_id=${id}${where} ORDER BY medido_en DESC${limit}) AS recent_biometrics;`);
  return JSON.parse(result || '[]');
}

module.exports = { readBiometrics, saveBiometric, validateBiometric };
