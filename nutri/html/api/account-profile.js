const { insertMifflinTmbSql, mifflinTmbStatus, mifflinTmbStatusSql } = require('./mifflin.js');

async function saveAccountProfile({ response, userId, data, dbQuery, textSql, json }) {
  const id = String(userId);
  if (!/^\d+$/.test(id) || !['masculino', 'femenino', 'otro'].includes(data.sex)) {
    json(response, 400, { error: 'Selecciona un sexo válido.' });
    return;
  }
  const hasHeight = Object.hasOwn(data, 'heightCm');
  const rawHeight = data.heightCm;
  const height = rawHeight == null || rawHeight === '' ? null
    : typeof rawHeight === 'string' && /^\d{2,3}(?:\.\d{1,2})?$/.test(rawHeight) ? Number(rawHeight) : NaN;
  if (hasHeight && height !== null && (!Number.isFinite(height) || height < 80 || height > 250)) {
    json(response, 400, { error: 'La estatura debe estar entre 80 y 250 cm.' });
    return;
  }
  try {
    const result = await dbQuery(`START TRANSACTION;
SELECT id FROM usuarios WHERE id=${id} FOR UPDATE;
UPDATE usuarios SET sexo=${textSql(data.sex)}${hasHeight ? `,estatura_cm=${height === null ? 'NULL' : height.toFixed(2)}` : ''} WHERE id=${id};
${insertMifflinTmbSql(id)}
${mifflinTmbStatusSql(id)}
COMMIT;`);
    const status = mifflinTmbStatus(JSON.parse(result.split(/\r?\n/).at(-1)));
    json(response, 200, { ok: true, sex: data.sex, ...(hasHeight ? { heightCm: height } : {}), tmbStatus: status });
  } catch {
    json(response, 503, { error: 'No se pudo actualizar el perfil de cuenta.' });
  }
}

async function readAccountProfile({ userId, dbQuery }) {
  const id = String(userId);
  if (!/^\d+$/.test(id)) throw new Error('invalid_user_id');
  const raw = await dbQuery(`SELECT JSON_OBJECT('sex',u.sexo,'heightCm',u.estatura_cm,'restingMetabolismKcal',(SELECT metabolismo_basal_kcal FROM registros_biometricos WHERE usuario_id=u.id AND metabolismo_basal_kcal IS NOT NULL ORDER BY medido_en DESC,id DESC LIMIT 1),'restingMetabolismSource',(SELECT fuente FROM registros_biometricos WHERE usuario_id=u.id AND metabolismo_basal_kcal IS NOT NULL ORDER BY medido_en DESC,id DESC LIMIT 1)) FROM usuarios u WHERE u.id=${id} LIMIT 1;`);
  return raw ? JSON.parse(raw) : null;
}

module.exports = { readAccountProfile, saveAccountProfile };
