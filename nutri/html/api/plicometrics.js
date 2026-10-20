const fields = [
  ['tricepsMm', 'triceps_mm', 'Tríceps'], ['bicepsMm', 'biceps_mm', 'Bíceps'],
  ['subescapularMm', 'subescapular_mm', 'Subescapular'], ['suprailiacoMm', 'suprailiaco_mm', 'Suprailíaco'],
  ['abdominalMm', 'abdominal_mm', 'Abdominal'], ['musloAnteriorMm', 'muslo_anterior_mm', 'Muslo anterior'],
  ['pantorrillaMm', 'pantorrilla_mm', 'Pantorrilla'],
];

function validatePlicometricInput(input) {
  const fecha = typeof input?.fecha === 'string' ? input.fecha : '';
  const parsedDate = new Date(`${fecha}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== fecha) {
    throw Object.assign(new Error('La fecha no es válida.'), { status: 400 });
  }
  if (fecha > new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString().slice(0, 10)) {
    throw Object.assign(new Error('La fecha no puede ser futura.'), { status: 400 });
  }
  const record = { fecha };
  let measured = 0;
  for (const [key, column, label] of fields) {
    const raw = input[key];
    if (raw == null || raw === '') { record[column] = null; continue; }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 120) {
      throw Object.assign(new Error(`${label} debe estar entre 0 y 120 mm.`), { status: 400 });
    }
    record[column] = Math.round(value * 100) / 100;
    measured += 1;
  }
  if (!measured) throw Object.assign(new Error('Indica al menos una medición en mm.'), { status: 400 });
  return record;
}

async function readPlicometrics({ userId, dbQuery }) {
  if (!/^\d+$/.test(String(userId))) throw new Error('invalid_user_id');
  const result = await dbQuery(`SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('fecha',fecha,'tricepsMm',triceps_mm,'bicepsMm',biceps_mm,'subescapularMm',subescapular_mm,'suprailiacoMm',suprailiaco_mm,'abdominalMm',abdominal_mm,'musloAnteriorMm',muslo_anterior_mm,'pantorrillaMm',pantorrilla_mm)),JSON_ARRAY()) FROM (SELECT id,fecha,triceps_mm,biceps_mm,subescapular_mm,suprailiaco_mm,abdominal_mm,muslo_anterior_mm,pantorrilla_mm FROM registros_plicometro WHERE usuario_id=${userId} ORDER BY fecha DESC,id DESC LIMIT 100) AS recent_plicometrics;`);
  return JSON.parse(result || '[]');
}

async function savePlicometric({ response, data, userId, dbQuery, json, textSql }) {
  if (!/^\d+$/.test(String(userId))) { json(response, 400, { error: 'Cuenta no válida.' }); return; }
  let record;
  try { record = validatePlicometricInput(data); }
  catch (error) { json(response, error.status || 400, { error: error.message }); return; }
  const values = fields.map(([, column]) => record[column] ?? 'NULL');
  try {
    await dbQuery(`INSERT INTO registros_plicometro(usuario_id,fecha,triceps_mm,biceps_mm,subescapular_mm,suprailiaco_mm,abdominal_mm,muslo_anterior_mm,pantorrilla_mm) VALUES (${userId},${textSql(record.fecha)},${values.join(',')});`);
    json(response, 201, { ok: true });
  } catch { json(response, 503, { error: 'No se pudo guardar el registro de plicómetro.' }); }
}

module.exports = { readPlicometrics, savePlicometric, validatePlicometricInput };
